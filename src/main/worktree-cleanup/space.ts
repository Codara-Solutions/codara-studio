import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeSize, WorktreeSizeEvent } from "@shared/worktree-cleanup";
import { writeFileAtomic } from "../fs-atomic";

// Size on disk of each worktree, measured in the background with a budget
// and cached on disk, so the cleanup screen opens on the last known sizes
// and refreshes the stale ones while it is open.
//
// macOS and Linux ask `du -sk -x` (fast, native, stays on one file system);
// Windows has no du, so a Node walk counts file sizes under an entry and time
// budget. A walk that runs out of budget, or a folder that cannot be read,
// gives a lower bound marked incomplete rather than a guess.

export const SIZE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DU_TIMEOUT_MS = 60_000;
const WALK_TIMEOUT_MS = 20_000;
const WALK_MAX_ENTRIES = 250_000;
const WALK_CONCURRENCY = 32;
const TOTAL_BUDGET_MS = 4 * 60 * 1000;
const CACHE_LIMIT = 2_000;

export interface Measured {
  bytes: number;
  complete: boolean;
  error?: string;
}

export type DuRunner = (dir: string, timeoutMs: number, signal?: AbortSignal) => Promise<Measured | null>;

/** Null when du is missing or gave nothing usable; the walk then measures. */
export const runDu: DuRunner = (dir, timeoutMs, signal) =>
  new Promise((done) => {
    try {
      execFile(
        "du",
        ["-sk", "-x", dir],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) },
        (error, stdout) => {
          const match = /^(\d+)\s/.exec(String(stdout ?? "").trim() + "\t");
          if (!match) {
            done(null);
            return;
          }
          // du exits non-zero yet prints a total when some folders were
          // unreadable: that total is a lower bound.
          done({
            bytes: Number(match[1]) * 1024,
            complete: !error,
            ...(error ? { error: "some folders could not be read" } : {}),
          });
        },
      );
    } catch {
      done(null);
    }
  });

/** Counts what lies under `dir` without following links or crossing into another file system. */
export async function walkSize(
  dir: string,
  options: { maxEntries?: number; timeoutMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<Measured> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? WALK_TIMEOUT_MS);
  let budget = options.maxEntries ?? WALK_MAX_ENTRIES;
  const root = await fsp.lstat(dir);
  if (!root.isDirectory()) return { bytes: root.size, complete: true };
  const usage = (stat: { size: number; blocks?: number }): number =>
    typeof stat.blocks === "number" && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
  let bytes = usage(root);
  let complete = true;
  let unreadable = false;
  let level = [dir];
  while (level.length) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += WALK_CONCURRENCY) {
      if (options.signal?.aborted || now() > deadline || budget <= 0) {
        complete = false;
        break;
      }
      const batch = level.slice(i, i + WALK_CONCURRENCY);
      await Promise.all(
        batch.map(async (folder) => {
          const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => null);
          if (!entries) {
            unreadable = true;
            return;
          }
          budget -= entries.length;
          for (const entry of entries) {
            const path = join(folder, entry.name);
            const stat = await fsp.lstat(path).catch(() => null);
            if (!stat) {
              unreadable = true;
              continue;
            }
            bytes += usage(stat);
            if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev) next.push(path);
          }
        }),
      );
    }
    if (!complete) break;
    level = next;
  }
  if (unreadable) complete = false;
  return { bytes, complete, ...(unreadable ? { error: "some folders could not be read" } : {}) };
}

export async function measureDirectory(
  dir: string,
  options: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    du?: DuRunner;
    duTimeoutMs?: number;
    walkTimeoutMs?: number;
    walkMaxEntries?: number;
    now?: () => number;
  } = {},
): Promise<WorktreeSize> {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const viaDu = await (options.du ?? runDu)(dir, options.duTimeoutMs ?? DU_TIMEOUT_MS, options.signal);
    if (viaDu) return { ...viaDu, measuredAt: now() };
  }
  try {
    const walked = await walkSize(dir, {
      maxEntries: options.walkMaxEntries,
      timeoutMs: options.walkTimeoutMs,
      signal: options.signal,
      now,
    });
    return { ...walked, measuredAt: now() };
  } catch (err) {
    return {
      bytes: 0,
      complete: false,
      measuredAt: now(),
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

// ── Cache ──────────────────────────────────────────────────────────────────

export interface SizeStore {
  load(): Promise<void>;
  get(id: string): WorktreeSize | null;
  set(id: string, size: WorktreeSize): void;
  delete(id: string): void;
  flush(): Promise<void>;
}

function isSize(value: unknown): value is WorktreeSize {
  const size = value as Partial<WorktreeSize> | null;
  return Boolean(
    size &&
      typeof size.bytes === "number" &&
      Number.isFinite(size.bytes) &&
      typeof size.complete === "boolean" &&
      typeof size.measuredAt === "number",
  );
}

export function createSizeStore(file: string, options: { saveDelayMs?: number } = {}): SizeStore {
  const entries = new Map<string, WorktreeSize>();
  let loaded: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    const sorted = [...entries.entries()].sort((a, b) => b[1].measuredAt - a[1].measuredAt).slice(0, CACHE_LIMIT);
    const body = JSON.stringify({ version: 1, entries: Object.fromEntries(sorted) });
    writing = writing
      .then(async () => {
        await fsp.mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, body);
      })
      .catch(() => undefined);
    return writing;
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, options.saveDelayMs ?? 500);
    timer.unref?.();
  };

  return {
    load() {
      loaded ??= fsp
        .readFile(file, "utf8")
        .then((text) => {
          const parsed = JSON.parse(text) as { entries?: Record<string, unknown> };
          for (const [id, size] of Object.entries(parsed.entries ?? {})) {
            if (isSize(size) && !entries.has(id)) entries.set(id, size);
          }
        })
        .catch(() => undefined);
      return loaded;
    },
    get: (id) => entries.get(id) ?? null,
    set(id, size) {
      entries.set(id, size);
      schedule();
    },
    delete(id) {
      if (entries.delete(id)) schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        await write();
      }
      await writing;
    },
  };
}

// ── Background queue ───────────────────────────────────────────────────────

export interface SizeRequest {
  id: string;
  path: string;
  /** Lower runs later; the main checkout is never reclaimable, so it goes last. */
  priority?: number;
}

export interface SizeMeasurer {
  enqueue(items: readonly SizeRequest[], options?: { force?: boolean }): number;
  cancel(): void;
  pending(): number;
}

export function createSizeMeasurer(deps: {
  store: SizeStore;
  measure: (path: string, signal: AbortSignal) => Promise<WorktreeSize>;
  onEvent: (event: WorktreeSizeEvent) => void;
  now?: () => number;
  maxAgeMs?: number;
  totalBudgetMs?: number;
  concurrency?: number;
}): SizeMeasurer {
  const now = deps.now ?? Date.now;
  const queue: SizeRequest[] = [];
  const running = new Map<string, AbortController>();
  let startedAt: number | null = null;

  const pending = (): number => queue.length + running.size;

  const pump = (): void => {
    const limit = deps.concurrency ?? 1;
    while (running.size < limit && queue.length) {
      if (startedAt !== null && now() - startedAt > (deps.totalBudgetMs ?? TOTAL_BUDGET_MS)) {
        queue.length = 0;
        if (running.size === 0) {
          startedAt = null;
          deps.onEvent({ pending: 0, budgetSpent: true });
        }
        return;
      }
      const item = queue.shift()!;
      const controller = new AbortController();
      running.set(item.id, controller);
      // After a cancel the same id may be measured again under a new
      // controller; a late answer from the old one must not touch it.
      const settle = (): void => {
        if (running.get(item.id) === controller) running.delete(item.id);
      };
      void deps
        .measure(item.path, controller.signal)
        .then((size) => {
          if (controller.signal.aborted) return;
          deps.store.set(item.id, size);
          settle();
          deps.onEvent({ measured: { id: item.id, size }, pending: pending() });
        })
        .catch(() => {
          settle();
          if (!controller.signal.aborted) deps.onEvent({ pending: pending() });
        })
        .finally(() => {
          if (pending() === 0) startedAt = null;
          pump();
        });
    }
  };

  return {
    enqueue(items, options = {}) {
      const maxAge = deps.maxAgeMs ?? SIZE_MAX_AGE_MS;
      const fresh = (id: string): boolean => {
        const cached = deps.store.get(id);
        return Boolean(cached && cached.complete && now() - cached.measuredAt < maxAge);
      };
      let added = 0;
      const ordered = [...items].sort((a, b) => {
        const priority = (b.priority ?? 0) - (a.priority ?? 0);
        if (priority) return priority;
        // Never measured first, then the oldest measurement.
        return (deps.store.get(a.id)?.measuredAt ?? 0) - (deps.store.get(b.id)?.measuredAt ?? 0);
      });
      for (const item of ordered) {
        if (running.has(item.id) || queue.some((queued) => queued.id === item.id)) continue;
        if (!options.force && fresh(item.id)) continue;
        queue.push(item);
        added += 1;
      }
      if (added && startedAt === null) startedAt = now();
      pump();
      return added;
    },
    cancel() {
      queue.length = 0;
      for (const controller of running.values()) controller.abort();
      running.clear();
      startedAt = null;
    },
    pending,
  };
}
