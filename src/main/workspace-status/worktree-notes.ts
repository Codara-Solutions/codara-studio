// Where codara_workspace_status puts a note when it names a worktree: on the
// row of the worktree, not on the caller's own line, so a coordinator's
// background subagent reports on the worktree it works in. An agent may write
// on a worktree it made with codara_worktree_create (wherever it made it,
// another workspace's repository included, which the user allowed then), or
// on any worktree of its own workspace's repository, the ones made outside
// Codara included. Anything else is refused: a note on another repository's
// row would speak for work the user never let this agent do there.
//
// No Electron import, so scripts/test-worktree-notes.cjs bundles it directly.

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { worktreeNoteKey, type AgentNoteKey } from "@shared/agent-status";
import { isRemotePath } from "@shared/remote";
import type { Workspace } from "@shared/types";

export interface WorktreeNoteCaller {
  /** The caller's own workspace (its pane's, or its chat's). */
  workspaceId: string;
  /** "pane:<id>" or "run:<id>"; null when Codara placed the workspace but not the pane. */
  agentKey: AgentNoteKey | null;
}

export interface WorktreeNoteDeps {
  workspaces: readonly Workspace[];
  realpath(path: string): Promise<string>;
  /** The worktrees git lists for the repository holding `cwd` (main null when bare); null when git cannot say. */
  worktreesOf(cwd: string): Promise<{ main: string | null; linked: string[] } | null>;
}

export type WorktreeNoteTarget =
  | {
      key: AgentNoteKey;
      /** The worktree's own rail workspace, else the project it belongs to. */
      workspaceId: string;
      path: string;
      /** The rail workspace of the worktree, when there is one. */
      worktreeWorkspaceId: string | null;
    }
  | { refusal: Record<string, unknown> };

const HINT =
  "Make the worktree with codara_worktree_create (with workspace for another repository) and pass its path, or leave worktree out to write your own line.";

function refused(reason: string, note: string): WorktreeNoteTarget {
  return { refusal: { updated: false, reason, note, hint: HINT } };
}

function pathKey(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  return process.platform === "win32" || process.platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** The note key of a worktree the rail does not show, by its folder. */
export function externalWorktreeNoteKey(canonicalPath: string): AgentNoteKey {
  return `worktree:path:${createHash("sha256").update(pathKey(canonicalPath)).digest("hex").slice(0, 24)}`;
}

function madeByCaller(workspace: Workspace, agentKey: AgentNoteKey | null): boolean {
  const creator = workspace.copyBranch?.createdBy;
  if (!agentKey || creator?.kind !== "agent") return false;
  return (
    (creator.paneId !== undefined && agentKey === `pane:${creator.paneId}`) ||
    (creator.runId !== undefined && agentKey === `run:${creator.runId}`)
  );
}

export async function resolveWorktreeNoteTarget(
  rawPath: string,
  caller: WorktreeNoteCaller,
  deps: WorktreeNoteDeps,
): Promise<WorktreeNoteTarget> {
  const path = rawPath.trim();
  if (!path || isRemotePath(path) || !isAbsolute(path)) {
    return refused("worktree_invalid", "worktree must be the absolute path of a local worktree.");
  }
  let real: string;
  try {
    real = await deps.realpath(path);
  } catch {
    return refused("worktree_not_found", `No folder exists at ${path}.`);
  }
  const callerWorkspace = deps.workspaces.find((workspace) => workspace.id === caller.workspaceId);
  if (!callerWorkspace || callerWorkspace.remote || isRemotePath(callerWorkspace.cwd)) {
    return refused("workspace_unknown", "Codara could not place your own workspace, so it cannot check that worktree.");
  }
  const realOr = async (value: string) => {
    try {
      return pathKey(await deps.realpath(value));
    } catch {
      return pathKey(value);
    }
  };
  const wanted = pathKey(real);
  // The worktree's own rail row, when the rail shows one.
  let rail: Workspace | undefined;
  for (const workspace of deps.workspaces) {
    if (!workspace.copyBranch || workspace.remote || isRemotePath(workspace.cwd)) continue;
    if ((await realOr(workspace.cwd)) === wanted) {
      rail = workspace;
      break;
    }
  }
  if (rail && madeByCaller(rail, caller.agentKey)) {
    return { key: worktreeNoteKey(rail.id), workspaceId: rail.id, path: rail.cwd, worktreeWorkspaceId: rail.id };
  }
  // Otherwise it must be one of the caller's own repository's worktrees.
  const listed = await deps.worktreesOf(callerWorkspace.cwd).catch(() => null);
  if (!listed) {
    return refused("worktree_not_yours", `${path} is not a worktree you made, and Codara could not list your repository's worktrees.`);
  }
  const mainKey = listed.main ? await realOr(listed.main) : null;
  if (mainKey === wanted) {
    return refused("worktree_is_main", `${path} is the repository's main checkout, not a worktree; leave worktree out to write your own line.`);
  }
  const keys = await Promise.all(listed.linked.map(realOr));
  if (!keys.includes(wanted)) {
    return refused("worktree_not_yours", `${path} is neither a worktree you made nor one of your own repository's.`);
  }
  if (rail) {
    return { key: worktreeNoteKey(rail.id), workspaceId: rail.id, path: rail.cwd, worktreeWorkspaceId: rail.id };
  }
  // A worktree made outside Codara hangs under the project whose folder is
  // the repository's main checkout, else under the caller's workspace.
  let project = callerWorkspace;
  for (const workspace of deps.workspaces) {
    if (workspace.copyBranch || workspace.remote || isRemotePath(workspace.cwd)) continue;
    if (mainKey && (await realOr(workspace.cwd)) === mainKey) {
      project = workspace;
      break;
    }
  }
  return { key: externalWorktreeNoteKey(real), workspaceId: project.id, path: real, worktreeWorkspaceId: null };
}
