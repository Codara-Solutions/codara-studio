// What an agent learns from codara_worktree_cleanup and what the user sees
// when it asks to remove worktrees: a recommendation per worktree with its
// reason, and the approval request and answer that pass between the main
// process and the approval dialog. Shared by src/main/worktree-cleanup/
// (agent-tool.ts) and components/worktree-cleanup/. Pure: no Node or DOM
// imports.

import type {
  WorktreeCleanupOutcome,
  WorktreeKeptBranch,
  WorktreeInUse,
  WorktreeLocalWork,
  WorktreeMergeProof,
  WorktreeMergeState,
} from "./worktree-cleanup";

/** safe: merged, clean and idle. review: worth a look first. keep: leave it. */
export type WorktreeAdvice = "safe" | "review" | "keep";

export const ADVICE_LABELS: Record<WorktreeAdvice, string> = {
  safe: "safe to remove",
  review: "review",
  keep: "keep",
};

export const DEFAULT_ADVICE_STALE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** unknown: GitHub was not asked or did not answer. none: GitHub knows no pull request for the branch. */
export type AgentPullRequestState = "open" | "draft" | "merged" | "closed" | "none" | "unknown";

/** Everything a recommendation is made from. */
export interface WorktreeAdviceFacts {
  missing: boolean;
  locked: boolean;
  inUse: WorktreeInUse[];
  /** Codes of the full check that refuse a removal outright, other than IN_USE and LOCKED. */
  hardBlockers: Array<{ code: string; message: string }>;
  /** Null when the status could not be read. */
  dirty: { tracked: number; untracked: number; inProgress: string | null } | null;
  /** The full check's local work, ignored files included; null when there is none or it was not read. */
  localWork: WorktreeLocalWork | null;
  merge: { state: WorktreeMergeState; proof?: WorktreeMergeProof; target?: string };
  /** Commits the base lacks. */
  ahead: number;
  pullRequest: { number: number; state: AgentPullRequestState } | null;
  /** Whether the branch is on the remote; null when unknown (no remote, detached HEAD, or not asked). */
  onRemote: boolean | null;
  /** Commits the remote copy of the branch lacks; null when unknown. */
  unpushed: number | null;
  lastActivityAt: number | null;
}

export interface WorktreeAdviceResult {
  advice: WorktreeAdvice;
  reason: string;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Edits a removal would lose for good: never removed by an agent's request. */
export function hasUnsavedChanges(facts: Pick<WorktreeAdviceFacts, "dirty" | "localWork" | "missing">): boolean {
  if (facts.missing) return false;
  if (facts.dirty === null) return true;
  if (facts.dirty.tracked + facts.dirty.untracked > 0 || facts.dirty.inProgress) return true;
  const work = facts.localWork;
  if (!work) return false;
  return work.tracked + work.untracked + work.hidden > 0 || work.inProgress !== null || work.submodules.length > 0;
}

/**
 * Local work that is only ignored files a fresh checkout would not bring
 * back (.env.local and the like), or a folder too large to check: the user
 * may still choose to remove it, after seeing the list.
 */
export function onlyIgnoredWork(work: WorktreeLocalWork | null): boolean {
  if (!work) return false;
  return (
    work.tracked + work.untracked + work.hidden === 0 &&
    work.inProgress === null &&
    work.submodules.length === 0 &&
    (work.ignored.length > 0 || work.unscanned !== null)
  );
}

function ignoredText(work: WorktreeLocalWork): string {
  const parts: string[] = [];
  if (work.ignored.length) {
    const shown = work.ignored.slice(0, 3).join(", ");
    parts.push(`ignored files a fresh checkout does not bring back (${shown}${work.ignored.length > 3 ? ", more" : ""})`);
  }
  if (work.unscanned) parts.push(`${work.unscanned}, too large to check`);
  return parts.join(" and ");
}

function idleDays(lastActivityAt: number | null, now: number): number | null {
  return lastActivityAt === null ? null : Math.floor(Math.max(0, now - lastActivityAt) / DAY_MS);
}

export function adviseWorktree(facts: WorktreeAdviceFacts, now: number, staleDays = DEFAULT_ADVICE_STALE_DAYS): WorktreeAdviceResult {
  const keep = (reason: string): WorktreeAdviceResult => ({ advice: "keep", reason });
  const review = (reason: string): WorktreeAdviceResult => ({ advice: "review", reason });
  if (facts.inUse.length) return keep(`In use: ${facts.inUse.map((use) => use.label).join(", ")}.`);
  if (facts.missing) {
    return facts.locked
      ? keep("The folder is gone but git keeps it locked, maybe on a drive that is not mounted.")
      : { advice: "safe", reason: "The folder is already gone; only git's record of it is left." };
  }
  if (facts.locked) return keep("Locked with git worktree lock.");
  if (facts.hardBlockers.length) return keep(facts.hardBlockers[0].message);
  if (facts.dirty === null) return keep("Its git status could not be read.");
  const work = facts.localWork;
  if (hasUnsavedChanges(facts)) {
    const dirty = facts.dirty;
    const parts: string[] = [];
    const tracked = Math.max(dirty.tracked, work?.tracked ?? 0);
    const untracked = Math.max(dirty.untracked, work?.untracked ?? 0);
    if (tracked) parts.push(plural(tracked, "edited file"));
    if (untracked) parts.push(plural(untracked, "new file"));
    if (work?.hidden) parts.push(plural(work.hidden, "hidden edit"));
    if (dirty.inProgress ?? work?.inProgress) parts.push(`a ${dirty.inProgress ?? work?.inProgress} in progress`);
    if (work?.submodules.length) parts.push(plural(work.submodules.length, "submodule checkout"));
    return keep(`Unsaved changes: ${parts.join(", ") || "local work"}.`);
  }
  const pr = facts.pullRequest;
  if (pr && (pr.state === "open" || pr.state === "draft")) {
    return keep(`Pull request #${pr.number} is ${pr.state === "draft" ? "a draft, still open" : "open"}.`);
  }
  const days = idleDays(facts.lastActivityAt, now);
  const stale = days !== null && days >= staleDays;
  const idle = days === null ? "no known activity" : days === 0 ? "active today" : `no activity for ${plural(days, "day")}`;
  if (facts.merge.state === "merged") {
    if (work && onlyIgnoredWork(work)) return review(`Merged, but it holds ${ignoredText(work)}.`);
    const how =
      facts.merge.proof === "pull-request"
        ? `merged through pull request${pr ? ` #${pr.number}` : ""}`
        : facts.merge.proof === "content-in-target"
          ? `its changes are in ${facts.merge.target ?? "the base branch"} (squash merge)`
          : `merged into ${facts.merge.target ?? "the base branch"}`;
    return { advice: "safe", reason: `${how.charAt(0).toUpperCase()}${how.slice(1)}, clean and idle.` };
  }
  if (facts.merge.state === "base") {
    const base = facts.merge.target ? `the base branch ${facts.merge.target}` : "the base branch";
    return review(`It has ${base} checked out; removing it loses nothing, but it may be a checkout you use.`);
  }
  // Unmerged or unknown from here.
  const commits = facts.merge.state === "unknown" ? "Codara could not tell whether it is merged" : `${plural(facts.ahead, "commit")} not merged`;
  if (facts.unpushed !== null && facts.unpushed > 0) {
    return keep(`${plural(facts.unpushed, "commit")} not pushed to the remote and not merged.`);
  }
  if (facts.onRemote === false && facts.ahead > 0) return keep(`${commits}, and the branch is not on the remote.`);
  if (pr?.state === "closed") return review(`Pull request #${pr.number} was closed without merging: ${commits}.`);
  if (stale) {
    if (work && onlyIgnoredWork(work)) return review(`${commits}, ${idle}, and it holds ${ignoredText(work)}.`);
    const saved = facts.onRemote === true ? " The commits are on the remote." : facts.ahead === 0 ? "" : " Its branch stays after removal.";
    return review(`${commits}, ${idle}, no local changes.${saved}`);
  }
  return keep(`${commits}, ${idle}.`);
}

const ADVICE_ORDER: Record<WorktreeAdvice, number> = { safe: 0, review: 1, keep: 2 };

/** Safe first, then review, then keep; the largest first within each. */
export function sortByAdvice<T extends { advice: WorktreeAdvice; sizeBytes: number | null; path: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      ADVICE_ORDER[a.advice] - ADVICE_ORDER[b.advice] ||
      (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) ||
      a.path.localeCompare(b.path),
  );
}

// ── The remote branch ──────────────────────────────────────────────────────

/** Branch names never deleted on the remote, merged or not. */
export const PROTECTED_REMOTE_BRANCHES: ReadonlySet<string> = new Set([
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

export interface RemoteBranchFacts {
  branch: string | null;
  /** The remote a deletion would push to; null when the repository has none. */
  remote: string | null;
  /** The branch's tip on the remote; null when it is not there or unknown. */
  remoteTip: string | null;
  /** The remote was asked just now (not only the last fetch). */
  remoteAsked: boolean;
  /** The repository's default branch and the base the worktree is judged against, short names. */
  baseBranches: string[];
  /** A merged pull request whose head is this branch, and the commit it merged. */
  mergedPullRequest: { number: number; headRefOid: string } | null;
  /** An open or draft pull request uses the branch as its head. */
  openPullRequest: number | null;
  /** The remote tip is already in the base branch (an ancestor of it). */
  remoteTipInBase: boolean;
  /** Why GitHub could not be asked, when it could not. */
  githubError?: string;
}

export interface RemoteBranchVerdict {
  /** The user may tick "also delete the remote branch". */
  offered: boolean;
  reason: string;
}

/**
 * Whether the remote copy of a branch may be deleted once the user ticks it:
 * only a branch whose pull request merged, whose remote tip has nothing the
 * merge lacks, that no open pull request uses, and that is not a long-lived
 * or default branch.
 */
export function remoteBranchVerdict(facts: RemoteBranchFacts): RemoteBranchVerdict {
  const no = (reason: string): RemoteBranchVerdict => ({ offered: false, reason });
  if (!facts.branch) return no("No branch: the worktree has a detached HEAD.");
  if (!facts.remote) return no("The repository has no remote.");
  if (PROTECTED_REMOTE_BRANCHES.has(facts.branch) || facts.baseBranches.includes(facts.branch)) {
    return no("A default or long-lived branch is never deleted.");
  }
  if (!facts.remoteAsked) return no("The remote was not asked.");
  if (!facts.remoteTip) return no(`The branch is not on ${facts.remote}.`);
  if (facts.openPullRequest !== null) return no(`Open pull request #${facts.openPullRequest} uses it.`);
  if (!facts.mergedPullRequest) {
    return no(facts.githubError ? `GitHub could not be asked: ${facts.githubError}` : "No merged pull request uses it.");
  }
  if (facts.remoteTip !== facts.mergedPullRequest.headRefOid.toLowerCase() && !facts.remoteTipInBase) {
    return no(`The remote branch has commits that pull request #${facts.mergedPullRequest.number} did not merge.`);
  }
  return { offered: true, reason: `Pull request #${facts.mergedPullRequest.number} merged it.` };
}

// ── The approval ───────────────────────────────────────────────────────────

export interface WorktreeCleanupApprovalItem {
  repoRoot: string;
  repoName: string;
  path: string;
  branch: string | null;
  workspaceName: string | null;
  sizeBytes: number | null;
  advice: WorktreeAdvice;
  reason: string;
  /** Null when the user may tick it; otherwise why it can never be removed here. */
  blocked: string | null;
  /** Ticked when the dialog opens: only a safe item is. */
  preselected: boolean;
  /** Ignored files the removal deletes, listed so the user sees them before ticking. */
  ignored: string[];
  /** Commits a removal leaves only on the branch (which stays) or a recovery ref. */
  unmergedCommits: number;
  remote: { offered: boolean; reason: string; name: string | null; suggested: boolean };
}

export interface WorktreeCleanupApprovalRequest {
  id: string;
  agent: { client: string; workspaceName: string | null };
  items: WorktreeCleanupApprovalItem[];
  /** Epoch ms after which the answer is no longer waited for. */
  expiresAt: number;
}

export interface WorktreeCleanupApprovalAnswer {
  id: string;
  approved: boolean;
  items: Array<{ repoRoot: string; path: string; remove: boolean; deleteRemoteBranch: boolean }>;
  deleteMergedBranches: boolean;
}

export interface WorktreeCleanupRemoteOutcome {
  repoRoot: string;
  branch: string;
  remote: string | null;
  status: "deleted" | "skipped" | "failed";
  message: string;
}

/** What the tool returns, and what the dialog shows once the removal ran. */
export interface WorktreeCleanupAgentResult {
  ok: boolean;
  status: "done" | "declined" | "timeout" | "no-window" | "nothing-to-remove";
  removed: Array<{ repoRoot: string; path: string; branch: string | null; branchDeleted: boolean; reclaimedBytes: number | null; recoveryRef?: string }>;
  skipped: Array<{ repoRoot: string; path: string; branch: string | null; reason: string }>;
  remoteBranches: WorktreeCleanupRemoteOutcome[];
  /** What the removal did per worktree, as the cleanup screen shows it. */
  outcomes?: WorktreeCleanupOutcome[];
  keptBranches?: WorktreeKeptBranch[];
  note: string;
}
