import { watch, readdirSync, FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
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

interface State {
  root: string;
  // One non-recursive watcher on the root (catches top-level file changes and
  // newly-created top-level directories) plus one recursive watcher per
  // non-ignored top-level directory. Keyed by the absolute path being watched
  // so we can avoid double-watching a directory we already cover and dispose
  // every handle on stop. The root key is the `root` path itself.
  watchers: Map<string, FSWatcher>;
  pendingDirs: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

const byContents = new Map<number, State>();

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

// Create a recursive watcher for a single non-ignored top-level directory and
// register it on the state. Returns true if a watcher was added (false if one
// already exists for that path, or creation failed).
function watchTopLevelDir(
  state: State,
  webContents: WebContents,
  dirAbsolute: string,
): boolean {
  if (state.watchers.has(dirAbsolute)) return false;
  let watcher: FSWatcher;
  try {
    watcher = watch(dirAbsolute, { recursive: true, persistent: true });
  } catch (err) {
    // fs.watch with { recursive: true } is unsupported on Linux; the manual
    // refresh button is the fallback there.
    console.warn("[fs-watcher] failed to watch", dirAbsolute, err);
    return false;
  }
  watcher.on("error", (err) => {
    console.warn("[fs-watcher] error", err);
  });
  watcher.on("change", (eventType, filename) => {
    // 'change' events fire on file content writes (e.g. saving via the editor)
    // and would force needless directory refreshes. Only react to 'rename',
    // which covers creation, deletion, and renames.
    if (eventType !== "rename" || !filename) return;
    stageChange(state, dirAbsolute, String(filename));
    scheduleFlush(state, webContents);
  });
  state.watchers.set(dirAbsolute, watcher);
  return true;
}

export function setWatchRoot(webContents: WebContents, root: string | null): void {
  const id = webContents.id;
  const existing = byContents.get(id);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    for (const watcher of existing.watchers.values()) {
      try { watcher.close(); } catch { /* noop */ }
    }
    byContents.delete(id);
  }
  if (!root) return;

  const state: State = {
    root,
    watchers: new Map<string, FSWatcher>(),
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
    rootWatcher = watch(root, { recursive: false, persistent: true });
  } catch (err) {
    console.warn("[fs-watcher] failed to watch", root, err);
    return;
  }
  rootWatcher.on("error", (err) => {
    console.warn("[fs-watcher] error", err);
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
      watchTopLevelDir(state, webContents, childAbsolute);
    } catch { /* not a directory (file change or deletion) — nothing to watch */ }

    stageChange(state, root, rel);
    scheduleFlush(state, webContents);
  });
  state.watchers.set(root, rootWatcher);

  // Enumerate the root's immediate entries and spin up one recursive watcher
  // per non-ignored top-level directory. Failures here are non-fatal: the root
  // watcher above still observes top-level activity.
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_TOP_LEVEL.has(entry.name)) continue;
      watchTopLevelDir(state, webContents, resolve(root, entry.name));
    }
  } catch (err) {
    console.warn("[fs-watcher] failed to enumerate", root, err);
  }

  byContents.set(id, state);
}

export function disposeForWebContents(webContents: WebContents): void {
  const state = byContents.get(webContents.id);
  if (!state) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  for (const watcher of state.watchers.values()) {
    try { watcher.close(); } catch { /* noop */ }
  }
  byContents.delete(webContents.id);
}

export function disposeAll(): void {
  for (const state of byContents.values()) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    for (const watcher of state.watchers.values()) {
      try { watcher.close(); } catch { /* noop */ }
    }
  }
  byContents.clear();
}
