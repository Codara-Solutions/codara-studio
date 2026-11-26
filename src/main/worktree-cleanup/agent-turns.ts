import { isAtOrUnder } from "./inspect";

/**
 * Which agent turns count for a worktree: by a folder the agent worked in,
 * at or under one of `dirs` (however the path is spelled); by the pane's
 * workspace when no folder is known.
 */
export function agentTurnIn(
  workspaceIds: readonly string[],
  dirs: readonly string[],
): (workspaceId: string, cwd: string | null) => boolean {
  const ids = new Set(workspaceIds);
  return (workspaceId, cwd) => (cwd ? dirs.some((dir) => isAtOrUnder(cwd, dir)) : ids.has(workspaceId));
}
