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
 * order whose folder is the worktree's source repository. A project is never
 * itself a worktree, so the tree is one level deep; a worktree whose project
 * is not in the rail stays a row of its own.
 */
export function buildRailTree(workspaces: readonly RailTreeWorkspace[]): RailTree {
  const projectByCwd = new Map<string, string>();
  for (const workspace of workspaces) {
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
    merged: boolean;
  }>;
}

/**
 * Puts each agent on the row it works in. An agent whose pane is in a
 * worktree's workspace works there; an agent in the project that created a
 * worktree works in that worktree (its chat stays in the project, its branch
 * is the worktree's). The rest are the project's own. Worktrees sort by
 * their most urgent agent (needs you, working, done, idle, none), keeping
 * rail order among equals.
 */
export function buildRailFamily(input: RailFamilyInput): RailFamily {
  const projectByKey = new Map(input.projectLines.map((line) => [line.key, line]));
  const claimed = new Set<string>();
  const rows = input.children.map((child, index) => {
    const agents = [...child.lines];
    const creator = child.creatorPaneId ? projectByKey.get(paneNoteKey(child.creatorPaneId)) : undefined;
    if (creator && !agents.some((line) => line.key === creator.key)) agents.push(creator);
    if (creator) claimed.add(creator.key);
    agents.sort(byUrgency);
    return { index, merged: child.merged, row: { workspaceId: child.workspaceId, agents } };
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
