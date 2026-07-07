// In-app file clipboard for the explorer's copy/cut/paste. Module-level
// singleton (not FileTree state) because FileTree remounts with key={cwd}
// on every workspace switch — a cut made in one workspace must survive into
// another. The OS clipboard (clipboard:writeFilePaths / readFilePaths) is
// the interop payload; this store is the source of truth for cut-vs-copy
// mode and the cut-row dimming, and the fallback path list when OS file
// clipboard interop is unavailable.
export interface ExplorerClipboardState {
  mode: "copy" | "cut";
  paths: string[];
}

let state: ExplorerClipboardState | null = null;
const listeners = new Set<() => void>();

export function getExplorerClipboard(): ExplorerClipboardState | null {
  return state;
}

export function setExplorerClipboard(next: ExplorerClipboardState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeExplorerClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
