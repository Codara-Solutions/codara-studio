// Opens the worktree cleanup screen from anywhere (the command, a rail row's
// menu) without prop drilling. <WorktreeCleanupHost/> listens for it.

export const OPEN_WORKTREE_CLEANUP_EVENT = "spark:open-worktree-cleanup";

export interface OpenWorktreeCleanupDetail {
  /** The workspace whose repository the screen starts filtered to; null shows every repository. */
  workspaceId: string | null;
}

export function openWorktreeCleanup(workspaceId: string | null): void {
  window.dispatchEvent(
    new CustomEvent<OpenWorktreeCleanupDetail>(OPEN_WORKTREE_CLEANUP_EVENT, { detail: { workspaceId } }),
  );
}
