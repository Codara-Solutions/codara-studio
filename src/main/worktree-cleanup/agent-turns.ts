import * as fs from "node:fs";
import { isAtOrUnder } from "./inspect";

/**
 * Which agent turns count for a worktree: by a folder the agent worked in,
 * at or under one of `dirs` (however the path is spelled, also through a
 * link); by the pane's workspace when no folder is known.
 */
export function agentTurnIn(
  workspaceIds: readonly string[],
  dirs: readonly string[],
): (workspaceId: string, cwd: string | null) => boolean {
  const ids = new Set(workspaceIds);
  const all = new Set(dirs);
  for (const dir of dirs) {
    try {
      all.add(fs.realpathSync(dir));
    } catch {
      // Gone: as spelled.
    }
  }
  const spelled = [...all];
  return (workspaceId, cwd) => (cwd ? spelled.some((dir) => isAtOrUnder(cwd, dir)) : ids.has(workspaceId));
}
