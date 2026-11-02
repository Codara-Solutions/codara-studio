// The Source Control panel's agent lanes (DESIGN.md, "Source Control"): one
// lane per checkout of the active project, what it changed, whether its pull
// request can land, and the one obvious next step. Pure, so
// scripts/test-source-lanes.cjs loads it without the app.

import type { AgentLine, AgentLineState } from "./agent-status";
import type { PullRequestWatchState } from "./pull-request-watch";

export type LaneFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface LaneFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: LaneFileStatus;
}

/** Everything a checkout changed since it left its base, committed or not. */
export interface LaneChanges {
  /** The branch it is compared against; null when none was found, so only uncommitted work counts. */
  base: string | null;
  additions: number;
  deletions: number;
  /** Every changed file, also when `files` was cut short. */
  fileCount: number;
  /** The first MAX_LANE_FILES, largest change first. */
  files: LaneFile[];
  error?: string;
}

/** Files one lane sends to the panel. A lane is a summary; the Review tab shows the rest. */
export const MAX_LANE_FILES = 200;
/** Checkouts read in one call. */
export const MAX_LANE_READS = 40;

export const NO_LANE_CHANGES: LaneChanges = { base: null, additions: 0, deletions: 0, fileCount: 0, files: [] };

export type LaneStep = "open-agent" | "fix-checks" | "merge" | "open";

export interface LaneInput {
  /** The workspace id, or "path:<folder>" for a worktree made outside Codara. */
  id: string;
  workspaceId: string | null;
  path: string;
  branch: string | null;
  /** The checkout the rest of the window is on; its detail and commit box are in the panel. */
  own: boolean;
  /** Most urgent first. */
  agents: readonly AgentLine[];
  /** Who made the worktree when an agent did ("claude-code"), for a reviewer of the other family. */
  creator?: string | null;
  pullRequest: PullRequestWatchState | null;
  merged: boolean;
  /** The folder is not on disk. */
  missing: boolean;
  changes: LaneChanges | null;
}

export interface SourceLane extends LaneInput {
  /** The next step first; empty when there is nothing to do from the lane. */
  steps: LaneStep[];
  urgency: number;
}

function nextSteps(input: LaneInput): LaneStep[] {
  if (input.own || input.merged || input.missing) return [];
  const steps: LaneStep[] = [];
  const agent = input.agents[0];
  const pr = input.pullRequest;
  const openPr = pr?.phase === "open" ? pr : null;
  if (agent?.state === "needs-you") steps.push("open-agent");
  if (openPr?.checks === "failing") steps.push("fix-checks");
  // Checks still running can fail, a draft is not asking to land yet, and an
  // agent working or asking may still change the branch, whichever agent the
  // lane shows first. Main reads GitHub again and pins the head commit when it
  // merges.
  const settled = !input.agents.some((line) => line.state === "working" || line.state === "needs-you");
  if (openPr && settled && (openPr.checks === "passing" || openPr.checks === "none")) {
    steps.push("merge");
  }
  if (agent && !steps.includes("open-agent")) steps.push("open-agent");
  steps.push("open");
  return steps;
}

const STATE_URGENCY: Record<AgentLineState, number> = { "needs-you": 0, working: 3, done: 4, idle: 5 };
const FAILING_URGENCY = 1;
const READY_URGENCY = 2;
const QUIET_URGENCY = 6;

function urgencyOf(input: LaneInput, steps: readonly LaneStep[]): number {
  const agent = input.agents[0];
  if (agent?.state === "needs-you") return STATE_URGENCY["needs-you"];
  if (steps.includes("fix-checks")) return FAILING_URGENCY;
  if (steps.includes("merge")) return READY_URGENCY;
  return agent ? STATE_URGENCY[agent.state] : QUIET_URGENCY;
}

export interface SourceLanes {
  /** Other checkouts still in play, most urgent first. */
  others: SourceLane[];
  /** The active checkout, always last so the list above it does not jump as its detail grows. */
  own: SourceLane | null;
  /** Merged worktrees, folded at the bottom. */
  merged: SourceLane[];
}

function byName(a: LaneInput, b: LaneInput): number {
  return (a.branch ?? a.path).localeCompare(b.branch ?? b.path);
}

export function buildSourceLanes(inputs: readonly LaneInput[]): SourceLanes {
  const lanes = inputs.map((input): SourceLane => {
    const steps = nextSteps(input);
    return { ...input, steps, urgency: urgencyOf(input, steps) };
  });
  return {
    own: lanes.find((lane) => lane.own) ?? null,
    others: lanes
      .filter((lane) => !lane.own && !lane.merged)
      .sort((a, b) => a.urgency - b.urgency || (b.agents[0]?.since ?? 0) - (a.agents[0]?.since ?? 0) || byName(a, b)),
    merged: lanes.filter((lane) => !lane.own && lane.merged).sort(byName),
  };
}

export const LANE_STEP_LABELS: Record<LaneStep, string> = {
  "open-agent": "Open agent",
  "fix-checks": "Fix checks",
  merge: "Merge",
  open: "Open",
};

/** Largest change first, so a lane's short list shows what matters. */
export function sortLaneFiles(files: readonly LaneFile[]): LaneFile[] {
  return [...files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
  );
}
