import type { AppState, GitCopyWorktreeResult, GitOpResult, Workspace } from "@shared/types";

// Pure AppState edits shared by every main-process path that adds or drops a
// copy-branch workspace (GitHub issue workspaces, agent worktrees). No
// Electron import, so the unit suites bundle it directly; publishing the
// result to the renderer lives in workspace-state-publish.ts.

// Insert a copy workspace right after its source and the source's existing
// copies, in both the workspace list and the top-level rail order, so it reads
// as nested under the repository it came from. The active workspace is left
// alone.
export function insertCopyWorkspace(
  state: AppState,
  sourceWorkspaceId: string,
  workspace: Workspace,
): AppState {
  const workspaces = state.workspaces.slice();
  const sourceIndex = workspaces.findIndex(
    (candidate) => candidate.id === sourceWorkspaceId,
  );
  let insertAt = sourceIndex < 0 ? workspaces.length : sourceIndex + 1;
  while (
    insertAt < workspaces.length &&
    workspaces[insertAt].copyBranch?.repoCwd === workspace.copyBranch?.repoCwd
  ) {
    insertAt += 1;
  }
  workspaces.splice(insertAt, 0, workspace);

  let workspaceRailOrder = state.workspaceRailOrder;
  if (!workspace.groupId) {
    const currentRail =
      state.workspaceRailOrder ??
      state.workspaces
        .filter((candidate) => !candidate.groupId)
        .map((candidate) => candidate.id);
    workspaceRailOrder = currentRail.filter(
      (id) => id !== workspace.id,
    );
    const sourceRailIndex = workspaceRailOrder.indexOf(sourceWorkspaceId);
    let railInsertAt =
      sourceRailIndex < 0 ? workspaceRailOrder.length : sourceRailIndex + 1;
    const workspaceById = new Map(
      workspaces.map((candidate) => [candidate.id, candidate]),
    );
    while (railInsertAt < workspaceRailOrder.length) {
      const next = workspaceById.get(workspaceRailOrder[railInsertAt]);
      if (next?.copyBranch?.repoCwd !== workspace.copyBranch?.repoCwd) break;
      railInsertAt += 1;
    }
    workspaceRailOrder.splice(railInsertAt, 0, workspace.id);
  }

  return {
    ...state,
    workspaces,
    // Keep an ungrouped copy worktree visibly nested beside the source and
    // its existing copies. Grouped workspaces remain represented by the
    // parent group rather than as duplicate top-level rail entries.
    workspaceRailOrder,
    activeWorkspaceId: state.activeWorkspaceId,
  };
}

// Drop a workspace and its rail entry. When it was active, the fallback (its
// parent, when that still exists) becomes active instead of whatever happens
// to be first.
export function removeWorkspaceFromAppState(
  state: AppState,
  workspaceId: string,
  fallbackActiveId: string | null,
): AppState {
  const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
  let activeWorkspaceId = state.activeWorkspaceId;
  if (activeWorkspaceId === workspaceId) {
    activeWorkspaceId =
      fallbackActiveId && workspaces.some((workspace) => workspace.id === fallbackActiveId)
        ? fallbackActiveId
        : workspaces[0]?.id ?? null;
  }
  return {
    ...state,
    workspaces,
    ...(state.workspaceRailOrder
      ? { workspaceRailOrder: state.workspaceRailOrder.filter((id) => id !== workspaceId) }
      : {}),
    activeWorkspaceId,
  };
}

// Every directory the fs sandbox must allow for this state, extra Explorer
// folders included, matching what the renderer's state:save grants.
export function workspaceAllowedRoots(state: AppState): string[] {
  return state.workspaces
    .flatMap((workspace) => [workspace.cwd, ...(workspace.extraFolders ?? [])])
    .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
}

export interface CreatedWorktreeRollbackDependencies {
  removeCopyWorktree(input: {
    repoCwd: string;
    worktreePath: string;
    branch: string;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<GitOpResult>;
  forceDeleteBranch(cwd: string, branch: string): Promise<GitOpResult>;
}

// Undo a worktree this same transaction created when its workspace could not
// be persisted. Force is acceptable only here: nothing has run in it yet.
export async function rollbackCreatedWorktree(
  repoCwd: string,
  created: Extract<GitCopyWorktreeResult, { ok: true }>,
  dependencies: CreatedWorktreeRollbackDependencies,
): Promise<boolean> {
  const removed = await dependencies.removeCopyWorktree({
    repoCwd,
    worktreePath: created.path,
    branch: created.branch,
    force: true,
    deleteBranch: true,
  }).catch(() => ({ ok: false as const, error: "cleanup failed" }));
  if (removed.ok) return true;
  // Nothing ran in this transaction-owned worktree, so a branch left after
  // successful directory removal is safe to force-delete.
  const branch = await dependencies
    .forceDeleteBranch(repoCwd, created.branch)
    .catch(() => ({ ok: false as const, error: "branch cleanup failed" }));
  return branch.ok;
}
