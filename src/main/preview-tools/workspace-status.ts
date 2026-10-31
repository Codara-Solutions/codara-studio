// codara_workspace_status (server.js): an agent reads or sets its own line in
// the rail: a status it declares and a one-line note, keyed to the agent (the
// terminal pane it runs in, or its Cora chat), never to the whole workspace,
// so agents sharing a workspace keep separate lines. The rail computes each
// agent's state itself and shows the note beside it. The workspace is always
// the caller's own, never one the call names. With `worktree` the note goes
// on that worktree's row instead, for the agent (often a coordinator's
// background subagent) working there; ../workspace-status/worktree-notes.ts
// decides which worktrees a caller may write on. The notes live in
// ../workspace-status/agent-notes.ts.

import { isWorktreeNoteKey, paneNoteKey, runNoteKey, type AgentNote, type AgentNoteKey } from "@shared/agent-status";
import {
  WORKSPACE_STATUS_IDS,
  WORKSPACE_STATUS_LABELS,
  WORKSPACE_STATUS_NOTE_MAX,
  parseWorkspaceStatusId,
  workspaceStatusAgentLabel,
  type WorkspaceStatusAuthor,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { workspaceStatusService } from "../workspace-status/service";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type CallerWorkspace =
  | { workspaceId: string; by: WorkspaceStatusAuthor; agentKey: AgentNoteKey | null }
  | { refusal: Record<string, unknown> };

/**
 * The workspace a caller-located tool acts on, who to credit, and the
 * caller's own agent line: the chat's for a run, else the terminal pane's the
 * caller runs in (null when Codara placed the workspace but not the pane).
 * Also used by the task list tools (cos-tasks.ts).
 */
export async function callerWorkspace(
  params: Record<string, unknown>,
  host: PreviewToolHost,
  tool = "codara_workspace_status",
): Promise<CallerWorkspace> {
  // The MCP server never sends one; a hand-made call must not pick a
  // workspace either.
  delete params.workspaceId;
  const client = text(params, "callerClient");
  const runId = text(params, "runId");
  if (runId) {
    const run = await host.getRun(runId);
    if (!run?.workspaceId) {
      return { refusal: { updated: false, reason: "workspace_unknown", note: "This chat's workspace could not be found." } };
    }
    const label = workspaceStatusAgentLabel(client);
    return {
      workspaceId: run.workspaceId,
      by: { kind: "agent", label: label === "Agent" ? "Cora" : label },
      agentKey: runNoteKey(runId),
    };
  }
  await host.scopeToCaller(params);
  const workspaceId = text(params, "workspaceId");
  if (!workspaceId) {
    // The managed MCP entry also loads in agents started outside Codara; for
    // them there is no workspace to label, which is an answer, not a failure.
    return {
      refusal: {
        updated: false,
        reason: "not_in_codara_workspace",
        note: `${tool} only works for an agent running in a Codara terminal pane or chat.`,
      },
    };
  }
  const paneId = text(params, "callerPaneId");
  // Outside a chat, client "cora" is the in-process bridge that `cora tool`
  // (a shell, aider, a script) and a pane's Pi share, never Cora itself, so
  // it names no agent; the pane's own agent, when Codara knows it, does.
  const fromClient = workspaceStatusAgentLabel(client);
  const label =
    (paneId ? workspaceStatusService().agentLabelForPane(paneId) : null) ?? (fromClient === "Cora" ? "Agent" : fromClient);
  return { workspaceId, by: { kind: "agent", label }, agentKey: paneId ? paneNoteKey(paneId) : null };
}

const STATUS_CHOICES = WORKSPACE_STATUS_IDS.join(", ");

function patchFromParams(params: Record<string, unknown>): WorkspaceStatusPatch {
  const patch: WorkspaceStatusPatch = {};
  if (params.clear === true) return { clear: true };
  if (params.clear !== undefined && params.clear !== false) {
    throw new PreviewToolParamsError("clear must be true or left out.");
  }
  const rawStatus = params.status;
  if (rawStatus === null || (typeof rawStatus === "string" && /^\s*none\s*$/i.test(rawStatus))) {
    patch.status = null;
  } else if (rawStatus !== undefined) {
    const status = parseWorkspaceStatusId(rawStatus);
    if (!status) throw new PreviewToolParamsError(`status must be one of ${STATUS_CHOICES}.`);
    patch.status = status;
  }
  const rawNote = params.note;
  if (rawNote === null) patch.note = null;
  else if (typeof rawNote === "string") patch.note = rawNote;
  // `cora tool --note 42` arrives as the number it was typed as.
  else if (typeof rawNote === "number" && Number.isFinite(rawNote)) patch.note = String(rawNote);
  else if (rawNote !== undefined) throw new PreviewToolParamsError("note must be one line of text.");
  return patch;
}

function isRead(patch: WorkspaceStatusPatch): boolean {
  return !patch.clear && patch.status === undefined && patch.note === undefined;
}

function iso(at: number): string | null {
  return at > 0 ? new Date(at).toISOString() : null;
}

/** What the agent reads back: its own line with its latest checkpoints, newest first, and the other agents' notes. */
function view(
  workspaceId: string,
  name: string,
  own: AgentNote | null,
  others: readonly AgentNote[],
): Record<string, unknown> {
  const entry = own?.entry ?? null;
  const otherAgents = others
    .filter((note) => note.entry.note)
    .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt)
    .map((note) => ({ agent: note.entry.by.label, note: note.entry.note, updatedAt: iso(note.entry.updatedAt) }));
  if (!entry) return { workspaceId, workspace: name, status: null, note: null, otherAgents };
  return {
    workspaceId,
    workspace: name,
    status: entry.status,
    ...(entry.status ? { statusLabel: WORKSPACE_STATUS_LABELS[entry.status] } : {}),
    note: entry.note,
    updatedAt: iso(entry.updatedAt),
    by: entry.by.label,
    checkpoints: entry.checkpoints
      .slice()
      .reverse()
      .map((checkpoint) => ({
        status: checkpoint.status,
        note: checkpoint.note,
        at: iso(checkpoint.at),
        by: checkpoint.by.label,
      })),
    otherAgents,
  };
}

const STATE_HINT =
  "Codara shows your state (working, needs you, done) on your line by itself; the rail shows your note beside it.";

async function runWorkspaceStatus(
  params: Record<string, unknown>,
  _method: string,
  host: PreviewToolHost,
): Promise<unknown> {
  const patch = patchFromParams(params);
  const rawWorktree = params.worktree;
  if (rawWorktree !== undefined && rawWorktree !== null && typeof rawWorktree !== "string") {
    throw new PreviewToolParamsError("worktree must be the absolute path of a worktree.");
  }
  const worktreePath = typeof rawWorktree === "string" && rawWorktree.trim() ? rawWorktree.trim() : null;
  const target = await callerWorkspace(params, host);
  if ("refusal" in target) return target.refusal;
  const service = workspaceStatusService();
  const name = await service.workspaceName(target.workspaceId);
  if (name === null) {
    return { updated: false, reason: "workspace_gone", note: "Your workspace was removed from Codara." };
  }
  const book = service.notes();
  if (worktreePath) return worktreeStatus(worktreePath, patch, target, name);
  // Notes of agents that are gone (a chat that left the Agents view, a pane
  // main never saw close) are dropped here rather than read back. A
  // worktree's note belongs to its row, not to an agent of this workspace.
  const others: AgentNote[] = [];
  for (const note of book.inWorkspace(target.workspaceId)) {
    if (note.key === target.agentKey || isWorktreeNoteKey(note.key)) continue;
    if (await service.agentIsLive(note.key)) others.push(note);
    else book.drop(note.key);
  }
  const own = target.agentKey ? book.get(target.agentKey) : null;
  if (isRead(patch)) return view(target.workspaceId, name, own, others);
  if (!target.agentKey) {
    return {
      updated: false,
      reason: "pane_unknown",
      note: "Codara could not tell which terminal pane you run in, so you have no line to write to.",
    };
  }
  const result = book.update(target.agentKey, target.workspaceId, patch, target.by);
  const hints: string[] = [];
  if (result.noteTruncated) hints.push(`A note is one line of at most ${WORKSPACE_STATUS_NOTE_MAX} characters; the rest was cut.`);
  if (patch.status) hints.push(STATE_HINT);
  return {
    ...view(target.workspaceId, name, result.note, others),
    updated: result.changed,
    ...(result.noteTruncated ? { noteTruncated: true } : {}),
    ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
  };
}

/** Reads or writes the note on a worktree's row. */
async function worktreeStatus(
  path: string,
  patch: WorkspaceStatusPatch,
  caller: { workspaceId: string; by: WorkspaceStatusAuthor; agentKey: AgentNoteKey | null },
  callerName: string,
): Promise<unknown> {
  const service = workspaceStatusService();
  const placed = await service.worktreeNoteTarget(path, { workspaceId: caller.workspaceId, agentKey: caller.agentKey });
  if ("refusal" in placed) return placed.refusal;
  const book = service.notes();
  const rowName = (await service.workspaceName(placed.workspaceId)) ?? callerName;
  const where = { worktree: placed.path, ...(placed.worktreeWorkspaceId ? { workspaceId: placed.worktreeWorkspaceId } : {}) };
  if (isRead(patch)) return { ...view(placed.workspaceId, rowName, book.get(placed.key), []), ...where };
  const result = book.update(placed.key, placed.workspaceId, patch, caller.by, {
    worktreePath: placed.path,
    from: { workspaceId: caller.workspaceId, workspaceName: callerName },
  });
  const hints: string[] = [];
  if (result.noteTruncated) hints.push(`A note is one line of at most ${WORKSPACE_STATUS_NOTE_MAX} characters; the rest was cut.`);
  if (patch.status) {
    hints.push("On a worktree's row, in_review or done reads as done, blocked as needs you; anything else Codara works out from its activity.");
  }
  return {
    ...view(placed.workspaceId, rowName, result.note, []),
    ...where,
    updated: result.changed,
    ...(result.noteTruncated ? { noteTruncated: true } : {}),
    ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
  };
}

export const workspaceStatusTools: PreviewToolTable = {
  // Scope "none": the handler resolves the caller's workspace itself and
  // refuses a call it cannot place, instead of falling back to the workspace
  // on screen as the browser tools do.
  "workspace.status": { run: runWorkspaceStatus, scope: "none", trustedRunsOnly: true },
};
