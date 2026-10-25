// The Usage page's numbers, derived from one scan summary. Kept apart from the
// components so every figure the page shows is unit tested
// (scripts/test-usage-page.cjs).

import {
  cacheHitShare,
  totalTokens,
  type UsageDayBucket,
  type UsageProjectRow,
  type UsageProviderKind,
  type UsageSource,
} from "@shared/usage-analytics";

/** Stacking order of the daily chart, bottom band first. */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["cora", "codex", "claude"];

/** Reading order everywhere else: the legend, the cards, the table columns. */
export const PROVIDER_READING_ORDER: readonly UsageProviderKind[] = [...PROVIDER_ORDER].reverse();

export interface DayTotals {
  day: string;
  costUsd: number;
  tokens: number;
  byProvider: Map<UsageProviderKind, { costUsd: number; tokens: number }>;
}

export function buildDailyTotals(days: string[], buckets: UsageDayBucket[]): DayTotals[] {
  const rows = new Map<string, DayTotals>();
  for (const day of days) {
    rows.set(day, { day, costUsd: 0, tokens: 0, byProvider: new Map() });
  }
  for (const bucket of buckets) {
    const row = rows.get(bucket.day);
    // A bucket outside the enumerated days can only happen if the summary and
    // the range drifted apart mid-fetch; drop it rather than draw off-axis.
    if (row === undefined) continue;
    const tokens = totalTokens(bucket.totals);
    row.costUsd += bucket.costUsd;
    row.tokens += tokens;
    const provider = row.byProvider.get(bucket.provider) ?? { costUsd: 0, tokens: 0 };
    provider.costUsd += bucket.costUsd;
    provider.tokens += tokens;
    row.byProvider.set(bucket.provider, provider);
  }
  return [...rows.values()];
}

/** The day with the most tokens, or null when none had any. */
export function busiestDay(days: DayTotals[]): DayTotals | null {
  return days.reduce<DayTotals | null>(
    (best, entry) => (entry.tokens > (best?.tokens ?? 0) ? entry : best),
    null,
  );
}

const INTENSITY_MAX_COLUMNS = 21;
const INTENSITY_MIN_COLUMNS = 7;

/**
 * Columns for the intensity grid: at most 21 across, with the rows filled
 * evenly, so 30 days lay out 15 + 15 rather than 21 + 9.
 */
export function intensityColumns(cells: number): number {
  if (cells <= INTENSITY_MAX_COLUMNS) return Math.max(INTENSITY_MIN_COLUMNS, cells);
  const rows = Math.ceil(cells / INTENSITY_MAX_COLUMNS);
  return Math.ceil(cells / rows);
}

export interface SummaryTotals {
  costUsd: number;
  cacheSavingsUsd: number;
  tokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Every usage record in the window. */
  records: number;
  pricedRecords: number;
  unpricedRecords: number;
  /** Prompt tokens read from cache over all prompt tokens; null with none. */
  cacheHitShare: number | null;
}

export function summarizeBuckets(buckets: UsageDayBucket[]): SummaryTotals {
  const totals: SummaryTotals = {
    costUsd: 0,
    cacheSavingsUsd: 0,
    tokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    records: 0,
    pricedRecords: 0,
    unpricedRecords: 0,
    cacheHitShare: null,
  };
  for (const bucket of buckets) {
    totals.costUsd += bucket.costUsd;
    totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
    totals.tokens += totalTokens(bucket.totals);
    totals.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    totals.cachedInputTokens += bucket.totals.cachedInputTokens;
    totals.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    totals.outputTokens += bucket.totals.outputTokens;
    totals.reasoningTokens += bucket.totals.reasoningTokens;
    totals.records += bucket.recordCount;
    if (bucket.costSource === "priced") totals.pricedRecords += bucket.recordCount;
    if (bucket.costSource === "unpriced") totals.unpricedRecords += bucket.recordCount;
  }
  totals.cacheHitShare = cacheHitShare(totals);
  return totals;
}

export interface ModelRow {
  provider: UsageProviderKind;
  model: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  unpriced: boolean;
}

export function buildModelRows(buckets: UsageDayBucket[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const bucket of buckets) {
    const key = `${bucket.provider}:${bucket.model}`;
    const row = rows.get(key) ?? {
      provider: bucket.provider,
      model: bucket.model,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      unpriced: false,
    };
    row.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    row.cachedInputTokens += bucket.totals.cachedInputTokens;
    row.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    row.outputTokens += bucket.totals.outputTokens;
    row.costUsd += bucket.costUsd;
    if (bucket.costSource === "unpriced") row.unpriced = true;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens,
  );
}

export interface ProjectRow {
  key: string;
  project: string;
  providers: UsageProviderKind[];
  tokens: number;
  sessions: number;
  records: number;
  costUsd: number;
}

// The scan keeps one row per provider and directory; the table merges the
// providers that shared a directory into one line so a project reads as one
// project no matter which agents worked in it.
export function buildProjectRows(projects: UsageProjectRow[]): ProjectRow[] {
  const rows = new Map<string, ProjectRow>();
  for (const entry of projects) {
    const row = rows.get(entry.project) ?? {
      key: entry.project,
      project: entry.project,
      providers: [],
      tokens: 0,
      sessions: 0,
      records: 0,
      costUsd: 0,
    };
    if (!row.providers.includes(entry.provider)) row.providers.push(entry.provider);
    row.tokens += totalTokens(entry.totals);
    row.sessions += entry.sessions;
    row.records += entry.records;
    row.costUsd += entry.costUsd;
    rows.set(entry.project, row);
  }
  for (const row of rows.values()) {
    row.providers.sort(
      (a, b) => PROVIDER_READING_ORDER.indexOf(a) - PROVIDER_READING_ORDER.indexOf(b),
    );
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

export interface ProviderCardData {
  provider: UsageProviderKind;
  source: UsageSource | null;
  tokens: number;
  costUsd: number;
  sessions: number;
  records: number;
  topModel: string | null;
  share: number;
}

/** One provider can read several folders (Codex: live and archived
 * sessions); its card sums them and is ok when any folder was read. */
function mergeSources(sources: UsageSource[]): UsageSource | null {
  if (sources.length <= 1) return sources[0] ?? null;
  const readable = sources.filter((source) => source.status === "ok");
  const lead = readable[0] ?? sources[0];
  return {
    ...lead,
    scannedFiles: sources.reduce((total, source) => total + source.scannedFiles, 0),
    skippedFiles: sources.reduce((total, source) => total + source.skippedFiles, 0),
    distinctSessions: sources.reduce((total, source) => total + source.distinctSessions, 0),
  };
}

export function buildProviderCards(
  buckets: UsageDayBucket[],
  sources: UsageSource[],
  allTokens: number,
): ProviderCardData[] {
  return PROVIDER_READING_ORDER.map((provider) => {
    const modelTokens = new Map<string, number>();
    let tokens = 0;
    let costUsd = 0;
    let records = 0;
    for (const bucket of buckets) {
      if (bucket.provider !== provider) continue;
      const count = totalTokens(bucket.totals);
      tokens += count;
      costUsd += bucket.costUsd;
      records += bucket.recordCount;
      modelTokens.set(bucket.model, (modelTokens.get(bucket.model) ?? 0) + count);
    }
    let topModel: string | null = null;
    let best = 0;
    for (const [model, count] of modelTokens) {
      if (count > best) {
        best = count;
        topModel = model;
      }
    }
    const source = mergeSources(sources.filter((entry) => entry.provider === provider));
    return {
      provider,
      source,
      tokens,
      costUsd,
      sessions: source?.distinctSessions ?? 0,
      records,
      topModel,
      share: allTokens === 0 ? 0 : tokens / allTokens,
    };
  });
}
