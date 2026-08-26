// Bounded GitHub projections shared by main, preload, and renderer. These
// intentionally exclude credentials, raw `gh` output, PR bodies, reviews, and
// comments; the source-control panel only needs enough data to orient the user.

export interface GitHubRepositoryIdentity {
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  hostname: string;
  defaultBranch?: string;
}

export type GitHubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface GitHubCheckSummary {
  total: number;
  successful: number;
  failed: number;
  pending: number;
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  /** False only when GitHub confirms the head branch belongs to this repository. */
  isCrossRepository?: boolean;
  updatedAt?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
  /** Current head commit from GitHub. Used as the optimistic merge guard. */
  headCommitOid?: string;
  checks: GitHubCheckSummary;
}

export interface GitHubPullRequestFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A bounded, read-only projection loaded only after somebody selects a PR.
 * Keeping this out of the queue makes the overview fast while still giving
 * the review surface enough context to make a merge decision.
 */
export interface GitHubPullRequestDetails {
  pullRequest: GitHubPullRequestSummary;
  author?: string;
  body: string;
  bodyTruncated: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  files: GitHubPullRequestFileSummary[];
  filesTruncated: boolean;
}

/**
 * Authoritative, checkout-safe projection for importing one exact PR revision.
 * This intentionally excludes bodies, comments, reviews, files, and raw GitHub
 * identifiers; the import transaction needs only pinned repository/ref/OID
 * identity.
 */
export interface GitHubPullRequestCheckoutMetadata {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  baseCommitOid: string;
  headBranch: string;
  headCommitOid: string;
  headRepository: string;
  headRepositoryUrl: string;
  isCrossRepository: boolean;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt?: string;
}

export interface GitHubWorkQueueLink {
  workspaceId: string;
  workspaceName: string;
  branch: string;
  matchCount: number;
  origin?:
    | {
        kind?: "github-issue";
        repository: string;
        issueNumber: number;
      }
    | {
        kind: "github-pull-request";
        repository: string;
        pullRequestNumber: number;
        importedHeadCommitOid: string;
      };
  run?: {
    runId: string;
    title: string;
    status: import("./types").RunStatus;
    updatedAt: string;
  };
}

export type GitHubWorkQueueItem =
  | {
      kind: "issue";
      key: string;
      repository: string;
      repositoryUrl: string;
      sourceWorkspaceId: string;
      issue: GitHubIssueSummary;
      link?: GitHubWorkQueueLink;
    }
  | {
      kind: "pull-request";
      key: string;
      repository: string;
      repositoryUrl: string;
      sourceWorkspaceId: string;
      pullRequest: GitHubPullRequestSummary;
      link?: GitHubWorkQueueLink;
    };

export interface GitHubWorkQueueError {
  stage: "resolve-repository" | "list-issues" | "list-pull-requests";
  sourceWorkspaceId: string;
  repository?: string;
  code:
    | "not-installed"
    | "not-authenticated"
    | "not-repository"
    | "command-failed"
    | "invalid-response";
  message: string;
}

export interface GitHubWorkQueueTruncation {
  sourceRootsOmitted: number;
  repositoriesOmitted: number;
  workspaceJoinsOmitted: number;
  errorsOmitted: number;
  itemsOmitted: number;
  payloadBytes: boolean;
}

export type GitHubWorkQueueStatus =
  | {
      kind: "not-installed" | "not-authenticated" | "error";
      message: string;
    }
  | {
      kind: "ready";
      refreshedAt: string;
      repositoriesScanned: number;
      items: GitHubWorkQueueItem[];
      errors: GitHubWorkQueueError[];
      truncated: GitHubWorkQueueTruncation;
    };

export const GITHUB_ISSUE_MAX_NUMBER = 2_147_483_647;

export interface StartGitHubIssueInput {
  sourceWorkspaceId: string;
  issueNumber: number;
}

export type StartGitHubIssuePhase =
  | "validate"
  | "inspect"
  | "provision"
  | "persist"
  | "start"
  | "activate";

export type StartGitHubIssueResult =
  | {
      ok: true;
      outcome: "created" | "resumed";
      workspaceId: string;
      runId: string;
      branch: string;
      activated: boolean;
    }
  | {
      ok: false;
      phase: StartGitHubIssuePhase;
      code: string;
      message: string;
      workspaceId?: string;
      runId?: string;
      branch?: string;
      /** True when a durable workspace/run remains available for recovery. */
      retained: boolean;
    };

export interface StartGitHubPullRequestInput {
  sourceWorkspaceId: string;
  /** Canonical base-repository URL emitted by the main-owned queue. */
  repositoryUrl: string;
  pullRequestNumber: number;
  /** Exact queue revision; main refuses if GitHub has moved the PR head. */
  expectedHeadCommitOid: string;
}

export type StartGitHubPullRequestPhase =
  | "validate"
  | "inspect"
  | "provision"
  | "persist"
  | "start"
  | "activate";

export type StartGitHubPullRequestResult =
  | {
      ok: true;
      outcome: "created" | "resumed";
      workspaceId: string;
      runId: string;
      branch: string;
      activated: boolean;
    }
  | {
      ok: false;
      phase: StartGitHubPullRequestPhase;
      code: string;
      message: string;
      workspaceId?: string;
      runId?: string;
      branch?: string;
      /** True when a durable workspace/run remains available for recovery. */
      retained: boolean;
    };

export const GITHUB_PUBLISH_MAX_TITLE_LENGTH = 256;
export const GITHUB_PUBLISH_MAX_BODY_LENGTH = 128 * 1024;
export const GITHUB_PUBLISH_MAX_COMMIT_MESSAGE_LENGTH = 16 * 1024;

/**
 * Explicit user intent for turning the active local worktree into a GitHub PR.
 *
 * `commitMessage` is also the authorization boundary for dirty files: when it
 * is absent, publish may push existing commits but must never stage or commit
 * working-tree changes.
 */
export interface GitHubPublishInput {
  title: string;
  body: string;
  draft: boolean;
  commitMessage?: string;
}

export type GitHubPublishPhase =
  | "validate"
  | "inspect"
  | "reconcile"
  | "sync"
  | "preflight"
  | "commit"
  | "push"
  | "create"
  | "verify";

export type GitHubPublishPhaseStatus = "completed" | "skipped" | "failed";

export interface GitHubPublishPhaseReceipt {
  phase: GitHubPublishPhase;
  status: GitHubPublishPhaseStatus;
  /** Bounded, credential-free text suitable for renderer presentation. */
  message: string;
}

export type GitHubPublishFailureCode =
  | "invalid-input"
  | "not-repository"
  | "github-unavailable"
  | "detached-head"
  | "default-branch"
  | "conflicts"
  | "behind"
  | "no-changes"
  | "workspace-changed"
  | "commit-message-required"
  | "sync-failed"
  | "stage-failed"
  | "commit-failed"
  | "push-failed"
  | "create-failed"
  | "verify-failed";

export type GitHubPublishResult =
  | {
      ok: true;
      receipts: GitHubPublishPhaseReceipt[];
      branch: string;
      base: string;
      committed: boolean;
      commitHash?: string;
      pushed: boolean;
      outcome: "created" | "existing";
      pullRequest: GitHubPullRequestSummary;
    }
  | {
      ok: false;
      receipts: GitHubPublishPhaseReceipt[];
      phase: GitHubPublishPhase;
      code: GitHubPublishFailureCode;
      message: string;
      branch?: string;
      base?: string;
      committed: boolean;
      commitHash?: string;
      pushed: boolean;
    };

export type GitHubMergeStrategy = "squash" | "merge" | "rebase";

/**
 * Marks one exact draft pull request ready for review. The base/head identity
 * and head commit are re-read immediately before the mutation so a stale
 * surface cannot mark newer or retargeted work ready.
 */
export interface GitHubMarkReadyInput {
  repository: string;
  pullRequestNumber: number;
  baseBranch: string;
  headBranch: string;
  expectedHeadCommitOid: string;
}

export type GitHubMarkReadyPhase =
  | "validate"
  | "inspect"
  | "preflight"
  | "ready"
  | "verify";

export type GitHubMarkReadyFailureCode =
  | "invalid-input"
  | "github-unavailable"
  | "repository-changed"
  | "pull-request-changed"
  | "closed"
  | "ready-failed"
  | "verify-failed";

export interface GitHubMarkReadyReceipt {
  phase: GitHubMarkReadyPhase;
  status: GitHubPublishPhaseStatus;
  /** Bounded, credential-free text suitable for desktop and phone UI. */
  message: string;
}

export type GitHubMarkReadyResult =
  | {
      ok: true;
      outcome: "ready" | "already-ready";
      pullRequest: GitHubPullRequestSummary;
      receipts: GitHubMarkReadyReceipt[];
    }
  | {
      ok: false;
      phase: GitHubMarkReadyPhase;
      code: GitHubMarkReadyFailureCode;
      message: string;
      receipts: GitHubMarkReadyReceipt[];
      pullRequest?: GitHubPullRequestSummary;
    };

/**
 * A merge intent is pinned to the exact repository, PR, base branch, head
 * branch, and head commit the user reviewed. Main re-reads all five from
 * GitHub immediately before mutating, so a stale screen can never merge newer,
 * unseen work or silently target a different destination branch.
 */
export interface GitHubMergeInput {
  repository: string;
  pullRequestNumber: number;
  baseBranch: string;
  headBranch: string;
  expectedHeadCommitOid: string;
  strategy: GitHubMergeStrategy;
}

export type GitHubMergePhase =
  | "validate"
  | "inspect"
  | "preflight"
  | "merge"
  | "verify";

export type GitHubMergeFailureCode =
  | "invalid-input"
  | "github-unavailable"
  | "repository-changed"
  | "pull-request-changed"
  | "draft"
  | "closed"
  | "checks-pending"
  | "checks-failed"
  | "changes-requested"
  | "review-required"
  | "not-mergeable"
  | "merge-failed"
  | "verify-failed";

export interface GitHubMergeReceipt {
  phase: GitHubMergePhase;
  status: GitHubPublishPhaseStatus;
  /** Bounded, credential-free text suitable for desktop and phone UI. */
  message: string;
}

export type GitHubMergeResult =
  | {
      ok: true;
      outcome: "merged" | "already-merged";
      strategy: GitHubMergeStrategy;
      pullRequest: GitHubPullRequestSummary;
      receipts: GitHubMergeReceipt[];
    }
  | {
      ok: false;
      phase: GitHubMergePhase;
      code: GitHubMergeFailureCode;
      message: string;
      receipts: GitHubMergeReceipt[];
      pullRequest?: GitHubPullRequestSummary;
    };

const GITHUB_ISSUE_BRANCH_SLUG_LENGTH = 48;

/**
 * Picks a readable, collision-free local branch name for a GitHub issue.
 *
 * `existingBranches` may contain both local names (`codara/issue-42-fix`) and
 * remote-tracking names (`origin/codara/issue-42-fix`). Treating either shape
 * as occupied avoids creating a confusing local namesake for a branch that
 * already exists on a remote. The caller supplies one fresh branch snapshot;
 * git remains the final atomic guard if another process creates the same ref
 * after that snapshot.
 */
export function selectGitHubIssueBranchName(
  issue: Pick<GitHubIssueSummary, "number" | "title">,
  existingBranches: readonly string[],
): string {
  const issueNumber = Math.max(0, Math.trunc(issue.number));
  const slug =
    issue.title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, GITHUB_ISSUE_BRANCH_SLUG_LENGTH)
      .replace(/-+$/g, "") || "work";
  const base = `codara/issue-${issueNumber}-${slug}`;
  const names = existingBranches.map((name) => name.trim()).filter(Boolean);
  const isTaken = (candidate: string): boolean =>
    names.some((name) => name === candidate || name.endsWith(`/${candidate}`));

  if (!isTaken(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}

export type GitHubWorkspaceStatus =
  | {
      kind:
        | "not-installed"
        /** Installed and authenticated, but too old for a field Codara reads. */
        | "outdated-cli"
        | "not-authenticated"
        | "not-repository"
        | "unavailable"
        | "error";
      message: string;
    }
  | {
      kind: "ready";
      repository: GitHubRepositoryIdentity;
      pullRequest: GitHubPullRequestSummary | null;
      /** Small, title-only issue projection for starting a Cora task. */
      issues: GitHubIssueSummary[];
      /** Safe diagnostic when issue listing failed but PR status still loaded. */
      issuesError?: string;
    };

export interface GitHubCreatePullRequestTarget {
  repositoryUrl: string;
  defaultBranch?: string;
  currentBranch?: string;
  detached: boolean;
}

const MAX_BRANCH_LENGTH = 1_024;
const MAX_REPOSITORY_URL_LENGTH = 4_096;

/**
 * Builds a GitHub compare-page URL without creating anything. A target is only
 * returned for a normal topic branch in a validated HTTP(S) repository. The
 * user still reviews and submits the PR on GitHub.
 */
export function buildGitHubCreatePullRequestUrl(
  target: GitHubCreatePullRequestTarget,
): string | null {
  if (target.detached) return null;
  const base = validBranch(target.defaultBranch);
  const head = validBranch(target.currentBranch);
  if (!base || !head || base === head) return null;
  if (
    typeof target.repositoryUrl !== "string" ||
    target.repositoryUrl.length === 0 ||
    target.repositoryUrl.length > MAX_REPOSITORY_URL_LENGTH
  ) {
    return null;
  }

  let repository: URL;
  try {
    repository = new URL(target.repositoryUrl);
  } catch {
    return null;
  }
  if (
    (repository.protocol !== "https:" && repository.protocol !== "http:") ||
    !repository.hostname ||
    repository.username ||
    repository.password
  ) {
    return null;
  }

  const repoPath = repository.pathname.replace(/\/+$/, "");
  if (!repoPath || repoPath === "/") return null;
  repository.pathname = `${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  repository.search = "expand=1";
  repository.hash = "";
  return repository.toString();
}

function validBranch(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch || branch.length > MAX_BRANCH_LENGTH) return null;
  return branch;
}
