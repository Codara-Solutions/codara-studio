// Tells replayed PTY history apart from live child output on a pane's data
// stream.
//
// Main deliberately pushes old bytes down the SAME channel as live output —
// the raw-tail frame on reattach, the buffered backlog after a lock/sleep —
// because xterm must apply them in arrival order to reproduce the screen.
// That is right for rendering and wrong for every heuristic reading the same
// stream: a `Local: http://localhost:3000` line a dev server printed before
// the laptop slept re-arrives on wake looking exactly like a server that just
// came up, and Studio would auto-open a preview onto a port nothing is
// listening on any more.
//
// So main announces the replay's byte count first (announceReplay in
// src/main/pty-manager.ts) and the renderer counts those bytes off the chunks
// that follow. Byte accounting rather than a boolean flag because a replay is
// only usually one send: Electron may split a large frame or coalesce the tail
// of a replay with the first live bytes behind it, and a flag would then either
// clear too early (live bytes attributed to history) or too late (a real
// server start ignored).

export interface ReplayTracker {
  /** Main announced `bytes` of replayed history heading down the data channel. */
  announce(bytes: number): void;
  /**
   * Account for one arriving chunk. True when it carries replayed history, so
   * callers can render it normally but refuse to treat it as something that
   * just happened. A chunk that straddles the boundary counts as replay: the
   * conservative side of the split, since acting on history is the defect and
   * skipping one auto-open is not.
   */
  consume(chunkLength: number): boolean;
}

export function createReplayTracker(): ReplayTracker {
  let pending = 0;
  return {
    announce(bytes: number): void {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      pending += bytes;
    },
    consume(chunkLength: number): boolean {
      if (pending <= 0) return false;
      pending = Math.max(0, pending - Math.max(0, chunkLength));
      return true;
    },
  };
}
