import { watch, existsSync, readdirSync, promises as fsp, FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { WebContents } from "electron";
import type { FsChangeEvent } from "@shared/types";

const IGNORED_TOP_LEVEL = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".next",
  ".turbo",
]);
const DEBOUNCE_MS = 200;
const CHANNEL = "fs:changed";
const EINTR_RETRY_DELAYS_MS = [0, 40, 160] as const;

function fsErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "") || undefined
    : undefined;
}

function fsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openRootWatcher(root: string): Promise<FSWatcher> {
  let lastError: unknown;
  for (const delayMs of EINTR_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    try {
      return watch(root, { recursive: false, persistent: true });
    } catch (error) {
      lastError = error;
      if (fsErrorCode(error) !== "EINTR") throw error;
    }
  }
  throw lastError;
}

// Native recursive watcher registration may synchronously walk a large tree
// before `fs.watch()` returns. Run those registrations in a Node worker so a
// parent workspace containing several repositories cannot monopolize
// Electron's browser/main thread. The worker sends only rename events back;
// noisy content-write events never cross the thread boundary.
const RECURSIVE_WATCHER_WORKER = String.raw`
  const { watch } = require("node:fs");
  const { parentPort, workerData } = require("node:worker_threads");
  const watchers = new Map();

  function add(dir) {
    if (!dir || watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { recursive: true, persistent: true });
      watcher.on("change", (eventType, filename) => {
        if (eventType !== "rename" || !filename) return;
        parentPort.postMessage({ type: "change", base: dir, filename: String(filename) });
      });
      watcher.on("error", (error) => {
        parentPort.postMessage({ type: "error", dir, message: String(error?.message || error) });
      });
      watchers.set(dir, watcher);
    } catch (error) {
      parentPort.postMessage({ type: "error", dir, message: String(error?.message || error) });
    }
  }

  for (const dir of workerData.dirs) add(dir);
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", (message) => {
    if (message?.type === "watch") add(message.dir);
  });
`;

interface State {
  root: string;
  // One non-recursive watcher on the root (catches top-level file changes and
  // newly-created top-level directories). Recursive child watchers live in a
  // worker thread because their native registration can be expensive. The map
  // remains keyed by path so every main-thread handle is disposed on stop.
  watchers: Map<string, FSWatcher>;
  recursiveWorker: Worker | null;
  recursiveReady: Promise<void> | null;
  recursiveDirs: Set<string>;
  pendingDirs: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

const byContents = new Map<number, State>();
/** Workspace roots already reported as missing, so N windows re-registering the
 * same stale workspace produce one line rather than N. */
const missingRootsReported = new Set<string>();

// Resolve a watcher event into the absolute directory whose contents changed
// and stage it for the next debounced flush. `base` is the absolute path of
// the watcher that fired (the root, or a top-level directory); `filename` is
// the path the OS reported, relative to `base`.
function stageChange(state: State, base: string, filename: string): void {
  const absolute = resolve(base, filename);
  state.pendingDirs.add(dirname(absolute));
}

// Schedule (or no-op if already scheduled) the debounced flush that ships the
// coalesced set of changed directories to the renderer in one event.
function scheduleFlush(state: State, webContents: WebContents): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    const dirs = Array.from(state.pendingDirs);
    state.pendingDirs.clear();
    if (webContents.isDestroyed()) return;
    const event: FsChangeEvent = { root: state.root, dirs };
    webContents.send(CHANNEL, event);
  }, DEBOUNCE_MS);
}

function watchTopLevelDir(state: State, dirAbsolute: string): void {
  if (state.recursiveDirs.has(dirAbsolute)) return;
  state.recursiveDirs.add(dirAbsolute);
  state.recursiveWorker?.postMessage({ type: "watch", dir: dirAbsolute });
}

function startRecursiveWatcher(state: State, webContents: WebContents): Promise<void> {
  if (state.recursiveWorker) return state.recursiveReady ?? Promise.resolve();
  if (state.recursiveDirs.size === 0) return Promise.resolve();
  let settleReady: () => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveReady();
    }, 1_500);
    timeout.unref?.();
    settleReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveReady();
    };
  });
  state.recursiveReady = ready;
  const worker = new Worker(RECURSIVE_WATCHER_WORKER, {
    eval: true,
    workerData: { dirs: Array.from(state.recursiveDirs) },
  });
  state.recursiveWorker = worker;
  worker.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      byContents.get(webContents.id) !== state ||
      webContents.isDestroyed()
    ) {
      return;
    }
    const payload = message as Record<string, unknown>;
    if (payload.type === "ready") {
      settleReady();
      state.recursiveReady = null;
      return;
    }
    if (
      payload.type === "change" &&
      typeof payload.base === "string" &&
      typeof payload.filename === "string"
    ) {
      stageChange(state, payload.base, payload.filename);
      scheduleFlush(state, webContents);
      return;
    }
    if (payload.type === "error") {
      console.warn("[fs-watcher] recursive worker error", payload.dir, payload.message);
    }
  });
  worker.on("error", (err) => {
    settleReady();
    state.recursiveReady = null;
    if (byContents.get(webContents.id) === state) {
      console.warn("[fs-watcher] recursive worker failed", err);
    }
  });
  worker.on("exit", () => {
    settleReady();
    if (state.recursiveWorker === worker) state.recursiveWorker = null;
    state.recursiveReady = null;
  });
  return ready;
}

function disposeState(state: State): void {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  for (const watcher of state.watchers.values()) {
    try { watcher.close(); } catch { /* noop */ }
  }
  if (state.recursiveWorker) {
    void state.recursiveWorker.terminate();
    state.recursiveWorker = null;
  }
}

export async function setWatchRoot(
  webContents: WebContents,
  root: string | null,
): Promise<void> {
  const id = webContents.id;
  const existing = byContents.get(id);
  if (existing) {
    disposeState(existing);
    byContents.delete(id);
  }
  if (!root) return;

  // A workspace whose folder has been moved or deleted is a normal, expected
  // state — the workspace list outlives the directory. fs.watch would throw
  // ENOENT here, and because every window re-runs this on boot, one stale
  // workspace produced several multi-line stack traces in the dev console on
  // every start. Report it once per path, in one line, and skip: there is
  // nothing to watch, and it is not an error worth a stack.
  if (!existsSync(root)) {
    if (!missingRootsReported.has(root)) {
      missingRootsReported.add(root);
      console.warn(`[fs-watcher] skipping missing workspace ${root}`);
    }
    return;
  }
  // The path exists again (workspace restored / remounted) — allow a future
  // disappearance to be reported afresh.
  missingRootsReported.delete(root);

  const state: State = {
    root,
    watchers: new Map<string, FSWatcher>(),
    recursiveWorker: null,
    recursiveReady: null,
    recursiveDirs: new Set<string>(),
    pendingDirs: new Set<string>(),
    flushTimer: null,
  };

  // A single recursive watcher on the workspace root forces the Windows kernel
  // to register and walk node_modules (tens of thousands of files), a constant
  // CPU/GC drain that the IGNORED_TOP_LEVEL filter cannot prevent because it
  // only discards events after the OS has already produced them. Instead we
  // watch each non-ignored top-level directory recursively and add a single
  // NON-recursive watcher on the root itself for top-level file changes and to
  // discover newly-created top-level directories.
  let rootWatcher: FSWatcher;
  try {
    rootWatcher = await openRootWatcher(root);
  } catch (err) {
    console.warn(`[fs-watcher] failed to watch ${root}: ${fsErrorMessage(err)}`);
    return;
  }
  rootWatcher.on("error", (err) => {
    if (fsErrorCode(err) === "EINTR" && byContents.get(id) === state) {
      console.warn(`[fs-watcher] watch interrupted for ${root}; retrying`);
      void setWatchRoot(webContents, root);
      return;
    }
    console.warn(`[fs-watcher] watch error for ${root}: ${fsErrorMessage(err)}`);
  });
  rootWatcher.on("change", (eventType, filename) => {
    // See per-directory watcher above: only 'rename' indicates create/delete/
    // rename; content writes ('change') must not trigger refreshes.
    if (eventType !== "rename" || !filename) return;
    const rel = String(filename);
    const firstSegment = rel.split(/[\\/]/, 1)[0];
    if (IGNORED_TOP_LEVEL.has(firstSegment)) return;

    // The non-recursive root watcher reports only direct children. A 'rename'
    // here can be a brand-new top-level directory; if so, start watching it
    // recursively so its descendants are covered going forward.
    const childAbsolute = resolve(root, firstSegment);
    try {
      const stat = readdirSync(childAbsolute, { withFileTypes: true });
      // readdirSync only succeeds on directories; if it threw, the child is a
      // file (or was deleted) and needs no dedicated recursive watcher.
      void stat;
      watchTopLevelDir(state, childAbsolute);
      void startRecursiveWatcher(state, webContents);
    } catch { /* not a directory (file change or deletion) — nothing to watch */ }

    stageChange(state, root, rel);
    scheduleFlush(state, webContents);
  });
  state.watchers.set(root, rootWatcher);

  // Register the state synchronously (with the root watcher already armed) so
  // the caller's await resolves once top-level activity is observable, and so a
  // rapid subsequent setWatchRoot call sees this state to tear it down. The
  // per-directory recursive watchers are then installed asynchronously below.
  byContents.set(id, state);

  // Enumerate the root's immediate entries and spin up one recursive watcher
  // per non-ignored top-level directory. This was a synchronous readdirSync +
  // a burst of recursive fs.watch calls, which froze the main thread when
  // opening a large workspace. Enumerate asynchronously, then hand recursive
  // registration to a worker thread. Failures are non-fatal: the root watcher
  // above still observes top-level activity.
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    console.warn("[fs-watcher] failed to enumerate", root, err);
    return;
  }

  // Bail if this watcher state was superseded (another setWatchRoot ran, or the
  // root was cleared) or its webContents was destroyed while we awaited the
  // readdir — installing watchers now would leak handles onto a dead state.
  if (byContents.get(id) !== state || webContents.isDestroyed()) return;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_TOP_LEVEL.has(entry.name)) continue;
    watchTopLevelDir(state, resolve(root, entry.name));
  }
  // The root watcher is already active, but nested directory events are not
  // observable until the worker has actually registered its fs.watch handles.
  // Await its ready handshake (bounded inside startRecursiveWatcher) so the
  // renderer's post-arm reconciliation happens after that blind window. Any
  // file created while the worker starts is then caught by the reconciliation;
  // anything created after readiness is caught by the watcher.
  await startRecursiveWatcher(state, webContents);
}

export function disposeForWebContents(webContents: WebContents): void {
  const state = byContents.get(webContents.id);
  if (!state) return;
  disposeState(state);
  byContents.delete(webContents.id);
}

export function disposeAll(): void {
  for (const state of byContents.values()) {
    disposeState(state);
  }
  byContents.clear();
}
