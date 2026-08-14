import type {
  GitHubMergeFailureCode,
  GitHubMergeInput,
  GitHubMergePhase,
  GitHubMergeReceipt,
  GitHubMergeResult,
  GitHubPullRequestSummary,
} from "@shared/github";
import {
  createGitHubCliAdapter,
  invalidateGitHubStatusCache,
  sanitizeGitHubFailure,
  type GitHubCliAdapter,
} from "./github-cli";

const MAX_CWD_LENGTH = 16_384;
const MAX_REPOSITORY_LENGTH = 240;
const MAX_BRANCH_LENGTH = 1_024;
const MAX_RECEIPT_LENGTH = 1_000;

export interface GitHubMergeDependencies {
  github?: GitHubCliAdapter;
  /** Injectable so a test can observe the post-write cache drop. */
  invalidateStatusCache?: (cwd: string) => void;
}

/**
 * Merge one pull request only after re-reading the exact repository, current
 * branch PR, base/head branches, checks, reviews, mergeability, and head commit
 * from GitHub.
 *
 * Nothing here deletes a branch or worktree. The CLI receives a fixed argv
 * vector and `--match-head-commit`, so a stale confirmation cannot merge newer
 * commits that arrived after the user reviewed the screen.
 */
export async function mergeGitHubPullRequest(
  cwd: string,
  rawInput: unknown,
  dependencies: GitHubMergeDependencies = {},
): Promise<GitHubMergeResult> {
  const invalidateStatus =
    dependencies.invalidateStatusCache ?? invalidateGitHubStatusCache;
  try {
    return await runMerge(cwd, rawInput, dependencies);
  } finally {
    // A merged pull request is the largest possible change to this
    // workspace's GitHub status. Dropped unconditionally because an
    // interrupted response can still have merged (see the reconcile path).
    invalidateStatus(cwd);
  }
}

async function runMerge(
  cwd: string,
  rawInput: unknown,
  dependencies: GitHubMergeDependencies,
): Promise<GitHubMergeResult> {
  const receipts: GitHubMergeReceipt[] = [];
  const input = normalizeMergeInput(rawInput);
  if (!validCwd(cwd) || !input) {
    return failure(
      receipts,
      "validate",
      "invalid-input",
      "The pull request merge request is invalid.",
    );
  }
  receipt(receipts, "validate", "completed", "Pinned the repository, pull request, base/head branches, and head commit.");

  const github = dependencies.github ?? createGitHubCliAdapter();
  let pullRequest: GitHubPullRequestSummary | undefined;
  try {
    const repository = await github.resolveRepository(cwd);
    if (repository.nameWithOwner !== input.repository) {
      return failure(
        receipts,
        "inspect",
        "repository-changed",
        "This workspace now points at a different GitHub repository. Refresh before merging.",
      );
    }

    const current = await github.getCurrentPullRequest(cwd);
    if (!current || current.number !== input.pullRequestNumber) {
      return failure(
        receipts,
        "inspect",
        "pull-request-changed",
        "The current branch is no longer attached to the pull request you reviewed.",
        current ?? undefined,
      );
    }
    pullRequest = current;
  } catch (cause) {
    return failure(
      receipts,
      "inspect",
      "github-unavailable",
      sanitizeGitHubFailure(cause, "GitHub could not refresh this pull request."),
    );
  }
  receipt(receipts, "inspect", "completed", `Refreshed pull request #${pullRequest.number} from GitHub.`);

  const identityFailure = validatePinnedIdentity(pullRequest, input);
  if (identityFailure) {
    return failure(
      receipts,
      "preflight",
      "pull-request-changed",
      identityFailure,
      pullRequest,
    );
  }

  if (pullRequest.state === "MERGED") {
    receipt(receipts, "preflight", "skipped", "GitHub already reports this exact pull request as merged.");
    receipt(receipts, "merge", "skipped", "No second merge command was sent.");
    receipt(receipts, "verify", "completed", "Confirmed the merged pull request on GitHub.");
    return {
      ok: true,
      outcome: "already-merged",
      strategy: input.strategy,
      pullRequest,
      receipts,
    };
  }

  const blocked = readinessFailure(pullRequest);
  if (blocked) {
    return failure(
      receipts,
      "preflight",
      blocked.code,
      blocked.message,
      pullRequest,
    );
  }
  receipt(
    receipts,
    "preflight",
    "completed",
    "Checks, review state, mergeability, branch, and head commit are ready.",
  );

  if (!github.mergePullRequest) {
    return failure(
      receipts,
      "merge",
      "github-unavailable",
      "This Codara build cannot merge GitHub pull requests.",
      pullRequest,
    );
  }

  try {
    await github.mergePullRequest({
      cwd,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      strategy: input.strategy,
      expectedHeadCommitOid: input.expectedHeadCommitOid,
    });
    receipt(
      receipts,
      "merge",
      "completed",
      `GitHub accepted the ${input.strategy} merge request.`,
    );
  } catch (cause) {
    // A transport failure may happen after GitHub committed the merge. Re-read
    // by exact PR number before reporting failure, which also makes a retry
    // under a fresh request id idempotent.
    const reconciled = await readExactPullRequest(github, cwd, input).catch(() => null);
    if (reconciled?.state === "MERGED" && validatePinnedIdentity(reconciled, input) === null) {
      receipt(receipts, "merge", "completed", "The response was interrupted, but GitHub completed the merge.");
      receipt(receipts, "verify", "completed", "Confirmed the merged pull request on GitHub.");
      return {
        ok: true,
        outcome: "merged",
        strategy: input.strategy,
        pullRequest: reconciled,
        receipts,
      };
    }
    return failure(
      receipts,
      "merge",
      "merge-failed",
      sanitizeGitHubFailure(cause, "GitHub did not merge this pull request."),
      reconciled ?? pullRequest,
    );
  }

  let verified: GitHubPullRequestSummary;
  try {
    verified = await readExactPullRequest(github, cwd, input);
  } catch (cause) {
    return failure(
      receipts,
      "verify",
      "verify-failed",
      sanitizeGitHubFailure(
        cause,
        "The merge command completed, but Codara could not verify the result. Refresh GitHub before retrying.",
      ),
      pullRequest,
    );
  }
  if (validatePinnedIdentity(verified, input) !== null || verified.state !== "MERGED") {
    return failure(
      receipts,
      "verify",
      "verify-failed",
      "GitHub did not confirm that the exact reviewed pull request was merged. Refresh before retrying.",
      verified,
    );
  }
  receipt(receipts, "verify", "completed", "Confirmed the merged pull request on GitHub.");
  return {
    ok: true,
    outcome: "merged",
    strategy: input.strategy,
    pullRequest: verified,
    receipts,
  };
}

async function readExactPullRequest(
  github: GitHubCliAdapter,
  cwd: string,
  input: GitHubMergeInput,
): Promise<GitHubPullRequestSummary> {
  if (github.getPullRequest) {
    return github.getPullRequest(cwd, input.repository, input.pullRequestNumber);
  }
  const current = await github.getCurrentPullRequest(cwd);
  if (!current || current.number !== input.pullRequestNumber) {
    throw new Error("GitHub no longer reports the expected pull request.");
  }
  return current;
}

function normalizeMergeInput(value: unknown): GitHubMergeInput | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  const expected = [
    "repository",
    "pullRequestNumber",
    "baseBranch",
    "headBranch",
    "expectedHeadCommitOid",
    "strategy",
  ];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    return null;
  }
  const repository = typeof value.repository === "string" ? value.repository.trim() : "";
  const baseBranch = typeof value.baseBranch === "string" ? value.baseBranch.trim() : "";
  const headBranch = typeof value.headBranch === "string" ? value.headBranch.trim() : "";
  const expectedHeadCommitOid =
    typeof value.expectedHeadCommitOid === "string"
      ? value.expectedHeadCommitOid.trim().toLowerCase()
      : "";
  const strategy = value.strategy;
  if (
    !repository ||
    repository.length > MAX_REPOSITORY_LENGTH ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    (value.pullRequestNumber as number) < 1 ||
    !baseBranch ||
    baseBranch.length > MAX_BRANCH_LENGTH ||
    /[\0\r\n]/.test(baseBranch) ||
    !headBranch ||
    headBranch.length > MAX_BRANCH_LENGTH ||
    /[\0\r\n]/.test(headBranch) ||
    !/^[0-9a-f]{40,64}$/.test(expectedHeadCommitOid) ||
    (strategy !== "squash" && strategy !== "merge" && strategy !== "rebase")
  ) {
    return null;
  }
  return {
    repository,
    pullRequestNumber: value.pullRequestNumber as number,
    baseBranch,
    headBranch,
    expectedHeadCommitOid,
    strategy,
  };
}

function validatePinnedIdentity(
  pullRequest: GitHubPullRequestSummary,
  input: GitHubMergeInput,
): string | null {
  if (
    pullRequest.number !== input.pullRequestNumber ||
    pullRequest.baseBranch !== input.baseBranch ||
    pullRequest.headBranch !== input.headBranch
  ) {
    return "The pull request base or head branch changed after you opened the merge confirmation. Refresh and review it again.";
  }
  if (
    !pullRequest.headCommitOid ||
    pullRequest.headCommitOid.toLowerCase() !== input.expectedHeadCommitOid
  ) {
    return "New commits arrived after you opened the merge confirmation. Refresh and review the latest head before merging.";
  }
  return null;
}

function readinessFailure(
  pullRequest: GitHubPullRequestSummary,
): { code: GitHubMergeFailureCode; message: string } | null {
  if (pullRequest.state === "CLOSED") {
    return { code: "closed", message: "This pull request is closed and cannot be merged." };
  }
  if (pullRequest.state !== "OPEN") {
    return { code: "not-mergeable", message: "This pull request is not open for merging." };
  }
  if (pullRequest.isDraft) {
    return { code: "draft", message: "Mark this pull request ready for review before merging." };
  }
  if (pullRequest.checks.failed > 0) {
    return {
      code: "checks-failed",
      message: `${pullRequest.checks.failed} GitHub check${pullRequest.checks.failed === 1 ? "" : "s"} failed. Fix or explicitly resolve them on GitHub before merging.`,
    };
  }
  if (pullRequest.checks.pending > 0) {
    return {
      code: "checks-pending",
      message: `${pullRequest.checks.pending} GitHub check${pullRequest.checks.pending === 1 ? " is" : "s are"} still pending.`,
    };
  }
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
    return {
      code: "changes-requested",
      message: "A reviewer requested changes. Resolve that review on GitHub before merging.",
    };
  }
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") {
    return {
      code: "review-required",
      message: "This pull request still requires an approving review.",
    };
  }
  if (
    pullRequest.mergeStateStatus !== "CLEAN" &&
    pullRequest.mergeStateStatus !== "HAS_HOOKS"
  ) {
    return {
      code: "not-mergeable",
      message: pullRequest.mergeStateStatus
        ? `GitHub reports merge state ${pullRequest.mergeStateStatus}. Resolve it before merging.`
        : "GitHub has not confirmed that this pull request is mergeable yet. Refresh shortly.",
    };
  }
  return null;
}

function receipt(
  receipts: GitHubMergeReceipt[],
  phase: GitHubMergePhase,
  status: GitHubMergeReceipt["status"],
  message: string,
): void {
  receipts.push({ phase, status, message: bounded(message) });
}

function failure(
  receipts: GitHubMergeReceipt[],
  phase: GitHubMergePhase,
  code: GitHubMergeFailureCode,
  message: string,
  pullRequest?: GitHubPullRequestSummary,
): GitHubMergeResult {
  receipt(receipts, phase, "failed", message);
  return {
    ok: false,
    phase,
    code,
    message: bounded(message),
    receipts,
    ...(pullRequest ? { pullRequest } : {}),
  };
}

function validCwd(cwd: unknown): cwd is string {
  return (
    typeof cwd === "string" &&
    Boolean(cwd.trim()) &&
    cwd.length <= MAX_CWD_LENGTH &&
    !cwd.includes("\0")
  );
}

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_RECEIPT_LENGTH);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
