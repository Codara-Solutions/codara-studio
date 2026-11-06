// Branch names that stay after a removal even when merged: deleting a long
// lived branch someone checked out in a worktree is never what cleanup means.
// No imports, so the agent tools (agent-worktrees.ts) share it without a cycle.
// Keep this list equal to PROTECTED_REMOTE_BRANCHES in
// src/shared/worktree-cleanup-agent.ts (scripts/test-kept-branches.cjs checks it).
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
  "development",
  "trunk",
  "staging",
  "production",
  "release",
  "gh-pages",
]);

/** `origin/feat/x` → `feat/x`; a name without a remote prefix stays as it is. */
function withoutRemote(target: string): string {
  return target.replace(/^[^/]+\//, "");
}

/**
 * A long-lived branch, or the base itself, which cleanup never deletes even when
 * merged. The base may be given as a remote name (`origin/feat/x`) or a local one
 * (`feat/x`); both spellings are kept, which can only keep more, never delete more.
 */
export function isKeptBranch(branch: string, target: string | undefined | null): boolean {
  if (PROTECTED_BRANCHES.has(branch)) return true;
  const base = target ?? "";
  return base !== "" && (branch === base || branch === withoutRemote(base));
}
