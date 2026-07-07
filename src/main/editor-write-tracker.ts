// Tracks the (path, mtimeMs) of every editor-initiated disk write — manual
// Ctrl+S and autosave alike — so the stuck-worker watchdog can discount mtime
// bumps the editor caused. Without this, periodic autosave writes inside a
// worker's cwd would keep refreshing the watchdog's workspace-activity channel
// and a genuinely stuck agent would never be flagged.
//
// Exact-mtime match, not a time window: a file's mtime after our own write is
// stable until something else touches it, so an exact match is unambiguous.
// The next non-editor write produces a fresh mtime that no longer matches.
const recent = new Map<string, number>(); // absolute path -> mtimeMs written
const MAX_ENTRIES = 2000;

export function recordEditorWrite(path: string, mtimeMs: number): void {
  // Re-insert to keep Map iteration order ~LRU so the cap evicts the oldest.
  recent.delete(path);
  recent.set(path, mtimeMs);
  if (recent.size > MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

export function isEditorWrittenMtime(path: string, mtimeMs: number): boolean {
  return recent.get(path) === mtimeMs;
}
