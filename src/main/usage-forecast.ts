// Usage forecast (Labs, behind the usageForecast preference): for each
// subscription window, when it runs out and whether that comes before the
// reset. The model is in @shared/usage-forecast; this module gathers what it
// learns from, all of it local:
//
//   - priced spend per 15 minutes from the CLIs' transcripts (the Usage tab's
//     scan and memo, on its worker thread),
//   - the limit readings the CLIs wrote themselves (Claude's "session limit"
//     messages, Codex's rate_limits on every turn),
//   - the provider's live usage read, and the readings this module records
//     from it while the preference is on (usage-history.jsonl),
//   - its own past forecasts: the back-test replays, and the live forecasts
//     it logs while the preference is on (usage-forecast-log.jsonl), scored
//     against the readings once their window resets. From their errors it
//     learns a correction per provider and window length
//     (@shared/usage-forecast-learning).
//
// Nothing here sends anything anywhere. With the preference off nothing in it
// runs: the IPC handler, the recorder and Cora's hint all check the preference
// first.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { codaraHome } from "./codara-home";
import { writeFileAtomic } from "./fs-atomic";
import { getPreferenceCached } from "./preferences-store";
import { readForecastScan } from "./usage-analytics";
import type { ForecastScan } from "./usage-scan-worker";
import type { PiUsageOverview, PiUsageProfile, PiUsageWindow } from "@shared/types";
import {
  FORECAST_BUCKET_MS,
  backtestForecast,
  burnNudge,
  calibrationFactors,
  coraForecastHint,
  describeForecast,
  forecastWindow,
  goAheadNote,
  median,
  normalizeForecastIdeas,
  pastWindowsFromReadings,
  pastWindowsFromSpend,
  percentSeriesFromReadings,
  quantile,
  suggestNextAccount,
  trimLeadingIdle,
  weeklyPattern,
  windowKindFor,
  windowLengthMs,
  groupReadingsByWindow,
  type AccountOption,
  type BacktestTrack,
  type BurnSeries,
  type CalibrationAnchor,
  type ForecastCalibration,
  type ForecastIdeas,
  type ForecastPattern,
  type ForecastProvider,
  type LimitReading,
  type PastWindow,
  type UsageForecastReport,
  type WindowForecastView,
} from "@shared/usage-forecast";
import {
  describeLearning,
  fitErrorModel,
  learnedBacktest,
  samplesFromBacktest,
  type ForecastLearning,
  type LearningSample,
} from "@shared/usage-forecast-learning";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 56;
/** Limit readings are small and memoised, and every past window is one more
 * lesson for the forecast, so they reach further back than the spend. */
const READINGS_DAYS = 120;
/** Longer than the renderer's 5-minute poll, so most reports reuse the last
 * scan; the live reading still moves the forecast on every one. */
const SCAN_TTL_MS = 10 * 60 * 1000;
/** The back-test's cache key already changes when a window closes or a live
 * forecast is scored, which is all that moves it; this only bounds drift. */
const BACKTEST_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_FILE = "usage-history.jsonl";
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const FORECAST_LOG_FILE = "usage-forecast-log.jsonl";
const FORECAST_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** A live forecast of one window is logged at most this often, and about
 * ten times per window whatever its length. */
const FORECAST_LOG_EVERY_MS = 30 * 60 * 1000;
/** Two reads whose resets lie this close are the same window: a reset computed
 * from "resets in N seconds" moves a little with every read. */
const SAME_RESET_MS = 5 * 60_000;
/** A window's last reading must come this close to its reset for its end to
 * count as known. */
const MAX_END_GAP_MS = 6 * HOUR_MS;
/** A reading that did not change is written again at most this often. */
const RECORD_REPEAT_MS = 10 * 60 * 1000;
/** Codex's general limit; others (codex_bengalfox) are per model. */
const CODEX_GENERAL_LIMITS = new Set(["codex"]);

/* ── Recorded readings ───────────────────────────────────────────────────── */

export interface RecordedReading {
  t: number;
  profileId: string;
  provider: string;
  windowId: string;
  label: string;
  used: number;
  resetsAt: number;
}

const lastRecorded = new Map<string, RecordedReading>();

function historyPath(): string {
  return join(codaraHome(), HISTORY_FILE);
}

function isGeneral(window: PiUsageWindow): boolean {
  return window.scope === undefined || window.scope.kind === "general";
}

let recording: Promise<void> = Promise.resolve();

/** Appends this read's general windows to usage-history.jsonl. Called only
 * while the usageForecast preference is on. Reads that overlap are queued so
 * the trim never drops lines another read appended. */
export function recordUsageReadings(overview: PiUsageOverview, nowMs = Date.now()): Promise<void> {
  const next = recording.then(() => appendReadings(overview, nowMs));
  recording = next.catch(() => undefined);
  return next;
}

async function appendReadings(overview: PiUsageOverview, nowMs: number): Promise<void> {
  const lines: string[] = [];
  for (const profile of overview.profiles ?? []) {
    if (profile.status !== "ok") continue;
    const at = Date.parse(profile.checkedAt);
    const t = Number.isNaN(at) ? nowMs : at;
    for (const window of profile.windows) {
      if (!isGeneral(window)) continue;
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      if (Number.isNaN(resetsAt)) continue;
      const key = `${profile.profileId}|${window.id}`;
      const previous = lastRecorded.get(key);
      if (
        previous &&
        previous.used === window.usedPercent &&
        Math.abs(previous.resetsAt - resetsAt) < SAME_RESET_MS &&
        t - previous.t < RECORD_REPEAT_MS
      ) {
        continue;
      }
      if (previous && previous.t === t) continue;
      const reading: RecordedReading = {
        t,
        profileId: profile.profileId,
        provider: profile.provider,
        windowId: window.id,
        label: window.label,
        used: window.usedPercent,
        resetsAt,
      };
      lastRecorded.set(key, reading);
      lines.push(JSON.stringify(reading));
    }
  }
  await appendTrimmed(historyPath(), lines, HISTORY_MAX_BYTES);
}

/** Appends lines and, past maxBytes, keeps the newer half. Callers queue on
 * `recording`, so a trim never races another append. */
async function appendTrimmed(path: string, lines: readonly string[], maxBytes: number): Promise<void> {
  if (lines.length === 0) return;
  await fs.appendFile(path, `${lines.join("\n")}\n`, "utf8");
  const stats = await fs.stat(path).catch(() => null);
  if (stats && stats.size > maxBytes) {
    const raw = await fs.readFile(path, "utf8");
    const kept = raw.split("\n").filter(Boolean);
    await writeFileAtomic(path, `${kept.slice(Math.floor(kept.length / 2)).join("\n")}\n`);
  }
}

async function readJsonLines<T>(path: string, keep: (value: T) => boolean): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }
  const values: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as T;
      if (keep(value)) values.push(value);
    } catch {
      // A torn last line from a crash; the next append starts a fresh one.
    }
  }
  return values;
}

export function readRecordedReadings(sinceMs: number): Promise<RecordedReading[]> {
  return readJsonLines<RecordedReading>(
    historyPath(),
    (reading) => typeof reading.t === "number" && reading.t >= sinceMs && typeof reading.used === "number",
  );
}

/* ── Logged forecasts ────────────────────────────────────────────────────── */

/** A live forecast as it was made, kept until its window resets and the
 * recorded readings say how it really ended. */
export interface LoggedForecast {
  t: number;
  profileId: string;
  provider: ForecastProvider;
  windowId: string;
  label: string;
  windowStartMs: number;
  resetsAt: number;
  used: number;
  /** Uncorrected growth quantiles, so a later correction can be scored on it. */
  growth: number[];
}

const lastLogged = new Map<string, { t: number; resetsAt: number }>();

function forecastLogPath(): string {
  return join(codaraHome(), FORECAST_LOG_FILE);
}

/** Logs the live forecasts of accounts in use. Called only while the
 * usageForecast preference is on, from building a report. */
export function logForecasts(views: readonly WindowForecastView[], nowMs = Date.now()): Promise<void> {
  const lines: string[] = [];
  for (const view of views) {
    if (!view.result.inUse || view.source !== "live") continue;
    const key = `${view.profileId}|${view.windowId}`;
    const every = Math.max(FORECAST_LOG_EVERY_MS, (view.result.resetsAtMs - view.result.windowStartMs) / 10);
    const previous = lastLogged.get(key);
    if (
      previous &&
      Math.abs(previous.resetsAt - view.result.resetsAtMs) < SAME_RESET_MS &&
      nowMs - previous.t < every
    ) {
      continue;
    }
    lastLogged.set(key, { t: nowMs, resetsAt: view.result.resetsAtMs });
    const entry: LoggedForecast = {
      t: nowMs,
      profileId: view.profileId,
      provider: view.provider,
      windowId: view.windowId,
      label: view.windowLabel,
      windowStartMs: view.result.windowStartMs,
      resetsAt: view.result.resetsAtMs,
      used: view.result.usedPercent,
      growth: view.result.growthQuantiles.map((value) => Math.round(value * 100) / 100),
    };
    lines.push(JSON.stringify(entry));
  }
  if (lines.length === 0) return Promise.resolve();
  const next = recording.then(() => appendTrimmed(forecastLogPath(), lines, FORECAST_LOG_MAX_BYTES));
  recording = next.catch(() => undefined);
  return next;
}

export function readLoggedForecasts(sinceMs: number): Promise<LoggedForecast[]> {
  return readJsonLines<LoggedForecast>(
    forecastLogPath(),
    (entry) => typeof entry.t === "number" && entry.t >= sinceMs && Array.isArray(entry.growth),
  );
}

/**
 * Logged forecasts whose window has reset, with the truth from the recorded
 * readings: the highest reading of that window. A window whose last reading
 * came long before the reset (Studio closed) has no known end unless it hit
 * 100, so it is left out rather than scored against a guess.
 */
export function scoreLoggedForecasts(
  logged: readonly LoggedForecast[],
  recorded: readonly RecordedReading[],
  nowMs: number,
): Map<string, LearningSample[]> {
  const byTrack = new Map<string, LearningSample[]>();
  // Both logs grow to thousands of lines, and this runs on every report.
  const byWindow = new Map<string, RecordedReading[]>();
  for (const reading of recorded) {
    const key = `${reading.profileId}|${reading.windowId}`;
    const list = byWindow.get(key) ?? [];
    list.push(reading);
    byWindow.set(key, list);
  }
  for (const list of byWindow.values()) list.sort((a, b) => a.resetsAt - b.resetsAt);
  for (const entry of logged) {
    if (entry.resetsAt > nowMs) continue;
    const lengthMs = entry.resetsAt - entry.windowStartMs;
    const sameWindow = byWindow.get(`${entry.profileId}|${entry.windowId}`) ?? [];
    let actual = Number.NEGATIVE_INFINITY;
    let lastAt = Number.NEGATIVE_INFINITY;
    for (let i = firstResetAfter(sameWindow, entry.resetsAt - SAME_RESET_MS); i < sameWindow.length; i += 1) {
      const reading = sameWindow[i] as RecordedReading;
      if (reading.resetsAt - entry.resetsAt >= SAME_RESET_MS) break;
      actual = Math.max(actual, reading.used);
      lastAt = Math.max(lastAt, reading.t);
    }
    if (actual === Number.NEGATIVE_INFINITY) continue;
    if (actual < 100 && lastAt < entry.resetsAt - Math.min(0.15 * lengthMs, MAX_END_GAP_MS)) continue;
    const kind = windowKindFor(entry.label, lengthMs);
    if (kind !== "5h" && kind !== "7d") continue;
    const key = `${entry.provider}|${kind}`;
    const list = byTrack.get(key) ?? [];
    list.push({
      atMs: entry.t,
      closedMs: entry.resetsAt,
      windowStartMs: entry.windowStartMs,
      usedPercent: entry.used,
      growth: entry.growth,
      actual: Math.min(100, actual),
      source: "live",
    });
    byTrack.set(key, list);
  }
  return byTrack;
}

/** Index of the first reading whose reset is after `ms`, in a list sorted by reset. */
function firstResetAfter(sorted: readonly RecordedReading[], ms: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as RecordedReading).resetsAt <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

let scanCache: { at: number; scan: ForecastScan } | null = null;
let scanInflight: Promise<ForecastScan> | null = null;

async function forecastScan(nowMs: number): Promise<ForecastScan> {
  if (scanCache && nowMs - scanCache.at < SCAN_TTL_MS) return scanCache.scan;
  if (scanInflight) return scanInflight;
  scanInflight = readForecastScan(
    nowMs - HISTORY_DAYS * DAY_MS,
    FORECAST_BUCKET_MS,
    nowMs - READINGS_DAYS * DAY_MS,
    () => getPreferenceCached("usageForecast") === true,
  )
    .then((scan) => {
      scanCache = { at: Date.now(), scan };
      return scan;
    })
    .finally(() => {
      scanInflight = null;
    });
  return scanInflight;
}

function spendSeries(scan: ForecastScan, provider: ForecastProvider): BurnSeries {
  return trimLeadingIdle({
    startMs: scan.timeline.startMs,
    bucketMs: scan.timeline.bucketMs,
    values: scan.timeline.costUsd[provider],
  });
}

function codexReadings(scan: ForecastScan, windowMinutes: number): LimitReading[] {
  return scan.signals.codexSamples
    .filter((sample) => CODEX_GENERAL_LIMITS.has(sample.limitId) && sample.windowMinutes === windowMinutes)
    .map((sample) => ({ atMs: sample.atMs, usedPercent: sample.usedPercent, resetsAtMs: sample.resetsAtMs }));
}

function readingsStart(readings: readonly LimitReading[], nowMs: number): number {
  return readings.reduce((earliest, reading) => Math.min(earliest, reading.atMs), nowMs);
}

/** One limit-hit per window: several panes report the same moment. */
function claudeSessionHits(scan: ForecastScan): Array<{ atMs: number; resetsAtMs: number }> {
  const byReset = new Map<number, { atMs: number; resetsAtMs: number }>();
  for (const hit of scan.signals.claudeHits) {
    if (hit.kind !== "session" || hit.resetsAtMs === null) continue;
    const existing = byReset.get(hit.resetsAtMs);
    if (!existing || hit.atMs < existing.atMs) byReset.set(hit.resetsAtMs, { atMs: hit.atMs, resetsAtMs: hit.resetsAtMs });
  }
  return [...byReset.values()].sort((a, b) => a.atMs - b.atMs);
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface SpendCalibration {
  factors: number[];
  calibration: ForecastCalibration;
}

/**
 * Percent of this window per dollar of spend. The live read of this window
 * counts three times: it is the same account, today's models and today's
 * plan. Recorded readings of the same account follow. Limit-hit messages are
 * older and do not say which account ran out, so they only count when they
 * roughly agree with the account's own readings.
 */
function spendCalibration(options: {
  series: BurnSeries;
  profile: PiUsageProfile;
  window: PiUsageWindow;
  lengthMs: number;
  resetsAtMs: number;
  nowMs: number;
  recorded: readonly RecordedReading[];
  hits: ReadonlyArray<{ atMs: number; resetsAtMs: number }>;
}): SpendCalibration | null {
  const { series, profile, window, lengthMs, resetsAtMs, nowMs } = options;
  const minUnits = lengthMs <= 5 * HOUR_MS ? 15 : 60;
  const checkedAt = Date.parse(profile.checkedAt);
  const live: CalibrationAnchor = {
    windowStartMs: resetsAtMs - lengthMs,
    atMs: Number.isNaN(checkedAt) ? nowMs : checkedAt,
    usedPercent: window.usedPercent,
    source: "live",
  };
  const own = options.recorded
    .filter((reading) => reading.profileId === profile.profileId && reading.windowId === window.id)
    .map<CalibrationAnchor>((reading) => ({
      windowStartMs: reading.resetsAt - lengthMs,
      atMs: reading.t,
      usedPercent: reading.used,
      source: "recorded",
    }));
  const liveFactors = calibrationFactors(series, [live], minUnits);
  const ownFactors = calibrationFactors(series, thin(own, 60), minUnits);
  const trusted = [...liveFactors, ...liveFactors, ...liveFactors, ...ownFactors];
  const reference = trusted.length > 0 ? median(trusted) : null;
  let hitFactors: number[] = [];
  if (lengthMs === 5 * HOUR_MS) {
    const anchors = options.hits
      .filter((hit) => nowMs - hit.atMs < 35 * DAY_MS)
      .map<CalibrationAnchor>((hit) => ({
        windowStartMs: hit.resetsAtMs - lengthMs,
        atMs: hit.atMs,
        usedPercent: 100,
        source: "limit-hit",
      }));
    hitFactors = calibrationFactors(series, anchors, minUnits).filter(
      (factor) => reference === null || (factor >= reference / 2.5 && factor <= reference * 2.5),
    );
  }
  const factors = [...trusted, ...hitFactors];
  if (factors.length === 0) return null;
  const sorted = [...factors].sort((a, b) => a - b);
  const mid = median(factors);
  const parts: string[] = [];
  if (liveFactors.length > 0) parts.push("this window's live reading");
  if (ownFactors.length > 0) parts.push(`${ownFactors.length} recorded reading${ownFactors.length === 1 ? "" : "s"}`);
  if (hitFactors.length > 0) parts.push(`${hitFactors.length} past limit hit${hitFactors.length === 1 ? "" : "s"}`);
  return {
    factors,
    calibration: {
      method: "spend",
      anchors: factors.length,
      spread: mid > 0 ? [quantile(sorted, 0.1) / mid, quantile(sorted, 0.9) / mid] : [1, 1],
      note: `Spend from the transcripts, turned into percent with ${parts.join(", ")}. About $${(100 / mid).toFixed(0)} of API-priced use fills this window.`,
    },
  };
}

function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)] as T);
}

/* ── Report ──────────────────────────────────────────────────────────────── */

interface Track {
  history: BurnSeries;
  factors: number[];
  calibration: ForecastCalibration;
}

function windowView(options: {
  profile: PiUsageProfile;
  window: PiUsageWindow;
  provider: ForecastProvider;
  track: Track;
  lengthMs: number;
  resetsAtMs: number;
  nowMs: number;
  source: "live" | "cli";
  ideas: ForecastIdeas;
  activeSessions: number;
  learning: ForecastLearning | null;
}): WindowForecastView {
  const { profile, window, provider, track, lengthMs, resetsAtMs, nowMs } = options;
  const kind = windowKindFor(window.label, lengthMs);
  const learning = profile.isDefault ? options.learning : null;
  const result = forecastWindow({
    nowMs,
    windowStartMs: resetsAtMs - lengthMs,
    resetsAtMs,
    usedPercent: window.usedPercent,
    kind,
    history: track.history,
    percentPerUnit: track.factors,
    inUse: profile.isDefault,
    ...(learning ? { correction: learning.correction } : {}),
    // Keyed on the reset to 10 minutes, so a reset that drifts between reads
    // does not reshuffle the replays.
    seed: hashSeed(`${profile.profileId}|${window.id}|${Math.round(resetsAtMs / (10 * 60_000))}`),
  });
  return {
    key: `${profile.profileId}|${window.id}`,
    profileId: profile.profileId,
    provider,
    accountLabel: profile.label,
    active: profile.isDefault,
    windowId: window.id,
    windowLabel: window.label,
    source: options.source,
    calibration: track.calibration,
    learning,
    result,
    verdict: describeForecast(result, window.label),
    nudge: options.ideas.burnNudge ? burnNudge(result, options.activeSessions, window.label) : null,
    goAhead: options.ideas.goAhead ? goAheadNote(result, window.label) : null,
  };
}

/** Codex's own last reading, for a Codex account whose live read came back
 * without windows. */
function codexCliWindow(scan: ForecastScan, nowMs: number): { window: PiUsageWindow; atMs: number; lengthMs: number } | null {
  const candidates = [300, 10080]
    .map((minutes) => ({ minutes, groups: groupReadingsByWindow(codexReadings(scan, minutes)) }))
    .flatMap(({ minutes, groups }) => groups.map((group) => ({ minutes, group })))
    .filter(({ group }) => (group[0]?.resetsAtMs ?? 0) > nowMs);
  const latest = candidates
    .map(({ minutes, group }) => ({ minutes, last: group[group.length - 1] as LimitReading }))
    .sort((a, b) => b.last.atMs - a.last.atMs)[0];
  if (!latest) return null;
  const lengthMs = latest.minutes * 60_000;
  return {
    atMs: latest.last.atMs,
    lengthMs,
    window: {
      id: latest.minutes === 300 ? "primary" : "secondary",
      label: latest.minutes === 300 ? "5-hour" : "7-day",
      scope: { kind: "general" },
      usedPercent: latest.last.usedPercent,
      remainingPercent: 100 - latest.last.usedPercent,
      resetsAt: new Date(latest.last.resetsAtMs).toISOString(),
    },
  };
}

const MIN_LIVE_WINDOWS_FOR_SURE = 10;
let backtestCache: { at: number; key: string; result: Backtests } | null = null;

interface Backtests {
  tracks: BacktestTrack[];
  /** By `${provider}|${kind}`. */
  learning: Map<string, ForecastLearning>;
}

function recentLines(windows: readonly PastWindow[], history: BurnSeries, factors: number[], kind: "5h" | "7d", label: string) {
  return windows
    .filter((window) => window.endPercent >= 5)
    .slice(-4)
    .map((window) => {
      // Halfway through, or an hour before it ran out when that came first.
      const half = window.startMs + (window.resetsAtMs - window.startMs) / 2;
      const atMs =
        window.hitAtMs !== null && window.hitAtMs - HOUR_MS < half
          ? Math.max(window.startMs + 15 * 60_000, window.hitAtMs - HOUR_MS)
          : half;
      const truncated: BurnSeries = {
        ...history,
        values: history.values.slice(0, Math.max(0, Math.floor((atMs - history.startMs) / history.bucketMs))),
      };
      const result = forecastWindow({
        nowMs: atMs,
        windowStartMs: window.startMs,
        resetsAtMs: window.resetsAtMs,
        usedPercent: window.usedAt(atMs),
        kind,
        history: truncated,
        percentPerUnit: factors,
        inUse: true,
        paths: 200,
      });
      return {
        startMs: window.startMs,
        resetsAtMs: window.resetsAtMs,
        actual: Math.round(Math.min(100, window.endPercent)),
        hit: window.hitAtMs !== null,
        saidAtMs: atMs,
        saidAtHalf: describeForecast(result, label).headline,
        predictedAtHalf: Math.round(result.endPercent.p50),
      };
    });
}

/** Scores a track's past forecasts before and after learning, and fits the
 * correction the live forecast uses from all of them plus the live ones. */
export function learnTrack(
  base: Omit<BacktestTrack, "learned" | "byHistory" | "learning">,
  cases: Parameters<typeof learnedBacktest>[0],
  kind: "5h" | "7d",
  live: readonly LearningSample[],
  nowMs: number,
): BacktestTrack {
  const learned = learnedBacktest(cases, kind, live);
  const model = fitErrorModel([...samplesFromBacktest(cases), ...live], nowMs, kind);
  let learning = describeLearning(model, [...learned.cases].sort((a, b) => a.atMs - b.atMs));
  // A spend back-test scores spend scaled by today's factor, so it vouches
  // for the timing, not for the scale. Only live forecasts scored on real
  // readings check the scale; until there are enough, it is at most fairly sure.
  if (base.truth === "spend" && learning.confidence === "good" && model.liveWindows < MIN_LIVE_WINDOWS_FOR_SURE) {
    learning = { ...learning, confidence: "fair" };
  }
  return {
    ...base,
    learned: learned.summary,
    byHistory: learned.byHistory,
    learning,
  };
}

function backtests(
  scan: ForecastScan,
  claudeFactors: Partial<Record<"5h" | "7d", number>>,
  live: ReadonlyMap<string, LearningSample[]>,
  nowMs: number,
): Backtests {
  const claude = spendSeries(scan, "anthropic");
  const hits = claudeSessionHits(scan).map((hit) => hit.atMs);
  const claudeTracks = (
    [["5h", 5 * HOUR_MS, "5-hour"], ["7d", 7 * DAY_MS, "7-day"]] as const
  ).flatMap(([kind, lengthMs, label]) => {
    const factor = claudeFactors[kind];
    if (factor === undefined) return [];
    return [{ kind, label, factor, windows: pastWindowsFromSpend(claude, lengthMs, factor, nowMs, kind === "5h" ? hits : []) }];
  });
  const readings = codexReadings(scan, 10080);
  const codex =
    readings.length > 0
      ? {
          series: trimLeadingIdle(percentSeriesFromReadings(readings, readingsStart(readings, nowMs), nowMs)),
          windows: pastWindowsFromReadings(readings, 7 * DAY_MS, nowMs),
        }
      : null;
  // The live reading moves the factors a little on every poll; only a real
  // change of scale (10% steps), another closed window or a newly scored live
  // forecast is worth a new back-test before the TTL.
  const shape = (windows: readonly PastWindow[]) => [
    windows.length,
    windows[windows.length - 1]?.resetsAtMs ?? 0,
    Math.round(windows.reduce((sum, window) => sum + window.endPercent, 0)),
  ];
  const key = JSON.stringify({
    factors: claudeTracks.map((track) => [track.kind, Math.round(Math.log(track.factor) * 10)]),
    windows: [...claudeTracks.map((track) => shape(track.windows)), codex ? shape(codex.windows) : null],
    live: [...live.entries()].map(([track, samples]) => [
      track,
      samples.length,
      samples.reduce((latest, sample) => Math.max(latest, sample.closedMs), 0),
    ]),
  });
  if (backtestCache && backtestCache.key === key && nowMs - backtestCache.at < BACKTEST_TTL_MS) {
    return backtestCache.result;
  }
  const tracks: BacktestTrack[] = [];
  const learning = new Map<string, ForecastLearning>();
  for (const { kind, label, factor, windows } of claudeTracks) {
    const { cases, summary, scored } = backtestForecast({ windows, history: claude, percentPerUnit: [factor], kind, paths: 150 });
    if (summary.cases === 0) continue;
    const track = learnTrack(
      { provider: "anthropic", windowLabel: label, truth: "spend", summary, recent: recentLines(scored, claude, [factor], kind, label) },
      cases,
      kind,
      live.get(`anthropic|${kind}`) ?? [],
      nowMs,
    );
    tracks.push(track);
    learning.set(`anthropic|${kind}`, track.learning);
  }
  if (codex) {
    const { series, windows } = codex;
    const { cases, summary, scored } = backtestForecast({ windows, history: series, percentPerUnit: [1], kind: "7d", paths: 150 });
    if (summary.cases > 0) {
      const track = learnTrack(
        { provider: "openai-codex", windowLabel: "7-day", truth: "readings", summary, recent: recentLines(scored, series, [1], "7d", "7-day") },
        cases,
        "7d",
        live.get("openai-codex|7d") ?? [],
        nowMs,
      );
      tracks.push(track);
      learning.set("openai-codex|7d", track.learning);
    }
  }
  // A track with live forecasts but no replays (a window length the history
  // cannot rebuild) still learns from what it logged.
  for (const [trackKey, samples] of live) {
    if (learning.has(trackKey) || samples.length === 0) continue;
    const kind = trackKey.endsWith("|5h") ? "5h" : "7d";
    learning.set(trackKey, describeLearning(fitErrorModel(samples, nowMs, kind), []));
  }
  const result = { tracks, learning };
  backtestCache = { at: nowMs, key, result };
  return result;
}

let lastReport: UsageForecastReport | null = null;

export async function buildUsageForecastReport(
  overview: PiUsageOverview,
  ideasInput: unknown,
  nowMs = Date.now(),
): Promise<UsageForecastReport> {
  lastReport = await buildReport(overview, ideasInput, nowMs);
  return lastReport;
}

async function buildReport(
  overview: PiUsageOverview,
  ideasInput: unknown,
  nowMs: number,
): Promise<UsageForecastReport> {
  const ideas = normalizeForecastIdeas(ideasInput);
  const [scan, recorded, logged] = await Promise.all([
    forecastScan(nowMs),
    readRecordedReadings(nowMs - HISTORY_DAYS * DAY_MS),
    readLoggedForecasts(nowMs - HISTORY_DAYS * DAY_MS),
  ]);
  const claudeSpend = spendSeries(scan, "anthropic");
  const codexSpend = spendSeries(scan, "openai-codex");
  const hits = claudeSessionHits(scan);
  const plans: Array<Omit<Parameters<typeof windowView>[0], "learning"> & { kind: string }> = [];
  const notes: string[] = [];
  const claudeFactorByKind: Partial<Record<"5h" | "7d", number[]>> = {};

  for (const profile of overview.profiles ?? []) {
    if (profile.provider !== "anthropic" && profile.provider !== "openai-codex") continue;
    const provider: ForecastProvider = profile.provider;
    let windows = profile.status === "ok" ? profile.windows.filter(isGeneral) : [];
    let source: "live" | "cli" = "live";
    let liveProfile = profile;
    if (provider === "openai-codex" && windows.length === 0 && profile.status !== "not_connected") {
      const cli = codexCliWindow(scan, nowMs);
      if (cli) {
        windows = [cli.window];
        source = "cli";
        liveProfile = { ...profile, checkedAt: new Date(cli.atMs).toISOString() };
      }
    }
    for (const window of windows) {
      const lengthMs = windowLengthMs(window.label);
      const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      if (lengthMs === 0 || Number.isNaN(resetsAtMs) || resetsAtMs <= nowMs) continue;
      // A reset further out than a whole window is a bad reading.
      if (resetsAtMs > nowMs + lengthMs + HOUR_MS) continue;
      let track: Track | null = null;
      const readings = provider === "openai-codex" ? codexReadings(scan, lengthMs / 60_000) : [];
      if (!profile.isDefault) {
        // The transcripts do not say which account spent, so all spend is
        // the active account's; any other one only moves when switched to.
        track = {
          history: provider === "anthropic" ? claudeSpend : codexSpend,
          factors: [0],
          calibration: {
            method: "readings",
            anchors: 0,
            spread: [1, 1],
            note: "Not the active account, so it only grows if you switch to it.",
          },
        };
      } else if (readings.length >= 5) {
        track = {
          history: trimLeadingIdle(percentSeriesFromReadings(readings, readingsStart(readings, nowMs), nowMs)),
          factors: [1],
          calibration: {
            method: "readings",
            anchors: readings.length,
            spread: [1, 1],
            note: `Codex's own limit readings, ${readings.length} of them since ${new Date(readings[0]?.atMs ?? nowMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.`,
          },
        };
      } else {
        const series = provider === "anthropic" ? claudeSpend : codexSpend;
        const calibrated = spendCalibration({
          series,
          profile: liveProfile,
          window,
          lengthMs,
          resetsAtMs,
          nowMs,
          recorded,
          hits: provider === "anthropic" ? hits : [],
        });
        if (calibrated) track = { history: series, ...calibrated };
      }
      if (!track) {
        if (profile.isDefault) {
          notes.push(`${profile.label} ${window.label}: too little use in this window to learn its scale yet.`);
        }
        continue;
      }
      const kind = windowKindFor(window.label, lengthMs);
      if (provider === "anthropic" && profile.isDefault && (kind === "5h" || kind === "7d")) {
        claudeFactorByKind[kind] = track.factors;
      }
      plans.push({
        profile: liveProfile,
        window,
        provider,
        track,
        lengthMs,
        resetsAtMs,
        nowMs,
        source,
        ideas,
        activeSessions: scan.timeline.activeSessions[provider],
        kind,
      });
    }
  }

  const factor5 = claudeFactorByKind["5h"];
  const factor7 = claudeFactorByKind["7d"];
  const live = scoreLoggedForecasts(logged, recorded, nowMs);
  const learned = backtests(
    scan,
    {
      ...(factor5 ? { "5h": median(factor5) } : {}),
      ...(factor7 ? { "7d": median(factor7) } : {}),
    },
    live,
    nowMs,
  );
  const views = plans.map(({ kind, ...plan }) =>
    windowView({ ...plan, learning: learned.learning.get(`${plan.provider}|${kind}`) ?? null }),
  );
  await logForecasts(views, nowMs).catch(() => undefined);

  const nextAccount: Partial<Record<ForecastProvider, string>> = {};
  if (ideas.nextAccount) {
    for (const provider of ["anthropic", "openai-codex"] as const) {
      const byProfile = new Map<string, AccountOption>();
      for (const view of views.filter((entry) => entry.provider === provider)) {
        const end = view.result.inUse ? view.result.endPercent.p50 : view.result.usedPercent;
        const current = byProfile.get(view.profileId);
        if (!current || end > current.tightestEnd) {
          byProfile.set(view.profileId, {
            profileId: view.profileId,
            label: view.accountLabel,
            active: view.active,
            tightestEnd: end,
            tightestLabel: view.windowLabel,
            resetsAtMs: view.result.resetsAtMs,
          });
        }
      }
      const line = suggestNextAccount([...byProfile.values()], nowMs);
      if (line) nextAccount[provider] = line;
    }
  }

  const patterns: ForecastPattern[] = [];
  if (factor5) {
    patterns.push({ provider: "anthropic", windowLabel: "5-hour", ...weeklyPattern(claudeSpend, median(factor5), nowMs) });
  }
  const codexWeekly = codexReadings(scan, 10080);
  if (codexWeekly.length > 0) {
    const series = trimLeadingIdle(percentSeriesFromReadings(codexWeekly, readingsStart(codexWeekly, nowMs), nowMs));
    patterns.push({ provider: "openai-codex", windowLabel: "7-day", ...weeklyPattern(series, 1, nowMs) });
  }

  const claudeDays = Math.round((nowMs - claudeSpend.startMs) / DAY_MS);
  const sources = [
    `Claude Code and Cora transcripts: ${claudeDays} days of priced spend, read on this computer.`,
    `${hits.length} Claude "session limit" messages, each a moment a 5-hour window was full.`,
    `${codexWeekly.length} Codex limit readings from its own session files, archived ones included.`,
    recorded.length > 0
      ? `${recorded.length} live readings recorded by Studio since the forecast was turned on.`
      : "No recorded readings yet: Studio starts recording when the forecast is on.",
    `${logged.length} of its own live forecasts logged, ${[...live.values()].reduce((sum, list) => sum + list.length, 0)} of them already scored against how the window really ended.`,
  ];

  return {
    generatedAt: nowMs,
    windows: views,
    nextAccount,
    activeSessions: scan.timeline.activeSessions,
    patterns,
    backtest: learned.tracks,
    sources,
    notes,
  };
}

/** The forecast lines Cora reads before it plans workers, active accounts only. */
export function coraForecastLines(report: UsageForecastReport): string[] {
  return report.windows
    .filter((view) => view.active)
    .map((view) => coraForecastHint(view.result, view.accountLabel, view.windowLabel));
}

const CORA_HINT_MAX_AGE_MS = 30 * 60_000;

/**
 * The prompt section for Cora's manager turn, from the last report the panel
 * or the Usage tab built: a manager turn never waits on a transcript scan.
 * Null unless the forecast and its Cora idea are both on.
 */
export function readCoraForecastHint(nowMs = Date.now()): string | null {
  if (getPreferenceCached("usageForecast") !== true) return null;
  if (!normalizeForecastIdeas(getPreferenceCached("usageForecastIdeas")).coraHint) return null;
  if (!lastReport || nowMs - lastReport.generatedAt > CORA_HINT_MAX_AGE_MS) return null;
  const lines = coraForecastLines(lastReport);
  if (lines.length === 0) return null;
  return [
    "Usage forecast (from the user's own history, at the current pace):",
    ...lines.map((line) => `- ${line}`),
    "Before dispatching several workers on an account that runs out early, dispatch fewer or use another account.",
  ].join("\n");
}
