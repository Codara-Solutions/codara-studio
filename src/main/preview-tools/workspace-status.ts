// codara_workspace_status (server.js): an agent reads or sets the status and
// one-line progress note of the workspace it works in, which the rail shows
// under the workspace's name. The workspace is always the caller's own: its
// Cora chat's, or that of the terminal pane it runs in, never one the call
// names. The store lives in ../workspace-status/.

import {
  WORKSPACE_STATUS_IDS,
  WORKSPACE_STATUS_LABELS,
  WORKSPACE_STATUS_NOTE_MAX,
  parseWorkspaceStatusId,
  workspaceStatusAgentLabel,
  type WorkspaceStatusAuthor,
  type WorkspaceStatusEntry,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { workspaceStatusService } from "../workspace-status/service";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type CallerWorkspace =
  | { workspaceId: string; by: WorkspaceStatusAuthor }
  | { refusal: Record<string, unknown> };

/**
 * The workspace a caller-located tool acts on, and who to credit: the chat's
 * workspace for a run, else that of the terminal pane the caller runs in.
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
    return { workspaceId: run.workspaceId, by: { kind: "agent", label: label === "Agent" ? "Cora" : label } };
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
  return { workspaceId, by: { kind: "agent", label } };
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

/** What the agent reads back: the current state and the latest checkpoints, newest first. */
function view(workspaceId: string, name: string, entry: WorkspaceStatusEntry | null): Record<string, unknown> {
  if (!entry) return { workspaceId, workspace: name, status: null, note: null };
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
  };
}

async function runWorkspaceStatus(
  params: Record<string, unknown>,
  _method: string,
  host: PreviewToolHost,
): Promise<unknown> {
  const patch = patchFromParams(params);
  const target = await callerWorkspace(params, host);
  if ("refusal" in target) return target.refusal;
  const service = workspaceStatusService();
  const name = await service.workspaceName(target.workspaceId);
  if (name === null) {
    return { updated: false, reason: "workspace_gone", note: "Your workspace was removed from Codara." };
  }
  if (isRead(patch)) return view(target.workspaceId, name, await service.store().get(target.workspaceId));
  const result = await service.store().update(target.workspaceId, patch, target.by);
  return {
    ...view(target.workspaceId, name, result.entry),
    updated: result.changed,
    ...(result.noteTruncated
      ? { noteTruncated: true, hint: `A note is one line of at most ${WORKSPACE_STATUS_NOTE_MAX} characters; the rest was cut.` }
      : {}),
  };
}

export const workspaceStatusTools: PreviewToolTable = {
  // Scope "none": the handler resolves the caller's workspace itself and
  // refuses a call it cannot place, instead of falling back to the workspace
  // on screen as the browser tools do.
  "workspace.status": { run: runWorkspaceStatus, scope: "none", trustedRunsOnly: true },
};
