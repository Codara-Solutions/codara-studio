import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RunState } from "@shared/types";
import { findRemoteCoraRetry, type RemoteCoraRetryInput } from "./cora-policy";

const RUN_FILE = "run.json";

/**
 * How far back a legacy/crash repair scan looks.
 *
 * The gap this covers is narrow: a delivery that wrote its run and then lost
 * the receipt write (host died in between), or a delivery that predates the
 * receipt index. The RETRY, though, only arrives once the host is reachable
 * again, so the window is sized for a host OUTAGE, not for the millisecond
 * crash gap itself — a laptop that died on Friday evening and came back on
 * Monday must still reconcile the phone's retry rather than start a second
 * conversation. A week is the honest horizon: past it a phone still holding an
 * unsent message is no longer a case this repair can distinguish from a
 * genuinely new send, and the byte scan below stays proportional to a week of
 * activity instead of the whole retained tree.
 *
 * Runs are selected by run.json mtime, which is always >= the run's createdAt
 * (run-store rewrites the whole file on every commit), so "created inside the
 * window" is a strict subset of "written inside the window": the filter cannot
 * drop a run this repair is looking for.
 */
export const CORA_RETRY_REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Safety ceiling on run files whose BYTES are scanned in one repair — NOT the
 * primary bound. The window is the bound; this only stops a pathological tree
 * from turning one send into unbounded IO. Retention keeps 50 terminal runs
 * plus the live ones, so reaching this many run files inside the window means
 * retention itself is broken (which is exactly the failure this replaces: an
 * unwindowed count cap that every busy machine crossed permanently).
 */
export const CORA_RETRY_REPAIR_READ_LIMIT = 1_024;

/**
 * Ceiling on run BODIES parsed in one repair. The byte pre-filter normally
 * yields at most one candidate, so this only binds when a retry key collides
 * with an unrelated string in many run files. Failing closed there is right:
 * the scan genuinely could not adjudicate every candidate.
 */
export const CORA_RETRY_REPAIR_PARSE_LIMIT = 64;

/** Concurrent run.json reads. Bounded so one repair cannot spike memory. */
const REPAIR_READ_CONCURRENCY = 8;

export interface CoraRetryRepairEntry {
  name: string;
  mtimeMs: number;
}

export interface CoraRetryRepairSelection {
  names: string[];
  /**
   * The window itself held more run files than the read ceiling allowed, so a
   * miss below is genuinely inconclusive. Never set by old runs piling up.
   */
  truncated: boolean;
}

export interface CoraRetryRepairDeps {
  runsRoot: string;
  loadRun: (runId: string) => Promise<RunState | null>;
  now?: () => number;
  windowMs?: number;
  readLimit?: number;
  parseLimit?: number;
}

export interface CoraRetryRepairResult {
  run?: RunState;
  /**
   * The scan could not adjudicate every candidate it should have. The caller
   * must not treat a missing run as proof that this is a first delivery.
   */
  truncated: boolean;
  /** Run files whose bytes were scanned — for logs and tests. */
  scanned: number;
  /** Run bodies actually parsed, i.e. files that carried the retry key. */
  inspected: number;
}

/**
 * Newest-first run directories written inside the repair window, capped.
 *
 * Order and cap are applied AFTER the window filter, so an old run can never
 * consume a slot or raise `truncated`.
 */
export function selectCoraRetryRepairCandidates(
  entries: readonly CoraRetryRepairEntry[],
  options: { now: number; windowMs: number; readLimit: number },
): CoraRetryRepairSelection {
  const windowMs = Math.max(0, options.windowMs);
  const readLimit = Math.max(0, Math.floor(options.readLimit));
  const cutoff = options.now - windowMs;
  // Entries without a readable run.json carry a non-finite mtime and are
  // dropped here, so stray files (.DS_Store, a leftover temp write) can neither
  // occupy a read slot nor inflate `truncated`.
  const windowed = entries
    .filter(
      (entry) =>
        Number.isFinite(entry.mtimeMs) && (entry.mtimeMs as number) >= cutoff,
    )
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    );
  return {
    names: windowed.slice(0, readLimit).map((entry) => entry.name),
    truncated: windowed.length > readLimit,
  };
}

/**
 * One-time repair for a new-conversation retry whose receipt is missing.
 *
 * Normal retries never reach this: the receipt index routes them with a single
 * getRun(). This path exists for a delivery that predates the index and for a
 * host that died between committing the run and committing its receipt.
 *
 * Two bounds, in order: only run files WRITTEN inside the repair window are
 * candidates, and only those whose bytes actually carry the retry key are
 * parsed. A workspace with thousands of retained runs therefore costs a
 * directory listing plus a few stats, and can no longer make a first send fail.
 */
export async function repairCoraRetryFromRunWindow(
  input: RemoteCoraRetryInput,
  deps: CoraRetryRepairDeps,
): Promise<CoraRetryRepairResult> {
  const now = deps.now ?? Date.now;
  const parseLimit = Math.max(
    0,
    Math.floor(deps.parseLimit ?? CORA_RETRY_REPAIR_PARSE_LIMIT),
  );
  const selection = selectCoraRetryRepairCandidates(
    await listRunFileEntries(deps.runsRoot),
    {
      now: now(),
      windowMs: deps.windowMs ?? CORA_RETRY_REPAIR_WINDOW_MS,
      readLimit: deps.readLimit ?? CORA_RETRY_REPAIR_READ_LIMIT,
    },
  );
  if (selection.names.length === 0) {
    return { truncated: selection.truncated, scanned: 0, inspected: 0 };
  }

  // Byte-level pre-filter. A run body is only parsed when its file literally
  // carries the retry key, so the scan stays cheap even when the window is wide
  // and run bodies are large. The needle is the key's JSON token, quotes
  // included: run.json is JSON.stringify output, so those are the exact bytes
  // an escaped id was written as, and the closing quote keeps a key from
  // matching inside a longer id. A false positive (some unrelated string equal
  // to the key) only costs one parse — findRemoteCoraRetry still adjudicates.
  const needle = JSON.stringify(input.clientMessageId);
  const hits = (
    await mapWithConcurrency(
      selection.names,
      REPAIR_READ_CONCURRENCY,
      async (name) => {
        let raw: Buffer;
        try {
          raw = await fs.readFile(join(deps.runsRoot, name, RUN_FILE));
        } catch {
          // Unreadable, or purged by retention mid-scan: it cannot be the run
          // we owe an answer for, because that run is readable by definition.
          return null;
        }
        return raw.includes(needle) ? name : null;
      },
    )
  ).filter((name): name is string => name !== null);

  const candidates: RunState[] = [];
  for (const name of hits.slice(0, parseLimit)) {
    const run = await deps.loadRun(name);
    if (run) candidates.push(run);
  }
  // Newest-first order is preserved, so a duplicated key resolves to the same
  // run the unwindowed scan used to pick.
  const run = findRemoteCoraRetry(candidates, input);
  return {
    ...(run ? { run } : {}),
    truncated: selection.truncated || (!run && hits.length > parseLimit),
    scanned: selection.names.length,
    inspected: candidates.length,
  };
}

async function listRunFileEntries(
  runsRoot: string,
): Promise<CoraRetryRepairEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const stat = await fs.stat(join(runsRoot, name, RUN_FILE));
        return { name, mtimeMs: stat.mtimeMs };
      } catch {
        // No readable run.json: never a repair target.
        return { name, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    }),
  );
  return entries;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
