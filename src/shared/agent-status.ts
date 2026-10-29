// Each agent's line in the rail and the one summary line its workspace shows.
// An agent's state is computed from what Codara already sees (the Agents
// view's cards, built by buildAgentBoard in agent-board.ts, and the alerts the
// user has not opened yet); the agent itself only adds a one-line note through
// codara_workspace_status, which main keeps per agent (src/main/workspace-status/)
// and drops with the agent's pane. Pure, so scripts/test-agent-status.cjs
// loads it without the app.

import type { AgentBoardCard, AgentBoardModel } from "./agent-board";
import { formatAgentSpan } from "./agent-board";
import type { TaskSummary } from "./cos-tasks";
import type { NavigationTarget } from "./types";
import type { WorkspaceStatusEntry } from "./workspace-status";

/**
 * "pane:<paneId>" for an agent in a terminal pane, "run:<runId>" for a Cora
 * chat, "worktree:<workspaceId>" for the work done in a worktree the rail
 * shows, and "worktree:path:<hash>" for a worktree it does not (made outside
 * Codara), whoever does it (codara_workspace_status with `worktree`).
 */
export type AgentNoteKey = string;

export function paneNoteKey(paneId: string): AgentNoteKey {
  return `pane:${paneId}`;
}

export function runNoteKey(runId: string): AgentNoteKey {
  return `run:${runId}`;
}

export function worktreeNoteKey(workspaceId: string): AgentNoteKey {
  return `worktree:${workspaceId}`;
}

export function isWorktreeNoteKey(key: string): boolean {
  return key.startsWith("worktree:");
}

/** What an agent said about its own work, and the workspace it said it in. */
export interface AgentNote {
  key: AgentNoteKey;
  workspaceId: string;
  entry: WorkspaceStatusEntry;
  /** A worktree note: the worktree's folder. */
  worktreePath?: string;
  /** A worktree note: the workspace of the agent that wrote it last. */
  from?: { workspaceId: string; workspaceName: string };
}

export type AgentNoteMap = Record<AgentNoteKey, AgentNote>;

export interface AgentNoteChange {
  key: AgentNoteKey;
  note: AgentNote | null;
}

export type AgentLineState = "working" | "needs-you" | "done" | "idle";

export const AGENT_LINE_STATE_LABELS: Record<AgentLineState, string> = {
  working: "Working",
  "needs-you": "Needs you",
  done: "Done",
  idle: "Idle",
};

/** The theme token each state is drawn in. */
export const AGENT_LINE_STATE_TONES: Record<AgentLineState, string> = {
  working: "var(--info)",
  "needs-you": "var(--danger)",
  done: "var(--ok)",
  idle: "var(--muted-2)",
};

export interface AgentLine {
  key: AgentNoteKey;
  workspaceId: string;
  /** "Claude Code · api", "Cora · Fix the login". */
  name: string;
  state: AgentLineState;
  /** The agent's own note, else what Codara saw it say or ask last. */
  text: string | null;
  /** True when `text` is the agent's own note. */
  fromNote: boolean;
  /** When the agent entered its state; 0 when unknown. */
  since: number;
  target: NavigationTarget | null;
}

/**
 * An agent's state. A prompt it raised stays "needs you" until the user opens
 * its tab, even if it moved on without them; a finished turn reads "done"
 * until then, and "idle" after.
 */
export function agentLineState(
  card: Pick<AgentBoardCard, "bucket" | "unseen">,
  unseenKind?: "blocked" | "complete" | null,
): AgentLineState {
  if (card.bucket === "needs-you" || unseenKind === "blocked") return "needs-you";
  if (card.bucket === "working") return "working";
  if (card.unseen || unseenKind === "complete") return "done";
  return "idle";
}

const STATE_ORDER: Record<AgentLineState, number> = { "needs-you": 0, working: 1, done: 2, idle: 3 };

// "Claude Code · api" when the tab tells the agent apart; agents split in one
// tab share its title, so it would only crowd the line.
function cardName(card: AgentBoardCard, sharedTabTitles: ReadonlySet<string>): string {
  const where = card.source === "cora" ? card.title : card.tabTitle;
  if (!where || where === card.agentLabel) return card.agentLabel;
  if (card.source === "terminal" && sharedTabTitles.has(`${card.workspaceId}\n${where}`)) return card.agentLabel;
  return `${card.agentLabel} · ${where}`;
}

function sharedTabTitles(cards: readonly AgentBoardCard[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const card of cards) {
    if (card.source !== "terminal" || !card.tabTitle) continue;
    const key = `${card.workspaceId}\n${card.tabTitle}`;
    if (seen.has(key)) shared.add(key);
    seen.add(key);
  }
  return shared;
}

/** A terminal pane that holds a note but no agent Codara recognizes (a shell running `cora tool`). */
export interface AgentNotePane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
}

export interface AgentLinesInput {
  board: AgentBoardModel;
  notes: AgentNoteMap;
  /** Unseen terminal alerts, by pane id. */
  unseenPanes?: Readonly<Record<string, "blocked" | "complete">>;
  /** Every terminal pane the layouts hold, by pane id; a pane note shows only while its pane does. */
  panes?: Readonly<Record<string, AgentNotePane>>;
}

/**
 * Every workspace's agent lines, needs-you first, then working, done and
 * idle, the latest first within each. A note shows on its own agent's line
 * only: a pane's note leaves with the pane, a run's with the run's card.
 */
export function buildAgentLines(input: AgentLinesInput): Record<string, AgentLine[]> {
  const out: Record<string, AgentLine[]> = {};
  const placed = new Set<AgentNoteKey>();
  const push = (line: AgentLine) => {
    (out[line.workspaceId] ??= []).push(line);
    placed.add(line.key);
  };
  const cards = [...input.board.needsYou, ...input.board.working, ...input.board.done];
  const shared = sharedTabTitles(cards);
  for (const card of cards) {
    const paneId = card.target.type === "terminal" ? card.target.paneId : null;
    const note = input.notes[card.key]?.entry.note ?? null;
    push({
      key: card.key,
      workspaceId: card.workspaceId,
      name: cardName(card, shared),
      state: agentLineState(card, paneId ? input.unseenPanes?.[paneId] : null),
      text: note ?? card.message,
      fromNote: note !== null,
      since: card.since,
      target: card.target,
    });
  }
  for (const note of Object.values(input.notes)) {
    if (placed.has(note.key) || !note.key.startsWith("pane:") || !note.entry.note) continue;
    const pane = input.panes?.[note.key.slice("pane:".length)];
    if (!pane) continue;
    push({
      key: note.key,
      workspaceId: pane.workspaceId,
      name: pane.tabTitle || "Terminal",
      state: "idle",
      text: note.entry.note,
      fromNote: true,
      since: note.entry.updatedAt,
      target: { type: "terminal", workspaceId: pane.workspaceId, tabId: pane.tabId, paneId: pane.paneId },
    });
  }
  for (const lines of Object.values(out)) {
    lines.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.since - a.since || (a.key < b.key ? -1 : 1));
  }
  return out;
}

export type WorkspaceSummaryPartKind = "working" | "needs-you" | "ready" | "inbox" | "done" | "idle" | "running";

export interface WorkspaceSummaryPart {
  kind: WorkspaceSummaryPartKind;
  count: number;
  text: string;
}

export interface WorkspaceSummary {
  /** "2 working · 1 needs you · 3 done today". */
  line: string;
  parts: WorkspaceSummaryPart[];
  needsYou: number;
  /** The longer account for the tooltip and screen readers. */
  description: string;
}

function countStates(lines: readonly AgentLine[]): Record<AgentLineState, number> {
  const counts: Record<AgentLineState, number> = { working: 0, "needs-you": 0, done: 0, idle: 0 };
  for (const line of lines) counts[line.state] += 1;
  return counts;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export interface SummarizeWorkspaceOptions {
  /**
   * "rail": the line under a workspace's name in the rail, whose number at
   * the row's right edge is the one home for agent counts (DESIGN.md, "One
   * home for agent counts"). It speaks only when something needs the user or
   * finished: needs you, ready, in inbox, done. It never counts agents
   * working or idle, tasks running read as tasks ("1 task running"), and it
   * is null when there is nothing to say. Its description names who needs
   * the user and why and gives the task list, but leaves the agent tally to
   * the number, which counts from another source and could disagree. "full"
   * (the default) is the line as it reads elsewhere.
   */
  variant?: "full" | "rail";
}

/**
 * The workspace's one line, computed from its agents and its task list (PR
 * #45's counts), never written by a model. Agents working and tasks running
 * read as "working", agents and tasks waiting on the user as "needs you", and
 * finished turns the user has not opened plus tasks closed today as "done".
 * A workspace whose agents are all idle says so; one with neither agents nor
 * a task list has no line (null). The rail variant differs; see its option.
 */
export function summarizeWorkspace(
  lines: readonly AgentLine[],
  tasks: TaskSummary | null,
  options: SummarizeWorkspaceOptions = {},
): WorkspaceSummary | null {
  if (lines.length === 0 && !tasks) return null;
  const agents = countStates(lines);
  const t = tasks?.counts ?? { inbox: 0, ready: 0, running: 0, needsYou: 0, doneToday: 0 };
  const parts: WorkspaceSummaryPart[] = [];
  const add = (kind: WorkspaceSummaryPartKind, count: number, text: string) => {
    if (count > 0) parts.push({ kind, count, text });
  };
  const working = agents.working + t.running;
  const needsYou = agents["needs-you"] + t.needsYou;
  const done = agents.done + t.doneToday;
  const rail = options.variant === "rail";
  if (!rail) add("working", working, `${working} working`);
  add("needs-you", needsYou, `${needsYou} needs you`);
  add("ready", t.ready, `${t.ready} ready`);
  add("inbox", t.inbox, `${t.inbox} in inbox`);
  add("done", done, t.doneToday > 0 ? `${done} done today` : `${done} done`);
  if (rail) add("running", t.running, `${plural(t.running, "task")} running`);
  else if (parts.length === 0 && agents.idle > 0) add("idle", agents.idle, `${plural(agents.idle, "agent")} idle`);
  if (rail && parts.length === 0) return null;
  const line = parts.length > 0 ? parts.map((part) => part.text).join(" · ") : "Nothing on the list";

  const sentences: string[] = [];
  if (lines.length > 0 && !rail) {
    const said = (["needs-you", "working", "done", "idle"] as const)
      .filter((state) => agents[state] > 0)
      .map((state) => `${agents[state]} ${AGENT_LINE_STATE_LABELS[state].toLowerCase()}`);
    sentences.push(`${plural(lines.length, "agent")}: ${said.join(", ")}.`);
  }
  if (tasks) sentences.push(`Tasks: ${tasks.line}.`);
  const waitingAgent = lines.find((entry) => entry.state === "needs-you");
  if (waitingAgent) {
    sentences.push(`${waitingAgent.name} needs you${waitingAgent.text ? `: ${waitingAgent.text}` : "."}`);
  }
  if (tasks?.needsYou) {
    const { taskId, title, reason } = tasks.needsYou;
    sentences.push(`${taskId} ${title} needs you${reason ? `: ${reason}` : "."}`);
  }
  return { line, parts, needsYou, description: sentences.join(" ") };
}

/** Unseen terminal alerts, workspace id to pane id, as App keeps them. */
export type PaneAttention<K extends string = string> = Readonly<
  Record<string, Readonly<Record<string, { tabId: string; kind: K }>>>
>;

/**
 * `attention` once the user has the tab `activeTabId` of workspace
 * `workspaceId` open: alerts of that tab are seen, and those of tabs that no
 * longer exist go too, so a closed tab cannot keep a line "done" or "needs
 * you". The same object when nothing changed.
 */
export function clearSeenAttention<K extends string>(
  attention: PaneAttention<K>,
  workspaceId: string,
  activeTabId: string | null,
  liveTabIds: ReadonlySet<string>,
): PaneAttention<K> {
  const entries = attention[workspaceId];
  if (!entries) return attention;
  let changed = false;
  const kept: Record<string, { tabId: string; kind: K }> = {};
  for (const [paneId, info] of Object.entries(entries)) {
    if (info.tabId === activeTabId || !liveTabIds.has(info.tabId)) {
      changed = true;
      continue;
    }
    kept[paneId] = info;
  }
  if (!changed) return attention;
  const next = { ...attention };
  if (Object.keys(kept).length === 0) delete next[workspaceId];
  else next[workspaceId] = kept;
  return next;
}

/** "4m", "2h 5m": how long the line has been in its state; null when unknown. */
export function agentLineAge(line: Pick<AgentLine, "since">, now: number): string | null {
  return line.since > 0 ? formatAgentSpan(Math.max(0, now - line.since)) : null;
}
