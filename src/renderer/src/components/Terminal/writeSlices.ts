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
// up: before `ESC [` (every parser state goes to CSI entry on it), else after
// a line feed, else outside a UTF-8 character.

export const WRITE_SLICE_BYTES = 128 * 1024;

function cutPoint(bytes: Uint8Array, from: number, max: number): number {
  const end = from + max;
  const floor = from + (max >> 1);
  for (let at = end - 1; at > floor; at -= 1) {
    if (bytes[at] === 0x1b && bytes[at + 1] === 0x5b) return at;
  }
  for (let at = end; at > floor; at -= 1) {
    if (bytes[at - 1] === 0x0a) return at;
  }
  for (let at = end; at > from; at -= 1) {
    if ((bytes[at] & 0xc0) !== 0x80) return at;
  }
  return end;
}

/**
 * The last at most `max` bytes of `bytes`, starting where a fresh parser can
 * pick up (the same rule as a slice edge).
 */
export function resumableTail(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  const from = bytes.length - max;
  for (let at = from; at < bytes.length - 1; at += 1) {
    if (bytes[at] === 0x1b && bytes[at + 1] === 0x5b) return bytes.subarray(at);
  }
  for (let at = from; at < bytes.length; at += 1) {
    if (bytes[at - 1] === 0x0a) return bytes.subarray(at);
  }
  for (let at = from; at < bytes.length; at += 1) {
    if ((bytes[at] & 0xc0) !== 0x80) return bytes.subarray(at);
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

export interface SliceWriter {
  /**
   * Write `bytes` through `write` in slices. `onSlice(n)` runs as each slice
   * is parsed; `onDone` after the last one. If `write` throws, the slice and
   * the ones after it are not written and the error propagates.
   */
  write(bytes: Uint8Array, onSlice?: (n: number) => void, onDone?: () => void): void;
  /** Bytes handed to xterm and not parsed yet, oldest first. */
  unparsed(): Uint8Array[];
}

export function createSliceWriter(
  write: (bytes: Uint8Array, parsed: () => void) => void,
): SliceWriter {
  // xterm parses writes in order and runs each callback right after its
  // chunk, so the entries complete front to back. An entry completes before
  // it is pushed when xterm parses synchronously (right after user input).
  const queued: Array<{ bytes: Uint8Array; parsed: boolean }> = [];
  return {
    write(bytes, onSlice, onDone) {
      const slices = sliceForWrite(bytes);
      slices.forEach((slice, index) => {
        const entry = { bytes: slice, parsed: false };
        queued.push(entry);
        try {
          write(slice, () => {
            entry.parsed = true;
            while (queued.length > 0 && queued[0].parsed) queued.shift();
            onSlice?.(slice.length);
            if (index === slices.length - 1) onDone?.();
          });
        } catch (error) {
          queued.splice(queued.indexOf(entry), 1);
          throw error;
        }
      });
    },
    unparsed() {
      return queued.filter((entry) => !entry.parsed).map((entry) => entry.bytes);
    },
  };
}
