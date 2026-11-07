// Every agent session running in a terminal pane, across workspaces, for
// session.list_all (codara_session_list_all): what a caller reads before it
// names a session, for example the target of a relayed message. Built from the
// same per-pane activity and placement as the rail's Agents view
// (agent-board.ts), so a session reads here as it does in the rail. Pure, so
// scripts/test-live-sessions.cjs loads it without the app.

import { agentBoardLine, agentBoardRuntimeLabel, terminalAgentPlacement, type TerminalAgentActivity } from "./agent-board";
import type { RuntimeState } from "./types";

export type LiveSessionState = "working" | "needs_you" | "idle" | "done";

export interface LiveSession {
  /** The pane id: what session.relay takes as its target. */
  id: string;
  title: string;
  workspaceId: string;
  workspace: string;
  runtime: string;
  state: LiveSessionState;
  /** When the session entered its state, ISO 8601; null when unknown. */
  lastActivity: string | null;
}

export const LIVE_SESSION_LIST_LIMIT = 100;
const TITLE_MAX = 120;

const STATE_ORDER: Record<LiveSessionState, number> = { needs_you: 0, working: 1, done: 2, idle: 3 };

/** The rail's bucket, with a finished turn ("done") told apart from a quiet prompt. */
export function liveSessionState(state: RuntimeState): LiveSessionState {
  const bucket = terminalAgentPlacement(state).bucket;
  if (bucket === "needs-you") return "needs_you";
  if (bucket === "working") return "working";
  return state === "done" ? "done" : "idle";
}

/**
 * Sessions whose workspace still exists: needs_you first, then working, done
 * and idle, the latest activity first within each.
 */
export function buildLiveSessions(
  activity: readonly TerminalAgentActivity[],
  workspaces: readonly { id: string; name: string }[],
): LiveSession[] {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const out: LiveSession[] = [];
  for (const entry of activity) {
    const workspace = names.get(entry.workspaceId);
    if (workspace === undefined) continue;
    out.push({
      id: entry.paneId,
      title: agentBoardLine(entry.tabTitle, TITLE_MAX) || agentBoardRuntimeLabel(entry.runtime),
      workspaceId: entry.workspaceId,
      workspace,
      runtime: entry.runtime,
      state: liveSessionState(entry.state),
      lastActivity: entry.stateSince > 0 ? new Date(entry.stateSince).toISOString() : null,
    });
  }
  out.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") ||
      a.id.localeCompare(b.id),
  );
  return out.slice(0, LIVE_SESSION_LIST_LIMIT);
}
