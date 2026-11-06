// Branch names that stay after a removal even when merged: deleting a long
// lived branch someone checked out in a worktree is never what cleanup means.
// No imports, so the agent tools (agent-worktrees.ts) share it without a cycle.
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "development", "trunk", "staging", "production"]);

function shortBranch(target: string): string {
  return target.replace(/^[^/]+\//, "");
}

/** A long-lived branch, or the base itself, which cleanup never deletes even when merged. */
export function isKeptBranch(branch: string, target: string | undefined | null): boolean {
  return PROTECTED_BRANCHES.has(branch) || branch === shortBranch(target ?? "");
}
