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
//
// A paused pane's backlog is different: main sends it in slices on the replay
// channel itself, each carrying its bytes, its end offset and the listener it
// is for in one message, so a pane knows exactly which slices are its own and
// which it took in (slice / tookIn / replayedTo).

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
  /** This listener's name in resume(): main addresses its slices to it. */
  readonly token: number;
  /**
   * One slice of a paused pane's backlog arrived on the replay channel.
   * Returns the bytes to write, or null. A slice addressed to this listener
   * is always written: main sends each such slice once, after this listener
   * exists. One addressed to another listener is skipped, unless this pane
   * only watches (a read-only mirror) or the slice is addressed to nobody;
   * then only bytes past what it already wrote are kept (a slice put back by
   * a pause comes again with its first offset).
   */
  slice(data: Uint8Array, end: number, token: number | undefined, watchOnly: boolean): Uint8Array | null;
  /** The pane took in (parsed or kept) its slice ending at `end`. */
  tookIn(end: number): void;
  /** End offset of the last slice addressed to this listener it took in; 0 before. */
  replayedTo(): number;
}

// Tokens only grow, also across reloads of the same window (main keeps the
// highest token a pause retired and ignores resumes at or below it): count
// from this document's start time in microseconds-ish steps.
let lastToken = Math.floor(performance.timeOrigin + performance.now()) * 1000;

export function createReplayTracker(): ReplayTracker {
  let pending = 0;
  let seen = 0;
  let taken = 0;
  const token = ++lastToken;
  return {
    token,
    announce(bytes: number): void {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      pending += bytes;
    },
    consume(chunkLength: number): boolean {
      if (pending <= 0) return false;
      pending = Math.max(0, pending - Math.max(0, chunkLength));
      return true;
    },
    slice(data: Uint8Array, end: number, to: number | undefined, watchOnly: boolean): Uint8Array | null {
      if (!Number.isFinite(end)) return null;
      if (to === token) {
        seen = Math.max(seen, end);
        return data;
      }
      if (to !== undefined && !watchOnly) return null;
      if (end <= seen) return null;
      const start = end - data.length;
      const fresh = seen > start ? data.subarray(seen - start) : data;
      seen = end;
      return fresh;
    },
    tookIn(end: number): void {
      taken = Math.max(taken, end);
    },
    replayedTo(): number {
      return taken;
    },
  };
}
