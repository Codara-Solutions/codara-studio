// Feeds large pty chunks to xterm in slices, and remembers what xterm has not
// parsed yet.
//
// Main sends a paused pane's whole backlog (up to 16 MB) as one message when
// the pane comes back. xterm's write buffer yields to the event loop between
// chunks (every 12 ms), but parses one chunk in a single call, so one 16 MB
// write froze the window for 100-300 ms. Written as slices of at most 128 KB,
// the same bytes are parsed in the same order, and live output written after
// them queues behind them in xterm's own buffer.
//
// The cost is a longer stretch during which bytes sit in xterm's queue
// unparsed. If the pane unmounts then, its text snapshot cannot hold them, so
// the caller hands `unparsed()` to the next mount with the snapshot instead
// of dropping them. A slice therefore ends only where a fresh parser can pick
// up: before ESC (every parser state, strings included, goes to the escape
// state on it), else after a line feed, else outside a UTF-8 character.

export const WRITE_SLICE_BYTES = 128 * 1024;

const ESC = 0x1b;
const LF = 0x0a;

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

function cutPoint(bytes: Uint8Array, from: number, max: number): number {
  const end = from + max;
  const floor = from + (max >> 1);
  // Best: a line feed right before an escape sequence, so neither a line nor
  // a sequence is split. Then before ESC, then after a line feed.
  for (let at = end; at > floor; at -= 1) {
    if (bytes[at] === ESC && bytes[at - 1] === LF) return at;
  }
  for (let at = end; at > floor; at -= 1) {
    if (bytes[at] === ESC) return at;
  }
  for (let at = end; at > floor; at -= 1) {
    if (bytes[at - 1] === LF) return at;
  }
  for (let at = end; at > from; at -= 1) {
    if (!isContinuation(bytes[at])) return at;
  }
  return end;
}

/**
 * The last at most `max` bytes of `bytes`, starting at the first point a
 * fresh parser can resume from (before ESC or after a line feed), else
 * outside a UTF-8 character.
 */
export function resumableTail(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  const from = bytes.length - max;
  for (let at = from; at < bytes.length; at += 1) {
    if (bytes[at] === ESC || bytes[at - 1] === LF) return bytes.subarray(at);
  }
  for (let at = from; at < bytes.length; at += 1) {
    if (!isContinuation(bytes[at])) return bytes.subarray(at);
  }
  return bytes.subarray(bytes.length);
}

/** `bytes` as consecutive slices of at most `max` bytes, cut where a fresh parser can resume. */
export function sliceForWrite(bytes: Uint8Array, max = WRITE_SLICE_BYTES): Uint8Array[] {
  if (bytes.length <= max) return [bytes];
  const slices: Uint8Array[] = [];
  let from = 0;
  while (bytes.length - from > max) {
    const at = cutPoint(bytes, from, max);
    slices.push(bytes.subarray(from, at));
    from = at;
  }
  slices.push(bytes.subarray(from));
  return slices;
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
}

export function createSliceWriter(
  write: (bytes: Uint8Array, parsed: () => void) => void,
): SliceWriter {
  // xterm parses writes in order and runs each callback right after its
  // chunk, so the entries complete front to back. An entry can complete
  // inside `write` when xterm parses synchronously (right after user input).
  const queued: Array<{ bytes: Uint8Array; parsed: boolean }> = [];
  return {
    write(bytes, onSlice, onDone) {
      const slices = sliceForWrite(bytes);
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
  };
}

/**
 * What an unmounting pane hands to its next mount: the bytes xterm had not
 * parsed (`unparsed()`), then the bytes that arrived while it was hidden, as
 * one buffer trimmed from the front to at most `scrollbackLineLimit` line
 * feeds (more would scroll out of the terminal anyway). Null when empty.
 */
export function handoffBytes(
  unparsed: Uint8Array[],
  hidden: Uint8Array[],
  scrollbackLineLimit: number,
): Uint8Array | null {
  const chunks = [...unparsed, ...hidden];
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (totalBytes <= 0) return null;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const maxLineBreaks = Math.max(0, scrollbackLineLimit);
  let start = 0;
  let seen = 0;
  for (let i = totalBytes - 1; i >= 0; i--) {
    if (merged[i] !== LF) continue;
    seen += 1;
    if (seen > maxLineBreaks) {
      start = i + 1;
      break;
    }
  }
  const trimmed = start > 0 ? merged.slice(start) : merged;
  return trimmed.length > 0 ? trimmed : null;
}
