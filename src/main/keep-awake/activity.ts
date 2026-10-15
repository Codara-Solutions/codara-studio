import type { KeepAwakeActivity } from "@shared/keep-awake";
import type { RuntimeState } from "@shared/types";

// What counts as "agents work" for keep-awake, from the snapshots the rest of
// main already keeps: the terminal notifier's chip state per pane, the
// pane's last output time, and the run store's live work.

/**
 * A pane the notifier still calls "working" after this long without a byte
 * of output is a detection that missed its turn end, not a turn: every agent
 * CLI repaints its working footer (a spinner, an elapsed time) while it works.
 * Without this cap a wedged detection would keep the computer awake forever.
 */
export const TERMINAL_AGENT_SILENT_STALE_MS = 30 * 60_000;

export interface TerminalAgentState {
  paneId: string;
  state: RuntimeState;
}

export function countWorkingTerminalAgents(
  states: ReadonlyArray<TerminalAgentState>,
  lastOutputAt: (paneId: string) => number | null,
  now: number,
  staleMs = TERMINAL_AGENT_SILENT_STALE_MS,
): number {
  let count = 0;
  for (const entry of states) {
    if (entry.state !== "working") continue;
    const at = lastOutputAt(entry.paneId);
    // No live PTY behind the pane: whatever the chip says, nothing runs.
    if (at === null || !Number.isFinite(at)) continue;
    if (now - at > staleMs) continue;
    count += 1;
  }
  return count;
}

export interface CoraLiveWork {
  chats: number;
  automations: number;
  workers: number;
}

/**
 * Combine the counts. A workflow run is a direct run, so one with an agent
 * running already counts once among the run store's automations; one whose
 * script runs between agents counts through activeWorkflows.
 */
export function combineKeepAwakeActivity(input: {
  terminalAgents: number;
  live: CoraLiveWork | null;
  activeWorkflows: number;
}): KeepAwakeActivity {
  const live = input.live ?? { chats: 0, automations: 0, workers: 0 };
  return {
    terminalAgents: Math.max(0, input.terminalAgents),
    chats: Math.max(0, live.chats),
    automations: Math.max(0, live.automations, input.activeWorkflows),
    workers: Math.max(0, live.workers),
  };
}
