// Refcounted registry of automation-worker attemptIds whose CANONICAL
// TerminalPane (the WorkerPane in WorkersView) is currently mounted.
//
// WHY: the live board's dock hosts a second, read-only MIRROR TerminalPane on
// the same pty sessionId. Two invariants make that safe, and both hinge on
// ordering:
//   1. The canonical pane must be the FIRST renderer attach after main's
//      headless spawn (or after a detach), so main's `previouslyDetached`
//      branch replays the raw pty tail while the canonical xterm is the one
//      listening — that replay is what reconstructs a live Ink TUI frame
//      without garbling. If a mirror won that race, the canonical pane would
//      attach second, get no replay, and come up blank.
//   2. The canonical pane owns the pty's cols/rows; the mirror never resizes
//      (readOnly + the pty.spawn mirror flag).
// Gating the mirror's mount on this registry guarantees the canonical pane's
// TerminalPane committed FIRST: its useTerminalSession spawn timer is armed in
// an earlier commit than any mirror gated on the registry flip, so its
// pty.spawn IPC is issued first and main processes it first.
//
// Refcounted so StrictMode's dev double-invoke (register → cleanup → register)
// can't briefly flicker an id out of the set while a pane is still mounted.

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Mark an attemptId's canonical pane as mounted. Returns the release fn. */
export function registerCanonicalWorkerPane(attemptId: string): () => void {
  counts.set(attemptId, (counts.get(attemptId) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = counts.get(attemptId) ?? 0;
    if (n <= 1) counts.delete(attemptId);
    else counts.set(attemptId, n - 1);
    emit();
  };
}

/** useSyncExternalStore subscribe function. */
export function subscribeCanonicalWorkerPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot read: is the canonical pane for this attemptId mounted right now? */
export function hasCanonicalWorkerPane(attemptId: string): boolean {
  return counts.has(attemptId);
}
