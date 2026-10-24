// The agent CLI running in a terminal pane (claude, codex, ...), from its live
// state or, before the first state arrives, from its session start record.

import { latestSessionStart } from "./agent-session-registry";
import { terminalAgentStateSnapshot } from "./terminal-agent-notify";

export function paneAgentRuntime(paneId: string): string | null {
  return terminalAgentStateSnapshot().find((pane) => pane.paneId === paneId)?.runtime ?? latestSessionStart(paneId)?.runtime ?? null;
}
