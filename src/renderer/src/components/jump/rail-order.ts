import type { Workspace, WorkspaceGroup } from "@shared/types";

// What the window needs from the jump model at startup: the rail order that
// "workspace N" counts in, and the workspace a new worktree forks from. The
// palette's entries and ranking load with the palette itself.

// ── Rail order ────────────────────────────────────────────────────────────

/**
 * The workspaces top to bottom as the rail draws them: the mixed top-level
 * order of loose workspaces and folders, each folder's members in workspace
 * order. Members of a collapsed folder are left out unless asked for, since
 * "workspace 3" means the third row the user can see.
 */
export function workspaceRailSequence(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
  railOrder: readonly string[],
  options: { includeCollapsed?: boolean } = {},
): Workspace[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const loose = new Map(
    workspaces
      .filter((workspace) => !workspace.groupId || !groupById.has(workspace.groupId))
      .map((workspace) => [workspace.id, workspace]),
  );
  const top: string[] = [];
  const seen = new Set<string>();
  for (const id of [...railOrder, ...loose.keys(), ...groupById.keys()]) {
    if (seen.has(id) || (!loose.has(id) && !groupById.has(id))) continue;
    seen.add(id);
    top.push(id);
  }
  const out: Workspace[] = [];
  for (const id of top) {
    const workspace = loose.get(id);
    if (workspace) {
      out.push(workspace);
      continue;
    }
    const group = groupById.get(id);
    if (!group || (group.collapsed && !options.includeCollapsed)) continue;
    for (const member of workspaces) if (member.groupId === group.id) out.push(member);
  }
  return out;
}

/**
 * The workspace a new worktree forks from: the repository the active
 * workspace belongs to. SSH workspaces cannot host one, and neither can a
 * folder whose branch read came back empty (`null` in the rail's branch map:
 * not a git repository). A branch not read yet does not hide the offer.
 */
export function worktreeSourceWorkspace(
  workspaces: readonly Workspace[],
  activeWorkspaceId: string | null,
  branchByWorkspaceId: Readonly<Record<string, string | null | undefined>> = {},
): Workspace | null {
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  if (!active || active.remote) return null;
  const repo = active.copyBranch?.repoCwd;
  const source = repo
    ? (workspaces.find((workspace) => workspace.cwd === repo && !workspace.copyBranch) ?? active)
    : active;
  return branchByWorkspaceId[source.id] === null ? null : source;
}
