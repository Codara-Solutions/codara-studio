// The worktree cleanup screen: every worktree of the repositories behind the
// user's workspaces, what is known about each, and the rules that decide what
// a removal may do. Shared by src/main/worktree-cleanup/, the preload area
// (window.spark.worktreeCleanup) and the screen in
// components/worktree-cleanup/. Pure: no Node or DOM imports.

/** How a branch was proven to be in the base branch. */
export type WorktreeMergeProof = "ancestor" | "content-in-target" | "pull-request";

/**
 * merged: every commit (or every change, for a squash merge) is in the base.
 * unmerged: commits exist that the base lacks. base: the worktree has the base
 * branch itself checked out. unknown: no base was found or the check failed.
 */
export type WorktreeMergeState = "merged" | "unmerged" | "base" | "unknown";

/** unknown: the worktree came from this pull request, but GitHub did not say its state. */
export type WorktreePullRequestState = "open" | "draft" | "merged" | "unknown";

export interface WorktreeCleanupPullRequest {
  number: number;
  url: string;
  state: WorktreePullRequestState;
  title?: string;
}

/** What keeps a worktree from being removed while it lasts. */
export type WorktreeInUseKind = "terminal" | "run" | "server" | "agent" | "process" | "app";

export interface WorktreeInUse {
  kind: WorktreeInUseKind;
  /** Plain words for the screen, such as "2 terminals". */
  label: string;
  /** With "agent": the open tab of the agent that made the worktree, to close. */
  tab?: { title: string; workspace?: string };
}

export interface WorktreeSize {
  bytes: number;
  /** False when the budget ran out or some folders could not be read: at least `bytes`. */
  complete: boolean;
  measuredAt: number;
  error?: string;
}

export interface WorktreeLinkedWorkspace {
  id: string;
  name: string;
  /** Present on a Codara copy-branch workspace. */
  createdBy?: "user" | "agent";
  client?: string;
}

export interface WorktreeCleanupRow {
  /** Stable key: the canonical path. */
  id: string;
  repoRoot: string;
  repoName: string;
  /** The path as git lists it. */
  path: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  head: string | null;
  isMain: boolean;
  /** The folder is gone; only git's registration is left. */
  missing: boolean;
  locked: boolean;
  workspace: WorktreeLinkedWorkspace | null;
  /** Newest of the last commit, the last checkout or commit here, and the last index write. */
  lastActivityAt: number | null;
  /** Null when the status could not be read. */
  dirty: { tracked: number; untracked: number; inProgress: string | null } | null;
  upstream: { name: string; ahead: number; behind: number; gone: boolean } | null;
  base: { name: string; ahead: number; behind: number } | null;
  merge: { state: WorktreeMergeState; proof?: WorktreeMergeProof; target?: string };
  pullRequest: WorktreeCleanupPullRequest | null;
  inUse: WorktreeInUse[];
  size: WorktreeSize | null;
  warnings: string[];
}

export interface WorktreeCleanupRepo {
  root: string;
  name: string;
  /** The base branch merges are judged against, such as "origin/main". */
  base: string | null;
  /** The Codara workspaces inside this repository, main checkout or worktree. */
  workspaceIds: string[];
  /** Why pull requests are unknown, when they are. */
  pullRequests: "known" | "unavailable";
  error?: string;
}

export interface WorktreeCleanupScan {
  scannedAt: number;
  repos: WorktreeCleanupRepo[];
  rows: WorktreeCleanupRow[];
  /** Null when this platform offers no process scan. */
  processScan: boolean;
}

/** Sizes measured in the background, sent to the screen as they land. */
export interface WorktreeSizeEvent {
  /** The measurement that just landed; absent on the notice that measuring stopped. */
  measured?: { id: string; size: WorktreeSize };
  /** How many measurements are still queued or running. */
  pending: number;
  /** Measuring stopped with worktrees left because its time budget ran out. */
  budgetSpent?: boolean;
}

// ── Filters ────────────────────────────────────────────────────────────────

export type WorktreeSortKey = "size" | "activity" | "name";

export interface WorktreeCleanupFilters {
  query: string;
  repo: string | null;
  merged: boolean;
  /** Only worktrees with no activity for this many days. */
  staleDays: number | null;
  /** Only worktrees at least this large. */
  largeBytes: number | null;
}

export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_LARGE_BYTES = 500 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(row: WorktreeCleanupRow, days: number, now: number): boolean {
  if (row.lastActivityAt === null) return false;
  return now - row.lastActivityAt >= days * DAY_MS;
}

function haystack(row: WorktreeCleanupRow): string {
  return [
    row.branch ?? "detached",
    row.path,
    row.repoName,
    row.workspace?.name ?? "",
    row.pullRequest ? `#${row.pullRequest.number} ${row.pullRequest.title ?? ""}` : "",
  ]
    .join("\n")
    .toLowerCase();
}

export function filterWorktreeRows(
  rows: readonly WorktreeCleanupRow[],
  filters: WorktreeCleanupFilters,
  now: number,
): WorktreeCleanupRow[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filters.repo && row.repoRoot !== filters.repo) return false;
    if (filters.merged && row.merge.state !== "merged") return false;
    if (filters.staleDays !== null && !isStale(row, filters.staleDays, now)) return false;
    if (filters.largeBytes !== null && (row.size === null || row.size.bytes < filters.largeBytes)) return false;
    if (terms.length) {
      const text = haystack(row);
      if (!terms.every((term) => text.includes(term))) return false;
    }
    return true;
  });
}

export function sortWorktreeRows(rows: readonly WorktreeCleanupRow[], key: WorktreeSortKey): WorktreeCleanupRow[] {
  // The root keeps two repositories that share a folder name apart, so each
  // one's rows stay together under its main checkout.
  const name = (row: WorktreeCleanupRow): string => `${row.repoName}\u0000${row.repoRoot}\u0000${row.branch ?? row.path}`;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    // By name, the main checkout heads its repository's rows.
    if (a.repoRoot === b.repoRoot && a.isMain !== b.isMain && key === "name") return a.isMain ? -1 : 1;
    if (key === "size") {
      const delta = (b.size?.bytes ?? -1) - (a.size?.bytes ?? -1);
      if (delta) return delta;
    } else if (key === "activity") {
      // Oldest first: the likeliest leftovers lead.
      const delta = (a.lastActivityAt ?? Number.MAX_SAFE_INTEGER) - (b.lastActivityAt ?? Number.MAX_SAFE_INTEGER);
      if (delta) return delta;
    }
    return name(a).localeCompare(name(b));
  });
  return sorted;
}

/** Each row's place in the list, taken when the user sorts or the list is read again. */
export function rowPositions(rows: readonly { id: string }[]): Map<string, number> {
  return new Map(rows.map((row, index) => [row.id, index]));
}

/**
 * Rows keep the place `positions` gave them while sizes land in the
 * background, so a row never moves under the pointer while the user picks;
 * rows it does not know follow in their live order.
 */
export function keepRowOrder<T extends { id: string }>(sorted: readonly T[], positions: ReadonlyMap<string, number>): T[] {
  const known: T[] = [];
  const fresh: T[] = [];
  for (const row of sorted) (positions.has(row.id) ? known : fresh).push(row);
  known.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  return [...known, ...fresh];
}

/** True when sorting again would put the rows in another order. */
export function orderDrifted(kept: readonly { id: string }[], sorted: readonly { id: string }[]): boolean {
  if (kept.length !== sorted.length) return true;
  return kept.some((row, index) => row.id !== sorted[index].id);
}

// ── What a removal may do ──────────────────────────────────────────────────

export interface WorktreeRemovalOutlook {
  /** Why this worktree cannot be selected at all, or null. */
  blocked: string | null;
  /** The worktree holds work a removal deletes; the user must confirm it per item. */
  needsDirtyConfirm: boolean;
  /** The branch or HEAD has commits the base lacks; the user must confirm it per item. */
  needsUnmergedConfirm: boolean;
}

/** What the list shows before the full check. The removal re-checks every point. */
export function removalOutlook(row: WorktreeCleanupRow): WorktreeRemovalOutlook {
  let blocked: string | null = null;
  if (row.isMain) blocked = "The main checkout is never removed.";
  else if (row.inUse.length) blocked = `In use: ${row.inUse.map((use) => use.label).join(", ")}.`;
  else if (row.locked) blocked = "Locked with git worktree lock. Unlock it first.";
  const dirty = row.dirty;
  const needsDirtyConfirm = !row.missing && (dirty === null || dirty.tracked + dirty.untracked > 0 || dirty.inProgress !== null);
  const needsUnmergedConfirm = !row.missing && (row.merge.state === "unmerged" || row.merge.state === "unknown");
  return { blocked, needsDirtyConfirm, needsUnmergedConfirm };
}

// ── Removal requests and answers ───────────────────────────────────────────

export interface WorktreeCleanupTarget {
  repoRoot: string;
  path: string;
}

/**
 * Why a removal was refused. The first group cannot be confirmed away; the
 * second needs the per-item confirmation the request did not carry.
 */
export type WorktreeCleanupCode =
  | "MAIN_CHECKOUT"
  | "NOT_REGISTERED"
  | "PROTECTED_PATH"
  | "IN_USE"
  | "LOCKED"
  | "NESTED_CHECKOUT"
  | "UNCHECKED"
  | "CHANGED"
  | "REPO_BUSY"
  | "GIT_FAILED"
  | "DIRTY_NOT_CONFIRMED"
  | "UNMERGED_NOT_CONFIRMED";

export interface WorktreeLocalWork {
  tracked: number;
  untracked: number;
  /** Edits git status hides (assume-unchanged or skip-worktree files). */
  hidden: number;
  /** Ignored files a fresh checkout would not bring back, such as .env.local. */
  ignored: string[];
  submodules: string[];
  inProgress: string | null;
  /** An ignored folder too large or unreadable to check for nested checkouts. */
  unscanned: string | null;
  paths: string[];
}

export interface WorktreeUnmergedWork {
  /** Commits the base lacks. */
  ahead: number;
  target: string | null;
  /** True when no branch, tag or remote branch holds HEAD: only the recovery ref will. */
  orphaned: boolean;
  commits: string[];
}

/** The full check of one worktree, as the confirm step shows it. */
export interface WorktreeRemovalCheck extends WorktreeCleanupTarget {
  branch: string | null;
  head: string | null;
  workspace: WorktreeLinkedWorkspace | null;
  alreadyRemoved: boolean;
  blockers: Array<{ code: WorktreeCleanupCode; message: string }>;
  /** What the IN_USE blocker is about. */
  inUse?: WorktreeInUse[];
  localWork: WorktreeLocalWork | null;
  unmerged: WorktreeUnmergedWork | null;
  merge: { state: WorktreeMergeState; proof?: WorktreeMergeProof; target?: string };
  /** The branch a removal deletes when merged branches are deleted; null keeps it. */
  branchDeletable: boolean;
  /** Ties a confirmation to the exact state the user saw. */
  fingerprint: string;
}

export interface WorktreeCleanupRemoveItem extends WorktreeCleanupTarget {
  fingerprint: string;
  confirmDirty: boolean;
  confirmUnmerged: boolean;
}

export interface WorktreeCleanupRemoveRequest {
  items: WorktreeCleanupRemoveItem[];
  deleteMergedBranches: boolean;
}

export interface WorktreeKeptBranch {
  repoRoot: string;
  branch: string;
  ahead: number;
  target: string | null;
}

export interface WorktreeCleanupOutcome extends WorktreeCleanupTarget {
  branch: string | null;
  status: "removed" | "already-removed" | "refused" | "failed";
  code?: WorktreeCleanupCode;
  message?: string;
  branchDeleted: boolean;
  /** Why the branch stayed, when it did. */
  branchKept?: "unmerged" | "not-requested" | "moved" | "checked-out" | "protected";
  recoveryRef?: string;
  /** The uncommitted changes saved before the removal, when they were small enough. */
  changesRef?: string;
  reclaimedBytes?: number;
  workspaceRemoved?: string;
}

export interface WorktreeCleanupRemoveResult {
  outcomes: WorktreeCleanupOutcome[];
  keptBranches: WorktreeKeptBranch[];
}

// ── The workspace rail ─────────────────────────────────────────────────────

/**
 * "gone": the branch no longer exists and git keeps no record of the worktree.
 * "empty": in its base only because it has no commits of its own yet, as
 * right after the worktree was made; the rail does not call that merged.
 */
export type WorktreeRailMerge = WorktreeMergeState | "gone" | "empty";

/** What the rail shows for one copy-branch workspace. */
export interface WorktreeRailState {
  workspaceId: string;
  /** The worktree folder is not on disk. */
  missing: boolean;
  branch: string;
  /** No local branch of that name is left. */
  branchGone: boolean;
  merge: WorktreeRailMerge;
  proof?: WorktreeMergeProof;
  target?: string;
  /** Missing, and merged or gone: the rail asks main to remove it, and main checks everything again. */
  autoCandidate: boolean;
  /** When its checked-out commit was made (ms), the activity a background agent leaves behind. */
  headAt?: number;
}

/**
 * A worktree git lists for a project's repository that no rail row shows: one
 * made with plain `git worktree add`, by hand or by an agent. The rail lists
 * it under its project so nothing works out of sight.
 */
export interface WorktreeRailExternal {
  /** The project row it hangs under: the workspace whose folder is the repository's main checkout. */
  projectId: string;
  path: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  head: string;
  /** When the checked-out commit was made (ms). */
  headAt?: number;
  locked: boolean;
}

/** One read of the rail's worktrees: the rows it has, and the ones made outside Codara. */
export interface WorktreeRailOverview {
  states: WorktreeRailState[];
  external: WorktreeRailExternal[];
}

/**
 * manual: the user clicked Clean up or Remove from rail on the row; the
 * workspace's own idle shells do not block it. auto: the rail found a missing
 * folder whose branch is merged or gone; anything in use blocks it.
 */
export interface WorktreeRailCleanupRequest {
  workspaceId: string;
  mode: "manual" | "auto";
  /**
   * The fingerprint of a "confirm" answer the user accepted: its ignored
   * files go with the folder. Anything changed since refuses again.
   */
  confirmIgnored?: string;
}

export interface WorktreeRailCleanupResult {
  /** "confirm": only ignored files hold it back; ask, then send the fingerprint back. */
  status: "removed" | "refused" | "failed" | "confirm";
  /** Why it was refused or failed, or what was left behind. */
  message?: string;
  workspaceName?: string;
  branchDeleted: boolean;
  /** Plain words for why the branch stayed, such as "it has unmerged commits". */
  branchKept?: string;
  /** With "confirm": the ignored files a fresh checkout would not bring back. */
  holds?: string[];
  /** With "confirm": what the answer is tied to. */
  fingerprint?: string;
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatAge(at: number | null, now: number): string {
  if (at === null) return "unknown";
  const delta = Math.max(0, now - at);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One argument of a command the user copies and pastes into a shell. A
 * branch name may hold `$`, `;`, `&` or a backtick, so anything beyond plain
 * ref characters is single-quoted: literal in sh, zsh, fish and PowerShell.
 */
export function shellArg(text: string): string {
  if (/^[A-Za-z0-9._/@:+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The command that lists a kept branch's commits the base lacks. */
export function keptBranchLogCommand(kept: { repoRoot: string; branch: string; target: string | null }): string {
  const range = kept.target ? `${kept.target}..${kept.branch}` : kept.branch;
  // The folder stays double-quoted: it reads the same in cmd, PowerShell and sh.
  return `git -C "${kept.repoRoot}" log --oneline ${shellArg(range)} --`;
}
