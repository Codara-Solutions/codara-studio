// Agents that work in a worktree without a pane there: a coordinator in one
// workspace hands a repository of another to a background subagent, which
// makes its worktree with codara_worktree_create({workspace}) and reports
// with codara_workspace_status({worktree}). Nothing runs in the worktree's
// own workspace, so without this its row would read "No agent" while work
// goes on. Each such worktree gets one card on the Agents board, keyed like
// its note ("worktree:<workspaceId>"), which puts it on the worktree's row in
// the rail (buildAgentLines) and in the Agents tab, until its branch merges
// or the worktree is removed.
//
// Its state is worked out from what Codara sees cheaply: the note's status,
// whether the creating session is still open and working (a Claude Code
// session with background tasks reads "In background", which is working),
// and how recent the last sign of work is (the note, the checked-out commit,
// the worktree's creation). Pure, so scripts/test-background-agents.cjs runs
// it without the app.

import {
  agentBoardWorkspaceColor,
  type AgentBoardCard,
  type AgentBoardModel,
  type AgentBoardRuntime,
  type AgentBoardWorkspace,
} from "./agent-board";
import { worktreeNoteKey, type AgentNoteMap } from "./agent-status";

/** While the creator is open, this long after the last sign of work still reads as working. */
export const BACKGROUND_RECENT_MS = 10 * 60_000;
/** While the creator itself works (or runs background tasks), this long. */
export const BACKGROUND_CREATOR_WORKING_MS = 2 * 60 * 60_000;

export const BACKGROUND_AGENT_LABEL = "Background agent";

export interface BackgroundWorktree {
  /** The worktree's own rail workspace. */
  workspaceId: string;
  /** The project row it hangs under, when the rail nests it. */
  projectId?: string;
  /** When it was made (ms); 0 when unknown. */
  createdAt: number;
  creator?: {
    paneId?: string;
    runId?: string;
    client?: string;
    purpose?: string;
    fromWorkspaceId?: string;
    fromWorkspaceName?: string;
  };
  /** Its branch is in its base: nobody works in it any more. */
  merged: boolean;
  /** When its checked-out commit was made (ms). */
  headAt?: number;
}

export interface BackgroundAgentInput {
  now: number;
  worktrees: readonly BackgroundWorktree[];
  notes: AgentNoteMap;
  /** The board's other cards: the creator's, and any agent already in the worktree. */
  cards: readonly AgentBoardCard[];
  workspaces: ReadonlyMap<string, AgentBoardWorkspace>;
}

/** The board with the background agents' cards added to their buckets, after the agents Codara runs itself. */
export function withBackgroundAgents(
  model: AgentBoardModel,
  input: Omit<BackgroundAgentInput, "cards" | "workspaces"> & { workspaces: readonly AgentBoardWorkspace[] },
): AgentBoardModel {
  if (input.worktrees.length === 0) return model;
  const cards = backgroundAgentCards({
    ...input,
    cards: [...model.needsYou, ...model.working, ...model.done],
    workspaces: new Map(input.workspaces.map((workspace) => [workspace.id, workspace])),
  });
  if (cards.length === 0) return model;
  return {
    needsYou: [...model.needsYou, ...cards.filter((card) => card.bucket === "needs-you")],
    working: [...model.working, ...cards.filter((card) => card.bucket === "working")],
    done: [...model.done, ...cards.filter((card) => card.bucket === "done")],
    total: model.total + cards.length,
  };
}

function runtimeOf(client: string | undefined): AgentBoardRuntime {
  const name = (client ?? "").toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("grok")) return "grok";
  if (name === "cora" || name.startsWith("pi")) return "cora";
  return "claude";
}

/** One card per worktree a background agent works in; none for a worktree whose agent shows by itself. */
export function backgroundAgentCards(input: BackgroundAgentInput): AgentBoardCard[] {
  const byKey = new Map(input.cards.map((card) => [card.key, card]));
  const occupied = new Set(input.cards.map((card) => card.workspaceId));
  const out: AgentBoardCard[] = [];
  for (const worktree of input.worktrees) {
    if (worktree.merged || occupied.has(worktree.workspaceId)) continue;
    const workspace = input.workspaces.get(worktree.workspaceId);
    if (!workspace) continue;
    const key = worktreeNoteKey(worktree.workspaceId);
    const note = input.notes[key] ?? null;
    const creator = worktree.creator;
    const creatorKey = creator?.paneId ? `pane:${creator.paneId}` : creator?.runId ? `run:${creator.runId}` : null;
    const creatorCard = creatorKey ? byKey.get(creatorKey) : undefined;
    const fromId = creatorCard?.workspaceId ?? creator?.fromWorkspaceId ?? note?.from?.workspaceId;
    // Without a note, only a worktree made from another workspace needs a
    // card: one made from its own project shows its creator on the row
    // already (buildRailFamily).
    if (!note) {
      if (!creator || !fromId || fromId === worktree.workspaceId || fromId === worktree.projectId) continue;
    }
    const fromName =
      (fromId ? input.workspaces.get(fromId)?.name : undefined) ?? creator?.fromWorkspaceName ?? note?.from?.workspaceName ?? null;
    const noteAt = note?.entry.updatedAt ?? 0;
    const lastActivity = Math.max(worktree.createdAt, noteAt, worktree.headAt ?? 0);
    const quiet = input.now - lastActivity;
    const status = note?.entry.status ?? null;
    let state: "needs-you" | "working" | "done" | "idle";
    if (status === "blocked") state = "needs-you";
    else if (status === "in_review" || status === "done") state = "done";
    else if (creatorCard?.bucket === "working" && quiet < BACKGROUND_CREATOR_WORKING_MS) state = "working";
    else if (creatorCard && quiet < BACKGROUND_RECENT_MS) state = "working";
    else state = "idle";
    const project = worktree.projectId ? input.workspaces.get(worktree.projectId) : undefined;
    const text = note?.entry.note ?? null;
    out.push({
      key,
      source: "background",
      bucket: state === "idle" ? "done" : state,
      status: state === "needs-you" ? "Blocked" : state === "working" ? "Working" : state === "done" ? "In review" : "Idle",
      tone: state === "needs-you" ? "warn" : state === "working" ? "info" : state === "done" ? "ok" : "muted",
      workspaceId: worktree.workspaceId,
      // The Agents tab names the project; the worktree's branch is its third line.
      workspaceName: project?.name ?? workspace.name,
      workspaceColor: agentBoardWorkspaceColor(project ?? workspace),
      workspaceIcon: (project ?? workspace).icon ?? null,
      runtime: creatorCard?.source === "terminal" ? creatorCard.runtime : runtimeOf(creator?.client),
      agentLabel: BACKGROUND_AGENT_LABEL,
      account: null,
      title: creator?.purpose || text || workspace.name,
      tabTitle: fromName ? `from ${fromName}` : null,
      message: text,
      tool: null,
      detail: null,
      since: state === "working" ? worktree.createdAt || lastActivity : state === "idle" ? lastActivity : noteAt || lastActivity,
      unseen: state === "done",
      sleeping: false,
      target: { type: "workspace", workspaceId: worktree.workspaceId },
      reply: null,
    });
  }
  return out;
}
