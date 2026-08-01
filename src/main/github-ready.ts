import type {
  GitHubMarkReadyFailureCode,
  GitHubMarkReadyInput,
  GitHubMarkReadyPhase,
  GitHubMarkReadyReceipt,
  GitHubMarkReadyResult,
  GitHubPullRequestSummary,
} from "@shared/github";
import {
  createGitHubCliAdapter,
  sanitizeGitHubFailure,
  type GitHubCliAdapter,
} from "./github-cli";

const MAX_CWD_LENGTH = 16_384;
const MAX_REPOSITORY_LENGTH = 240;
const MAX_BRANCH_LENGTH = 1_024;
const MAX_RECEIPT_LENGTH = 1_000;

export interface GitHubMarkReadyDependencies {
  github?: GitHubCliAdapter;
}

/**
 * Marks one exact draft pull request ready for review.
 *
 * The provider does not expose a `--match-head-commit` equivalent for
 * `gh pr ready`, so Codara fences the complete PR identity immediately before
 * the command and verifies it again afterward. A lost command response is
 * reconciled by exact PR number before it is reported as a failure.
 */
export async function markGitHubPullRequestReady(
  cwd: string,
  rawInput: unknown,
  dependencies: GitHubMarkReadyDependencies = {},
): Promise<GitHubMarkReadyResult> {
  const receipts: GitHubMarkReadyReceipt[] = [];
  const input = normalizeMarkReadyInput(rawInput);
  if (!validCwd(cwd) || !input) {
    return failure(
      receipts,
      "validate",
      "invalid-input",
      "The mark-ready request is invalid.",
    );
  }
  receipt(
    receipts,
    "validate",
    "completed",
    "Pinned the repository, pull request, base/head branches, and head commit.",
  );

  const github = dependencies.github ?? createGitHubCliAdapter();
  let pullRequest: GitHubPullRequestSummary;
  try {
    const repository = await github.resolveRepository(cwd);
    if (repository.nameWithOwner !== input.repository) {
      return failure(
        receipts,
        "inspect",
        "repository-changed",
        "This workspace now points at a different GitHub repository. Refresh before marking the pull request ready.",
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
      sanitizeGitHubFailure(
        cause,
        "GitHub could not refresh this pull request.",
      ),
    );
  }
  receipt(
    receipts,
    "inspect",
    "completed",
    `Refreshed pull request #${pullRequest.number} from GitHub.`,
  );

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
  if (pullRequest.state !== "OPEN") {
    return failure(
      receipts,
      "preflight",
      "closed",
      pullRequest.state === "MERGED"
        ? "This pull request is already merged and cannot be marked ready."
        : "This pull request is closed and cannot be marked ready.",
      pullRequest,
    );
  }
  if (!pullRequest.isDraft) {
    receipt(
      receipts,
      "preflight",
      "skipped",
      "This exact pull request is already ready for review.",
    );
    receipt(receipts, "ready", "skipped", "No second mark-ready command was sent.");
    receipt(
      receipts,
      "verify",
      "completed",
      "Confirmed the pull request is ready for review on GitHub.",
    );
    return success(receipts, "already-ready", pullRequest);
  }
  receipt(
    receipts,
    "preflight",
    "completed",
    "The exact reviewed draft is eligible to be marked ready.",
  );

  if (!github.markPullRequestReady) {
    return failure(
      receipts,
      "ready",
      "github-unavailable",
      "This Codara build cannot mark GitHub pull requests ready for review.",
      pullRequest,
    );
  }

  try {
    await github.markPullRequestReady({
      cwd,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
    });
    receipt(
      receipts,
      "ready",
      "completed",
      "GitHub accepted the mark-ready request.",
    );
  } catch (cause) {
    const reconciled = await readExactPullRequest(github, cwd, input).catch(
      () => null,
    );
    if (
      reconciled &&
      validatePinnedIdentity(reconciled, input) === null &&
      reconciled.state === "OPEN" &&
      !reconciled.isDraft
    ) {
      receipt(
        receipts,
        "ready",
        "completed",
        "The response was interrupted, but GitHub marked the pull request ready.",
      );
      receipt(
        receipts,
        "verify",
        "completed",
        "Confirmed the pull request is ready for review on GitHub.",
      );
      return success(receipts, "ready", reconciled);
    }
    const changed =
      reconciled && validatePinnedIdentity(reconciled, input) !== null;
    return failure(
      receipts,
      "ready",
      changed ? "pull-request-changed" : "ready-failed",
      changed
        ? "The pull request changed during the mark-ready attempt. Refresh and review its latest branches and head commit."
        : sanitizeGitHubFailure(
            cause,
            "GitHub did not mark this pull request ready for review.",
          ),
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
        "The mark-ready command completed, but Codara could not verify the result. Refresh GitHub before retrying.",
      ),
      pullRequest,
    );
  }
  if (
    validatePinnedIdentity(verified, input) !== null ||
    verified.state !== "OPEN" ||
    verified.isDraft
  ) {
    return failure(
      receipts,
      "verify",
      "verify-failed",
      "GitHub did not confirm that the exact reviewed pull request is ready. Refresh before retrying.",
      verified,
    );
  }
  receipt(
    receipts,
    "verify",
    "completed",
    "Confirmed the pull request is ready for review on GitHub.",
  );
  return success(receipts, "ready", verified);
}

async function readExactPullRequest(
  github: GitHubCliAdapter,
  cwd: string,
  input: GitHubMarkReadyInput,
): Promise<GitHubPullRequestSummary> {
  if (github.getPullRequest) {
    return github.getPullRequest(
      cwd,
      input.repository,
      input.pullRequestNumber,
    );
  }
  const current = await github.getCurrentPullRequest(cwd);
  if (!current || current.number !== input.pullRequestNumber) {
    throw new Error("GitHub no longer reports the expected pull request.");
  }
  return current;
}

export function normalizeMarkReadyInput(
  value: unknown,
): GitHubMarkReadyInput | null {
  if (!isPlainRecord(value)) return null;
  const expected = [
    "repository",
    "pullRequestNumber",
    "baseBranch",
    "headBranch",
    "expectedHeadCommitOid",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    return null;
  }
  const repository =
    typeof value.repository === "string" ? value.repository.trim() : "";
  const baseBranch =
    typeof value.baseBranch === "string" ? value.baseBranch.trim() : "";
  const headBranch =
    typeof value.headBranch === "string" ? value.headBranch.trim() : "";
  const expectedHeadCommitOid =
    typeof value.expectedHeadCommitOid === "string"
      ? value.expectedHeadCommitOid.trim().toLowerCase()
      : "";
  if (
    !repository ||
    repository.length > MAX_REPOSITORY_LENGTH ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    (value.pullRequestNumber as number) < 1 ||
    !validBranch(baseBranch) ||
    !validBranch(headBranch) ||
    !/^[0-9a-f]{40,64}$/.test(expectedHeadCommitOid)
  ) {
    return null;
  }
  return {
    repository,
    pullRequestNumber: value.pullRequestNumber as number,
    baseBranch,
    headBranch,
    expectedHeadCommitOid,
  };
}

function validatePinnedIdentity(
  pullRequest: GitHubPullRequestSummary,
  input: GitHubMarkReadyInput,
): string | null {
  if (
    pullRequest.number !== input.pullRequestNumber ||
    pullRequest.baseBranch !== input.baseBranch ||
    pullRequest.headBranch !== input.headBranch
  ) {
    return "The pull request base or head branch changed after you reviewed it. Refresh before marking it ready.";
  }
  if (
    !pullRequest.headCommitOid ||
    pullRequest.headCommitOid.toLowerCase() !== input.expectedHeadCommitOid
  ) {
    return "New commits arrived after you reviewed this draft. Refresh before marking the latest head ready.";
  }
  return null;
}

function success(
  receipts: GitHubMarkReadyReceipt[],
  outcome: "ready" | "already-ready",
  pullRequest: GitHubPullRequestSummary,
): GitHubMarkReadyResult {
  return { ok: true, outcome, pullRequest, receipts };
}

function receipt(
  receipts: GitHubMarkReadyReceipt[],
  phase: GitHubMarkReadyPhase,
  status: GitHubMarkReadyReceipt["status"],
  message: string,
): void {
  receipts.push({ phase, status, message: bounded(message) });
}

function failure(
  receipts: GitHubMarkReadyReceipt[],
  phase: GitHubMarkReadyPhase,
  code: GitHubMarkReadyFailureCode,
  message: string,
  pullRequest?: GitHubPullRequestSummary,
): GitHubMarkReadyResult {
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

function validBranch(branch: string): boolean {
  return (
    Boolean(branch) &&
    branch.length <= MAX_BRANCH_LENGTH &&
    !/[\0\r\n]/.test(branch)
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
