// Feeds large pty chunks to xterm in slices, and can finish them at once.
//
// Main sends a paused pane's whole backlog (up to 16 MB) as one message when
// the pane comes back. xterm's write buffer yields to the event loop between
// chunks (every 12 ms), but parses one chunk in a single call, so one 16 MB
// write froze the window for 100-300 ms. Written as slices of at most 128 KB,
// the same bytes reach the same parser in the same order (it carries partial
// characters and sequences across writes), and live output written after
// them queues behind them in xterm's own buffer.
//
// The cost is a longer stretch during which accepted bytes sit in xterm's
// queue unparsed. The pane's unmount snapshot is the parsed screen as text,
// which can carry neither queued bytes nor the parser's state inside a
// sequence, so an unmounting pane calls `drain()` first: every queued write
// is parsed there and then, and the snapshot sees what one write would have
// left. Without a way to drain, the writer does not slice.

export const WRITE_SLICE_BYTES = 128 * 1024;

/** `bytes` as consecutive slices of at most `max` bytes. */
export function sliceForWrite(bytes: Uint8Array, max = WRITE_SLICE_BYTES): Uint8Array[] {
  if (bytes.length <= max) return [bytes];
  const slices: Uint8Array[] = [];
  for (let from = 0; from < bytes.length; from += max) slices.push(bytes.subarray(from, from + max));
  return slices;
}

interface XtermWriteQueue {
  _innerWrite(lastTime?: number): void;
}

/**
 * A function that parses everything queued in `term`'s write buffer now, in
 * one call, running the write callbacks in order; null when this xterm build
 * does not expose its write buffer.
 *
 * xterm has no public synchronous write (its `writeSync` is deprecated and
 * replays chunks the async loop already parsed). The async loop,
 * `WriteBuffer._innerWrite(lastTime)`, stops once 12 ms have passed since
 * `lastTime`; from +Infinity that never happens, so it runs to the end of the
 * queue, exactly as its timer-driven calls would. The timer it had already
 * set then finds the queue empty. scripts/test-terminal-replay-slices.cjs
 * checks this on both xterm builds the app ships.
 */
export function xtermQueueDrainer(term: object): (() => void) | null {
  const queue = (term as { _core?: { _writeBuffer?: Partial<XtermWriteQueue> } })._core?._writeBuffer;
  if (!queue || typeof queue._innerWrite !== "function") return null;
  return () => (queue as XtermWriteQueue)._innerWrite(Number.POSITIVE_INFINITY);
}

// Bytes xterm took before a write of a later slice threw.
const acceptedBeforeErrors = new WeakMap<object, number>();

/**
 * How many bytes of the message xterm had already taken when
 * `SliceWriter.write` threw `error` (they are parsed, and acknowledged
 * through `onSlice`, as usual). 0 when nothing was taken.
 */
export function bytesAcceptedBefore(error: unknown): number {
  return typeof error === "object" && error !== null ? (acceptedBeforeErrors.get(error) ?? 0) : 0;
}

export interface SliceWriter {
  /**
   * Write `bytes` through `write` in slices. `onSlice(n)` runs as each slice
   * is parsed; `onDone` after the last one. If `write` throws, the slice and
   * the ones after it are not written and the error propagates;
   * `bytesAcceptedBefore(error)` says how much was written. `onDone` then
   * runs after the last slice written, or never if none was.
   */
  write(bytes: Uint8Array, onSlice?: (n: number) => void, onDone?: () => void): void;
  /** Bytes handed to xterm and not parsed yet, oldest first. */
  unparsed(): Uint8Array[];
  /**
   * When a slice is still waiting, parse everything queued in xterm now
   * (its callbacks run as usual). Called before an unmount snapshot.
   */
  drain(): void;
}

export function createSliceWriter(
  write: (bytes: Uint8Array, parsed: () => void) => void,
  drainQueue: (() => void) | null,
): SliceWriter {
  // xterm parses writes in order and runs each callback right after its
  // chunk, so the entries complete front to back. An entry can complete
  // inside `write` when xterm parses synchronously (right after user input).
  const queued: Array<{ bytes: Uint8Array; parsed: boolean }> = [];
  const sliceBytes = drainQueue ? WRITE_SLICE_BYTES : Number.POSITIVE_INFINITY;
  return {
    write(bytes, onSlice, onDone) {
      const slices = sliceForWrite(bytes, sliceBytes);
      // The index of the last slice written, lowered when xterm refuses one.
      let last = slices.length - 1;
      let accepted = 0;
      let previous: { parsed: boolean } | null = null;
      slices.forEach((slice, index) => {
        const entry = { bytes: slice, parsed: false };
        queued.push(entry);
        try {
          write(slice, () => {
            entry.parsed = true;
            while (queued.length > 0 && queued[0].parsed) queued.shift();
            onSlice?.(slice.length);
            if (index === last) onDone?.();
          });
        } catch (error) {
          const at = queued.indexOf(entry);
          if (at >= 0) queued.splice(at, 1);
          last = index - 1;
          if (accepted > 0 && typeof error === "object" && error !== null) {
            acceptedBeforeErrors.set(error, accepted);
          }
          // The slice before already parsed (xterm parsed it synchronously):
          // its callback has passed, so the message is done now.
          if (previous?.parsed) onDone?.();
          throw error;
        }
        accepted += slice.length;
        previous = entry;
      });
    },
    unparsed() {
      return queued.filter((entry) => !entry.parsed).map((entry) => entry.bytes);
    },
    drain() {
      if (drainQueue && queued.some((entry) => !entry.parsed)) drainQueue();
    },
  };
}
