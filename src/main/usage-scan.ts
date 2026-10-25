// Usage analytics scan: walks the provider CLIs' own on-disk transcripts and
// returns priced daily token usage for the Usage tab.
//
// Reading the CLIs' session files rather than Codara's orchestration journal is
// deliberate — it covers turns the user drove OUTSIDE Codara (a plain
// `claude`/`codex` terminal) too, which is the number people actually want.
//
// The roots are resolved by usage-analytics.ts and handed in, because that
// needs Electron and this module must not: it runs on the usage scan worker
// thread (usage-scan-worker.ts), so a cold scan of a few GB and the memo it
// builds never touch the main process.
//
// Codara-managed account profiles SYMLINK their projects/ and sessions/ into
// the personal home (see cli-account-homes.ts), so walking the managed
// roots as well would count the same files twice. For the same reason the walk
// never descends through a symlink.
//
// Transcripts are append-only, so parsed records are memoised per file by
// (size, mtime) and the memo is persisted — a warm scan only re-reads the files
// that actually changed.

import { createReadStream, promises as fs, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { lookupUsagePrice } from "./model-prices";
import {
  UsageAggregator,
  initialCodexScanState,
  priceUsageRecord,
  initialPiScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parsePiLine,
  type UsageProviderKind,
  type UsageRecord,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@shared/usage-analytics";

// Files are filtered by mtime before being opened. The slack covers a session
// whose last write lands just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

// Longest window the UI offers (a year), plus slack. Older cache entries are
// dropped. A shorter retention evicted everything past it on every short
// scan, so the next one-year view re-parsed months of transcripts cold.
const CACHE_RETENTION_DAYS = 368;

// Files parsed between event-loop yields, so a scan running inline (no worker
// bundle in this build) still lets IPC through on a cold history.
const FILES_PER_YIELD = 24;

// Version 2 added the interned project (working directory) per record.
const SCAN_CACHE_VERSION = 2;

export interface CachedFile {
  size: number;
  mtimeMs: number;
  provider: UsageProviderKind;
  records: UsageRecord[];
}

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export type ScanCache = Map<string, CachedFile>;

/** One transcript root, as resolved by the main process. */
export interface UsageScanRoot {
  provider: UsageProviderKind;
  dir: string;
  /** Set when the root could not be resolved at all. */
  error: string | null;
}

/**
 * Codex moves a finished session out of sessions/YYYY/MM/DD into a flat
 * archived_sessions folder beside it, so most of a long history lives there.
 * The archive is only listed when it exists, so a machine without one shows
 * no extra "missing" source.
 */
export function codexTranscriptRoots(sessionsRoot: string): UsageScanRoot[] {
  const roots: UsageScanRoot[] = [{ provider: "codex", dir: sessionsRoot, error: null }];
  const archived = join(dirname(sessionsRoot), "archived_sessions");
  let isDirectory = false;
  try {
    isDirectory = statSync(archived).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) roots.push({ provider: "codex", dir: archived, error: null });
  return roots;
}

export interface UsageScanRequest {
  roots: UsageScanRoot[];
  /** Where the parsed-record memo is persisted between runs. */
  cachePath: string;
  input: UsageSummaryInput;
}

const fileCache: ScanCache = new Map();
let cacheLoaded: Promise<void> | null = null;
let cacheLoadedFrom: string | null = null;
let cacheDirty = false;

/* ── Walking ─────────────────────────────────────────────────────────────── */

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Per-entry errors are swallowed: session files rotate and vanish while a walk
 * is in flight, and a partial listing beats failing the page.
 */
export async function listTranscriptFiles(root: string, sinceMs: number): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Never descend (or read) through a link: managed CLI homes alias back
      // into the personal home, so following one would double-count, and a
      // link cycle would hang the walk.
      if (entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await fs.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Streams one transcript and returns the usage records it holds, or null when
 * the file could not be read.
 *
 * The distinction matters to the cache: a genuinely empty transcript is a
 * stable fact worth memoising, while a transient read failure stored under the
 * same (size, mtime) would silently drop that file's usage until it changes.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const piState = initialPiScanState(basenameSessionId(filePath));

  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        // turn_context/session_meta lines carry no usage of their own but set
        // the model and session the following token_counts are attributed to,
        // so they still have to reach the reducer.
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "cora") {
        // Same reasoning: the header line names the session.
        if (!mightCarryUsage(line, provider) && !line.includes('"type":"session"')) continue;
        const record = parsePiLine(line, piState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}

// Pi session files are named `<iso>_<session id>.jsonl`; the id from the header
// line wins, this only covers a file whose header was lost to truncation.
function basenameSessionId(filePath: string): string {
  const base = basename(filePath, ".jsonl");
  const underscore = base.indexOf("_");
  return underscore === -1 ? base : base.slice(underscore + 1);
}

/** Within-file de-duplication, applied before an entry is cached. */
function dedupeWithinFile(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}

/* ── Persisted per-file memo ─────────────────────────────────────────────── */

// Positional and interned rather than object-per-record: model and session
// strings repeat on every row, and this is the difference between a cache file
// measured in tens of megabytes and one a few percent of that.
type SerializedRecord = [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  /** Index into the projects table, or null when the record carried none. */
  projectIndex: number | null,
];

interface SerializedFile {
  s: number;
  m: number;
  p: UsageProviderKind;
  r: SerializedRecord[];
}

export function encodeScanCache(cache: ScanCache): string {
  const models: string[] = [];
  const sessions: string[] = [];
  const projects: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();
  const projectIndex = new Map<string, number>();
  const intern = (table: string[], index: Map<string, number>, value: string): number => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map((record) => [
        record.timestampMs,
        intern(models, modelIndex, record.model),
        intern(sessions, sessionIndex, record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens,
        record.dedupeKey,
        record.reportedCostUsd,
        // A record read before projects existed carries no field at all.
        typeof record.project === "string" ? intern(projects, projectIndex, record.project) : null,
      ]),
    };
  }

  return JSON.stringify({ version: SCAN_CACHE_VERSION, models, sessions, projects, files });
}

/**
 * Rebuilds the memo from disk. Anything malformed is dropped rather than
 * raised: a corrupt cache should cost one cold scan, never a broken page.
 */
export function decodeScanCache(raw: string, cache: ScanCache): void {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof document !== "object" || document === null) return;
  const root = document as Record<string, unknown>;
  if (root["version"] !== SCAN_CACHE_VERSION) return;
  const models = root["models"];
  const sessions = root["sessions"];
  const projects = root["projects"];
  const files = root["files"];
  if (!Array.isArray(models) || !Array.isArray(sessions) || !Array.isArray(projects)) return;
  if (typeof files !== "object" || files === null) return;
  // A numeric entry in an intern table would pass the per-row guards below and
  // land in a record's model, so a corrupt table rejects the whole cache.
  if (!models.every((value) => typeof value === "string")) return;
  if (!sessions.every((value) => typeof value === "string")) return;
  if (!projects.every((value) => typeof value === "string")) return;

  for (const [path, raw] of Object.entries(files as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const size = entry["s"];
    const mtimeMs = entry["m"];
    const provider = entry["p"];
    const rows = entry["r"];
    if (typeof size !== "number" || typeof mtimeMs !== "number") continue;
    if (provider !== "claude" && provider !== "codex" && provider !== "cora") continue;
    if (!Array.isArray(rows)) continue;

    const records: UsageRecord[] = [];
    // One bad row disqualifies the entry: keeping the survivors under the
    // original (size, mtime) would read as a valid warm hit and the file would
    // never be re-parsed, silently losing the dropped rows' usage.
    let corrupt = false;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 11) {
        corrupt = true;
        break;
      }
      const [timestampMs, mIndex, sIndex, uncached, cached, creation, output, reasoning, dedupeKey, cost, pIndex] =
        row as SerializedRecord;
      const model = typeof mIndex === "number" ? (models as string[])[mIndex] : undefined;
      const project = typeof pIndex === "number" ? (projects as string[])[pIndex] : null;
      if (typeof pIndex === "number" && project === undefined) {
        corrupt = true;
        break;
      }
      if (
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(creation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        corrupt = true;
        break;
      }
      records.push({
        provider,
        timestampMs,
        model,
        sessionId: (typeof sIndex === "number" ? (sessions as string[])[sIndex] : undefined) ?? "",
        project: project ?? null,
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: creation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof cost === "number" ? cost : null,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    if (corrupt) continue;
    cache.set(path, { size, mtimeMs, provider, records });
  }
}

// Loaded exactly once per thread, and concurrent first readers await the same
// load rather than each cold-scanning against a still-empty memo.
function ensureScanCacheLoaded(cachePath: string): Promise<void> {
  if (cacheLoaded === null || cacheLoadedFrom !== cachePath) {
    fileCache.clear();
    cacheLoadedFrom = cachePath;
    cacheLoaded = (async () => {
      try {
        decodeScanCache(await fs.readFile(cachePath, "utf8"), fileCache);
      } catch {
        // Missing or unreadable: one cold scan, then it rewrites.
      }
    })();
  }
  return cacheLoaded;
}

async function persistScanCache(cachePath: string): Promise<void> {
  if (!cacheDirty) return;
  try {
    await fs.writeFile(cachePath, encodeScanCache(fileCache), "utf8");
    // Cleared only after the write lands, so a failed persist retries on the
    // next scan instead of leaving disk permanently stale.
    cacheDirty = false;
  } catch (err) {
    console.warn("[usage-analytics] could not persist the scan cache:", err);
  }
}

/**
 * Age at which a cache entry is dropped regardless of whether its file is still
 * there, clamped so it never falls inside the window this scan just walked.
 *
 * Were a window ever longer than the retention, the plain cutoff would sit
 * INSIDE the walked range (the mtime prefilter adds 36h of slack), so the
 * boundary files would be parsed, cached, and pruned on the same pass, then
 * re-parsed on every such scan. Never evict what this scan just looked at.
 */
export function retentionCutoffMs(startedAtMs: number, windowStartMs: number): number {
  return Math.min(startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000, windowStartMs);
}

/**
 * Drops aged-out entries and entries whose file has disappeared.
 *
 * The walk only covers the requested window, so absence from `livePaths` proves
 * deletion only for entries INSIDE it — pruning everything the walk missed
 * would evict the longer windows' entries every time someone looked at 7 days.
 */
export function pruneScanCache(cache: ScanCache, options: {
  livePaths: Set<string>;
  walkedRoots: string[];
  windowStartMs: number;
  retentionCutoffMs: number;
}): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRoots.some((root) => path.startsWith(root));
    const deleted =
      underWalkedRoot && entry.mtimeMs >= options.windowStartMs && !options.livePaths.has(path);
    if (agedOut || deleted) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/** Parses one transcript, reusing the memo when the file is unchanged. */
export async function readFileRecords(
  cache: ScanCache,
  file: TranscriptFile,
  provider: UsageProviderKind,
): Promise<UsageRecord[] | null> {
  const cached = cache.get(file.path);
  // Provider is part of the identity: were two providers ever pointed at one
  // directory, a hit parsed by the other parser must not be reused.
  if (
    cached &&
    cached.size === file.size &&
    cached.mtimeMs === file.mtimeMs &&
    cached.provider === provider
  ) {
    return cached.records;
  }

  const parsed = await readTranscriptRecords(file.path, provider);
  // A read failure is not an empty transcript: do not memoise it, and tell
  // the caller apart from an empty file (null).
  if (parsed === null) return null;
  const records = dedupeWithinFile(parsed);

  cache.set(file.path, {
    size: file.size,
    mtimeMs: file.mtimeMs,
    provider,
    records,
  });
  cacheDirty = true;
  return records;
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

let scanQueue: Promise<unknown> = Promise.resolve();

/**
 * Scans the given roots for one window. Scans run one at a time: flipping
 * through windows on a cold history would otherwise start overlapping scans
 * that each parse the same files before either has memoised them.
 */
export function scanUsage(request: UsageScanRequest): Promise<UsageSummary> {
  const run = scanQueue.then(() => scanUsageNow(request));
  scanQueue = run.catch(() => undefined);
  return run;
}

async function scanUsageNow({ roots, cachePath, input }: UsageScanRequest): Promise<UsageSummary> {
  const sinceDay = String(input?.sinceDay ?? "");
  const untilDay = String(input?.untilDay ?? "");
  const timeZone = String(input?.timeZone ?? "") || "UTC";
  if (!DAY_PATTERN.test(sinceDay) || !DAY_PATTERN.test(untilDay)) {
    throw new Error("Usage window days must be formatted YYYY-MM-DD.");
  }
  if (sinceDay > untilDay) {
    throw new Error(`Usage window start '${sinceDay}' is after its end '${untilDay}'.`);
  }
  const windowStart = Date.parse(`${sinceDay}T00:00:00Z`);
  if (Number.isNaN(windowStart)) {
    throw new Error(`Usage window start '${sinceDay}' is not a valid date.`);
  }

  const startedAtMs = Date.now();
  await ensureScanCacheLoaded(cachePath);

  const windowStartMs = windowStart - MTIME_SLACK_MS;
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay,
    untilDay,
    lookup: lookupUsagePrice,
  });

  const sources: UsageSource[] = [];
  const livePaths = new Set<string>();
  const walkedRoots: string[] = [];
  // Codex records carry no dedupe key (one file is one session), and a
  // session archived between the two walks is seen under both roots. The
  // rollout name survives the move, so it identifies the file.
  const codexFileNames = new Set<string>();
  let filesSinceYield = 0;

  for (const root of roots) {
    if (root.error !== null) {
      sources.push({
        provider: root.provider,
        dir: root.dir,
        status: "error",
        scannedFiles: 0,
        skippedFiles: 0,
        distinctSessions: 0,
        message: root.error,
      });
      continue;
    }

    let exists = false;
    try {
      exists = (await fs.stat(root.dir)).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      sources.push({
        provider: root.provider,
        dir: root.dir,
        status: "missing",
        scannedFiles: 0,
        skippedFiles: 0,
        distinctSessions: 0,
        message: "No transcript directory on this machine.",
      });
      continue;
    }

    walkedRoots.push(root.dir);
    const files = await listTranscriptFiles(root.dir, windowStartMs);
    let scannedFiles = 0;
    let skippedFiles = 0;
    // Only sessions that actually contributed in-window count: the mtime slack
    // admits boundary files whose records fall outside the range.
    const sessionIds = new Set<string>();

    for (const file of files) {
      livePaths.add(file.path);
      const codexName = root.provider === "codex" ? basename(file.path) : null;
      if (codexName !== null && codexFileNames.has(codexName)) continue;
      const read = await readFileRecords(fileCache, file, root.provider);
      // Only a file that was read claims its name: one that vanished between
      // the listing and the read (moved to archived_sessions) must leave the
      // archived copy free to count.
      if (codexName !== null && read !== null) codexFileNames.add(codexName);
      const records = read ?? [];
      if (records.length === 0) {
        skippedFiles += 1;
      } else {
        scannedFiles += 1;
        for (const record of records) {
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }
      filesSinceYield += 1;
      if (filesSinceYield >= FILES_PER_YIELD) {
        filesSinceYield = 0;
        await yieldToLoop();
      }
    }

    sources.push({
      provider: root.provider,
      dir: root.dir,
      status: "ok",
      scannedFiles,
      skippedFiles,
      distinctSessions: sessionIds.size,
      message: null,
    });
  }

  const pruned = pruneScanCache(fileCache, {
    livePaths,
    walkedRoots,
    windowStartMs,
    retentionCutoffMs: retentionCutoffMs(startedAtMs, windowStartMs),
  });
  if (pruned > 0) cacheDirty = true;
  await persistScanCache(cachePath);

  return {
    readAt: new Date().toISOString(),
    timeZone,
    sinceDay,
    untilDay,
    ...(() => {
      const result = aggregator.finish();
      return {
        buckets: result.buckets,
        projects: result.projects,
        recentSessions: result.recentSessions,
      };
    })(),
    sources,
    scanDurationMs: Math.max(0, Date.now() - startedAtMs),
    pricedBy: "model-prices",
  };
}

/* ── Timeline (usage forecast) ───────────────────────────────────────────── */

/** The subscription a record spent: Claude Code and Claude-on-Pi share the
 * Claude plan, Codex and GPT-on-Pi share ChatGPT's. Grok never reports usage. */
export type UsageTimelinePool = "anthropic" | "openai-codex";

export interface UsageTimelineRequest {
  roots: UsageScanRoot[];
  cachePath: string;
  sinceMs: number;
  bucketMs: number;
  nowMs: number;
}

export interface UsageTimeline {
  startMs: number;
  bucketMs: number;
  /** Priced spend per bucket, oldest first, ending with the bucket holding nowMs. */
  costUsd: Record<UsageTimelinePool, number[]>;
  /** Sessions that wrote a priced turn in the last ten minutes. */
  activeSessions: Record<UsageTimelinePool, number>;
}

const ACTIVE_SESSION_MS = 10 * 60 * 1000;

export function timelinePool(record: UsageRecord): UsageTimelinePool | null {
  if (record.provider === "claude") return "anthropic";
  if (record.provider === "codex") return "openai-codex";
  const model = record.model.toLowerCase();
  if (model.includes("claude") || model.startsWith("anthropic/")) return "anthropic";
  if (/(^|\/)(gpt|o\d|codex)/.test(model) || model.startsWith("openai")) return "openai-codex";
  return null;
}

/**
 * Spend per time bucket for the usage forecast, from the same memo the Usage
 * tab fills. Read-only on the transcripts; it persists the memo like a scan.
 */
export function scanUsageTimeline(request: UsageTimelineRequest): Promise<UsageTimeline> {
  const run = scanQueue.then(() => scanUsageTimelineNow(request));
  scanQueue = run.catch(() => undefined);
  return run;
}

async function scanUsageTimelineNow({
  roots,
  cachePath,
  sinceMs,
  bucketMs,
  nowMs,
}: UsageTimelineRequest): Promise<UsageTimeline> {
  await ensureScanCacheLoaded(cachePath);
  const startMs = Math.floor(sinceMs / bucketMs) * bucketMs;
  const count = Math.max(1, Math.floor((nowMs - startMs) / bucketMs) + 1);
  const costUsd: Record<UsageTimelinePool, number[]> = {
    anthropic: new Array<number>(count).fill(0),
    "openai-codex": new Array<number>(count).fill(0),
  };
  const recent: Record<UsageTimelinePool, Set<string>> = {
    anthropic: new Set(),
    "openai-codex": new Set(),
  };
  // Claude repeats a message across files when a session is resumed or
  // forked; the per-file dedupe cannot see that, so it is done again here.
  const seen = new Set<string>();
  // As in scanUsageNow: a Codex rollout seen under sessions/ and
  // archived_sessions/ counts once, claimed only once it was read.
  const codexFileNames = new Set<string>();
  let filesSinceYield = 0;

  for (const root of roots) {
    if (root.error !== null || root.dir.length === 0) continue;
    const files = await listTranscriptFiles(root.dir, startMs - MTIME_SLACK_MS);
    for (const file of files) {
      const codexName = root.provider === "codex" ? basename(file.path) : null;
      if (codexName !== null && codexFileNames.has(codexName)) continue;
      const read = await readFileRecords(fileCache, file, root.provider);
      if (codexName !== null && read !== null) codexFileNames.add(codexName);
      for (const record of read ?? []) {
        if (record.timestampMs < startMs || record.timestampMs > nowMs) continue;
        if (record.dedupeKey !== null) {
          if (seen.has(record.dedupeKey)) continue;
          seen.add(record.dedupeKey);
        }
        const pool = timelinePool(record);
        if (pool === null) continue;
        const { costUsd: cost } = priceUsageRecord(
          lookupUsagePrice,
          record.provider,
          record.model,
          record.totals,
          record.reportedCostUsd,
        );
        if (!(cost > 0)) continue;
        costUsd[pool][Math.floor((record.timestampMs - startMs) / bucketMs)] += cost;
        if (nowMs - record.timestampMs <= ACTIVE_SESSION_MS && record.sessionId.length > 0) {
          recent[pool].add(record.sessionId);
        }
      }
      filesSinceYield += 1;
      if (filesSinceYield >= FILES_PER_YIELD) {
        filesSinceYield = 0;
        await yieldToLoop();
      }
    }
  }
  await persistScanCache(cachePath);

  return {
    startMs,
    bucketMs,
    costUsd,
    activeSessions: {
      anthropic: recent.anthropic.size,
      "openai-codex": recent["openai-codex"].size,
    },
  };
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
