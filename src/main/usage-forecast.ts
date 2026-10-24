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
//     from it while the preference is on (usage-history.jsonl).
//
// Nothing here sends anything anywhere. With the preference off it is never
// loaded: the IPC handler and the recorder both check the preference first.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { codaraHome } from "./codara-home";
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 56;
const SCAN_TTL_MS = 3 * 60 * 1000;
const BACKTEST_TTL_MS = 60 * 60 * 1000;
const HISTORY_FILE = "usage-history.jsonl";
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
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

/** Appends this read's windows to usage-history.jsonl. Called only while the
 * usageForecast preference is on. */
export async function recordUsageReadings(overview: PiUsageOverview, nowMs = Date.now()): Promise<void> {
  const lines: string[] = [];
  for (const profile of overview.profiles ?? []) {
    if (profile.status !== "ok") continue;
    const at = Date.parse(profile.checkedAt);
    const t = Number.isNaN(at) ? nowMs : at;
    for (const window of profile.windows) {
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      if (Number.isNaN(resetsAt)) continue;
      const key = `${profile.profileId}|${window.id}`;
      const previous = lastRecorded.get(key);
      if (
        previous &&
        previous.used === window.usedPercent &&
        Math.abs(previous.resetsAt - resetsAt) < 5 * 60_000 &&
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
  if (lines.length === 0) return;
  const path = historyPath();
  await fs.appendFile(path, `${lines.join("\n")}\n`, "utf8");
  const stats = await fs.stat(path).catch(() => null);
  if (stats && stats.size > HISTORY_MAX_BYTES) {
    const raw = await fs.readFile(path, "utf8");
    const kept = raw.split("\n").filter(Boolean);
    await fs.writeFile(path, `${kept.slice(Math.floor(kept.length / 2)).join("\n")}\n`, "utf8");
  }
}

export async function readRecordedReadings(sinceMs: number): Promise<RecordedReading[]> {
  let raw: string;
  try {
    raw = await fs.readFile(historyPath(), "utf8");
  } catch {
    return [];
  }
  const readings: RecordedReading[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const reading = JSON.parse(line) as RecordedReading;
      if (typeof reading.t === "number" && reading.t >= sinceMs && typeof reading.used === "number") {
        readings.push(reading);
      }
    } catch {
      // A torn last line from a crash; the next append starts a fresh one.
    }
  }
  return readings;
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

let scanCache: { at: number; scan: ForecastScan } | null = null;
let scanInflight: Promise<ForecastScan> | null = null;

async function forecastScan(nowMs: number): Promise<ForecastScan> {
  if (scanCache && nowMs - scanCache.at < SCAN_TTL_MS) return scanCache.scan;
  if (scanInflight) return scanInflight;
  scanInflight = readForecastScan(nowMs - HISTORY_DAYS * DAY_MS, FORECAST_BUCKET_MS)
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
    .filter((reading) => reading.profileId === profile.profileId && windowLengthMs(reading.label) === lengthMs)
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
}): WindowForecastView {
  const { profile, window, provider, track, lengthMs, resetsAtMs, nowMs } = options;
  const kind = windowKindFor(window.label, lengthMs);
  const result = forecastWindow({
    nowMs,
    windowStartMs: resetsAtMs - lengthMs,
    resetsAtMs,
    usedPercent: window.usedPercent,
    kind,
    history: track.history,
    percentPerUnit: track.factors,
    inUse: profile.isDefault,
    seed: hashSeed(`${profile.profileId}|${window.id}|${resetsAtMs}`),
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

let backtestCache: { at: number; key: string; tracks: BacktestTrack[] } | null = null;

function recentLines(windows: readonly PastWindow[], history: BurnSeries, factors: number[], kind: "5h" | "7d", label: string) {
  return windows
    .filter((window) => window.endPercent >= 5)
    .slice(-4)
    .map((window) => {
      const atMs = window.startMs + (window.resetsAtMs - window.startMs) / 2;
      const truncated: BurnSeries = {
        ...history,
        values: history.values.slice(0, Math.max(0, Math.floor((atMs - history.startMs) / history.bucketMs))),
      };
      const result = forecastWindow({
        nowMs: atMs,
        windowStartMs: window.startMs,
        resetsAtMs: window.resetsAtMs,
        usedPercent: window.hitAtMs !== null && window.hitAtMs <= atMs ? 100 : window.usedAt(atMs),
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
        saidAtHalf: describeForecast(result, label).headline,
        predictedAtHalf: Math.round(result.endPercent.p50),
      };
    });
}

function backtests(
  scan: ForecastScan,
  claudeFactors: Partial<Record<"5h" | "7d", number>>,
  nowMs: number,
): BacktestTrack[] {
  const key = JSON.stringify(claudeFactors);
  if (backtestCache && backtestCache.key === key && nowMs - backtestCache.at < BACKTEST_TTL_MS) {
    return backtestCache.tracks;
  }
  const tracks: BacktestTrack[] = [];
  const claude = spendSeries(scan, "anthropic");
  const hits = claudeSessionHits(scan).map((hit) => hit.atMs);
  for (const [kind, lengthMs, label] of [["5h", 5 * HOUR_MS, "5-hour"], ["7d", 7 * DAY_MS, "7-day"]] as const) {
    const factor = claudeFactors[kind];
    if (factor === undefined) continue;
    const windows = pastWindowsFromSpend(claude, lengthMs, factor, nowMs, kind === "5h" ? hits : []);
    const { summary, scored } = backtestForecast({ windows, history: claude, percentPerUnit: [factor], kind, paths: 150 });
    if (summary.cases === 0) continue;
    tracks.push({
      provider: "anthropic",
      windowLabel: label,
      truth: "spend",
      summary,
      recent: recentLines(scored, claude, [factor], kind, label),
    });
  }
  const readings = codexReadings(scan, 10080);
  if (readings.length > 0) {
    const series = trimLeadingIdle(percentSeriesFromReadings(readings, scan.timeline.startMs, nowMs));
    const windows = pastWindowsFromReadings(readings, 7 * DAY_MS, nowMs);
    const { summary, scored } = backtestForecast({ windows, history: series, percentPerUnit: [1], kind: "7d", paths: 150 });
    if (summary.cases > 0) {
      tracks.push({
        provider: "openai-codex",
        windowLabel: "7-day",
        truth: "readings",
        summary,
        recent: recentLines(scored, series, [1], "7d", "7-day"),
      });
    }
  }
  backtestCache = { at: nowMs, key, tracks };
  return tracks;
}

export async function buildUsageForecastReport(
  overview: PiUsageOverview,
  ideasInput: unknown,
  nowMs = Date.now(),
): Promise<UsageForecastReport> {
  const ideas = normalizeForecastIdeas(ideasInput);
  const [scan, recorded] = await Promise.all([forecastScan(nowMs), readRecordedReadings(nowMs - HISTORY_DAYS * DAY_MS)]);
  const claudeSpend = spendSeries(scan, "anthropic");
  const codexSpend = spendSeries(scan, "openai-codex");
  const hits = claudeSessionHits(scan);
  const views: WindowForecastView[] = [];
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
      let track: Track | null = null;
      const readings = provider === "openai-codex" ? codexReadings(scan, lengthMs / 60_000) : [];
      if (readings.length >= 5) {
        track = {
          history: trimLeadingIdle(percentSeriesFromReadings(readings, scan.timeline.startMs, nowMs)),
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
      views.push(
        windowView({
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
        }),
      );
    }
  }

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

  const factor5 = claudeFactorByKind["5h"];
  const factor7 = claudeFactorByKind["7d"];
  const patterns: ForecastPattern[] = [];
  if (factor5) {
    patterns.push({ provider: "anthropic", windowLabel: "5-hour", ...weeklyPattern(claudeSpend, median(factor5), nowMs) });
  }
  const codexWeekly = codexReadings(scan, 10080);
  if (codexWeekly.length > 0) {
    const series = trimLeadingIdle(percentSeriesFromReadings(codexWeekly, scan.timeline.startMs, nowMs));
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
  ];

  return {
    generatedAt: nowMs,
    windows: views,
    nextAccount,
    activeSessions: scan.timeline.activeSessions,
    patterns,
    backtest: backtests(
      scan,
      {
        ...(factor5 ? { "5h": median(factor5) } : {}),
        ...(factor7 ? { "7d": median(factor7) } : {}),
      },
      nowMs,
    ),
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
