// Hook watcher — the consumer half of the "CLI hook ingestion" big-bet.
// Watches <spark-home>/hooks/ for JSON files dropped by `spark-hook.py`,
// reads each file, routes the event to run-store, then moves the file to
// <spark-home>/hooks/processed/ so we don't reprocess it on app restart.
//
// Design rules
// ------------
// 1. fs.watch (not chokidar) — Codara already uses fs.watch elsewhere
//    (fs-watcher.ts) and the burst rate here is small (a tool-heavy Claude
//    turn might produce 30-50 files; not 30k). Falling back to a scan on
//    "rename" events keeps Windows/macOS quirks from dropping events.
// 2. Race-safe reads — when fs.watch fires on a new file, the writer's
//    `os.replace()` may not have committed the rename yet on Windows. We
//    open-read with a small retry/backoff (200ms × 3) before giving up.
// 3. Self-healing — the hooks dir is auto-created on start. If it's deleted
//    out from under us mid-run, we re-create on the next tick and re-arm.
// 4. Malformed input is dropped, not crashed. We log once per file with the
//    parse error and the raw bytes (capped to 1KiB) so the user can diagnose.
// 5. Routing rules:
//      Notification     → applyHookStateReport({state: "blocked"})
//      Stop / SubagentStop → applyHookStateReport({state: "done"})
//      SessionStart     → appendEvent + capture session_id from payload
//      every other hook → appendEvent only (PreToolUse, PostToolUse,
//                         UserPromptSubmit, PreCompact, ...)

import { promises as fs, type Dir, type FSWatcher } from "node:fs";
import { watch as fsWatch } from "node:fs";
import { join } from "node:path";

import { recordSessionStart } from "./agent-session-registry";
import { sparkHome } from "./spark-home";

type RunStoreModule = typeof import("./orchestration/run-store");

const HOOKS_SUBDIR = "hooks";
const PROCESSED_SUBDIR = "processed";

// Files we drop into hooks/ are uuid.json — anything else is either our own
// tmp file (".tmp" suffix from the python writer) or unrelated user noise we
// should ignore. The python writer renames .tmp → uuid.json atomically so we
// never read a half-written file.
const HOOK_FILE_PATTERN = /\.json$/i;
const TMP_FILE_PATTERN = /\.tmp$/i;

// Race-safe read: on Windows the fs.watch event fires before os.replace()
// has finished committing, so the first open can ENOENT or hand us a 0-byte
// file. Retry a few times with short backoff. Three tries at 60/120/240 ms
// covers every observed delay in dev; if it still fails after that the file
// is genuinely broken / missing and we drop.
const READ_RETRIES = 3;
const READ_RETRY_BASE_MS = 60;

// Cap on the bytes we'll read from a single hook file. Real hook payloads
// (PreToolUse for a large tool input) can be a few KB; 256 KiB is the cap
// from above which we treat the file as hostile/corrupt and drop it.
// spark-hook.py trims payloads at the source (96KB budget), so anything this
// large predates the trim or bypassed the writer.
const MAX_HOOK_FILE_BYTES = 256 * 1024;

// A cold-start backlog can hold dozens of oversized files (each Claude
// session on the machine drops hooks here while Codara is closed); one
// summary line beats a page of per-file warnings.
let oversizedDropCount = 0;
let oversizedDropBytes = 0;
let oversizedFlushTimer: NodeJS.Timeout | null = null;

function noteOversizedDrop(size: number): void {
  oversizedDropCount++;
  oversizedDropBytes += size;
  if (oversizedFlushTimer === null) {
    oversizedFlushTimer = setTimeout(() => {
      oversizedFlushTimer = null;
      const mb = (oversizedDropBytes / (1024 * 1024)).toFixed(1);
      console.warn(
        `[hook-watcher] dropped ${oversizedDropCount} oversized hook file(s) (${mb} MB total; per-file cap ${MAX_HOOK_FILE_BYTES} bytes)`,
      );
      oversizedDropCount = 0;
      oversizedDropBytes = 0;
    }, 1000);
    oversizedFlushTimer.unref?.();
  }
}

// Debounce window when fs.watch sees a "rename" event but the file name is
// missing (Windows on some volumes). We rescan the directory and process
// any new uuid.json files. Set high enough that we coalesce a 30-event
// burst into one scan; low enough that we still feel real-time.
const RESCAN_DEBOUNCE_MS = 50;

// Native directory watchers are inode-bound on macOS/Linux. If hooks/ is
// deleted and recreated, the old watcher can remain alive but permanently
// deaf. Re-arm failures use one bounded exponential-backoff timer, and a
// lightweight identity check catches silent directory replacement even when
// the platform emits neither "error" nor "close".
const REARM_BASE_DELAY_MS = 100;
const REARM_MAX_DELAY_MS = 2_000;
const WATCH_HEALTH_INTERVAL_MS = 30_000;

// Concurrency cap for handleFile. The "burst rate here is small" assumption
// above holds for a live session, but the cold-start backlog does not: the
// hooks dir accumulates while Codara is closed (every Claude CLI session on
// the machine drops files here), and the initial rescan once hit 11k+
// pending files — firing an unbounded handleFile per entry exhausted the
// process's file handles (EMFILE) and broke app launch. Slots hand off
// directly to the next waiter so the cap is exact.
const MAX_CONCURRENT_HANDLES = 16;
let handleSlotsAvailable = MAX_CONCURRENT_HANDLES;
const handleSlotWaiters: Array<() => void> = [];

async function acquireHandleSlot(): Promise<void> {
  if (handleSlotsAvailable > 0) {
    handleSlotsAvailable--;
    return;
  }
  await new Promise<void>((resolve) => handleSlotWaiters.push(resolve));
}

function releaseHandleSlot(): void {
  const next = handleSlotWaiters.shift();
  if (next) next();
  // Clamp: waiters force-woken by stopHookWatcher() release a slot they were
  // never handed; without the cap a stop with a deep queue would let the
  // count drift past MAX for a later watcher restart.
  else handleSlotsAvailable = Math.min(MAX_CONCURRENT_HANDLES, handleSlotsAvailable + 1);
}

// processed/ retention. Files there exist only so a restart doesn't replay
// already-routed events; after a week they are pure dead weight (the dir was
// once found holding 114k files, slowing every readdir of its parent).
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_PRUNE_BATCH = 200;
// Let app boot settle before spending IO on the prune.
const PROCESSED_PRUNE_DELAY_MS = 30_000;
// Continue a large sweep in small, yielded chunks, then revisit retention
// periodically for long-running app sessions.
const PROCESSED_PRUNE_CONTINUE_MS = 25;
const PROCESSED_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The cold-start backlog sweep is deferred past first paint. startHookWatcher()
// runs immediately before createWindow(), and a backlog of a few hundred files
// (each a stat + read + parse + rename, and the first one with a paneId pulls
// in the run-store chunk) is enough main-process work to visibly delay the
// BrowserWindow and its renderer load. Nothing is lost by waiting: fs.watch is
// still armed synchronously below, so live hook files are handled the moment
// they land, and the backlog is by definition already stale.
const INITIAL_SCAN_DELAY_MS = 3_000;

interface WatcherState {
  hooksDir: string;
  processedDir: string;
  watcher: FSWatcher | null;
  // Monotonic lifecycle token. Every invalidation and stop advances it, so
  // callbacks from a closed watcher or an old async arm attempt are inert.
  generation: number;
  watchedDirectoryIdentity: string | null;
  armCount: number;
  rearmAttempt: number;
  rearmTimer: NodeJS.Timeout | null;
  rearmPromise: Promise<void> | null;
  healthTimer: NodeJS.Timeout | null;
  healthPromise: Promise<void> | null;
  // Files we've already kicked off processing for in this process lifetime.
  // Prevents the same uuid being handled twice if fs.watch sends duplicate
  // events (which it can — same inode, different listeners on macOS).
  inFlight: Set<string>;
  // Set when stopHookWatcher() is called; we use this to bail out of any
  // pending retries / rescans so shutdown is prompt.
  stopped: boolean;
  // Rescan debounce timer for the directory-level fallback path.
  rescanTimer: NodeJS.Timeout | null;
  // One-shot timer for the deferred cold-start backlog sweep.
  initialScanTimer: NodeJS.Timeout | null;
  // One-shot timer for the deferred processed/ retention prune.
  pruneTimer: NodeJS.Timeout | null;
  pruneDueAt: number | null;
  prunePromise: Promise<void> | null;
  pruneDir: Dir | null;
  pruneCutoff: number;
  pruneCount: number;
  pruneSweepCount: number;
  // Lazy-resolved run-store. We use a Promise so concurrent dispatches
  // share the import.
  runStorePromise: Promise<RunStoreModule> | null;
}

let active: WatcherState | null = null;

// Wrapper that the Python script emits. We re-validate every field at the
// read site because the file may have been hand-edited or corrupted. Both
// `paneId` and `payload` may be empty strings / null respectively when the
// script's stdin/env was empty; we propagate that to run-store which then
// drops the event (no worker to attach to).
interface HookFileEnvelope {
  hookName: string;
  timestamp: string;
  paneId: string;
  payload: unknown;
  parseError?: string;
}

export async function startHookWatcher(): Promise<void> {
  if (active) return;

  const hooksDir = join(sparkHome(), HOOKS_SUBDIR);
  const processedDir = join(hooksDir, PROCESSED_SUBDIR);

  const state: WatcherState = {
    hooksDir,
    processedDir,
    watcher: null,
    generation: 1,
    watchedDirectoryIdentity: null,
    armCount: 0,
    rearmAttempt: 0,
    rearmTimer: null,
    rearmPromise: null,
    healthTimer: null,
    healthPromise: null,
    inFlight: new Set(),
    stopped: false,
    rescanTimer: null,
    initialScanTimer: null,
    pruneTimer: null,
    pruneDueAt: null,
    prunePromise: null,
    pruneDir: null,
    pruneCutoff: 0,
    pruneCount: 0,
    pruneSweepCount: 0,
    runStorePromise: null,
  };
  // Claim ownership before the first await. Two startup paths can otherwise
  // both pass the `active` check while mkdir is pending and publish duplicate
  // native watchers.
  active = state;

  // Pick up any files that were dropped while Codara was shut down. Without
  // this, a long-running Claude session that emitted hooks during a crash
  // would have those events lost forever. Deferred past first paint — see
  // INITIAL_SCAN_DELAY_MS. Files the live watcher already handled in the
  // meantime are gone from hooks/ (moved to processed/) so the sweep won't
  // see them, and one still in flight is held off by state.inFlight.
  state.initialScanTimer = setTimeout(() => {
    state.initialScanTimer = null;
    void rescanDirectory(state).catch((err) =>
      console.warn("[hook-watcher] initial rescan failed:", err),
    );
  }, INITIAL_SCAN_DELAY_MS);
  state.initialScanTimer.unref?.();

  // Retention prune for processed/, deferred past boot so the (potentially
  // large) stat sweep never competes with startup IO.
  schedulePrune(state, PROCESSED_PRUNE_DELAY_MS);

  let armed = false;
  const initialArm = (async () => {
    armed = await armWatcher(state, state.generation);
  })();
  state.rearmPromise = initialArm;
  try {
    await initialArm;
  } finally {
    if (state.rearmPromise === initialArm) state.rearmPromise = null;
  }
  if (!armed && !state.stopped) {
    scheduleRearm(state);
  }
}

function isCurrentGeneration(state: WatcherState, generation: number): boolean {
  return active === state && !state.stopped && state.generation === generation;
}

function isCurrentWatcher(
  state: WatcherState,
  watcher: FSWatcher,
  generation: number,
): boolean {
  return isCurrentGeneration(state, generation) && state.watcher === watcher;
}

async function armWatcher(state: WatcherState, generation: number): Promise<boolean> {
  if (!isCurrentGeneration(state, generation) || state.watcher !== null) return false;

  try {
    await fs.mkdir(state.hooksDir, { recursive: true });
    await fs.mkdir(state.processedDir, { recursive: true });
  } catch (err) {
    if (isCurrentGeneration(state, generation)) {
      console.warn("[hook-watcher] failed to ensure hooks dir for re-arm:", err);
    }
    return false;
  }
  if (!isCurrentGeneration(state, generation) || state.watcher !== null) return false;

  const beforeIdentity = await directoryIdentity(state.hooksDir);
  if (beforeIdentity === null || !isCurrentGeneration(state, generation)) return false;

  let watcher: FSWatcher;
  try {
    watcher = fsWatch(state.hooksDir, { persistent: true }, (_eventType, filename) => {
      if (!isCurrentWatcher(state, watcher, generation)) return;
      if (filename && typeof filename === "string") {
        const name = filename.toString();
        if (TMP_FILE_PATTERN.test(name)) return;
        if (HOOK_FILE_PATTERN.test(name)) {
          void handleFile(state, name).catch((err) =>
            console.warn("[hook-watcher] handle failed:", err),
          );
          return;
        }
      }
      scheduleRescan(state, generation);
    });
  } catch (err) {
    if (isCurrentGeneration(state, generation)) {
      console.warn("[hook-watcher] failed to start fs.watch on", state.hooksDir, ":", err);
    }
    return false;
  }

  if (!isCurrentGeneration(state, generation) || state.watcher !== null) {
    try {
      watcher.close();
    } catch {
      // A watcher that lost the generation race has no remaining owner.
    }
    return false;
  }

  state.watcher = watcher;
  state.watchedDirectoryIdentity = beforeIdentity;
  state.armCount++;
  state.rearmAttempt = 0;

  watcher.on("error", (err) => {
    if (!isCurrentWatcher(state, watcher, generation)) return;
    console.warn("[hook-watcher] fs.watch error:", err);
    invalidateWatcher(state, watcher, generation, "watcher error");
  });
  watcher.on("close", () => {
    if (!isCurrentWatcher(state, watcher, generation)) return;
    invalidateWatcher(state, watcher, generation, "watcher closed");
  });

  // Close the narrow stat→watch race: if another process replaced hooks/
  // between those operations, this watcher belongs to the old inode.
  const afterIdentity = await directoryIdentity(state.hooksDir);
  if (
    !isCurrentWatcher(state, watcher, generation) ||
    afterIdentity === null ||
    afterIdentity !== beforeIdentity
  ) {
    if (isCurrentWatcher(state, watcher, generation)) {
      invalidateWatcher(state, watcher, generation, "directory changed while arming");
    }
    return false;
  }

  scheduleHealthCheck(state, generation, WATCH_HEALTH_INTERVAL_MS);
  return true;
}

function invalidateWatcher(
  state: WatcherState,
  expectedWatcher: FSWatcher | null,
  generation: number,
  _reason: string,
): void {
  if (!isCurrentGeneration(state, generation)) return;
  if (expectedWatcher !== null && state.watcher !== expectedWatcher) return;

  const watcher = state.watcher;
  state.watcher = null;
  state.watchedDirectoryIdentity = null;
  state.generation++;
  state.rearmAttempt = 0;
  if (state.rescanTimer !== null) {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = null;
  }
  if (state.healthTimer !== null) {
    clearTimeout(state.healthTimer);
    state.healthTimer = null;
  }
  try {
    watcher?.close();
  } catch (err) {
    console.warn("[hook-watcher] watcher.close during re-arm threw:", err);
  }
  scheduleRearm(state);
}

function scheduleRearm(state: WatcherState): void {
  if (
    state.stopped ||
    active !== state ||
    state.watcher !== null ||
    state.rearmTimer !== null ||
    state.rearmPromise !== null
  ) {
    return;
  }
  const generation = state.generation;
  const delayMs = Math.min(
    REARM_MAX_DELAY_MS,
    REARM_BASE_DELAY_MS * 2 ** Math.min(state.rearmAttempt, 8),
  );
  state.rearmTimer = setTimeout(() => {
    state.rearmTimer = null;
    if (!isCurrentGeneration(state, generation) || state.watcher !== null) return;

    let armed = false;
    const pending = (async () => {
      armed = await armWatcher(state, generation);
      if (!armed && isCurrentGeneration(state, generation)) {
        state.rearmAttempt++;
      }
    })();
    state.rearmPromise = pending;
    void pending
      .catch((err) => console.warn("[hook-watcher] re-arm failed:", err))
      .finally(() => {
        if (state.rearmPromise === pending) state.rearmPromise = null;
        if (!state.stopped && active === state && state.watcher === null) {
          scheduleRearm(state);
        }
      });
  }, delayMs);
  state.rearmTimer.unref?.();
}

function scheduleRescan(state: WatcherState, generation: number): void {
  if (!isCurrentGeneration(state, generation) || state.rescanTimer !== null) return;
  state.rescanTimer = setTimeout(() => {
    state.rescanTimer = null;
    if (!isCurrentGeneration(state, generation)) return;
    void rescanDirectory(state).catch((err) =>
      console.warn("[hook-watcher] rescan failed:", err),
    );
  }, RESCAN_DEBOUNCE_MS);
  state.rescanTimer.unref?.();
}

function scheduleHealthCheck(
  state: WatcherState,
  generation: number,
  delayMs: number,
): void {
  if (!isCurrentGeneration(state, generation) || state.healthTimer !== null) return;
  state.healthTimer = setTimeout(() => {
    state.healthTimer = null;
    if (!isCurrentGeneration(state, generation)) return;
    const pending = checkWatcherHealth(state, generation);
    state.healthPromise = pending;
    void pending
      .catch((err) => console.warn("[hook-watcher] health check failed:", err))
      .finally(() => {
        if (state.healthPromise === pending) state.healthPromise = null;
        if (isCurrentGeneration(state, generation) && state.watcher !== null) {
          scheduleHealthCheck(state, generation, WATCH_HEALTH_INTERVAL_MS);
        }
      });
  }, delayMs);
  state.healthTimer.unref?.();
}

async function checkWatcherHealth(state: WatcherState, generation: number): Promise<void> {
  if (!isCurrentGeneration(state, generation)) return;
  const identity = await directoryIdentity(state.hooksDir);
  if (!isCurrentGeneration(state, generation)) return;
  if (
    identity === null ||
    state.watchedDirectoryIdentity === null ||
    identity !== state.watchedDirectoryIdentity
  ) {
    invalidateWatcher(state, state.watcher, generation, "health check");
  }
}

async function directoryIdentity(dirPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return null;
    // birthtime covers filesystems/platforms that report a non-distinct or
    // zero inode for replaced directories (notably some Windows volumes).
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    return null;
  }
}

export async function stopHookWatcher(): Promise<void> {
  if (!active) return;
  const state = active;
  state.stopped = true;
  state.generation++;
  if (state.rescanTimer !== null) {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = null;
  }
  if (state.initialScanTimer !== null) {
    clearTimeout(state.initialScanTimer);
    state.initialScanTimer = null;
  }
  if (state.pruneTimer !== null) {
    clearTimeout(state.pruneTimer);
    state.pruneTimer = null;
    state.pruneDueAt = null;
  }
  if (state.rearmTimer !== null) {
    clearTimeout(state.rearmTimer);
    state.rearmTimer = null;
  }
  if (state.healthTimer !== null) {
    clearTimeout(state.healthTimer);
    state.healthTimer = null;
  }
  // Wake every queued handleFile so its post-acquire stopped check runs and
  // the pending promises settle instead of hanging past shutdown.
  while (handleSlotWaiters.length > 0) {
    const next = handleSlotWaiters.shift();
    if (next) next();
  }
  try {
    const watcher = state.watcher;
    state.watcher = null;
    state.watchedDirectoryIdentity = null;
    watcher?.close();
  } catch (err) {
    console.warn("[hook-watcher] watcher.close threw:", err);
  }
  // Any arm/health/prune operation already inside an fs promise is allowed to
  // settle, but its generation/stopped checks prevent it from publishing new
  // resources. Awaiting them makes stop deterministic for tests and app quit.
  await Promise.allSettled(
    [state.rearmPromise, state.healthPromise, state.prunePromise].filter(
      (pending): pending is Promise<void> => pending !== null,
    ),
  );
  if (state.pruneDir) {
    try {
      await state.pruneDir.close();
    } catch {
      // A completed async iterator may already have closed it.
    }
    state.pruneDir = null;
  }
  if (oversizedFlushTimer !== null) {
    clearTimeout(oversizedFlushTimer);
    oversizedFlushTimer = null;
    oversizedDropCount = 0;
    oversizedDropBytes = 0;
  }
  active = null;
}

async function rescanDirectory(state: WatcherState): Promise<void> {
  if (state.stopped) return;
  let entries: string[];
  try {
    entries = await fs.readdir(state.hooksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The watcher is inode-bound, so recreating the path alone is not
      // enough. Invalidate this exact generation and let the single re-arm
      // owner recreate both directories.
      invalidateWatcher(state, state.watcher, state.generation, "directory missing");
      return;
    }
    console.warn("[hook-watcher] readdir failed:", err);
    return;
  }
  const identity = await directoryIdentity(state.hooksDir);
  if (
    identity === null ||
    (state.watchedDirectoryIdentity !== null &&
      identity !== state.watchedDirectoryIdentity)
  ) {
    invalidateWatcher(state, state.watcher, state.generation, "directory replaced");
    return;
  }
  for (const name of entries) {
    if (!HOOK_FILE_PATTERN.test(name)) continue;
    if (TMP_FILE_PATTERN.test(name)) continue;
    void handleFile(state, name).catch((err) =>
      console.warn("[hook-watcher] handle failed:", err),
    );
  }
}

async function handleFile(state: WatcherState, filename: string): Promise<void> {
  if (state.stopped) return;
  if (state.inFlight.has(filename)) return;
  state.inFlight.add(filename);
  await acquireHandleSlot();
  try {
    // Re-check after the (possibly long) queue wait — a stop while queued
    // force-wakes us and the only correct move is to bail untouched.
    if (state.stopped) return;
    const filePath = join(state.hooksDir, filename);

    // Race-safe read with retry. ENOENT and zero-byte reads both indicate
    // the writer hasn't finished the os.replace yet.
    let raw: string | null = null;
    for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
      if (state.stopped) return;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          // Probably a directory entry (e.g. the processed/ subdir surfaced
          // as a watch event). Nothing to do.
          return;
        }
        if (stat.size === 0) {
          await delay(READ_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        if (stat.size > MAX_HOOK_FILE_BYTES) {
          noteOversizedDrop(stat.size);
          await dropFile(filePath);
          return;
        }
        raw = await fs.readFile(filePath, "utf8");
        if (raw.length > 0) break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // File renamed away (processed by another instance? unlikely) or
          // not yet finalised — back off and retry.
          await delay(READ_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    if (raw === null || raw.length === 0) {
      // Gave up — drop quietly so we don't keep retrying every fs.watch tick.
      await dropFile(filePath);
      return;
    }

    let envelope: HookFileEnvelope | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        envelope = {
          hookName: typeof obj.hookName === "string" ? obj.hookName : "unknown",
          timestamp:
            typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
          paneId: typeof obj.paneId === "string" ? obj.paneId : "",
          payload: obj.payload === undefined ? null : obj.payload,
          parseError: typeof obj.parseError === "string" ? obj.parseError : undefined,
        };
      }
    } catch (err) {
      console.warn(
        "[hook-watcher] malformed hook file",
        filename,
        (err as Error).message,
        "preview:",
        raw.slice(0, 1024),
      );
    }

    if (envelope) {
      try {
        await dispatchEnvelope(state, envelope);
      } catch (err) {
        console.warn("[hook-watcher] dispatch failed for", filename, err);
      }
    }

    await moveToProcessed(state, filePath, filename);
  } finally {
    releaseHandleSlot();
    state.inFlight.delete(filename);
  }
}

function schedulePrune(state: WatcherState, delayMs: number): void {
  if (state.stopped || active !== state || state.prunePromise !== null) return;
  const dueAt = Date.now() + delayMs;
  // An opportunistic request may bring a distant periodic prune forward, but
  // never creates a second timer.
  if (state.pruneTimer !== null) {
    if (state.pruneDueAt !== null && state.pruneDueAt <= dueAt) return;
    clearTimeout(state.pruneTimer);
  }
  state.pruneDueAt = dueAt;
  state.pruneTimer = setTimeout(() => {
    state.pruneTimer = null;
    state.pruneDueAt = null;
    if (state.stopped || active !== state) return;

    let sweepComplete = true;
    const pending = (async () => {
      sweepComplete = await pruneProcessedChunk(state);
    })();
    state.prunePromise = pending;
    void pending
      .catch((err) => console.warn("[hook-watcher] processed prune failed:", err))
      .finally(() => {
        if (state.prunePromise === pending) state.prunePromise = null;
        if (!state.stopped && active === state) {
          schedulePrune(
            state,
            sweepComplete ? PROCESSED_PRUNE_INTERVAL_MS : PROCESSED_PRUNE_CONTINUE_MS,
          );
        }
      });
  }, delayMs);
  state.pruneTimer.unref?.();
}

// Best-effort retention sweep of processed/. One invocation reads/stats at
// most PROCESSED_PRUNE_BATCH entries. A single open directory cursor carries
// the sweep across yielded timer ticks, so a six-figure backlog neither
// allocates a six-figure names array nor monopolises the main process.
async function pruneProcessedChunk(state: WatcherState): Promise<boolean> {
  if (state.stopped) return true;
  if (state.pruneDir === null) {
    try {
      state.pruneDir = await fs.opendir(state.processedDir);
      state.pruneCutoff = Date.now() - PROCESSED_RETENTION_MS;
      state.pruneCount = 0;
    } catch {
      return true; // dir missing — nothing to prune
    }
  }

  const dir = state.pruneDir;
  const batch: string[] = [];
  let reachedEnd = false;
  try {
    for (let i = 0; i < PROCESSED_PRUNE_BATCH; i++) {
      if (state.stopped) return false;
      const entry = await dir.read();
      if (entry === null) {
        reachedEnd = true;
        break;
      }
      if (entry.isFile()) batch.push(entry.name);
    }
  } catch {
    reachedEnd = true;
  }

  await Promise.all(
    batch.map(async (name) => {
      if (state.stopped) return;
      try {
        const filePath = join(state.processedDir, name);
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.mtimeMs < state.pruneCutoff) {
          await fs.unlink(filePath);
          state.pruneCount++;
        }
      } catch {
        /* best-effort; a vanished or locked file just stays for next time */
      }
    }),
  );

  if (!reachedEnd) return false;
  try {
    await dir.close();
  } catch {
    // Directory replacement may have closed the handle for us.
  }
  if (state.pruneDir === dir) state.pruneDir = null;
  if (state.pruneCount > 0) {
    console.log(
      `[hook-watcher] pruned ${state.pruneCount} processed hook files older than 7 days`,
    );
  }
  state.pruneCount = 0;
  state.pruneSweepCount++;
  return true;
}

async function dispatchEnvelope(state: WatcherState, envelope: HookFileEnvelope): Promise<void> {
  // No paneId means we can't tie the event to a worker (the python script
  // landed without SPARK_PANE_ID in env — happens if the user launched
  // Claude outside Codara's orchestrator). We still log + drop here; a future
  // "ambient hook surface" can pick these up.
  if (!envelope.paneId) {
    return;
  }

  const payloadObj =
    envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
      ? (envelope.payload as Record<string, unknown>)
      : null;

  // Bind pane → session identity BEFORE the run-store dispatch: the registry
  // is what terminal-pane restore resumes from, and it must not lose a
  // capture to a run-store import failure. SessionStart fires with the real
  // session id on startup, `--resume`, in-TUI `/resume`, and `/clear` — the
  // flows the filesystem-discovery heuristic can't see (they append to an
  // old transcript or swap ids without creating a file). UserPromptSubmit and
  // Stop feed the same map so the binding tracks the session the user is
  // ACTUALLY talking to: a `claude -p` one-shot spawned inside the pane (an
  // agent's Bash tool, a quick question) fires its own SessionStart with the
  // same SPARK_PANE_ID, but the interactive session's next prompt/turn-end
  // re-binds the pane, so the one-shot can't permanently steal restore.
  if (
    envelope.hookName === "SessionStart" ||
    envelope.hookName === "UserPromptSubmit" ||
    envelope.hookName === "Stop"
  ) {
    const boundSessionId = stringField(payloadObj, ["session_id", "sessionId", "id"]);
    if (boundSessionId) {
      recordSessionStart({
        paneId: envelope.paneId,
        runtime: "claude",
        sessionId: boundSessionId,
        transcriptPath: stringField(payloadObj, ["transcript_path", "transcriptPath"]),
        cwd: stringField(payloadObj, ["cwd"]),
        source:
          envelope.hookName === "SessionStart"
            ? stringField(payloadObj, ["source"])
            : envelope.hookName === "Stop"
              ? "stop"
              : "prompt",
        timestamp: envelope.timestamp,
      });
    }
  }

  const runStore = await loadRunStore(state);
  if (!runStore) return;

  switch (envelope.hookName) {
    case "Notification": {
      // Notifications fire when Claude needs human input (permission prompt,
      // model question). Surface as blocked so the UI's attention rollup
      // catches it. The note picks the most useful free text on the payload
      // — Claude commonly includes `message` for permission prompts.
      const note = stringField(payloadObj, ["message", "text", "title", "reason"]);
      runStore.applyHookStateReport({
        paneId: envelope.paneId,
        state: "blocked",
        ...(note ? { note } : {}),
      });
      // Also append the raw event so the Session Inspector can replay it.
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: note ?? "Worker requesting attention",
      });
      return;
    }
    case "Stop":
    case "SubagentStop": {
      runStore.applyHookStateReport({
        paneId: envelope.paneId,
        state: "done",
      });
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: envelope.hookName === "SubagentStop" ? "Sub-agent stopped" : "Worker stopped",
      });
      return;
    }
    case "SessionStart": {
      // SessionStart carries the new session id, which Codara uses for
      // `claude -r <uuid>` resume. We append the event with the id surfaced
      // as a top-level field so a future "agent-resume on restore" big-bet
      // can pull it without re-parsing the payload.
      const sessionId = stringField(payloadObj, [
        "session_id",
        "sessionId",
        "id",
      ]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: sessionId
          ? { ...(payloadObj ?? {}), sessionId }
          : payloadObj,
        timestamp: envelope.timestamp,
        message: sessionId ? `Session started: ${sessionId}` : "Session started",
      });
      return;
    }
    case "PreToolUse":
    case "PostToolUse": {
      const tool = stringField(payloadObj, ["tool_name", "toolName", "tool"]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: tool
          ? `${envelope.hookName}: ${tool}`
          : envelope.hookName,
      });
      return;
    }
    case "UserPromptSubmit": {
      const promptPreview = stringField(payloadObj, ["prompt", "input", "message"]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: promptPreview
          ? `User prompt: ${truncate(promptPreview, 120)}`
          : "User prompt submitted",
      });
      return;
    }
    case "PreCompact": {
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: "Context compaction starting",
      });
      return;
    }
    default: {
      // Unknown / future hook events still land in the event log so we don't
      // silently drop anything. A user investigating a new Claude release
      // can grep the log for hook.<unknown> and see what arrived.
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
      });
    }
  }
}

async function moveToProcessed(
  state: WatcherState,
  filePath: string,
  filename: string,
): Promise<void> {
  const target = join(state.processedDir, filename);
  try {
    await fs.rename(filePath, target);
  } catch (err) {
    // Rename can fail if processed/ was deleted out from under us, or on
    // Windows when another process briefly held the file open. Try unlink as
    // a fallback so we don't loop forever on the same file.
    try {
      await fs.mkdir(state.processedDir, { recursive: true });
      await fs.rename(filePath, target);
    } catch {
      try {
        await fs.unlink(filePath);
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(
            "[hook-watcher] failed to move/unlink",
            filePath,
            "rename err:",
            err,
            "unlink err:",
            unlinkErr,
          );
        }
      }
    }
  }
}

async function dropFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[hook-watcher] dropFile failed:", err);
    }
  }
}

async function loadRunStore(state: WatcherState): Promise<RunStoreModule | null> {
  if (!state.runStorePromise) {
    state.runStorePromise = import("./orchestration/run-store");
  }
  try {
    return await state.runStorePromise;
  } catch (err) {
    console.warn("[hook-watcher] run-store import failed:", err);
    state.runStorePromise = null;
    return null;
  }
}

function stringField(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test / diagnostic helpers. Lets future ipc handlers / Session Inspector
// surface whether the watcher is currently armed without re-implementing
// the state lookup.
export function isHookWatcherActive(): boolean {
  return active !== null && active.stopped === false;
}

// Narrow deterministic test seam for lifecycle faults that cannot be induced
// portably through the public fs API (notably FSWatcher "error"). It exposes
// counters/booleans only—never the watcher handle or hook payloads.
export const __test = {
  diagnostics(): {
    generation: number;
    armCount: number;
    watcherArmed: boolean;
    rearmPending: boolean;
    pruneSweepCount: number;
    prunePending: boolean;
  } | null {
    const state = active;
    if (!state) return null;
    return {
      generation: state.generation,
      armCount: state.armCount,
      watcherArmed: state.watcher !== null,
      rearmPending: state.rearmTimer !== null || state.rearmPromise !== null,
      pruneSweepCount: state.pruneSweepCount,
      prunePending:
        state.pruneTimer !== null ||
        state.prunePromise !== null ||
        state.pruneDir !== null,
    };
  },
  emitWatcherError(times = 1): boolean {
    const watcher = active?.watcher;
    if (!watcher) return false;
    for (let i = 0; i < Math.max(1, times); i++) {
      watcher.emit("error", new Error("synthetic hook watcher fault"));
    }
    return true;
  },
  emitWatcherClose(): boolean {
    const watcher = active?.watcher;
    if (!watcher) return false;
    watcher.emit("close");
    return true;
  },
  async rescanNow(): Promise<void> {
    if (active) await rescanDirectory(active);
  },
  pruneNow(): void {
    if (active) schedulePrune(active, 0);
  },
  rearmBaseDelayMs: REARM_BASE_DELAY_MS,
};
