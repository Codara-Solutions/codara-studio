import type { IMarker, Terminal } from "@xterm/xterm";

// Output a pane had before Codara restarted (src/main/terminal-scrollback.ts),
// written into its fresh xterm before the PTY spawns, so it sits above
// whatever the new shell or the resumed agent draws.
//
// The replayed rows are history, not a live screen: an agent's last frame
// (its footer, its prompt box) is in there, and the detectors that read the
// bottom rows for agent chrome must not mistake it for an agent running now.
// A marker on the first row after the replay is that floor; readers stop
// there. xterm moves the marker as rows scroll and disposes it once the row
// leaves the scrollback, along with the history it guarded.

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

/** First buffer row that is not replayed history, or 0 when there is none. */
export function replayFloorRow(term: Terminal): number {
  if (term.buffer.active.type !== "normal") return 0;
  const marker = replayFloors.get(term);
  if (!marker || marker.isDisposed || marker.line < 0) return 0;
  return marker.line;
}
