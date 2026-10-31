import { watch, existsSync, readdirSync, promises as fsp, FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { WebContents } from "electron";
import type { FsChangeEvent } from "@shared/types";

// Folders whose contents never drive the Explorer's live refresh, at any depth:
// dependency stores, VCS internals, caches and build or test output churn far
// more than anyone reads them. A folder with one of these names appearing or
// disappearing still refreshes its parent's listing.
const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".vite-cache",
  "out",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "coverage",
  "test-results",
  ".cache",
]);
const DEBOUNCE_MS = 200;
const CHANNEL = "fs:changed";
const EINTR_RETRY_DELAYS_MS = [0, 40, 160] as const;

// Recursive fs.watch is native on macOS (FSEvents) and Windows
// (ReadDirectoryChangesW over the subtree): one handle per watched tree,
// whatever its size. Everywhere else Node emulates it by walking the tree and
// adding an inotify watch for every directory and file, all charged to
// fs.inotify.max_user_watches, which every editor, test runner and dev server
// of the user shares; one parent folder of several repositories took 139k of
// the machine's 274k. There the Explorer watches only the root and the folders
// the renderer reports as expanded, one non-recursive watch each, within a
// budget shared by every window. Folders past the budget are polled.
const NATIVE_RECURSIVE = process.platform === "darwin" || process.platform === "win32";
const DEFAULT_WATCH_BUDGET = 2048;
const DEFAULT_POLL_MS = 5000;
// No real tree has this many expanded folders; it bounds a broken renderer.
const MAX_VISIBLE_DIRS_PER_ROOT = 10_000;
// The kernel refused a watch for everyone, not just for this folder.
const WATCH_LIMIT_CODES = new Set(["ENOSPC", "EMFILE"]);

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
// noisy content-write events and anything inside an ignored folder never
// cross the thread boundary.
const RECURSIVE_WATCHER_WORKER = String.raw`
  const { watch } = require("node:fs");
  const { parentPort, workerData } = require("node:worker_threads");
  const watchers = new Map();
  const ignored = new Set(workerData.ignored);

  function insideIgnored(filename) {
    const parts = filename.split(/[\\/]/);
    for (let i = 0; i < parts.length - 1; i++) {
      if (ignored.has(parts[i])) return true;
    }
    return false;
  }

  function add(dir) {
    if (!dir || watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { recursive: true, persistent: true });
      watcher.on("change", (eventType, filename) => {
        if (eventType !== "rename" || !filename) return;
        const name = String(filename);
        if (insideIgnored(name)) return;
        parentPort.postMessage({ type: "change", base: dir, filename: name });
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

type DirListener = (dir: string) => void;

// One non-recursive watch on a folder, shared by every window and root that
// shows it, or a poll of its mtime when there is no watch.
interface DirWatch {
  dir: string;
  watcher: FSWatcher | null;
  // Folders under an ignored name are polled whatever the budget.
  pollOnly: boolean;
  // From the last stat: a polled folder changed when its mtime or inode did,
  // and a watched one was replaced when its inode did.
  ino: number | null;
  mtimeMs: number | null;
  identity: Promise<void>;
  listeners: Set<DirListener>;
}

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
  // Without native recursion: the expanded folders the renderer reported, each
  // holding a lease on a shared DirWatch. The root takes one too when the
  // kernel refused its own watcher.
  visibleDirs: Set<string>;
  rootLease: boolean;
  onDirChange: DirListener;
  pendingDirs: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

// One State per (webContents, root) pair: a window watches its active
// workspace root plus any external Explorer folders attached to it, each with
// its own independent watcher lifecycle.
const byContents = new Map<number, Map<string, State>>();
/** Workspace roots already reported as missing, so N windows re-registering the
 * same stale workspace produce one line rather than N. */
const missingRootsReported = new Set<string>();
// The latest addWatchRoot per (webContents, root). An arm still awaiting its
// root watcher when a newer arm, a removal or a dispose came in closes what it
// opened instead of registering a second, unreachable State.
const latestArm = new Map<number, Map<string, number>>();
let armCounter = 0;

const dirWatches = new Map<string, DirWatch>();
let watchBudget = DEFAULT_WATCH_BUDGET;
let pollMs = DEFAULT_POLL_MS;
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let openDirWatchers = 0;
let budgetReported = false;
const watchErrorsReported = new Set<string>();

// Folders of files open in a preview, so a replaced or deleted image refreshes
// even when its folder is collapsed in the Explorer or outside every root.
interface PreviewWatch {
  count: number;
  listener: DirListener;
  flushTimer: NodeJS.Timeout | null;
}
const previewsByContents = new Map<number, Map<string, PreviewWatch>>();

function getState(id: number, root: string): State | undefined {
  return byContents.get(id)?.get(root);
}

function beginArm(id: number, root: string): number {
  let inner = latestArm.get(id);
  if (!inner) {
    inner = new Map<string, number>();
    latestArm.set(id, inner);
  }
  armCounter += 1;
  inner.set(root, armCounter);
  return armCounter;
}

function forgetArm(id: number, root: string): void {
  const inner = latestArm.get(id);
  if (!inner) return;
  inner.delete(root);
  if (inner.size === 0) latestArm.delete(id);
}

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

function isInsideRoot(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function hasIgnoredSegment(root: string, dir: string): boolean {
  return relative(root, dir).split(sep).some((segment) => IGNORED_NAMES.has(segment));
}

// Upper bound on the inotify watches this module holds: two handles on one
// inode share a kernel watch inside libuv, so the real number can be lower.
function kernelWatchCount(): number {
  let count = openDirWatchers;
  for (const inner of byContents.values()) {
    for (const state of inner.values()) count += state.watchers.size;
  }
  return count;
}

function reportBudget(): void {
  if (budgetReported) return;
  budgetReported = true;
  console.warn(
    `[fs-watcher] watch budget of ${watchBudget} folders reached; polling further expanded folders every ${pollMs / 1000}s`,
  );
}

function reportWatchError(dir: string, error: unknown): void {
  const code = fsErrorCode(error) ?? "unknown";
  // A folder deleted between the renderer's listing and the watch is routine;
  // the poll notices if it comes back.
  if (code === "ENOENT" || watchErrorsReported.has(code)) return;
  watchErrorsReported.add(code);
  const hint = code === "ENOSPC" ? " (fs.inotify.max_user_watches is used up)" : "";
  console.warn(`[fs-watcher] cannot watch ${dir}: ${fsErrorMessage(error)}${hint}; polling instead`);
}

function notifyDir(entry: DirWatch): void {
  for (const listener of Array.from(entry.listeners)) listener(entry.dir);
}

async function refreshIdentity(entry: DirWatch, notifyIfChanged: boolean): Promise<void> {
  const stat = await fsp.stat(entry.dir).catch(() => null);
  if (dirWatches.get(entry.dir) !== entry) return;
  const ino = stat?.isDirectory() ? stat.ino : null;
  const mtimeMs = stat?.isDirectory() ? stat.mtimeMs : null;
  const changed = ino !== entry.ino || mtimeMs !== entry.mtimeMs;
  entry.ino = ino;
  entry.mtimeMs = mtimeMs;
  if (changed && notifyIfChanged) notifyDir(entry);
}

function closeDirWatcher(entry: DirWatch): void {
  if (!entry.watcher) return;
  try { entry.watcher.close(); } catch { /* noop */ }
  entry.watcher = null;
  openDirWatchers -= 1;
}

// inotify keeps a watch on the inode, not the path: once the folder is deleted
// or replaced the watch goes silent. Re-arm it on the new folder, or poll until
// the path is a folder again.
async function revalidate(entry: DirWatch): Promise<void> {
  const stat = await fsp.stat(entry.dir).catch(() => null);
  if (dirWatches.get(entry.dir) !== entry || !entry.watcher) return;
  if (stat?.isDirectory() && stat.ino === entry.ino) return;
  closeDirWatcher(entry);
  entry.ino = null;
  entry.mtimeMs = null;
  if (stat?.isDirectory() && openDirWatcher(entry)) {
    await refreshIdentity(entry, true);
    return;
  }
  ensurePolling();
}

function openDirWatcher(entry: DirWatch): boolean {
  if (kernelWatchCount() >= watchBudget) {
    reportBudget();
    return false;
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(entry.dir, { persistent: true });
  } catch (error) {
    reportWatchError(entry.dir, error);
    return false;
  }
  entry.watcher = watcher;
  openDirWatchers += 1;
  watcher.on("change", (eventType, filename) => {
    if (eventType !== "rename" || entry.watcher !== watcher) return;
    // inotify reports the folder's own deletion or move under its own name.
    if (!filename || String(filename) === basename(entry.dir)) void revalidate(entry);
    notifyDir(entry);
  });
  watcher.on("error", (error) => {
    if (entry.watcher !== watcher) return;
    reportWatchError(entry.dir, error);
    closeDirWatcher(entry);
    ensurePolling();
  });
  return true;
}

function ensurePolling(): void {
  if (pollTimer || polling) return;
  let anyPolled = false;
  for (const entry of dirWatches.values()) {
    if (!entry.watcher) {
      anyPolled = true;
      break;
    }
  }
  if (!anyPolled) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollOnce();
  }, pollMs);
  pollTimer.unref?.();
}

async function pollOnce(): Promise<void> {
  polling = true;
  try {
    for (const entry of Array.from(dirWatches.values())) {
      if (entry.watcher || dirWatches.get(entry.dir) !== entry) continue;
      await refreshIdentity(entry, true);
      if (dirWatches.get(entry.dir) !== entry || entry.watcher) continue;
      if (entry.ino !== null && !entry.pollOnly) openDirWatcher(entry);
    }
  } finally {
    polling = false;
    ensurePolling();
  }
}

// A released watch frees budget: hand it to folders that were polled for lack
// of one, checking each for a change since its last poll.
function promotePolledDirs(): void {
  if (!budgetReported) return;
  for (const entry of dirWatches.values()) {
    if (entry.watcher || entry.pollOnly || entry.ino === null) continue;
    if (kernelWatchCount() >= watchBudget) return;
    if (openDirWatcher(entry)) void refreshIdentity(entry, true);
  }
  budgetReported = false;
}

function acquireDirWatch(dir: string, listener: DirListener, pollOnly: boolean): DirWatch {
  let entry = dirWatches.get(dir);
  if (!entry) {
    const created: DirWatch = {
      dir,
      watcher: null,
      pollOnly,
      ino: null,
      mtimeMs: null,
      identity: Promise.resolve(),
      listeners: new Set(),
    };
    dirWatches.set(dir, created);
    if (pollOnly || !openDirWatcher(created)) ensurePolling();
    created.identity = refreshIdentity(created, false);
    entry = created;
  }
  entry.listeners.add(listener);
  return entry;
}

function releaseDirWatch(dir: string, listener: DirListener): void {
  const entry = dirWatches.get(dir);
  if (!entry || !entry.listeners.delete(listener) || entry.listeners.size > 0) return;
  dirWatches.delete(dir);
  if (!entry.watcher) return;
  closeDirWatcher(entry);
  promotePolledDirs();
}

function applyVisibleDirs(state: State, dirs: Iterable<string>): DirWatch[] {
  const next = new Set<string>();
  for (const dir of dirs) {
    if (next.size >= MAX_VISIBLE_DIRS_PER_ROOT) break;
    const absolute = resolve(dir);
    if (isInsideRoot(state.root, absolute)) next.add(absolute);
  }
  // Release first so the folders that just became visible can use the budget
  // the collapsed ones held.
  for (const dir of state.visibleDirs) {
    if (!next.has(dir)) releaseDirWatch(dir, state.onDirChange);
  }
  const added: DirWatch[] = [];
  for (const dir of next) {
    if (state.visibleDirs.has(dir)) continue;
    added.push(acquireDirWatch(dir, state.onDirChange, hasIgnoredSegment(state.root, dir)));
  }
  state.visibleDirs = next;
  return added;
}

// A Dirent describes the link itself, so a top-level symlink to a folder
// (a workspace's `SharePoint` shortcut into OneDrive, say) reports
// isDirectory() false and was never watched: its contents only refreshed when
// the tree remounted. A recursive watch opened on the link path follows it and
// reports names relative to the link, which are the paths the tree shows.
async function listTopLevelDirs(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) {
      dirs.push(absolute);
    } else if (entry.isSymbolicLink()) {
      const target = await fsp.stat(absolute).catch(() => null);
      if (target?.isDirectory()) dirs.push(absolute);
    }
  }
  return dirs;
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
    workerData: { dirs: Array.from(state.recursiveDirs), ignored: Array.from(IGNORED_NAMES) },
  });
  state.recursiveWorker = worker;
  worker.on("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      getState(webContents.id, state.root) !== state ||
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
    if (getState(webContents.id, state.root) === state) {
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
  state.watchers.clear();
  for (const dir of state.visibleDirs) releaseDirWatch(dir, state.onDirChange);
  state.visibleDirs.clear();
  if (state.rootLease) {
    state.rootLease = false;
    releaseDirWatch(state.root, state.onDirChange);
  }
  if (state.recursiveWorker) {
    void state.recursiveWorker.terminate();
    state.recursiveWorker = null;
  }
}

function disposePreviews(id: number): void {
  const inner = previewsByContents.get(id);
  if (!inner) return;
  for (const [dir, preview] of inner) {
    if (preview.flushTimer) clearTimeout(preview.flushTimer);
    releaseDirWatch(dir, preview.listener);
  }
  previewsByContents.delete(id);
}

export async function addWatchRoot(webContents: WebContents, root: string): Promise<void> {
  const id = webContents.id;
  const sequence = beginArm(id, root);
  // Rebuild-from-scratch idempotency, scoped to this root only: re-arming a
  // root disposes its previous watchers without touching any other root the
  // same window is watching (the workspace tree and each external Explorer
  // folder arm independently). The expanded folders carry over: the renderer
  // only reports them when they change.
  const existing = getState(id, root);
  const carriedDirs = existing ? Array.from(existing.visibleDirs) : [];
  if (existing) {
    disposeState(existing);
    byContents.get(id)?.delete(root);
  }

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
    visibleDirs: new Set<string>(),
    rootLease: false,
    onDirChange: (dir) => {
      if (getState(id, root) !== state || webContents.isDestroyed()) return;
      state.pendingDirs.add(dir);
      scheduleFlush(state, webContents);
    },
    pendingDirs: new Set<string>(),
    flushTimer: null,
  };

  // A single recursive watcher on the workspace root forces the Windows kernel
  // to register and walk node_modules (tens of thousands of files), a constant
  // CPU/GC drain that filtering events cannot prevent because it only discards
  // them after the OS has already produced them. Instead we watch each
  // non-ignored top-level directory recursively where recursion is native, and
  // add a single NON-recursive watcher on the root itself for top-level file
  // changes and to discover newly-created top-level directories.
  let rootWatcher: FSWatcher | null = null;
  try {
    rootWatcher = await openRootWatcher(root);
  } catch (err) {
    // When other programs have used up the inotify limit, a polled tree beats
    // a dead one.
    if (NATIVE_RECURSIVE || !WATCH_LIMIT_CODES.has(fsErrorCode(err) ?? "")) {
      console.warn(`[fs-watcher] failed to watch ${root}: ${fsErrorMessage(err)}`);
      return;
    }
    reportWatchError(root, err);
  }
  if (latestArm.get(id)?.get(root) !== sequence || webContents.isDestroyed()) {
    try { rootWatcher?.close(); } catch { /* noop */ }
    return;
  }
  if (rootWatcher) {
    rootWatcher.on("error", (err) => {
      if (fsErrorCode(err) === "EINTR" && getState(id, root) === state) {
        console.warn(`[fs-watcher] watch interrupted for ${root}; retrying`);
        void addWatchRoot(webContents, root);
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

      // The non-recursive root watcher reports only direct children. A 'rename'
      // here can be a brand-new top-level directory; if so, start watching it
      // recursively so its descendants are covered going forward.
      if (NATIVE_RECURSIVE && !IGNORED_NAMES.has(firstSegment)) {
        const childAbsolute = resolve(root, firstSegment);
        try {
          const stat = readdirSync(childAbsolute, { withFileTypes: true });
          // readdirSync only succeeds on directories; if it threw, the child is a
          // file (or was deleted) and needs no dedicated recursive watcher.
          void stat;
          watchTopLevelDir(state, childAbsolute);
          void startRecursiveWatcher(state, webContents);
        } catch { /* not a directory (file change or deletion): nothing to watch */ }
      }

      stageChange(state, root, rel);
      scheduleFlush(state, webContents);
    });
    state.watchers.set(root, rootWatcher);
  }

  // Register the state synchronously (with the root watcher already armed) so
  // the caller's await resolves once top-level activity is observable, and so a
  // rapid subsequent addWatchRoot call for the same root sees this state to
  // tear it down. The per-directory watchers are then installed below.
  let inner = byContents.get(id);
  if (!inner) {
    inner = new Map<string, State>();
    byContents.set(id, inner);
  }
  inner.set(root, state);

  if (!NATIVE_RECURSIVE) {
    if (!rootWatcher) {
      state.rootLease = true;
      acquireDirWatch(root, state.onDirChange, true);
    }
    applyVisibleDirs(state, carriedDirs);
    return;
  }

  // Enumerate the root's immediate entries and spin up one recursive watcher
  // per non-ignored top-level directory. This was a synchronous readdirSync +
  // a burst of recursive fs.watch calls, which froze the main thread when
  // opening a large workspace. Enumerate asynchronously, then hand recursive
  // registration to a worker thread. Failures are non-fatal: the root watcher
  // above still observes top-level activity.
  let topLevelDirs: string[];
  try {
    topLevelDirs = await listTopLevelDirs(root);
  } catch (err) {
    console.warn("[fs-watcher] failed to enumerate", root, err);
    return;
  }

  // Bail if this watcher state was superseded (another addWatchRoot ran for
  // this root, or the root was removed) or its webContents was destroyed while
  // we awaited the readdir — installing watchers now would leak handles onto a
  // dead state.
  if (getState(id, root) !== state || webContents.isDestroyed()) return;

  for (const dir of topLevelDirs) watchTopLevelDir(state, dir);
  // The root watcher is already active, but nested directory events are not
  // observable until the worker has actually registered its fs.watch handles.
  // Await its ready handshake (bounded inside startRecursiveWatcher) so the
  // renderer's post-arm reconciliation happens after that blind window. Any
  // file created while the worker starts is then caught by the reconciliation;
  // anything created after readiness is caught by the watcher.
  await startRecursiveWatcher(state, webContents);
}

/**
 * Report the folders a root's Explorer shows expanded. Where recursion is not
 * native each gets its own watch (or a poll past the budget), and folders no
 * longer listed are released. Resolves with the folders that were not watched
 * until now, once their baselines are taken: the renderer re-lists them, since
 * they may have changed after it last listed them.
 */
export async function setWatchedDirs(
  webContents: WebContents,
  root: string,
  dirs: readonly string[],
): Promise<string[]> {
  if (NATIVE_RECURSIVE) return [];
  const state = getState(webContents.id, root);
  if (!state) return [];
  const added = applyVisibleDirs(state, dirs);
  await Promise.all(added.map((entry) => entry.identity));
  return added.map((entry) => entry.dir);
}

export function removeWatchRoot(webContents: WebContents, root: string): void {
  forgetArm(webContents.id, root);
  const inner = byContents.get(webContents.id);
  const state = inner?.get(root);
  if (!inner || !state) return;
  disposeState(state);
  inner.delete(root);
  if (inner.size === 0) byContents.delete(webContents.id);
}

export function watchPreviewFile(webContents: WebContents, file: string): void {
  const dir = dirname(resolve(file));
  const id = webContents.id;
  let inner = previewsByContents.get(id);
  if (!inner) {
    inner = new Map<string, PreviewWatch>();
    previewsByContents.set(id, inner);
  }
  const existing = inner.get(dir);
  if (existing) {
    existing.count += 1;
    return;
  }
  const preview: PreviewWatch = {
    count: 1,
    flushTimer: null,
    listener: () => {
      if (preview.flushTimer || webContents.isDestroyed()) return;
      preview.flushTimer = setTimeout(() => {
        preview.flushTimer = null;
        if (webContents.isDestroyed()) return;
        const event: FsChangeEvent = { root: dir, dirs: [dir] };
        webContents.send(CHANNEL, event);
      }, DEBOUNCE_MS);
    },
  };
  inner.set(dir, preview);
  acquireDirWatch(dir, preview.listener, false);
}

export function unwatchPreviewFile(webContents: WebContents, file: string): void {
  const dir = dirname(resolve(file));
  const inner = previewsByContents.get(webContents.id);
  const preview = inner?.get(dir);
  if (!inner || !preview) return;
  preview.count -= 1;
  if (preview.count > 0) return;
  if (preview.flushTimer) clearTimeout(preview.flushTimer);
  inner.delete(dir);
  if (inner.size === 0) previewsByContents.delete(webContents.id);
  releaseDirWatch(dir, preview.listener);
}

export function disposeForWebContents(webContents: WebContents): void {
  disposePreviews(webContents.id);
  latestArm.delete(webContents.id);
  const inner = byContents.get(webContents.id);
  if (!inner) return;
  for (const state of inner.values()) disposeState(state);
  byContents.delete(webContents.id);
}

export function disposeAll(): void {
  for (const id of Array.from(previewsByContents.keys())) disposePreviews(id);
  latestArm.clear();
  for (const inner of byContents.values()) {
    for (const state of inner.values()) disposeState(state);
  }
  byContents.clear();
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

// Narrow test seam: shrink the budget and poll interval, and read counts. It
// never exposes watcher handles.
export const __test = {
  setLimits(limits: { budget?: number; pollMs?: number }): void {
    if (limits.budget !== undefined) watchBudget = limits.budget;
    if (limits.pollMs !== undefined) pollMs = limits.pollMs;
  },
  diagnostics(): { roots: number; watchedDirs: number; polledDirs: number; previews: number } {
    let roots = 0;
    for (const inner of byContents.values()) roots += inner.size;
    let previews = 0;
    for (const inner of previewsByContents.values()) previews += inner.size;
    return {
      roots,
      watchedDirs: openDirWatchers,
      polledDirs: dirWatches.size - openDirWatchers,
      previews,
    };
  },
};
