import type { IMarker, Terminal } from "@xterm/xterm";
import { RESTORED_OUTPUT_MARKER_TEXT } from "@shared/terminal-scrollback";

// Output a pane had before Codara restarted (src/main/terminal-scrollback.ts),
// written into its fresh xterm before the PTY spawns, so it sits above
// whatever the new shell or the resumed agent draws.
//
// The replayed rows are history, not a live screen: an agent's last frame
// (its footer, its prompt box) is in there, and the detectors that read the
// bottom rows for agent chrome must not mistake it for an agent running now.
// A marker on the first row after the replay is that floor; readers stop
// there. xterm moves the marker as rows scroll and disposes it once the row
// leaves the scrollback, along with the history it guarded. A remount (a
// workspace switch, a drag) rebuilds the buffer from a text snapshot in a new
// xterm, and the marker does not come along; the dim marker line main wrote
// after the replay does, so the floor is also found by that line.

const replayFloors = new WeakMap<Terminal, IMarker>();

/**
 * Replay the saved output for `paneId` into `term`. Resolves once xterm has
 * parsed it (so the PTY's first bytes land below it), true when anything was
 * written.
 */
export async function replayPersistedScrollback(
  term: Terminal,
  paneId: string,
  maxLines: number,
): Promise<boolean> {
  const restore = window.spark.terminalScrollback?.restore;
  if (!restore) return false;
  const replay = await restore({ paneId, maxLines }).catch(() => null);
  if (!replay?.text) return false;
  await new Promise<void>((resolve) => {
    try {
      term.write(replay.text, resolve);
    } catch {
      resolve();
    }
  });
  try {
    const marker = term.registerMarker(0);
    if (marker) replayFloors.set(term, marker);
  } catch {
    /* a terminal disposed mid-replay has nothing left to guard */
  }
  return true;
}

type BufferReader = Pick<Terminal["buffer"]["active"], "type" | "length" | "getLine">;

/**
 * First buffer row that is not replayed history, or 0 when there is none.
 * Only rows from `searchFrom` down are searched for the marker line, so a
 * caller reading the last N rows pays for those N rows only.
 */
export function replayFloorRow(term: Terminal, searchFrom = 0): number {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return 0;
  const marker = replayFloors.get(term);
  const floor = marker && !marker.isDisposed && marker.line >= 0 ? marker.line : 0;
  return Math.max(floor, rowAfterMarkerLine(buffer, Math.max(floor, searchFrom)));
}

/**
 * The row after the last restored-output marker line at or below `from`, or
 * 0. A narrow pane wraps the marker over several rows; the logical line is
 * what is compared.
 */
export function rowAfterMarkerLine(buffer: BufferReader, from: number): number {
  if (buffer.type !== "normal") return 0;
  let text = "";
  let lineEnd = -1;
  for (let row = buffer.length - 1; row >= Math.max(0, from); row -= 1) {
    const line = buffer.getLine(row);
    if (!line) {
      text = "";
      lineEnd = -1;
      continue;
    }
    if (lineEnd < 0) lineEnd = row;
    text = line.translateToString(true) + text;
    if (line.isWrapped) continue;
    if (text.trimEnd() === RESTORED_OUTPUT_MARKER_TEXT) return lineEnd + 1;
    text = "";
    lineEnd = -1;
  }
  return 0;
}
