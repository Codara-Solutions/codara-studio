// Pure usage analytics: transcript parsers, day bucketing, and the pricing
// glue the Usage tab reads.
//
// Everything here is filesystem-free and clock-free so the main-process scanner
// (src/main/usage-analytics.ts), the renderer, and the .cjs test harness can all
// share one implementation. The three providers write three different transcript
// shapes, each with its own double-counting hazard — those rules live in the
// per-parser comments below and are the reason this module is unit tested.

export type UsageProviderKind = "claude" | "codex" | "cora";

export const USAGE_PROVIDERS: readonly UsageProviderKind[] = ["claude", "codex", "cora"];

export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Subset of outputTokens — surfaced for the token mix, never added to totals. */
  reasoningTokens: number;
}

export const EMPTY_USAGE_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export interface UsageRecord {
  provider: UsageProviderKind;
  timestampMs: number;
  model: string;
  sessionId: string;
  totals: UsageTokenTotals;
  /** Cost the transcript itself reported, when it carried one. */
  reportedCostUsd: number | null;
  /** Cross-file dedupe key, or null when the record is inherently unique. */
  dedupeKey: string | null;
}

// "reported" = the transcript carried a cost; "priced" = we multiplied the
// local price table; "unpriced" = the model isn't in the table, cost is 0 and
// the UI says so rather than showing a confidently-wrong number.
export type UsageCostSource = "reported" | "priced" | "unpriced";

export interface UsageDayBucket {
  /** `YYYY-MM-DD` in the requested time zone. */
  day: string;
  provider: UsageProviderKind;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  costSource: UsageCostSource;
  recordCount: number;
  /** Distinct session ids that contributed to this cell. */
  sessions: number;
}

export type UsageSourceStatus = "ok" | "missing" | "error";

export interface UsageSource {
  provider: UsageProviderKind;
  dir: string;
  status: UsageSourceStatus;
  scannedFiles: number;
  skippedFiles: number;
  distinctSessions: number;
  message: string | null;
}

export interface UsageSummaryInput {
  sinceDay: string;
  untilDay: string;
  /** IANA zone the days are resolved in. */
  timeZone: string;
}

export interface UsageSummary {
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageDayBucket[];
  sources: UsageSource[];
  scanDurationMs: number;
  /** Names where the prices came from, so the UI can attribute the estimate. */
  pricedBy: "model-prices";
}

export function addUsageTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

// reasoningTokens is a subset of outputTokens and must not be added again.
export function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Cheap substring gate applied before JSON.parse. Transcripts are mostly tool
// output; only a minority of lines carry usage, and skipping the parse on the
// rest is worth roughly an order of magnitude on a cold scan.
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  return provider === "codex" ? line.includes('"token_count"') : line.includes('"usage"');
}

/* ── Claude Code ─────────────────────────────────────────────────────────── */

/**
 * Parses one line of a Claude Code transcript
 * (`<claudeConfigDir>/projects/**\/*.jsonl`).
 *
 * The CLI writes one record per assistant CONTENT BLOCK and every one of them
 * repeats the parent message's complete `usage` object. Summing them overcounts
 * by roughly 2.4x on a real workload, so the caller must drop repeats by
 * `dedupeKey` and keep the first — within the file AND across files, because a
 * resumed or forked session copies earlier records forward.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Records carrying neither id cannot be de-duplicated; null marks them as
  // inherently unique rather than collapsing them all onto one empty key.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* ── Codex ───────────────────────────────────────────────────────────────── */

/**
 * Rolling state for a single Codex rollout file. `token_count` events carry no
 * model, so it is carried forward from the most recent `turn_context`.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
}

export function initialCodexScanState(): CodexScanState {
  return { model: "", sessionId: "", lastUsageSignature: null };
}

/**
 * Feeds one rollout line into `state`, returning a record when the line was a
 * usage event.
 *
 * Deltas come from `last_token_usage`; summing them across a session reconciles
 * with the final `total_token_usage`, provided consecutive duplicates are
 * dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  if (record["type"] === "session_meta") {
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadRecord["type"] !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an otherwise-eligible event may consume the duplicate signature. A
  // token_count arriving before its turn_context (no model yet) must not poison
  // it, or the re-emitted copy that arrives once the model is known would be
  // skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Rollouts carry no cost, and one file is one session, so no global dedup.
    reportedCostUsd: null,
    dedupeKey: null,
  };
}

/* ── Cora (Pi runtime) ───────────────────────────────────────────────────── */

/** Rolling state for one Pi session file: the id from its header line. */
export interface PiScanState {
  sessionId: string;
}

export function initialPiScanState(fallbackSessionId = ""): PiScanState {
  return { sessionId: fallbackSessionId };
}

/**
 * Parses one line of a Pi runtime session (`sparkHome()/pi-agent/sessions`).
 *
 * Pi computes the exact provider cost itself, so `usage.cost.total` is trusted
 * over the local price table. One writer per file and no content-block fan-out,
 * so records need no dedupe key.
 */
export function parsePiLine(line: string, state: PiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;

  if (record["type"] === "session") {
    if (typeof record["id"] === "string" && record["id"].length > 0) {
      state.sessionId = record["id"];
    }
    return null;
  }

  if (record["type"] !== "message") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord["role"] !== "assistant") return null;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;
  // Pi writes a zeroed usage block for failed turns (transport errors); those
  // were never billed and must not land as an empty record.
  if (int(usageRecord["totalTokens"]) === 0) return null;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const outputTokens = int(usageRecord["output"]);
  const cost = usageRecord["cost"];
  const reportedCostUsd =
    typeof cost === "object" && cost !== null
      ? finiteOrNull((cost as Record<string, unknown>)["total"])
      : null;

  return {
    provider: "cora",
    timestampMs,
    model,
    sessionId: state.sessionId,
    totals: {
      uncachedInputTokens: int(usageRecord["input"]),
      cachedInputTokens: int(usageRecord["cacheRead"]),
      cacheCreationTokens: int(usageRecord["cacheWrite"]),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, int(usageRecord["reasoning"])),
    },
    reportedCostUsd,
    dedupeKey: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ── Pricing ─────────────────────────────────────────────────────────────── */

/** USD per 1,000,000 tokens, per dimension. */
export interface UsagePriceRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Resolves a transcript model name to a rate. Supplied by the main process
 * (src/main/model-prices.ts) so this module stays free of the price table.
 */
export type UsagePriceLookup = (
  model: string,
  provider: UsageProviderKind,
) => UsagePriceRate | null;

export interface PricedUsage {
  costUsd: number;
  costSource: UsageCostSource;
}

/**
 * Prices one record. A transcript-reported cost always wins: the provider knows
 * its own billing better than a snapshotted table does.
 */
export function priceUsageRecord(
  lookup: UsagePriceLookup,
  provider: UsageProviderKind,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "reported" };
  }
  const rate = lookup(model, provider);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    (totals.uncachedInputTokens * rate.input +
      totals.cachedInputTokens * rate.cacheRead +
      totals.cacheCreationTokens * rate.cacheWrite +
      totals.outputTokens * rate.output) /
    1_000_000;
  // reasoningTokens is deliberately not charged: it is inside outputTokens.
  return { costUsd, costSource: "priced" };
}

/** What the cache reads would have cost at full input rates, minus what they did. */
export function cacheSavingsUsd(
  lookup: UsagePriceLookup,
  provider: UsageProviderKind,
  model: string,
  totals: UsageTokenTotals,
): number {
  const rate = lookup(model, provider);
  if (rate === null) return 0;
  return (totals.cachedInputTokens * (rate.input - rate.cacheRead)) / 1_000_000;
}

/* ── Aggregation ─────────────────────────────────────────────────────────── */

/**
 * Formats an instant as `YYYY-MM-DD` in `timeZone`.
 *
 * `en-CA` yields ISO-ordered parts, which is why it is used instead of
 * assembling the day from Date getters (those are host-local only). An unknown
 * zone degrades to UTC rather than failing the whole scan.
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  try {
    format = new Intl.DateTimeFormat("en-CA", options);
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
  // Intl formatting dominates the aggregate on a large scan, and transcripts
  // carry long runs of near-identical timestamps, so memoize per whole minute.
  const memo = new Map<number, string>();
  return (timestampMs) => {
    const minute = Math.floor(timestampMs / 60_000);
    const hit = memo.get(minute);
    if (hit !== undefined) return hit;
    const day = format.format(new Date(timestampMs));
    memo.set(minute, day);
    return day;
  };
}

export interface UsageAggregateOptions {
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  lookup: UsagePriceLookup;
}

export interface UsageAggregateResult {
  buckets: UsageDayBucket[];
  /** Records dropped because an earlier record carried the same dedupe key. */
  duplicatesDropped: number;
  /** Records whose local day fell outside the requested window. */
  outOfWindow: number;
}

interface MutableBucket {
  // The cell's identity, carried on the value rather than parsed back out of
  // the map key. A Codex `turn_context` can name any model the user configured,
  // including one containing spaces, so a key that has to be split apart is a
  // way to truncate a model label and silently merge two distinct models.
  day: string;
  provider: UsageProviderKind;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  reportedRecords: number;
  unpricedRecords: number;
  sessions: Set<string>;
}

/**
 * Folds records into `(day, provider, model)` cells.
 *
 * De-duplication is global across the whole scan rather than per file: Claude
 * Code copies a message's records forward when a session is resumed or forked,
 * so the same key legitimately appears in several transcripts.
 */
export class UsageAggregator {
  private readonly buckets = new Map<string, MutableBucket>();
  private readonly seen = new Set<string>();
  private readonly toDay: (timestampMs: number) => string;
  private readonly options: UsageAggregateOptions;
  private duplicatesDropped = 0;
  private outOfWindow = 0;

  constructor(options: UsageAggregateOptions) {
    this.options = options;
    this.toDay = makeDayFormatter(options.timeZone);
  }

  /**
   * Folds one record in, returning whether it actually contributed so callers
   * can derive per-window facts (distinct sessions) from the records that
   * landed rather than everything the mtime prefilter happened to admit.
   */
  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.seen.has(record.dedupeKey)) {
        this.duplicatesDropped += 1;
        return false;
      }
      this.seen.add(record.dedupeKey);
    }

    const day = this.toDay(record.timestampMs);
    if (day < this.options.sinceDay || day > this.options.untilDay) {
      this.outOfWindow += 1;
      return false;
    }

    // Newline separated: day comes from Intl and provider is an enum, so the
    // model is the only free-form part, and a transcript model name cannot
    // contain a newline.
    const key = `${day}\n${record.provider}\n${record.model}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        day,
        provider: record.provider,
        model: record.model,
        totals: EMPTY_USAGE_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        reportedRecords: 0,
        unpricedRecords: 0,
        sessions: new Set<string>(),
      };
      this.buckets.set(key, bucket);
    }

    const priced = priceUsageRecord(
      this.options.lookup,
      record.provider,
      record.model,
      record.totals,
      record.reportedCostUsd,
    );

    bucket.totals = addUsageTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.options.lookup,
      record.provider,
      record.model,
      record.totals,
    );
    bucket.records += 1;
    if (priced.costSource === "reported") bucket.reportedRecords += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  finish(): UsageAggregateResult {
    const buckets: UsageDayBucket[] = [];
    for (const bucket of this.buckets.values()) {
      buckets.push({
        day: bucket.day,
        provider: bucket.provider,
        model: bucket.model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        recordCount: bucket.records,
        sessions: bucket.sessions.size,
      });
    }
    // Stable ordering keeps payloads diffable and the tables deterministic.
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
    return {
      buckets,
      duplicatesDropped: this.duplicatesDropped,
      outOfWindow: this.outOfWindow,
    };
  }
}

// A cell mixes records of one model whose cost provenance can differ when only
// some carried a reported cost. The weakest provenance wins so the UI never
// overstates confidence.
function resolveCostSource(bucket: MutableBucket): UsageCostSource {
  if (bucket.records > 0 && bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.records > 0 && bucket.reportedRecords === bucket.records) return "reported";
  return "priced";
}

/* ── Day window helpers (shared with the renderer) ───────────────────────── */

/** Inclusive `YYYY-MM-DD` list between two bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The window a viewer asks for, expressed in their own zone so the days line up
 * with the days they experienced.
 *
 * Subtracting fixed milliseconds from `now` lands on the wrong calendar day
 * around a DST transition, so only "today" is resolved in the zone; the start
 * is calendar arithmetic on that day, done in UTC where days are uniform.
 */
export function makeUsageWindow(
  days: number,
  now: Date = new Date(),
  timeZone: string = resolveLocalTimeZone(),
): UsageSummaryInput {
  let untilDay: string;
  try {
    untilDay = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    untilDay = now.toISOString().slice(0, 10);
  }
  const [year = 1970, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const span = Math.max(1, Math.trunc(days));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (span - 1)));
  return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone };
}

export function resolveLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
