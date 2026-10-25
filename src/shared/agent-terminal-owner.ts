// Who opened an agent terminal, saved with the pane in the tab layout so it
// survives a restart. Main's ownership ledger (agent-terminal-registry.ts)
// lives in memory and starts empty after a relaunch; when an agent asks to
// write to or close a pane the ledger does not know, main reads this record
// from the restored layout and adopts the pane back for the same run, or for
// the same agent CLI session (a resumed Claude Code or Codex keeps its
// session id) in the same workspace.

export interface TerminalAgentOwner {
  // The workspace the opening agent ran in.
  workspaceId: string;
  runId?: string;
  sessionId?: string;
  retention?: "service";
}

export interface TerminalAgentCaller {
  runId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
}

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

// What agent-session-registry.ts captured in a pane: the newest session an
// agent CLI started or resumed there, and when.
export interface CapturedAgentSession {
  sessionId: string;
  runtime: string;
  timestamp: string;
  active?: boolean;
}

// The agent CLI session the caller runs, for ownership: the one captured in
// its pane after the caller's agent started, by the CLI running there now.
// A session captured earlier, or by another CLI, or whose process ended,
// belongs to an earlier agent in that pane, so until its own is captured the
// caller has none and only its process identifies it. `ps` gives start
// times in whole seconds, so a session captured in the second before the
// agent started still counts.
export function callerAgentSession(
  start: CapturedAgentSession | null | undefined,
  agent: { runtime: string | null | undefined; startedMs: number | null },
): string | null {
  if (!start?.sessionId || start.active === false || agent.startedMs === null) return null;
  if (agent.runtime && agent.runtime !== start.runtime) return null;
  const captured = Date.parse(start.timestamp);
  return Number.isFinite(captured) && captured >= agent.startedMs ? start.sessionId : null;
}

// The layout is user-editable localStorage: keep only a well-formed record.
export function sanitizeTerminalAgentOwner(value: unknown): TerminalAgentOwner | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const workspaceId = typeof raw.workspaceId === "string" && ID.test(raw.workspaceId) ? raw.workspaceId : null;
  const runId = typeof raw.runId === "string" && ID.test(raw.runId) ? raw.runId : null;
  const sessionId = typeof raw.sessionId === "string" && ID.test(raw.sessionId) ? raw.sessionId : null;
  if (!workspaceId || (!runId && !sessionId)) return null;
  return {
    workspaceId,
    ...(runId ? { runId } : { sessionId: sessionId! }),
    ...(raw.retention === "service" ? { retention: "service" as const } : {}),
  };
}

// A run owns what it opened; a run-less agent owns what the same CLI session
// opened from the same workspace. A run never matches a session record, so a
// Cora run cannot take over a terminal Claude Code opened, or the reverse.
export function terminalAgentOwnerMatches(owner: TerminalAgentOwner, caller: TerminalAgentCaller): boolean {
  if (owner.runId) return caller.runId === owner.runId;
  return (
    !caller.runId &&
    Boolean(owner.sessionId) &&
    caller.sessionId === owner.sessionId &&
    caller.workspaceId === owner.workspaceId
  );
}

export interface RestoredAgentTerminal {
  paneId: string;
  tabId: string;
  runId: string | null;
  retention: "temporary" | "service";
  ownerPaneId?: string;
  ownerSessionId?: string;
  ownerProcess?: string;
}

// The ledger entry to admit for a restored pane the caller asks about, or
// null when its saved owner is someone else. A run-less agent's session, and
// the pane it now runs in, become the opener again, as when it created the
// pane, so no other agent inherits it.
export function restoredAgentTerminal(
  pane: { paneId: string; tabId: string; workspaceId: string; agentOwner?: unknown },
  caller: TerminalAgentCaller & { paneId: string | null; process?: string | null },
): RestoredAgentTerminal | null {
  const owner = sanitizeTerminalAgentOwner(pane.agentOwner);
  if (!owner || !terminalAgentOwnerMatches(owner, caller)) return null;
  return {
    paneId: pane.paneId,
    tabId: pane.tabId,
    runId: owner.runId ?? null,
    retention: owner.retention ?? "temporary",
    ...(!owner.runId && caller.paneId ? { ownerPaneId: caller.paneId } : {}),
    ...(owner.sessionId ? { ownerSessionId: owner.sessionId } : {}),
    ...(!owner.runId && caller.process ? { ownerProcess: caller.process } : {}),
  };
}
