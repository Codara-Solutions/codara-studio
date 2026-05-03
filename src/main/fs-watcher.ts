import { watch, FSWatcher } from "node:fs";
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
  watcher: FSWatcher;
  pendingDirs: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

const byContents = new Map<number, State>();

export function setWatchRoot(webContents: WebContents, root: string | null): void {
  const id = webContents.id;
  const existing = byContents.get(id);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    try { existing.watcher.close(); } catch { /* noop */ }
    byContents.delete(id);
  }
  if (!root) return;

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: true });
  } catch (err) {
    // fs.watch with { recursive: true } is unsupported on Linux; the manual
    // refresh button is the fallback there.
    console.warn("[fs-watcher] failed to watch", root, err);
    return;
  }

  const state: State = {
    root,
    watcher,
    pendingDirs: new Set<string>(),
    flushTimer: null,
  };

  watcher.on("error", (err) => {
    console.warn("[fs-watcher] error", err);
  });

  watcher.on("change", (eventType, filename) => {
    // 'change' events fire on file content writes (e.g. saving via the editor)
    // and would force needless directory refreshes. Only react to 'rename',
    // which covers creation, deletion, and renames.
    if (eventType !== "rename" || !filename) return;
    const rel = String(filename);
    const firstSegment = rel.split(/[\\/]/, 1)[0];
    if (IGNORED_TOP_LEVEL.has(firstSegment)) return;

    const absolute = resolve(root, rel);
    state.pendingDirs.add(dirname(absolute));

    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const dirs = Array.from(state.pendingDirs);
      state.pendingDirs.clear();
      if (webContents.isDestroyed()) return;
      const event: FsChangeEvent = { root: state.root, dirs };
      webContents.send(CHANNEL, event);
    }, DEBOUNCE_MS);
  });

  byContents.set(id, state);
}

export function disposeForWebContents(webContents: WebContents): void {
  const state = byContents.get(webContents.id);
  if (!state) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  try { state.watcher.close(); } catch { /* noop */ }
  byContents.delete(webContents.id);
}

export function disposeAll(): void {
  for (const state of byContents.values()) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    try { state.watcher.close(); } catch { /* noop */ }
  }
  byContents.clear();
}
