// Usage forecast: will this limit window run out before it resets?
//
// The model is deliberately small enough to explain in one sentence: replay
// how you used this subscription on past days at the same time of day, blend
// in your pace over the last hour (which fades out over the next hour or
// two), and add the result to what the window already used. Several hundred
// replays give the cone; the share of replays that reach 100% before the
// reset is the chance of running out.
//
// Everything here is pure and clock-free (callers pass nowMs) so the main
// process, the renderer and the test harness share one implementation. Time
// of day is read in the process's local time zone, which is the user's.

import type { ForecastLearning, LearnedBacktest } from "./usage-forecast-learning";

export const FORECAST_BUCKET_MS = 15 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ForecastWindowKind = "5h" | "7d" | "other";

/** Burn history in some unit, one value per bucket, oldest first. */
export interface BurnSeries {
  startMs: number;
  bucketMs: number;
  values: number[];
}

export interface ForecastInput {
  nowMs: number;
  windowStartMs: number;
  resetsAtMs: number;
  /** What the provider reports used now, 0 to 100. */
  usedPercent: number;
  kind: ForecastWindowKind;
  /** Burn per bucket, in the same unit as `percentPerUnit` converts. */
  history: BurnSeries;
  /**
   * Percent of this window one unit of history costs. One value when the
   * history is already in percent; several when the conversion is estimated
   * (spend to percent), and their spread widens the cone.
   */
  percentPerUnit: number[];
  /** False for an account that is not the one in use: its window only grows
   * when someone switches to it, so it is forecast flat. */
  inUse: boolean;
  /** What the forecast learned from its own past errors on this kind of
   * window (usage-forecast-learning.ts). Absent: the replays as they come. */
  correction?: ForecastCorrection;
  paths?: number;
  seed?: number;
}

/**
 * A correction learned from past forecasts and what really happened. Each
 * replay's growth from now to the reset becomes
 * growthBias * (median + spread * (growth - median)): the bias moves the
 * whole forecast up or down, the spread widens or narrows the band.
 */
export interface ForecastCorrection {
  growthBias: number;
  spread: number;
}

/** Quantile levels kept of the uncorrected growth, so a correction can be
 * applied to a forecast after the fact (the back-test does). */
export const GROWTH_LEVELS = 20;

export interface ConePoint {
  ms: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface ForecastResult {
  nowMs: number;
  windowStartMs: number;
  resetsAtMs: number;
  usedPercent: number;
  kind: ForecastWindowKind;
  /** Used so far, from the window start to now, ending at usedPercent. */
  observed: Array<[number, number]>;
  cone: ConePoint[];
  endPercent: { p10: number; p50: number; p90: number };
  /** Share of replays that reach 100% before the reset. */
  hitProbability: number;
  /** Uncorrected growth from now to the reset, uncapped, at quantile levels
   * 0, 1/GROWTH_LEVELS, ..., 1. */
  growthQuantiles: number[];
  /** When the limit is reached, as quantiles over every replay; null where a
   * quantile falls among the replays that never reach it. */
  hitAt: { p10: number | null; p50: number | null; p90: number | null };
  pace: {
    /** Percent per hour over the recent span. */
    recentPerHour: number;
    /** Typical percent per hour at this time of day on similar days. */
    usualPerHour: number;
    /** recent / usual, or null when there is no usual to compare with. */
    ratio: number | null;
  };
  /** Past days the replays drew from. */
  analogDays: number;
  /** How much heavier (above 1) or lighter this window runs than the usual
   * day, applied to the replays. 1 for short windows. */
  level: number;
  inUse: boolean;
}

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** Deterministic PRNG (mulberry32), so a forecast does not flicker between reads. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return lo === hi ? a : pos - lo < 0.5 ? a : b;
  return a + (b - a) * (pos - lo);
}

export function median(values: readonly number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function windowKindFor(label: string, lengthMs?: number): ForecastWindowKind {
  const ms = lengthMs ?? windowLengthMs(label);
  if (ms === 5 * HOUR_MS) return "5h";
  if (ms === 7 * DAY_MS) return "7d";
  return "other";
}

const LENGTH = /(\d+)-(minute|hour|day)\b/;

/** "5-hour" -> 5h in ms, "Opus 7-day" -> 7d; 0 when the label names no length. */
export function windowLengthMs(label: string): number {
  const match = LENGTH.exec(label);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] === "minute" ? 60_000 : match[2] === "hour" ? HOUR_MS : DAY_MS;
  return amount * unit;
}

function bucketIndex(series: BurnSeries, ms: number): number {
  return Math.floor((ms - series.startMs) / series.bucketMs);
}

function valueAt(series: BurnSeries, ms: number): number | null {
  const index = bucketIndex(series, ms);
  if (index < 0 || index >= series.values.length) return null;
  return series.values[index] as number;
}

/** Sum of the series over [fromMs, toMs), counting a partial bucket pro rata. */
export function sumBetween(series: BurnSeries, fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let total = 0;
  const first = Math.max(0, bucketIndex(series, fromMs));
  const last = Math.min(series.values.length - 1, bucketIndex(series, toMs - 1));
  for (let i = first; i <= last; i += 1) {
    const bucketStart = series.startMs + i * series.bucketMs;
    const overlap =
      Math.min(toMs, bucketStart + series.bucketMs) - Math.max(fromMs, bucketStart);
    if (overlap > 0) total += (series.values[i] as number) * (overlap / series.bucketMs);
  }
  return total;
}

function localDayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isWeekend(ms: number): boolean {
  const day = new Date(ms).getDay();
  return day === 0 || day === 6;
}

/* ── Analog days ─────────────────────────────────────────────────────────── */

interface AnalogDay {
  dayStartMs: number;
  weight: number;
}

/**
 * Past days a replay can borrow from for a future day: fully observed days
 * before today, the same weekday counted twice and the same kind of day
 * (weekday or weekend) once, recent weeks weighing more. When the history is
 * too short for that, any past day will do.
 */
function analogDaysFor(
  history: BurnSeries,
  targetDayMs: number,
  todayStartMs: number,
  nowMs: number,
  longWindow: boolean,
): AnalogDay[] {
  const target = new Date(targetDayMs);
  const weekend = isWeekend(targetDayMs);
  const days: AnalogDay[] = [];
  const any: AnalogDay[] = [];
  const recentBurn = sumBetween(history, nowMs - REGIME_MS, nowMs);
  const scale = Math.max(1e-9, sumBetween(history, history.startMs, nowMs) / Math.max(1, nowMs - history.startMs)) * REGIME_MS;
  for (let back = 1; back <= 70; back += 1) {
    const date = new Date(todayStartMs);
    date.setDate(date.getDate() - back);
    const start = date.getTime();
    if (start < history.startMs) break;
    const recency = Math.pow(0.85, back / 7);
    // Days that followed a stretch like the last three days weigh more: a
    // heavy week stays heavy and a quiet one stays quiet.
    const before = start + (nowMs - todayStartMs);
    const theirBurn = sumBetween(history, before - REGIME_MS, before);
    const gap = Math.abs(Math.log((theirBurn + 0.1 * scale) / (recentBurn + 0.1 * scale)));
    const regime = longWindow ? Math.exp(-gap / 0.6) : 1;
    any.push({ dayStartMs: start, weight: recency * regime });
    if (isWeekend(start) !== weekend) continue;
    const sameWeekday = date.getDay() === target.getDay();
    days.push({ dayStartMs: start, weight: recency * regime * (sameWeekday ? 2 : 1) });
  }
  return days.length >= 3 ? days : any;
}

const REGIME_MS = 3 * DAY_MS;
/** No window is longer than a week; a reset further out is a bad reading and
 * must not turn into an unbounded number of steps. */
const MAX_HORIZON_MS = 8 * DAY_MS;

function pickWeighted(days: readonly AnalogDay[], random: () => number): AnalogDay | null {
  if (days.length === 0) return null;
  let total = 0;
  for (const day of days) total += day.weight;
  let roll = random() * total;
  for (const day of days) {
    roll -= day.weight;
    if (roll <= 0) return day;
  }
  return days[days.length - 1] ?? null;
}

/* ── Forecast ────────────────────────────────────────────────────────────── */

/** How long the recent pace is measured over, and how fast it fades. */
function paceSpan(kind: ForecastWindowKind): { recentMs: number; fadeMs: number } {
  return kind === "5h"
    ? { recentMs: HOUR_MS, fadeMs: HOUR_MS }
    : { recentMs: 3 * HOUR_MS, fadeMs: 2 * HOUR_MS };
}

/** Typical burn per hour at this time of day on similar past days, in units. */
function usualRate(history: BurnSeries, nowMs: number, spanMs: number): { rate: number; days: number } {
  const today = localDayStart(nowMs);
  const analogs = analogDaysFor(history, today, today, nowMs, false);
  if (analogs.length === 0) return { rate: 0, days: 0 };
  const offset = nowMs - today;
  let weighted = 0;
  let weights = 0;
  for (const day of analogs) {
    const end = day.dayStartMs + offset;
    weighted += day.weight * sumBetween(history, end - spanMs, end);
    weights += day.weight;
  }
  return { rate: weights > 0 ? weighted / weights / (spanMs / HOUR_MS) : 0, days: analogs.length };
}

export function forecastWindow(input: ForecastInput): ForecastResult {
  const { nowMs, windowStartMs, resetsAtMs, history, kind } = input;
  const bucketMs = FORECAST_BUCKET_MS;
  const used = clamp(input.usedPercent, 0, 100);
  const factors = input.percentPerUnit.filter((value) => Number.isFinite(value) && value >= 0);
  const factorMid = factors.length > 0 ? median(factors) : 0;
  // An account not in use does not grow, so every replay would be the same.
  const pathCount = input.inUse ? (input.paths ?? 400) : 1;
  const random = seededRandom(input.seed ?? Math.floor(windowStartMs / 60_000));
  const { recentMs, fadeMs } = paceSpan(kind);

  const recentUnitsPerHour = sumBetween(history, nowMs - recentMs, nowMs) / (recentMs / HOUR_MS);
  const usual = usualRate(history, nowMs, recentMs);
  const level = windowLevel(history, windowStartMs, nowMs, kind);
  const windowUnitsPerHour =
    nowMs > windowStartMs
      ? sumBetween(history, windowStartMs, nowMs) / ((nowMs - windowStartMs) / HOUR_MS)
      : 0;
  const recentPerHour = recentUnitsPerHour * factorMid;
  const usualPerHour = usual.rate * factorMid;

  const steps: number[] = [];
  const lastStepMs = Math.min(resetsAtMs, nowMs + MAX_HORIZON_MS);
  for (let t = nowMs + bucketMs; t < lastStepMs; t += bucketMs) steps.push(t);
  steps.push(resetsAtMs);

  const todayStart = localDayStart(nowMs);
  const dayAnalogs = new Map<number, AnalogDay[]>();
  const analogsFor = (ms: number): AnalogDay[] => {
    const day = localDayStart(ms);
    let found = dayAnalogs.get(day);
    if (!found) {
      found = analogDaysFor(history, day, todayStart, nowMs, kind !== "5h");
      dayAnalogs.set(day, found);
    }
    return found;
  };

  // Growth since now, uncapped, per step and replay: the cap at 100 and the
  // learned correction are applied after, so neither distorts the other.
  const growth: number[][] = steps.map(() => new Array<number>(pathCount));

  for (let p = 0; p < pathCount; p += 1) {
    const factor =
      factors.length === 0 ? 0 : (factors[Math.floor(random() * factors.length)] as number);
    // How much of the recent pace carries on is the least certain part, so
    // each replay keeps its own multiple of it (log-normal, median 1).
    const persistence = Math.exp(0.6 * gaussian(random));
    const chosenDay = new Map<number, AnalogDay | null>();
    let grown = 0;
    let previous = nowMs;
    for (let s = 0; s < steps.length; s += 1) {
      const t = steps[s] as number;
      const span = t - previous;
      let units = 0;
      if (input.inUse && span > 0) {
        const day = localDayStart(previous);
        if (!chosenDay.has(day)) chosenDay.set(day, pickWeighted(analogsFor(previous), random));
        const analog = chosenDay.get(day) ?? null;
        let replay = 0;
        if (analog) {
          const sameTime = analog.dayStartMs + (previous - day);
          replay = (valueAt(history, sameTime) ?? 0) * (span / history.bucketMs);
        }
        const weight = Math.exp(-(previous - nowMs) / fadeMs);
        const paced = recentUnitsPerHour * persistence * (span / HOUR_MS);
        // A long window also keeps its own pace so far: half the replay,
        // half the window's average rate, each scaled by this replay's
        // persistence so the two do not cancel out the spread.
        const own = windowUnitsPerHour * (span / HOUR_MS) * persistence;
        const pattern = kind === "5h" ? replay : 0.5 * replay * level + 0.5 * own;
        units = weight * paced + (1 - weight) * pattern;
      }
      grown += units * factor;
      (growth[s] as number[])[p] = grown;
      previous = t;
    }
  }

  const rawEnds = pathCount > 0 && steps.length > 0 ? (growth[steps.length - 1] as number[]).slice() : [];
  const sortedRaw = rawEnds.slice().sort((a, b) => a - b);
  const growthQuantiles = Array.from({ length: GROWTH_LEVELS + 1 }, (_, k) =>
    sortedRaw.length > 0 ? quantile(sortedRaw, k / GROWTH_LEVELS) : 0,
  );

  const correction = input.correction;
  const middle = sortedRaw.length > 0 ? quantile(sortedRaw, 0.5) : 0;
  const scale: number[] = new Array<number>(pathCount).fill(1);
  const linear: number[] = new Array<number>(pathCount).fill(0);
  if (correction) {
    for (let p = 0; p < pathCount; p += 1) {
      const raw = rawEnds[p] as number;
      const corrected = Math.max(0, correction.growthBias * (middle + correction.spread * (raw - middle)));
      // A replay that grew nothing has no shape to scale; a corrected one
      // that should grow does so evenly up to the reset.
      if (raw > 1e-9) scale[p] = corrected / raw;
      else {
        scale[p] = 0;
        linear[p] = corrected;
      }
    }
  }
  const untilReset = Math.max(1, resetsAtMs - nowMs);
  const columns: number[][] = steps.map(() => new Array<number>(pathCount));
  const hits: number[] = new Array<number>(pathCount);
  const ends: number[] = new Array<number>(pathCount);
  for (let p = 0; p < pathCount; p += 1) {
    let before = used;
    let previous = nowMs;
    let hitAt = used >= 100 ? nowMs : Number.POSITIVE_INFINITY;
    for (let s = 0; s < steps.length; s += 1) {
      const t = steps[s] as number;
      const raw = (growth[s] as number[])[p] as number;
      const value = Math.min(100, used + raw * (scale[p] as number) + (linear[p] as number) * ((t - nowMs) / untilReset));
      if (value >= 100 && before < 100 && hitAt === Number.POSITIVE_INFINITY) {
        const added = value - before;
        const share = added > 0 ? (100 - before) / added : 1;
        hitAt = previous + (t - previous) * clamp(share, 0, 1);
      }
      (columns[s] as number[])[p] = value;
      before = value;
      previous = t;
    }
    hits[p] = hitAt;
    ends[p] = before;
  }

  const cone: ConePoint[] = [{ ms: nowMs, p10: used, p50: used, p90: used }];
  // Sorting every replay at every step is most of a week's cost; hourly is
  // still finer than the chart draws it.
  const coneEvery = kind === "5h" ? 1 : 4;
  steps.forEach((ms, s) => {
    if (s % coneEvery !== coneEvery - 1 && s !== steps.length - 1) return;
    const sorted = (columns[s] as number[]).slice().sort((a, b) => a - b);
    cone.push({
      ms,
      p10: quantile(sorted, 0.1),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
    });
  });

  const sortedEnds = ends.slice().sort((a, b) => a - b);
  const sortedHits = hits.slice().sort((a, b) => a - b);
  const hitCount = hits.filter((ms) => Number.isFinite(ms)).length;
  const hitQuantile = (q: number): number | null => {
    const value = sortedHits[Math.round((sortedHits.length - 1) * q)];
    return value !== undefined && Number.isFinite(value) ? value : null;
  };

  return {
    nowMs,
    windowStartMs,
    resetsAtMs,
    usedPercent: used,
    kind,
    observed: observedCurve(input, factorMid),
    cone,
    endPercent: {
      p10: quantile(sortedEnds, 0.1),
      p50: quantile(sortedEnds, 0.5),
      p90: quantile(sortedEnds, 0.9),
    },
    hitProbability: pathCount > 0 ? hitCount / pathCount : 0,
    growthQuantiles,
    // The early quantile of the hit time is the pessimistic one.
    hitAt: { p10: hitQuantile(0.1), p50: hitQuantile(0.5), p90: hitQuantile(0.9) },
    pace: {
      recentPerHour,
      usualPerHour,
      ratio: usualPerHour > 0.01 ? recentPerHour / usualPerHour : null,
    },
    analogDays: usual.days,
    level,
    inUse: input.inUse,
  };
}

/**
 * A long window has a regime: a heavy week stays heavy. Compare what this
 * window burned so far with the average burn over the same length of time in
 * the four weeks before it, and trust that ratio more as the window ages.
 */
function windowLevel(history: BurnSeries, windowStartMs: number, nowMs: number, kind: ForecastWindowKind): number {
  if (kind === "5h") return 1;
  const elapsed = nowMs - windowStartMs;
  if (elapsed < 6 * HOUR_MS) return 1;
  const lookbackStart = Math.max(history.startMs, windowStartMs - 28 * DAY_MS);
  const lookback = windowStartMs - lookbackStart;
  if (lookback < 3 * DAY_MS) return 1;
  const usualPerMs = sumBetween(history, lookbackStart, windowStartMs) / lookback;
  if (!(usualPerMs > 0)) return 1;
  const ratio = sumBetween(history, windowStartMs, nowMs) / (usualPerMs * elapsed);
  const trust = Math.min(1, elapsed / (2 * DAY_MS));
  return clamp(1 + (ratio - 1) * trust, 0.25, 4);
}

/** The series from the day of its first burn: days before any record are
 * missing history, not idle days, and must not be replayed as zero. */
export function trimLeadingIdle(series: BurnSeries): BurnSeries {
  const first = series.values.findIndex((value) => value > 0);
  if (first <= 0) return series;
  const firstMs = series.startMs + first * series.bucketMs;
  const dayStart = Math.max(series.startMs, localDayStart(firstMs));
  const skip = Math.floor((dayStart - series.startMs) / series.bucketMs);
  return { startMs: series.startMs + skip * series.bucketMs, bucketMs: series.bucketMs, values: series.values.slice(skip) };
}

/** Box-Muller, one standard normal draw. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * The window's curve so far. Its shape comes from the history, its height
 * from the provider's own figure: the curve is scaled to end at usedPercent,
 * so an estimated conversion never shows a number the provider did not say.
 */
function observedCurve(input: ForecastInput, factor: number): Array<[number, number]> {
  const { history, windowStartMs, nowMs } = input;
  const used = clamp(input.usedPercent, 0, 100);
  const points: Array<[number, number]> = [[windowStartMs, 0]];
  const step = input.kind === "5h" ? FORECAST_BUCKET_MS : HOUR_MS;
  let raw = 0;
  const raws: Array<[number, number]> = [];
  for (let t = windowStartMs; t < nowMs; t += step) {
    raw += sumBetween(history, t, Math.min(nowMs, t + step)) * factor;
    raws.push([Math.min(nowMs, t + step), raw]);
  }
  const scale = raw > 0 ? used / raw : 0;
  for (const [ms, value] of raws) points.push([ms, raw > 0 ? value * scale : used * ((ms - windowStartMs) / Math.max(1, nowMs - windowStartMs))]);
  if (points[points.length - 1]?.[0] !== nowMs) points.push([nowMs, used]);
  return points;
}

/* ── Calibration ─────────────────────────────────────────────────────────── */

export interface CalibrationAnchor {
  /** The window the reading belongs to. */
  windowStartMs: number;
  atMs: number;
  usedPercent: number;
  source: "limit-hit" | "live" | "recorded";
}

/**
 * Percent of a window per unit of spend, one estimate per anchor: what the
 * provider said the window used, divided by the spend the history shows in
 * that window up to the same moment. Anchors with almost no spend behind them
 * say little about the ratio and are skipped.
 */
export function calibrationFactors(
  history: BurnSeries,
  anchors: readonly CalibrationAnchor[],
  minUnits: number,
): number[] {
  const factors: number[] = [];
  for (const anchor of anchors) {
    if (anchor.usedPercent < 3) continue;
    const units = sumBetween(history, anchor.windowStartMs, anchor.atMs);
    if (units < minUnits) continue;
    factors.push(anchor.usedPercent / units);
  }
  return factors;
}

/* ── Words ───────────────────────────────────────────────────────────────── */

export type ForecastTone = "danger" | "warn" | "ok" | "calm";

export interface ForecastVerdict {
  tone: ForecastTone;
  headline: string;
  detail: string;
}

export function formatClock(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (localDayStart(ms) === localDayStart(nowMs)) return time;
  const tomorrow = new Date(localDayStart(nowMs));
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (localDayStart(ms) === tomorrow.getTime()) return `tomorrow ${time}`;
  return `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

function windowName(label: string): string {
  return `${label} limit`;
}

function paceWords(result: ForecastResult): string | null {
  const ratio = result.pace.ratio;
  if (ratio === null || result.pace.recentPerHour < 0.5) return null;
  if (ratio >= 1.5) return `You are using ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, "")}× your usual pace for this time of day.`;
  if (ratio <= 0.6) return "You are going slower than usual for this time of day.";
  return "Your pace is about usual for this time of day.";
}

/** One headline and one supporting line, plain words, for the panel and chart. */
export function describeForecast(result: ForecastResult, label: string): ForecastVerdict {
  const { nowMs, resetsAtMs } = result;
  const reset = formatClock(resetsAtMs, nowMs);
  const name = windowName(label);
  if (result.usedPercent >= 100) {
    return {
      tone: "danger",
      headline: `The ${name} is used up.`,
      detail: `It resets at ${reset}, in ${formatSpan(resetsAtMs - nowMs)}.`,
    };
  }
  if (!result.inUse) {
    return {
      tone: "calm",
      headline: `Not in use: stays at ${Math.round(result.usedPercent)}% until it resets.`,
      detail: `Resets at ${reset}. Switch to it to spread the load.`,
    };
  }
  const pace = paceWords(result);
  const hit = result.hitAt.p50;
  if (result.hitProbability >= 0.5 && hit !== null) {
    const early = result.hitAt.p10;
    const late = result.hitAt.p90;
    const range =
      early !== null && late !== null && late - early >= 10 * 60_000
        ? ` Likely between ${formatClock(early, nowMs)} and ${formatClock(late, nowMs)}.`
        : "";
    return {
      tone: "danger",
      headline: `At this pace you hit the ${name} at ${formatClock(hit, nowMs)}, ${formatSpan(resetsAtMs - hit)} before it resets.`,
      detail: `${pace ? `${pace} ` : ""}${range.trim()}`.trim(),
    };
  }
  if (result.hitProbability >= 0.2) {
    const odds = Math.round(result.hitProbability * 10);
    return {
      tone: "warn",
      headline: `You may run out before the reset at ${reset} (about ${odds} in 10).`,
      detail: `${pace ? `${pace} ` : ""}Most likely you end near ${Math.round(result.endPercent.p50)}%.`,
    };
  }
  const end = Math.round(result.endPercent.p50);
  const low = Math.round(result.endPercent.p10);
  const high = Math.round(result.endPercent.p90);
  const room = end <= 70 ? " Room to spare." : "";
  return {
    tone: end <= 70 ? "calm" : "ok",
    headline: `You'll end this window at about ${end}%.${room}`,
    detail: `Likely ${low === high ? `${low}%` : `${low} to ${high}%`} when it resets at ${reset}.${pace ? ` ${pace}` : ""}`,
  };
}

/* ── Ideas (each behind its own toggle) ──────────────────────────────────── */

export interface ForecastIdeas {
  /** Warn when several agents drain the window faster than usual. */
  burnNudge: boolean;
  /** Say so when plenty is left close to a reset. */
  goAhead: boolean;
  /** Suggest which account of the same provider to use next. */
  nextAccount: boolean;
  /** Give Cora the forecast before it dispatches several workers. */
  coraHint: boolean;
}

export const DEFAULT_FORECAST_IDEAS: ForecastIdeas = {
  burnNudge: true,
  goAhead: true,
  nextAccount: true,
  coraHint: false,
};

export function normalizeForecastIdeas(value: unknown): ForecastIdeas {
  const src = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const pick = (key: keyof ForecastIdeas): boolean =>
    typeof src[key] === "boolean" ? (src[key] as boolean) : DEFAULT_FORECAST_IDEAS[key];
  return {
    burnNudge: pick("burnNudge"),
    goAhead: pick("goAhead"),
    nextAccount: pick("nextAccount"),
    coraHint: pick("coraHint"),
  };
}

/** "5 agents are burning 3x your usual rate", when it is both fast and risky. */
export function burnNudge(result: ForecastResult, activeAgents: number, label: string): string | null {
  const ratio = result.pace.ratio;
  if (!result.inUse || ratio === null || ratio < 2 || result.hitProbability < 0.3) return null;
  const who = activeAgents >= 2 ? `${activeAgents} agents are` : "You are";
  const times = ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(/\.0$/, "");
  const hit = result.hitAt.p50;
  const when = hit !== null ? ` The ${label} limit runs out around ${formatClock(hit, result.nowMs)}.` : "";
  return `${who} burning ${times}× your usual rate.${when}`;
}

/** "Go ahead": plenty left and the reset is close, so unused quota is lost. */
export function goAheadNote(result: ForecastResult, label: string): string | null {
  if (!result.inUse) return null;
  const length = result.resetsAtMs - result.windowStartMs;
  const left = result.resetsAtMs - result.nowMs;
  if (length <= 0 || left > length * 0.3 || result.endPercent.p90 > 70) return null;
  const spare = Math.round(100 - result.endPercent.p50);
  return `Go ahead: about ${spare}% of the ${label} limit will be left when it resets in ${formatSpan(left)}, and unused quota does not carry over.`;
}

export interface AccountOption {
  profileId: string;
  label: string;
  active: boolean;
  /** Forecast end percent of the account's tightest window, or its used percent. */
  tightestEnd: number;
  tightestLabel: string;
  resetsAtMs: number | null;
}

/** The account with the most room, when it beats the active one clearly. */
export function suggestNextAccount(options: readonly AccountOption[], nowMs: number): string | null {
  const active = options.find((option) => option.active);
  const others = options.filter((option) => !option.active);
  if (!active || others.length === 0) return null;
  const best = others.reduce((a, b) => (b.tightestEnd < a.tightestEnd ? b : a));
  if (active.tightestEnd < 80 || best.tightestEnd > active.tightestEnd - 20) return null;
  const reset =
    best.resetsAtMs !== null ? `, its ${best.tightestLabel} limit resets ${formatClock(best.resetsAtMs, nowMs)}` : "";
  return `Use ${best.label} next: ${Math.round(100 - best.tightestEnd)}% left${reset}.`;
}

/** The sentence Cora reads before it plans a fan-out of workers. */
export function coraForecastHint(result: ForecastResult, accountLabel: string, label: string): string {
  const verdict = describeForecast(result, label);
  const hit = result.hitAt.p50;
  if (result.inUse && result.hitProbability >= 0.5 && hit !== null) {
    return `${accountLabel} ${label}: at the current pace it runs out around ${formatClock(hit, result.nowMs)}, before it resets at ${formatClock(result.resetsAtMs, result.nowMs)}. Dispatch fewer workers, or put some on another account.`;
  }
  return `${accountLabel} ${label}: ${verdict.headline}`;
}

/* ── Back-test ───────────────────────────────────────────────────────────── */

export interface PastWindow {
  startMs: number;
  resetsAtMs: number;
  /** Percent used at the end of the window, the truth a forecast is scored against. */
  endPercent: number;
  /** When the window reached 100%, if it did. */
  hitAtMs: number | null;
  /** Used percent at a moment inside the window. */
  usedAt: (ms: number) => number;
}

export interface BacktestCase {
  startMs: number;
  /** When the window reset, so when its outcome was known. */
  closedMs: number;
  checkpoint: number;
  atMs: number;
  usedPercent: number;
  predicted: { p10: number; p50: number; p90: number };
  naive: number;
  actual: number;
  hitProbability: number;
  hit: boolean;
  /** The uncorrected growth quantiles the forecast saw (ForecastResult). */
  growth: number[];
  /** Minutes the forecast warned ahead of an actual hit (p50 hit at a likely hit), or null. */
  warnedMinutesAhead: number | null;
}

export interface BacktestSummary {
  windows: number;
  cases: number;
  /** Mean absolute error of the median forecast, in percentage points. */
  maeModel: number;
  /** The same for a straight line from the window start through now. */
  maeNaive: number;
  /** Share of cases whose outcome fell inside p10 to p90. */
  coverage: number;
  /** Of the windows that ran out, the share the forecast called (>= 50%) at this checkpoint. */
  hitRecall: number | null;
  /** Of the calls that said "will run out", the share that did. */
  hitPrecision: number | null;
  hits: number;
}

export function backtestForecast(options: {
  windows: readonly PastWindow[];
  history: BurnSeries;
  percentPerUnit: number[];
  kind: ForecastWindowKind;
  checkpoints?: readonly number[];
  paths?: number;
  /** History a forecast needs before it is scored; windows with less are skipped. */
  minHistoryMs?: number;
}): { cases: BacktestCase[]; summary: BacktestSummary; scored: PastWindow[] } {
  const checkpoints = options.checkpoints ?? [0.25, 0.5, 0.75];
  const minHistoryMs = options.minHistoryMs ?? (options.kind === "5h" ? 3 * DAY_MS : 10 * DAY_MS);
  const cases: BacktestCase[] = [];
  const scored: PastWindow[] = [];
  for (const window of options.windows) {
    if (window.startMs - options.history.startMs < minHistoryMs) continue;
    scored.push(window);
    for (const checkpoint of checkpoints) {
      const atMs = window.startMs + (window.resetsAtMs - window.startMs) * checkpoint;
      // A forecast made after the window already ran out has nothing to say.
      if (window.hitAtMs !== null && window.hitAtMs <= atMs) continue;
      const usedPercent = window.usedAt(atMs);
      const truncated: BurnSeries = {
        ...options.history,
        values: options.history.values.slice(
          0,
          Math.max(0, Math.floor((atMs - options.history.startMs) / options.history.bucketMs)),
        ),
      };
      const result = forecastWindow({
        nowMs: atMs,
        windowStartMs: window.startMs,
        resetsAtMs: window.resetsAtMs,
        usedPercent,
        kind: options.kind,
        history: truncated,
        percentPerUnit: options.percentPerUnit,
        inUse: true,
        paths: options.paths ?? 200,
      });
      const elapsed = atMs - window.startMs;
      const naive = Math.min(
        100,
        elapsed > 0 ? usedPercent * ((window.resetsAtMs - window.startMs) / elapsed) : usedPercent,
      );
      const hit = window.hitAtMs !== null;
      const called = result.hitProbability >= 0.5;
      cases.push({
        startMs: window.startMs,
        closedMs: window.resetsAtMs,
        checkpoint,
        atMs,
        usedPercent,
        predicted: result.endPercent,
        naive,
        actual: Math.min(100, window.endPercent),
        hitProbability: result.hitProbability,
        hit,
        growth: result.growthQuantiles,
        warnedMinutesAhead:
          hit && called && window.hitAtMs !== null ? Math.round((window.hitAtMs - atMs) / 60_000) : null,
      });
    }
  }
  return { cases, summary: summarizeBacktest(cases, scored.length), scored };
}

export function summarizeBacktest(cases: readonly BacktestCase[], windows: number): BacktestSummary {
  const n = cases.length;
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  const hitCases = cases.filter((c) => c.hit);
  const calls = cases.filter((c) => c.hitProbability >= 0.5);
  return {
    windows,
    cases: n,
    maeModel: mean(cases.map((c) => Math.abs(c.predicted.p50 - c.actual))),
    maeNaive: mean(cases.map((c) => Math.abs(c.naive - c.actual))),
    coverage: n === 0 ? 0 : cases.filter((c) => c.actual >= c.predicted.p10 - 0.5 && c.actual <= c.predicted.p90 + 0.5).length / n,
    hitRecall: hitCases.length === 0 ? null : hitCases.filter((c) => c.hitProbability >= 0.5).length / hitCases.length,
    hitPrecision: calls.length === 0 ? null : calls.filter((c) => c.hit).length / calls.length,
    hits: new Set(hitCases.map((c) => c.startMs)).size,
  };
}

/* ── Building histories ──────────────────────────────────────────────────── */

export interface LimitReading {
  atMs: number;
  usedPercent: number;
  resetsAtMs: number;
}

/** Readings of one window length grouped by the window they belong to. A
 * reset time that moves by a minute or two is the same window. */
export function groupReadingsByWindow(readings: readonly LimitReading[]): LimitReading[][] {
  const sorted = [...readings].sort((a, b) => a.resetsAtMs - b.resetsAtMs || a.atMs - b.atMs);
  const groups: LimitReading[][] = [];
  for (const reading of sorted) {
    const last = groups[groups.length - 1];
    const anchor = last?.[0];
    if (last && anchor && Math.abs(reading.resetsAtMs - anchor.resetsAtMs) <= 5 * 60_000) last.push(reading);
    else groups.push([reading]);
  }
  for (const group of groups) group.sort((a, b) => a.atMs - b.atMs);
  return groups;
}

/**
 * Percent burned per bucket, from real readings: each rise in used percent
 * is booked to the bucket of the reading that showed it. The first reading of
 * a window counts from zero.
 */
export function percentSeriesFromReadings(
  readings: readonly LimitReading[],
  startMs: number,
  nowMs: number,
  bucketMs = FORECAST_BUCKET_MS,
): BurnSeries {
  const begin = Math.floor(startMs / bucketMs) * bucketMs;
  const values = new Array<number>(Math.max(1, Math.floor((nowMs - begin) / bucketMs) + 1)).fill(0);
  for (const group of groupReadingsByWindow(readings)) {
    let previous = 0;
    for (const reading of group) {
      const rise = reading.usedPercent - previous;
      previous = Math.max(previous, reading.usedPercent);
      if (rise <= 0) continue;
      const index = Math.floor((reading.atMs - begin) / bucketMs);
      if (index >= 0 && index < values.length) values[index] = (values[index] as number) + rise;
    }
  }
  return { startMs: begin, bucketMs, values };
}

/** Past windows as the readings saw them, for scoring forecasts. */
export function pastWindowsFromReadings(
  readings: readonly LimitReading[],
  lengthMs: number,
  nowMs: number,
): PastWindow[] {
  const windows: PastWindow[] = [];
  for (const group of groupReadingsByWindow(readings)) {
    const first = group[0];
    if (!first || first.resetsAtMs > nowMs) continue;
    const startMs = first.resetsAtMs - lengthMs;
    const hit = group.find((reading) => reading.usedPercent >= 100);
    windows.push({
      startMs,
      resetsAtMs: first.resetsAtMs,
      endPercent: Math.max(...group.map((reading) => reading.usedPercent)),
      hitAtMs: hit ? hit.atMs : null,
      usedAt: (ms) => {
        let used = 0;
        for (const reading of group) if (reading.atMs <= ms) used = Math.max(used, reading.usedPercent);
        return used;
      },
    });
  }
  return windows;
}

/**
 * Windows rebuilt from spend alone, the way rolling limits open: a window
 * starts at the hour of the first spend after the previous one reset. Used
 * percent is spend times the factor, so this scores the timing model in the
 * provider's own scale only as well as the factor is known.
 */
export function pastWindowsFromSpend(
  history: BurnSeries,
  lengthMs: number,
  percentPerUnit: number,
  nowMs: number,
  limitHits: readonly number[] = [],
): PastWindow[] {
  const windows: PastWindow[] = [];
  let nextFree = history.startMs;
  for (let i = 0; i < history.values.length; i += 1) {
    const at = history.startMs + i * history.bucketMs;
    if (at < nextFree || !((history.values[i] as number) > 0)) continue;
    const startMs = Math.floor(at / HOUR_MS) * HOUR_MS;
    const resetsAtMs = startMs + lengthMs;
    nextFree = resetsAtMs;
    if (resetsAtMs > nowMs) break;
    const usedAt = (ms: number): number => Math.min(100, sumBetween(history, startMs, ms) * percentPerUnit);
    const spent = sumBetween(history, startMs, resetsAtMs) * percentPerUnit;
    const realHit = limitHits.find((ms) => ms >= startMs && ms < resetsAtMs) ?? null;
    let hitAtMs = realHit;
    if (hitAtMs === null && spent >= 100) {
      for (let t = startMs; t < resetsAtMs; t += history.bucketMs) {
        if (usedAt(t + history.bucketMs) >= 100) {
          hitAtMs = t + history.bucketMs;
          break;
        }
      }
    }
    windows.push({
      startMs,
      resetsAtMs,
      endPercent: hitAtMs !== null ? 100 : Math.min(100, spent),
      hitAtMs,
      usedAt,
    });
  }
  return windows;
}

/* ── Report (main to renderer) ───────────────────────────────────────────── */

export type ForecastProvider = "anthropic" | "openai-codex";

export interface ForecastCalibration {
  /** "readings": the history is the provider's own percent. "spend": priced
   * transcript spend converted with factors from real readings. */
  method: "readings" | "spend";
  anchors: number;
  /** p10 to p90 of the factors, as a ratio to their median; 1 to 1 when exact. */
  spread: [number, number];
  note: string;
}

export interface WindowForecastView {
  key: string;
  profileId: string;
  provider: ForecastProvider;
  accountLabel: string;
  active: boolean;
  windowId: string;
  windowLabel: string;
  /** "live": the provider's usage read. "cli": the CLI's own last reading,
   * used when the live read has no windows. */
  source: "live" | "cli";
  calibration: ForecastCalibration;
  /** What it learned from its past errors on this provider and window
   * length, already applied to `result`; null when nothing to learn from. */
  learning: ForecastLearning | null;
  result: ForecastResult;
  verdict: ForecastVerdict;
  nudge: string | null;
  goAhead: string | null;
}

export interface ForecastPattern {
  provider: ForecastProvider;
  /** [weekday 0 = Sunday][hour] average percent per hour of `windowLabel`. */
  perHour: number[][];
  windowLabel: string;
  days: number;
}

export interface BacktestWindowLine {
  startMs: number;
  resetsAtMs: number;
  actual: number;
  hit: boolean;
  /** When the replayed forecast was made: halfway, or an hour before the
   * window ran out when that came first. */
  saidAtMs: number;
  /** What the panel would have said then. */
  saidAtHalf: string;
  predictedAtHalf: number;
}

export interface BacktestTrack {
  provider: ForecastProvider;
  windowLabel: string;
  /** "readings" scores against the provider's percent; "spend" against spend
   * scaled by today's factor, which tests timing, not the scale. */
  truth: "readings" | "spend";
  /** The plain model, as the forecast was before it learned. */
  summary: BacktestSummary;
  /** The same past forecasts corrected with only what was known at the
   * time (walk-forward), and that split by how much history it had. */
  learned: BacktestSummary;
  byHistory: LearnedBacktest["byHistory"];
  learning: ForecastLearning;
  recent: BacktestWindowLine[];
}

export interface UsageForecastReport {
  generatedAt: number;
  windows: WindowForecastView[];
  nextAccount: Partial<Record<ForecastProvider, string>>;
  activeSessions: Record<ForecastProvider, number>;
  patterns: ForecastPattern[];
  backtest: BacktestTrack[];
  /** What was read, in words, for the "how it works" line. */
  sources: string[];
  notes: string[];
}

/** Average percent per hour by weekday and hour, over whole days of history. */
export function weeklyPattern(history: BurnSeries, percentPerUnit: number, nowMs: number): { perHour: number[][]; days: number } {
  const sums = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const end = localDayStart(nowMs);
  for (let i = 0; i < history.values.length; i += 1) {
    const at = history.startMs + i * history.bucketMs;
    if (at >= end) break;
    const date = new Date(at);
    const row = sums[date.getDay()] as number[];
    row[date.getHours()] = (row[date.getHours()] as number) + (history.values[i] as number) * percentPerUnit;
    if (date.getMinutes() < history.bucketMs / 60_000) {
      const countRow = counts[date.getDay()] as number[];
      countRow[date.getHours()] = (countRow[date.getHours()] as number) + 1;
    }
  }
  const perHour = sums.map((row, day) => row.map((sum, hour) => {
    const count = (counts[day] as number[])[hour] as number;
    return count > 0 ? sum / count : 0;
  }));
  return { perHour, days: Math.round((end - history.startMs) / DAY_MS) };
}
