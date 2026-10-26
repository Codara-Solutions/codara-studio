// How the usage forecast learns from its own mistakes. Every past forecast is
// kept with what really happened: the back-test replays (made from history,
// as if at the time) and, while the forecast is on, the live forecasts Studio
// logged and later scored against the provider's own reading at the reset.
//
// From those it fits two numbers per provider and window length, both easy to
// say out loud:
//
//   - growthBias: how much more (above 1) or less the windows really grew
//     than the forecast said. "It tends to underestimate you by 20%" is 1.2.
//   - spread: how much wider (above 1) or narrower the band has to be for
//     8 in 10 outcomes to land inside it, which is what p10 to p90 promises.
//
// Both start at 1 and move away from it only as evidence piles up (each is
// shrunk toward 1 by how many windows back it), so a new install forecasts as
// the plain model does and grows more sure of itself week by week. Recent
// forecasts weigh more than old ones, and live ones more than replays: they
// are scored on the provider's own percent, not on spend scaled by a factor.

import {
  GROWTH_LEVELS,
  summarizeBacktest,
  type BacktestCase,
  type BacktestSummary,
  type ForecastCorrection,
} from "./usage-forecast";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LearningSample {
  /** When the forecast was made. */
  atMs: number;
  /** When its window reset, so when its outcome was known. */
  closedMs: number;
  /** Identifies the window, to count windows rather than forecasts. */
  windowStartMs: number;
  usedPercent: number;
  /** Uncorrected growth quantiles (ForecastResult.growthQuantiles). */
  growth: number[];
  /** Used percent at the reset. */
  actual: number;
  source: "replay" | "live";
}

export type ForecastConfidence = "learning" | "rough" | "fair" | "good";

export interface ErrorModel extends ForecastCorrection {
  /** Past windows the correction learned from. */
  windows: number;
  samples: number;
  /** How many of them were live forecasts rather than replays. */
  liveSamples: number;
  /** Past windows with at least one scored live forecast. */
  liveWindows: number;
}

export interface ForecastLearning {
  correction: ForecastCorrection;
  windows: number;
  liveSamples: number;
  confidence: ForecastConfidence;
  /** Typical miss of the corrected forecast, in points, from the walk-forward
   * back-test of the most recent forecasts; null before there is one. */
  typicalMiss: number | null;
  /** Share of recent corrected forecasts whose outcome fell in the band. */
  bandHeld: number | null;
}

export const NO_CORRECTION: ForecastCorrection = { growthBias: 1, spread: 1 };

/** Windows' worth of evidence that pulls a number halfway from 1. */
const SHRINK_WINDOWS = 12;
/** Narrowing the band is the risky direction (it promises more than the
 * model knows), so it needs much more evidence than widening. */
const NARROW_SHRINK_WINDOWS = 40;
/** A past forecast teaches something once its window moved this many points,
 * or was forecast to. */
const MIN_LESSON_POINTS = 2;
/** No correction at all before this many such windows. */
const MIN_LESSON_WINDOWS = 5;
/** Live forecasts are scored on the provider's percent. */
const LIVE_WEIGHT = 3;
const BIAS_LIMITS: [number, number] = [0.4, 2.5];
const SPREAD_LIMITS: [number, number] = [0.6, 4];
/** Forecasts of one window can disagree on its start by a few minutes (a
 * reset computed from "resets in N seconds" moves with every read), while two
 * real windows start hours apart. */
const SAME_WINDOW_MS = 30 * 60_000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** How fast an old lesson fades: a 5-hour habit changes within weeks, a
 * weekly one over months. */
function halfLifeMs(kind: "5h" | "7d"): number {
  return kind === "5h" ? 21 * DAY_MS : 60 * DAY_MS;
}

function weightedQuantile(pairs: Array<[number, number]>, q: number): number {
  const sorted = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, w]) => sum + w, 0);
  if (total === 0) return 0;
  let seen = 0;
  for (const [value, w] of sorted) {
    seen += w;
    if (seen >= q * total) return value;
  }
  return (sorted[sorted.length - 1] as [number, number])[0];
}

function growthAt(growth: readonly number[], level: number): number {
  return (growth[Math.round(level * GROWTH_LEVELS)] as number | undefined) ?? 0;
}

/** p10, p50 and p90 of the end, and the chance of running out, after a
 * correction: the same transform forecastWindow applies to each replay. */
export function correctedEnd(
  growth: readonly number[],
  usedPercent: number,
  correction: ForecastCorrection,
): { p10: number; p50: number; p90: number; hitProbability: number } {
  const middle = growthAt(growth, 0.5);
  const corrected = growth.map((value) =>
    Math.max(0, correction.growthBias * (middle + correction.spread * (value - middle))),
  );
  const end = (level: number) => Math.min(100, usedPercent + growthAt(corrected, level));
  const room = 100 - usedPercent;
  let hitProbability = 0;
  if (room <= 0) hitProbability = 1;
  else if ((corrected[corrected.length - 1] ?? 0) >= room) {
    // Corrected quantiles are monotone, so the first level at the limit,
    // interpolated, is where the share that runs out begins.
    for (let k = 0; k < corrected.length; k += 1) {
      const value = corrected[k] as number;
      if (value < room) continue;
      if (k === 0) {
        hitProbability = 1;
        break;
      }
      const below = corrected[k - 1] as number;
      const within = value > below ? (room - below) / (value - below) : 1;
      hitProbability = 1 - (k - 1 + within) / GROWTH_LEVELS;
      break;
    }
  }
  return { p10: end(0.1), p50: end(0.5), p90: end(0.9), hitProbability };
}

/** One id per real window: forecasts whose starts lie within SAME_WINDOW_MS
 * of the window's first start share it, whichever source made them. */
function windowIds(samples: readonly LearningSample[]): number[] {
  const order = samples.map((_, i) => i).sort((a, b) => (samples[a] as LearningSample).windowStartMs - (samples[b] as LearningSample).windowStartMs);
  const ids = new Array<number>(samples.length);
  let id = -1;
  let first = Number.NEGATIVE_INFINITY;
  for (const i of order) {
    const start = (samples[i] as LearningSample).windowStartMs;
    if (start - first > SAME_WINDOW_MS) {
      id += 1;
      first = start;
    }
    ids[i] = id;
  }
  return ids;
}

/**
 * Fits the correction from forecasts whose outcome was known by nowMs. The
 * bias is the scale that would have made the middle guesses miss least; the
 * spread is the 80th percentile of the miss measured in band half-widths, so
 * 8 in 10 outcomes land in the band.
 */
export function fitErrorModel(
  samples: readonly LearningSample[],
  nowMs: number,
  kind: "5h" | "7d",
): ErrorModel {
  const known = samples.filter((sample) => sample.closedMs <= nowMs && sample.growth.length > 0);
  const ids = windowIds(known);
  const counts = {
    windows: new Set(ids).size,
    samples: known.length,
    liveSamples: known.filter((sample) => sample.source === "live").length,
    liveWindows: new Set(ids.filter((_, i) => (known[i] as LearningSample).source === "live")).size,
  };
  // A window where nothing happened and nothing was forecast says nothing
  // about scale or spread, and early on those are most of what there is.
  const lessonIds = new Map<LearningSample, number>();
  known.forEach((sample, i) => {
    if (Math.max(growthAt(sample.growth, 0.9), sample.actual - sample.usedPercent) >= MIN_LESSON_POINTS) {
      lessonIds.set(sample, ids[i] as number);
    }
  });
  const lessons = [...lessonIds.keys()];
  const life = halfLifeMs(kind);
  const windowWeightOf = (sample: LearningSample) =>
    Math.pow(0.5, Math.max(0, nowMs - sample.closedMs) / life) * (sample.source === "live" ? LIVE_WEIGHT : 1);

  // Evidence is counted in windows: three checkpoints of one window are not
  // three independent lessons, and a window logged live every half hour is
  // still one window. Each source's checkpoints share that window's weight.
  const checkpoints = new Map<string, number>();
  const checkpointKey = (sample: LearningSample) => `${lessonIds.get(sample)}|${sample.source}`;
  for (const sample of lessons) checkpoints.set(checkpointKey(sample), (checkpoints.get(checkpointKey(sample)) ?? 0) + 1);
  const weightOf = (sample: LearningSample) => windowWeightOf(sample) / (checkpoints.get(checkpointKey(sample)) ?? 1);
  const windowWeight = new Map<number, number>();
  for (const sample of lessons) {
    const id = lessonIds.get(sample) as number;
    windowWeight.set(id, Math.max(windowWeight.get(id) ?? 0, windowWeightOf(sample)));
  }
  if (windowWeight.size < MIN_LESSON_WINDOWS) return { ...NO_CORRECTION, ...counts };
  const evidence = [...windowWeight.values()].reduce((sum, w) => sum + w, 0);
  const trust = evidence / (evidence + SHRINK_WINDOWS);

  // The scale m that makes m * forecast closest to the actual growth, in
  // points summed over windows, is the median of actual / forecast weighted
  // by the forecast: |actual - m g| = g |actual / g - m|.
  const ratios: Array<[number, number]> = [];
  for (const sample of lessons) {
    const forecast = Math.max(0, growthAt(sample.growth, 0.5));
    if (forecast < 0.5) continue;
    const actual = Math.max(0, sample.actual - sample.usedPercent);
    // A window that hit 100 grew at least this much; past the limit the truth
    // is censored, so it only counts when the forecast fell short of it.
    if (sample.actual >= 100 && forecast >= actual) continue;
    ratios.push([actual / forecast, weightOf(sample) * forecast]);
  }
  const rawBias = ratios.length > 0 ? Math.log(Math.max(1e-3, weightedQuantile(ratios, 0.5))) : 0;
  const growthBias = clamp(Math.exp(rawBias * trust), BIAS_LIMITS[0], BIAS_LIMITS[1]);

  const misses: Array<[number, number]> = [];
  for (const sample of lessons) {
    const at = correctedEnd(sample.growth, sample.usedPercent, { growthBias, spread: 1 });
    const actual = Math.min(100, sample.actual);
    const half = actual >= at.p50 ? at.p90 - at.p50 : at.p50 - at.p10;
    // A band capped at 100 cannot be missed from above.
    if (actual >= at.p50 && at.p90 >= 100 - 1e-6) continue;
    // The same half-point tolerance the back-test's "band held" uses.
    misses.push([Math.max(0, Math.abs(actual - at.p50) - 0.5) / Math.max(1, half), weightOf(sample)]);
  }
  const rawSpread = misses.length > 0 ? weightedQuantile(misses, 0.8) : 1;
  // Outcomes that always land on the middle guess still leave the band some
  // width: a third of it at least.
  const logSpread = Math.log(Math.max(0.3, rawSpread));
  const spreadTrust = logSpread < 0 ? evidence / (evidence + NARROW_SHRINK_WINDOWS) : trust;
  const spread = clamp(Math.exp(logSpread * spreadTrust), SPREAD_LIMITS[0], SPREAD_LIMITS[1]);

  return { growthBias, spread, ...counts };
}

export function samplesFromBacktest(cases: readonly BacktestCase[]): LearningSample[] {
  return cases.map((c) => ({
    atMs: c.atMs,
    closedMs: c.closedMs,
    windowStartMs: c.startMs,
    usedPercent: c.usedPercent,
    growth: c.growth,
    actual: c.actual,
    source: "replay",
  }));
}

export interface LearnedBacktest {
  /** The same cases, scored with the correction known at the time. */
  cases: BacktestCase[];
  summary: BacktestSummary;
  /** Before and after, by how many past windows the correction had. */
  byHistory: Array<{
    label: string;
    cases: number;
    maeBefore: number;
    maeAfter: number;
    coverageBefore: number;
    coverageAfter: number;
  }>;
}

function countAtOrBefore(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const HISTORY_BANDS: Array<[number, number, string]> = [
  [0, 10, "fewer than 10 past windows"],
  [10, 30, "10 to 29 past windows"],
  [30, Number.POSITIVE_INFINITY, "30 or more past windows"],
];

/**
 * Walk-forward: each past forecast is corrected only with what was known when
 * it was made (windows that had already reset), then scored. This is the
 * honest "after" number; fitting on everything and scoring the same cases
 * would flatter it.
 */
export function learnedBacktest(
  cases: readonly BacktestCase[],
  kind: "5h" | "7d",
  extra: readonly LearningSample[] = [],
): LearnedBacktest {
  const pool = [...samplesFromBacktest(cases), ...extra];
  const closings = pool.map((sample) => sample.closedMs).sort((a, b) => a - b);
  const after = new Array<BacktestCase>(cases.length);
  const priorWindows = new Array<number>(cases.length);
  // Refitting for every forecast costs a fit over the whole pool each time.
  // One more closed window, or a few more days of fade, barely moves a fit
  // made from many, so it is refit once the known history grew by a twentieth
  // or a week passed. It still only ever uses windows that had reset.
  let fitted: { known: number; atMs: number; model: ErrorModel } | null = null;
  const order = cases.map((_, i) => i).sort((a, b) => (cases[a] as BacktestCase).atMs - (cases[b] as BacktestCase).atMs);
  for (const i of order) {
    const c = cases[i] as BacktestCase;
    const known = countAtOrBefore(closings, c.atMs);
    if (!fitted || known - fitted.known >= Math.max(1, fitted.known / 20) || c.atMs - fitted.atMs >= 7 * DAY_MS) {
      fitted = { known, atMs: c.atMs, model: fitErrorModel(pool, c.atMs, kind) };
    }
    const corrected = correctedEnd(c.growth, c.usedPercent, fitted.model);
    priorWindows[i] = fitted.model.windows;
    after[i] = {
      ...c,
      predicted: { p10: corrected.p10, p50: corrected.p50, p90: corrected.p90 },
      hitProbability: corrected.hitProbability,
    };
  }
  const windows = new Set(cases.map((c) => c.startMs)).size;
  const byHistory = HISTORY_BANDS.map(([lo, hi, label]) => {
    const picked = cases.map((_, i) => i).filter((i) => (priorWindows[i] as number) >= lo && (priorWindows[i] as number) < hi);
    const before = summarizeBacktest(picked.map((i) => cases[i] as BacktestCase), 0);
    const later = summarizeBacktest(picked.map((i) => after[i] as BacktestCase), 0);
    return {
      label,
      cases: picked.length,
      maeBefore: before.maeModel,
      maeAfter: later.maeModel,
      coverageBefore: before.coverage,
      coverageAfter: later.coverage,
    };
  }).filter((band) => band.cases > 0);
  return { cases: after, summary: summarizeBacktest(after, windows), byHistory };
}

/** How sure the corrected forecast is, from how much it has learned and how
 * well it did on the most recent past forecasts. */
export function describeLearning(model: ErrorModel, recent: readonly BacktestCase[]): ForecastLearning {
  const latest = recent.slice(-30);
  const typicalMiss =
    latest.length > 0 ? latest.reduce((sum, c) => sum + Math.abs(c.predicted.p50 - c.actual), 0) / latest.length : null;
  const bandHeld =
    latest.length > 0
      ? latest.filter((c) => c.actual >= c.predicted.p10 - 0.5 && c.actual <= c.predicted.p90 + 0.5).length / latest.length
      : null;
  let confidence: ForecastConfidence = "learning";
  if (model.windows >= 8 && typicalMiss !== null) {
    const heldWell = bandHeld !== null && bandHeld >= 0.65;
    if (model.windows >= 40 && typicalMiss <= 6 && heldWell) confidence = "good";
    else if (model.windows >= 15 && typicalMiss <= 12 && heldWell) confidence = "fair";
    else confidence = "rough";
  }
  return {
    correction: { growthBias: model.growthBias, spread: model.spread },
    windows: model.windows,
    liveSamples: model.liveSamples,
    confidence,
    typicalMiss,
    bandHeld,
  };
}

export const CONFIDENCE_WORDS: Record<ForecastConfidence, string> = {
  learning: "still learning",
  rough: "rough guess",
  fair: "fairly sure",
  good: "sure",
};

/** "fairly sure · 40 past windows", the confidence line under a forecast. */
export function confidenceLine(learning: ForecastLearning): string {
  const windows = `${learning.windows} past window${learning.windows === 1 ? "" : "s"}`;
  return `${CONFIDENCE_WORDS[learning.confidence]} · ${windows}`;
}

/** What the correction does, in words, for the Usage tab. */
export function correctionWords(correction: ForecastCorrection): string {
  const parts: string[] = [];
  const bias = correction.growthBias;
  if (bias >= 1.05) parts.push(`your windows grew ${Math.round((bias - 1) * 100)}% more than it said, so it adds that`);
  else if (bias <= 0.95) parts.push(`your windows grew ${Math.round((1 - bias) * 100)}% less than it said, so it takes that off`);
  else parts.push("its middle guess has been about right");
  const spread = correction.spread;
  if (spread >= 1.1) parts.push(`the band is ${spread.toFixed(1)}× wider so 8 in 10 outcomes land in it`);
  else if (spread <= 0.9) parts.push(`the band is ${Math.round((1 - spread) * 100)}% narrower, since outcomes landed close`);
  return parts.join("; ");
}
