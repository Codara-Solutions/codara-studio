// The Agents view of the workspace rail: every agent terminal and Cora run
// across all workspaces, sorted into Needs you, Working and Done.
//
// Pure and shared so the bucketing is testable without the app
// (scripts/test-agent-board.cjs). Main contributes what only its terminal
// notifier knows (the tool, the last message, when a turn started); the
// renderer adds the tab layouts it holds, the run list and the alerts the
// user has not seen yet, and renders what buildAgentBoard returns.

import { isBackendFailurePark, resolveOpenRunQuestion } from "./run-questions";
import type {
  NavigationTarget,
  RunQuestionOption,
  RunState,
  RuntimeState,
  TerminalAgentRuntime,
} from "./types";

/** One user terminal pane hosting an agent CLI, as main's notifier sees it. */
export interface TerminalAgentActivity {
  paneId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
  runtime: TerminalAgentRuntime;
  state: RuntimeState;
  /** When the pane entered `state` (ms since epoch). */
  stateSince: number;
  /** When the agent session now in the pane started. */
  sessionSince: number;
  /** Start of the turn in progress, or null between turns. */
  turnStartedAt: number | null;
  /** The tool the agent is running or asks to run, when its hooks say so. */
  tool: string | null;
  /** The user's latest prompt, one line, when the agent's hooks report it. */
  prompt: string | null;
  /** The agent's latest finished message, one line. */
  message: string | null;
  /** What the agent waits on while blocked. */
  question: string | null;
  /** The CLI account the pane was started on, when Codara chose one. */
  accountProfileId: string | null;
}

/** A pane the renderer's layouts show with a live agent chip. */
export interface AgentBoardLayoutPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
  runtime: TerminalAgentRuntime;
  state?: RuntimeState;
  accountProfileId?: string;
}

export interface AgentBoardWorkspace {
  id: string;
  name: string;
  color?: string;
}

/** What a Cora run's live stream said last (tool calls, assistant text). */
export interface AgentBoardRunLive {
  tool: string | null;
  text: string | null;
}

export type AgentBoardBucket = "needs-you" | "working" | "done";
export type AgentBoardTone = "warn" | "accent" | "ok" | "muted" | "danger";
export type AgentBoardRuntime = TerminalAgentRuntime | "cora";

// "pane": the agent is back at its prompt (it stopped with an error), so a
// reply is pasted there and submitted like a new prompt. "pane-dialog": the
// agent waits in a menu (a permission prompt, a question, a plan to approve,
// a trust screen) that takes keys, where pasted text and Enter could pick the
// highlighted answer the user never chose; the card opens the pane instead.
export type AgentBoardReply =
  | { kind: "pane"; paneId: string }
  | { kind: "pane-dialog"; paneId: string }
  | { kind: "question"; runId: string; questionMessageId: string; options: RunQuestionOption[] }
  | { kind: "message"; runId: string };

export interface AgentBoardCard {
  /** "pane:<id>" or "run:<id>"; stable across updates. */
  key: string;
  source: "terminal" | "cora";
  bucket: AgentBoardBucket;
  status: string;
  tone: AgentBoardTone;
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  runtime: AgentBoardRuntime;
  agentLabel: string;
  account: string | null;
  title: string;
  message: string | null;
  tool: string | null;
  detail: string | null;
  /** Start of what the elapsed time measures; 0 when unknown. */
  since: number;
  /** Finished or waiting since the user last looked at it. */
  unseen: boolean;
  target: NavigationTarget;
  reply: AgentBoardReply | null;
}

export interface AgentBoardModel {
  needsYou: AgentBoardCard[];
  working: AgentBoardCard[];
  done: AgentBoardCard[];
  total: number;
}

export interface AgentBoardInput {
  now: number;
  workspaces: readonly AgentBoardWorkspace[];
  layoutPanes: readonly AgentBoardLayoutPane[];
  /** Main's view of every user pane; null until the first read arrives. */
  activity: readonly TerminalAgentActivity[] | null;
  runs: readonly RunState[];
  runLive?: Readonly<Record<string, AgentBoardRunLive>>;
  /** Panes with an alert the user has not seen, by pane id. */
  unseenPanes?: Readonly<Record<string, "blocked" | "complete">>;
  /** Account labels by profile id (CLI profiles and Cora's Pi profiles). */
  accountLabels?: Readonly<Record<string, string>>;
  /** How long a finished Cora run stays under Done. */
  doneWindowMs?: number;
}

export const AGENT_BOARD_DONE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const AGENT_BOARD_LINE_MAX = 200;

const RUNTIME_LABEL: Record<AgentBoardRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
  cora: "Cora",
};

export function agentBoardRuntimeLabel(runtime: AgentBoardRuntime): string {
  return RUNTIME_LABEL[runtime] ?? "Agent";
}

/** A message as one plain line: markdown markers and code blocks dropped. */
export function agentBoardLine(text: unknown, max = AGENT_BOARD_LINE_MAX): string | null {
  if (typeof text !== "string") return null;
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Elapsed time in the rail's compact voice: "now", "4m", "2h 5m", "3d". */
export function formatAgentElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

interface Placement {
  bucket: AgentBoardBucket;
  status: string;
  tone: AgentBoardTone;
}

/** Where a terminal agent in `state` belongs. */
export function terminalAgentPlacement(state: RuntimeState | undefined): Placement {
  switch (state) {
    case "blocked":
      return { bucket: "needs-you", status: "Needs you", tone: "warn" };
    case "error":
      return { bucket: "needs-you", status: "Stopped", tone: "danger" };
    case "working":
      return { bucket: "working", status: "Working", tone: "accent" };
    case "stalled":
      return { bucket: "working", status: "No output", tone: "accent" };
    case "idle":
    case "done":
      return { bucket: "done", status: "Ready", tone: "ok" };
    default:
      return { bucket: "working", status: "Starting", tone: "muted" };
  }
}

// Loom passes, workflow runs and board-card runs have their own surfaces;
// they only reach the board while they work or wait on the user.
function hubOwned(run: RunState): boolean {
  return Boolean(run.automationId || run.workflow || run.boardCardId);
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Where a Cora run belongs, or null when it should not be on the board. */
export function coraRunPlacement(
  run: RunState,
  now: number,
  doneWindowMs = AGENT_BOARD_DONE_WINDOW_MS,
): Placement | null {
  switch (run.status) {
    case "planning":
      return { bucket: "working", status: "Planning", tone: "accent" };
    case "running":
      return { bucket: "working", status: "Working", tone: "accent" };
    case "reviewing":
      return { bucket: "working", status: "Reviewing", tone: "accent" };
    case "blocked":
      if (isBackendFailurePark(run)) {
        if (hubOwned(run)) return null;
        return { bucket: "done", status: "Turn failed", tone: "danger" };
      }
      return { bucket: "needs-you", status: "Needs you", tone: "warn" };
    case "paused":
      return { bucket: "needs-you", status: "Paused", tone: "warn" };
    default:
      break;
  }
  if (hubOwned(run)) return null;
  const finished = time(run.completedAt) || time(run.updatedAt);
  const recent = finished > 0 && now - finished <= doneWindowMs;
  if (run.status === "complete") {
    if (run.seen === true && !recent) return null;
    return { bucket: "done", status: "Done", tone: "ok" };
  }
  if (!recent) return null;
  if (run.status === "failed") return { bucket: "done", status: "Failed", tone: "danger" };
  if (run.status === "cancelled") return { bucket: "done", status: "Cancelled", tone: "muted" };
  return null;
}

function lastCoraLine(run: RunState): string | null {
  const messages = run.humanMessages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.author !== "spark") continue;
    if (message.compaction || message.boardNote) continue;
    const line = agentBoardLine(message.message);
    if (line) return line;
  }
  return null;
}

function runningWorkers(run: RunState): number {
  let count = 0;
  for (const task of run.workerTasks ?? []) {
    if (task.status === "running" || task.status === "claimed") count += 1;
  }
  return count;
}

function currentCallStart(run: RunState): number {
  const calls = run.sparkCalls ?? [];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call.status === "started" && !call.completedAt) return time(call.createdAt);
  }
  return 0;
}

function coraCard(
  run: RunState,
  placement: Placement,
  workspace: AgentBoardWorkspace,
  input: AgentBoardInput,
): AgentBoardCard {
  const live = input.runLive?.[run.id];
  const question = placement.bucket === "needs-you" ? resolveOpenRunQuestion(run) : null;
  const workers = runningWorkers(run);
  const detailParts: string[] = [];
  if (run.automationId) detailParts.push("Automation");
  else if (run.workflow) detailParts.push("Workflow");
  if (placement.bucket === "working" && workers > 0) {
    detailParts.push(`${workers} worker${workers === 1 ? "" : "s"} running`);
  }
  let since = time(run.updatedAt);
  if (placement.bucket === "working") since = currentCallStart(run) || since;
  else if (placement.bucket === "needs-you") since = time(question?.createdAt) || since;
  else since = time(run.completedAt) || since;
  let reply: AgentBoardReply | null = null;
  if (placement.bucket === "needs-you") {
    reply = question
      ? { kind: "question", runId: run.id, questionMessageId: question.id, options: question.questionOptions ?? [] }
      : { kind: "message", runId: run.id };
  }
  // A Loom pass opens in the Automations hub, as its notifications do;
  // everything else opens as a chat.
  const target: NavigationTarget = run.automationId && !run.boardCardId
    ? { type: "automation", jobId: run.automationId, runId: run.id, workspaceId: run.workspaceId }
    : { type: "run", runId: run.id, workspaceId: run.workspaceId };
  return {
    key: `run:${run.id}`,
    source: "cora",
    bucket: placement.bucket,
    status: placement.status,
    tone: placement.tone,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceColor: workspace.color ?? null,
    runtime: "cora",
    agentLabel: agentBoardRuntimeLabel("cora"),
    account: (run.chatAccountProfileId && input.accountLabels?.[run.chatAccountProfileId]) || null,
    title: agentBoardLine(run.title, 120) ?? "Cora chat",
    message: question
      ? agentBoardLine(question.message)
      : (placement.bucket === "working" ? agentBoardLine(live?.text) : null) ?? lastCoraLine(run),
    tool: placement.bucket === "working" ? agentBoardLine(live?.tool, 120) : null,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
    since,
    unseen: placement.bucket === "done" && run.status === "complete" && run.seen !== true,
    target,
    reply,
  };
}

interface MergedPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
  runtime: TerminalAgentRuntime;
  state: RuntimeState | undefined;
  activity: TerminalAgentActivity | null;
  accountProfileId: string | null;
}

function mergePanes(input: AgentBoardInput): MergedPane[] {
  const merged = new Map<string, MergedPane>();
  for (const pane of input.layoutPanes) {
    merged.set(pane.paneId, {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      tabTitle: pane.tabTitle,
      runtime: pane.runtime,
      state: pane.state,
      activity: null,
      accountProfileId: pane.accountProfileId ?? null,
    });
  }
  for (const activity of input.activity ?? []) {
    const layout = merged.get(activity.paneId);
    merged.set(activity.paneId, {
      paneId: activity.paneId,
      // The layout the renderer holds is where the pane lives now; main
      // learns about a move only on the next registry sync.
      workspaceId: layout?.workspaceId ?? activity.workspaceId,
      tabId: layout?.tabId ?? activity.tabId,
      tabTitle: layout?.tabTitle ?? activity.tabTitle,
      runtime: activity.runtime,
      state: activity.state,
      activity,
      accountProfileId: activity.accountProfileId ?? layout?.accountProfileId ?? null,
    });
  }
  return [...merged.values()];
}

function terminalCard(
  pane: MergedPane,
  workspace: AgentBoardWorkspace,
  input: AgentBoardInput,
): AgentBoardCard {
  const placement = terminalAgentPlacement(pane.state);
  const activity = pane.activity;
  let message: string | null = null;
  if (pane.state === "blocked") message = activity?.question ?? "Waiting for your answer.";
  else if (pane.state === "error") message = activity?.message ?? "Stopped with an error.";
  else message = activity?.message ?? null;
  const unseenKind = input.unseenPanes?.[pane.paneId];
  const finishedTurn = placement.bucket === "done" && activity?.message != null;
  let since = activity?.stateSince ?? 0;
  if (placement.bucket === "working") since = activity?.turnStartedAt ?? since;
  return {
    key: `pane:${pane.paneId}`,
    source: "terminal",
    bucket: placement.bucket,
    status: placement.bucket === "done" && (finishedTurn || unseenKind === "complete") ? "Finished" : placement.status,
    tone: placement.tone,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceColor: workspace.color ?? null,
    runtime: pane.runtime,
    agentLabel: agentBoardRuntimeLabel(pane.runtime),
    account: (pane.accountProfileId && input.accountLabels?.[pane.accountProfileId]) || null,
    title: activity?.prompt ?? (agentBoardLine(pane.tabTitle, 120) || agentBoardRuntimeLabel(pane.runtime)),
    message: agentBoardLine(message),
    tool:
      pane.state === "working" || pane.state === "blocked" || pane.state === "stalled"
        ? agentBoardLine(activity?.tool, 120)
        : null,
    detail: null,
    since,
    unseen: placement.bucket === "done" && unseenKind === "complete",
    target: { type: "terminal", workspaceId: pane.workspaceId, tabId: pane.tabId, paneId: pane.paneId },
    reply: terminalReply(pane),
  };
}

function terminalReply(pane: MergedPane): AgentBoardReply | null {
  if (pane.state === "blocked") return { kind: "pane-dialog", paneId: pane.paneId };
  if (pane.state === "error") return { kind: "pane", paneId: pane.paneId };
  return null;
}

function compareCards(order: Map<string, number>, newestFirst: boolean) {
  return (a: AgentBoardCard, b: AgentBoardCard): number => {
    if (a.unseen !== b.unseen) return a.unseen ? -1 : 1;
    // Unknown start times sink, whatever the direction.
    if ((a.since > 0) !== (b.since > 0)) return a.since > 0 ? -1 : 1;
    if (a.since !== b.since) return newestFirst ? b.since - a.since : a.since - b.since;
    const byWorkspace = (order.get(a.workspaceId) ?? 0) - (order.get(b.workspaceId) ?? 0);
    if (byWorkspace !== 0) return byWorkspace;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

/**
 * The board: Needs you (the longest wait first), Working (the latest start
 * first) and Done (unseen first, then the latest). Cards of a workspace that
 * no longer exists are left out.
 */
export function buildAgentBoard(input: AgentBoardInput): AgentBoardModel {
  const workspaces = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const order = new Map(input.workspaces.map((workspace, index) => [workspace.id, index]));
  const cards: AgentBoardCard[] = [];
  for (const pane of mergePanes(input)) {
    const workspace = workspaces.get(pane.workspaceId);
    if (workspace) cards.push(terminalCard(pane, workspace, input));
  }
  for (const run of input.runs) {
    const workspace = workspaces.get(run.workspaceId);
    if (!workspace) continue;
    const placement = coraRunPlacement(run, input.now, input.doneWindowMs);
    if (placement) cards.push(coraCard(run, placement, workspace, input));
  }
  const needsYou = cards.filter((card) => card.bucket === "needs-you").sort(compareCards(order, false));
  const working = cards.filter((card) => card.bucket === "working").sort(compareCards(order, true));
  const done = cards.filter((card) => card.bucket === "done").sort(compareCards(order, true));
  return { needsYou, working, done, total: cards.length };
}
