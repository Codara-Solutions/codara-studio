// The workspace rail as a tree: each project with the worktrees made from
// it nested under it, and each agent on the row it works in. Pure, so
// scripts/test-rail-tree.cjs loads it without the app; WorkspaceRail and
// rail/WorkspaceChildren.tsx render what it decides. DESIGN.md ("Worktrees
// in the rail") has the look this serves.

import type { AgentLine, AgentLineState } from "./agent-status";
import { paneNoteKey } from "./agent-status";

export interface RailTreeWorkspace {
  id: string;
  cwd: string;
  groupId?: string;
  copyBranch?: {
    repoCwd: string;
    createdBy?: { kind: "user" | "agent"; paneId?: string };
  };
}

export interface RailTree {
  /** Worktree workspace id to the project it nests under. */
  parentOf: ReadonlyMap<string, string>;
  /** Project id to its worktrees, in rail order. */
  childrenOf: ReadonlyMap<string, readonly string[]>;
}

function samePath(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/**
 * Which worktree nests under which project: the first workspace in rail
 * order whose folder is the worktree's source repository. `railOrder` is the
 * top-level order the rail shows (workspace and folder ids); a filed project
 * ranks where its folder sits, and the workspaces array orders the rest,
 * since dropping a row reorders that array without the rail moving. A
 * project is never itself a worktree, so the tree is one level deep; a
 * worktree whose project is not in the rail stays a row of its own.
 */
export function buildRailTree(workspaces: readonly RailTreeWorkspace[], railOrder: readonly string[] = []): RailTree {
  const slot = new Map(railOrder.map((id, index) => [id, index]));
  const place = (workspace: RailTreeWorkspace) =>
    (workspace.groupId === undefined ? undefined : slot.get(workspace.groupId)) ?? slot.get(workspace.id) ?? railOrder.length;
  const projects = workspaces
    .map((workspace, index) => ({ workspace, index, place: place(workspace) }))
    .sort((a, b) => a.place - b.place || a.index - b.index)
    .map((entry) => entry.workspace);
  const projectByCwd = new Map<string, string>();
  for (const workspace of projects) {
    if (workspace.copyBranch) continue;
    const key = samePath(workspace.cwd);
    if (!projectByCwd.has(key)) projectByCwd.set(key, workspace.id);
  }
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const workspace of workspaces) {
    if (!workspace.copyBranch) continue;
    const parent = projectByCwd.get(samePath(workspace.copyBranch.repoCwd));
    if (!parent || parent === workspace.id) continue;
    parentOf.set(workspace.id, parent);
    const list = childrenOf.get(parent);
    if (list) list.push(workspace.id);
    else childrenOf.set(parent, [workspace.id]);
  }
  return { parentOf, childrenOf };
}

export interface RailFamilyChild {
  workspaceId: string;
  /** The agents working in it, most urgent first. */
  agents: AgentLine[];
}

export interface RailFamily {
  /** The project's agents that work in no worktree of it, most urgent first. */
  own: AgentLine[];
  /** Worktrees still in play, most urgent agent first. */
  active: RailFamilyChild[];
  /** Merged worktrees, folded at the bottom. */
  merged: RailFamilyChild[];
  /** Every agent of the family once, for the project's roll-up line. */
  all: AgentLine[];
}

const STATE_RANK: Record<AgentLineState, number> = { "needs-you": 0, working: 1, done: 2, idle: 3 };
const NO_AGENT_RANK = 4;

function rank(agents: readonly AgentLine[]): number {
  return agents.length ? Math.min(...agents.map((line) => STATE_RANK[line.state])) : NO_AGENT_RANK;
}

function byUrgency(a: AgentLine, b: AgentLine): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || b.since - a.since;
}

export interface RailFamilyInput {
  /** The project's own agent lines. */
  projectLines: readonly AgentLine[];
  children: ReadonlyArray<{
    workspaceId: string;
    /** Lines of agents whose pane is in the worktree's own workspace. */
    lines: readonly AgentLine[];
    /** The pane that created the worktree, when an agent did. */
    creatorPaneId?: string;
    /** When the worktree was made (ISO), to pick a creator's newest one. */
    createdAt?: string;
    /** Null until the rail knows: the row stays in play, its creator on the project. */
    merged: boolean | null;
  }>;
}

/**
 * Puts each agent on the row it works in. An agent whose pane is in a
 * worktree's workspace works there. An agent in the project that created a
 * worktree works in it while no agent runs inside it and it is not merged
 * (its chat stays in the project, its branch is the worktree's); once one
 * does, the creator was a coordinator and stays on the project. A creator of
 * several such worktrees works in the newest, so each agent shows on one row.
 * The rest are the project's own. Worktrees sort by their most urgent agent
 * (needs you, working, done, idle, none), keeping rail order among equals.
 */
export function buildRailFamily(input: RailFamilyInput): RailFamily {
  const projectByKey = new Map(input.projectLines.map((line) => [line.key, line]));
  // Creator line key to the child it works in. Later entries in rail order
  // win ties, since a new worktree's row is added at the end.
  const workingIn = new Map<string, { index: number; createdAt: number }>();
  input.children.forEach((child, index) => {
    if (!child.creatorPaneId || child.merged !== false || child.lines.length > 0) return;
    const key = paneNoteKey(child.creatorPaneId);
    if (!projectByKey.has(key)) return;
    const createdAt = child.createdAt ? Date.parse(child.createdAt) || 0 : 0;
    const current = workingIn.get(key);
    if (!current || createdAt >= current.createdAt) workingIn.set(key, { index, createdAt });
  });
  const claimed = new Set<string>();
  const rows = input.children.map((child, index) => {
    const agents = [...child.lines];
    const key = child.creatorPaneId ? paneNoteKey(child.creatorPaneId) : null;
    const creator = key && workingIn.get(key)?.index === index ? projectByKey.get(key) : undefined;
    if (creator) {
      agents.push(creator);
      claimed.add(creator.key);
    }
    agents.sort(byUrgency);
    return { index, merged: child.merged === true, row: { workspaceId: child.workspaceId, agents } };
  });
  const own = input.projectLines.filter((line) => !claimed.has(line.key)).sort(byUrgency);
  const ordered = (list: typeof rows) =>
    list
      .sort((a, b) => rank(a.row.agents) - rank(b.row.agents) || a.index - b.index)
      .map((entry) => entry.row);
  const seen = new Set<string>();
  const all: AgentLine[] = [];
  for (const line of [...own, ...rows.flatMap((entry) => entry.row.agents)]) {
    if (seen.has(line.key)) continue;
    seen.add(line.key);
    all.push(line);
  }
  return {
    own,
    active: ordered(rows.filter((entry) => !entry.merged)),
    merged: ordered(rows.filter((entry) => entry.merged)),
    all: all.sort(byUrgency),
  };
}
