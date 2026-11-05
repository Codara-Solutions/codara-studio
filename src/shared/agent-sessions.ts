// A session one agent starts for another: a real agent CLI in a visible tab of
// a workspace, with its brief already submitted (codara_session_start). What
// the caller sees of it comes from one record plus what the pane's notifier
// knows right now. Pure, so scripts/test-agent-sessions.cjs runs it without
// the app; src/main/agent-sessions.ts keeps the records.

import type { RuntimeState } from "./types";

export const AGENT_SESSION_RUNTIMES = ["claude", "codex"] as const;
export type AgentSessionRuntime = (typeof AGENT_SESSION_RUNTIMES)[number];

export const AGENT_SESSION_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** One MCP request is limited to 64 KB, so a brief must fit well inside it. */
export const AGENT_SESSION_BRIEF_MAX_CHARS = 60_000;
/** As much of a final message as the agents' hooks hand over. */
export const AGENT_SESSION_MESSAGE_MAX_CHARS = 16_000;
/** A list stays readable: status with an id returns the whole message. */
export const AGENT_SESSION_LIST_MESSAGE_CHARS = 500;
/** A caller that loops must not run up the user's subscription unnoticed. */
export const AGENT_SESSION_MAX_LIVE = 12;
export const AGENT_SESSION_WAIT_DEFAULT_SECONDS = 120;
export const AGENT_SESSION_WAIT_MAX_SECONDS = 540;

/** No agent showed up in the pane in this long: the launch failed. */
export const AGENT_SESSION_LAUNCH_LIMIT_MS = 3 * 60_000;
/** A new tab reaches the notifier a moment after it opens. */
export const AGENT_SESSION_PANE_GRACE_MS = 30_000;
// `ps` and hooks disagree by moments; a turn that began just before the prompt
// was recorded is that prompt's turn.
const PROMPT_SKEW_MS = 2_000;

export type AgentSessionStatus =
  | "starting"
  | "working"
  | "needs_you"
  | "finished"
  | "failed"
  | "closed";

export interface AgentSessionRecord {
  id: string;
  runtime: AgentSessionRuntime;
  model: string | null;
  effort: string | null;
  title: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  branch: string | null;
  /** The workspace the caller ran in; every agent there can find the session. */
  callerWorkspaceId: string | null;
  /** The process that started it, for a caller with no workspace. */
  ownerProcess: string | null;
  startedAt: number;
  /** When the latest brief or message was sent. */
  promptAt: number;
  turnEndedAt: number | null;
  /** The last turn ended with an error rather than an answer. */
  failure: string | null;
  finalMessage: string | null;
  /** The user or the caller closed the tab. */
  closedAt: number | null;
}

/** What the pane's notifier knows now; null while no watcher holds the pane. */
export interface AgentSessionLive {
  runtime: string | null;
  state: RuntimeState;
  tool: string | null;
  question: string | null;
  lastTurnStartedAt: number;
  turnActive: boolean;
}

export interface AgentSessionState {
  status: AgentSessionStatus;
  /** Why, when the status alone does not say what to do next. */
  detail: string | null;
}

const WORKING_STATES: ReadonlySet<RuntimeState> = new Set(["working", "background", "stalled"]);
const AT_REST_STATES: ReadonlySet<RuntimeState> = new Set(["idle", "done"]);

/** The session reached a point where its caller should look: a wait ends here. */
export function agentSessionSettled(status: AgentSessionStatus): boolean {
  return status !== "starting" && status !== "working";
}

/** Still running, for the cap on live sessions. */
export function agentSessionLive(status: AgentSessionStatus): boolean {
  return status === "starting" || status === "working" || status === "needs_you";
}

/**
 * `bootAt` is when this Codara started: a prompt sent before it was answered
 * by a process that no longer exists unless its turn end was recorded.
 */
export function agentSessionState(
  record: AgentSessionRecord,
  live: AgentSessionLive | null,
  now: number,
  bootAt: number,
): AgentSessionState {
  const answered = record.turnEndedAt !== null && record.turnEndedAt >= record.promptAt;
  const ended = (): AgentSessionState =>
    record.failure ? { status: "failed", detail: record.failure } : { status: "finished", detail: null };
  if (!live) {
    if (record.closedAt === null && now - record.startedAt < AGENT_SESSION_PANE_GRACE_MS) {
      return { status: "starting", detail: null };
    }
    if (answered) return ended();
    return { status: "closed", detail: "The tab was closed before the session finished." };
  }
  if (live.state === "blocked") {
    return { status: "needs_you", detail: live.question ?? "Waiting for the user in its tab." };
  }
  if (live.turnActive || WORKING_STATES.has(live.state)) return { status: "working", detail: null };
  if (answered) return ended();
  if (live.state === "error") {
    return { status: "failed", detail: record.failure ?? "The agent stopped unexpectedly." };
  }
  const atRest = AT_REST_STATES.has(live.state);
  // Its turn ran and closed with no answer: the user stopped it, or it ended
  // some way the hooks did not report.
  if (atRest && live.lastTurnStartedAt >= record.promptAt - PROMPT_SKEW_MS) {
    return { status: "finished", detail: "The turn ended without a final message; read its tab." };
  }
  if (atRest && record.promptAt < bootAt) {
    return {
      status: "failed",
      detail: "Codara restarted during this turn. The session is open and idle; message it to continue.",
    };
  }
  if (now - record.promptAt > AGENT_SESSION_LAUNCH_LIMIT_MS && !live.runtime) {
    return { status: "failed", detail: "No agent started in its tab; read the terminal for the error." };
  }
  return { status: record.promptAt === record.startedAt ? "starting" : "working", detail: null };
}
