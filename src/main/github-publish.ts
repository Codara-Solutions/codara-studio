import {
  GITHUB_PUBLISH_MAX_BODY_LENGTH,
  GITHUB_PUBLISH_MAX_COMMIT_MESSAGE_LENGTH,
  GITHUB_PUBLISH_MAX_TITLE_LENGTH,
} from "@shared/github";
import type {
  GitHubPublishFailureCode,
  GitHubPublishInput,
  GitHubPublishPhase,
  GitHubPublishPhaseReceipt,
  GitHubPublishResult,
  GitHubPullRequestSummary,
  GitHubRepositoryIdentity,
} from "@shared/github";
import type { GitOpResult, GitStatus } from "@shared/types";
import {
  createGitHubCliAdapter,
  sanitizeGitHubFailure,
  type GitHubCliAdapter,
} from "./github-cli";
import {
  commitChanges,
  computeGitStatus,
  fetchRemote,
  push,
  stageAll,
} from "./git-ops";
import { runGit } from "./git-exec";

const MAX_CWD_LENGTH = 16_384;
const MAX_RECEIPT_MESSAGE_LENGTH = 1_000;

export interface GitHubPublishDependencies {
  github?: GitHubCliAdapter;
  getStatus?: (cwd: string) => Promise<GitStatus>;
  fetch?: (cwd: string) => Promise<GitOpResult>;
  stageAll?: (cwd: string) => Promise<GitOpResult>;
  commit?: (cwd: string, message: string) => Promise<GitOpResult>;
  push?: (cwd: string) => Promise<GitOpResult>;
  readHead?: (cwd: string) => Promise<string>;
  countCommitsAheadOfBase?: (cwd: string, base: string) => Promise<number>;
}

interface PublishState {
  receipts: GitHubPublishPhaseReceipt[];
  branch?: string;
  base?: string;
  committed: boolean;
  commitHash?: string;
  pushed: boolean;
}

/**
 * Turns the active local topic branch into a pull request.
 *
 * The existing-PR read intentionally happens before fetch/stage/commit/push.
 * That makes retries idempotent and ensures an already-published branch never
 * causes a surprise commit or push.
 */
export async function publishGitHubWorktree(
  cwd: string,
  rawInput: unknown,
  dependencies: GitHubPublishDependencies = {},
): Promise<GitHubPublishResult> {
  const state: PublishState = {
    receipts: [],
    committed: false,
    pushed: false,
  };

  let input: GitHubPublishInput;
  try {
    assertCwd(cwd);
    input = parsePublishInput(rawInput);
    addReceipt(state, "validate", "completed", "Publish request validated.");
  } catch (cause) {
    return fail(
      state,
      "validate",
      "invalid-input",
      safeFailure(cause, "The publish request is invalid."),
    );
  }

  const github = dependencies.github ?? createGitHubCliAdapter();
  const getStatus = dependencies.getStatus ?? computeGitStatus;
  const doFetch = dependencies.fetch ?? fetchRemote;
  const doStageAll = dependencies.stageAll ?? stageAll;
  const doCommit = dependencies.commit ?? commitChanges;
  const doPush = dependencies.push ?? push;
  const readHead =
    dependencies.readHead ??
    (async (directory: string) => (await runGit(directory, ["rev-parse", "HEAD"])).stdout.trim());
  const countCommitsAheadOfBase =
    dependencies.countCommitsAheadOfBase ??
    (async (directory: string, base: string) => {
      const stdout = (
        await runGit(directory, ["rev-list", "--count", `${base}..HEAD`])
      ).stdout.trim();
      if (!/^\d+$/.test(stdout)) {
        throw new Error("Git returned an invalid commit count.");
      }
      return Number(stdout);
    });

  let repository: GitHubRepositoryIdentity;
  let initialStatus: GitStatus;
  try {
    initialStatus = await getStatus(cwd);
    if (!initialStatus.isRepo) {
      return fail(
        state,
        "inspect",
        "not-repository",
        "This workspace is not a Git repository.",
      );
    }
    if (initialStatus.error) {
      return fail(
        state,
        "inspect",
        "not-repository",
        safeFailure(initialStatus.error, "Git status could not be read."),
      );
    }
    repository = await github.resolveRepository(cwd);
    state.branch = initialStatus.branch;
    state.base = repository.defaultBranch;
    if (!state.base) {
      return fail(
        state,
        "inspect",
        "github-unavailable",
        "GitHub did not report a default branch for this repository.",
      );
    }
    addReceipt(
      state,
      "inspect",
      "completed",
      `Topic branch ${state.branch || "(detached)"}; base ${state.base}.`,
    );
  } catch (cause) {
    return fail(
      state,
      "inspect",
      "github-unavailable",
      safeFailure(cause, "GitHub repository details could not be loaded."),
    );
  }

  let existingPullRequest: GitHubPullRequestSummary | null;
  try {
    existingPullRequest = await github.getCurrentPullRequest(cwd);
  } catch (cause) {
    return fail(
      state,
      "reconcile",
      "github-unavailable",
      safeFailure(cause, "The existing pull request could not be checked."),
    );
  }
  if (existingPullRequest?.state === "OPEN") {
    state.branch = existingPullRequest.headBranch;
    state.base = existingPullRequest.baseBranch;
    addReceipt(
      state,
      "reconcile",
      "completed",
      `Open pull request #${existingPullRequest.number} already exists.`,
    );
    return succeed(state, "existing", existingPullRequest);
  }
  addReceipt(state, "reconcile", "completed", "No open pull request exists.");

  const initialFailure = preflightFailure(initialStatus, state.base, input);
  if (initialFailure) {
    return fail(
      state,
      "preflight",
      initialFailure.code,
      initialFailure.message,
    );
  }

  let operation = await doFetch(cwd);
  if (!operation.ok) {
    return fail(
      state,
      "sync",
      "sync-failed",
      safeFailure(operation.error, "The remote branch could not be refreshed."),
    );
  }
  addReceipt(state, "sync", "completed", "Remote refs refreshed.");

  let freshStatus: GitStatus;
  try {
    freshStatus = await getStatus(cwd);
  } catch (cause) {
    return fail(
      state,
      "preflight",
      "workspace-changed",
      safeFailure(cause, "The workspace could not be rechecked after fetching."),
    );
  }
  if (freshStatus.branch !== state.branch) {
    return fail(
      state,
      "preflight",
      "workspace-changed",
      "The active branch changed while publish was preparing. Nothing was committed.",
    );
  }
  const freshFailure = preflightFailure(freshStatus, state.base, input);
  if (freshFailure) {
    return fail(
      state,
      "preflight",
      freshFailure.code,
      freshFailure.message,
    );
  }
  try {
    const commitsAheadOfBase = await countCommitsAheadOfBase(cwd, state.base);
    if (
      !Number.isSafeInteger(commitsAheadOfBase) ||
      commitsAheadOfBase < 0
    ) {
      throw new Error("Git returned an invalid commit count.");
    }
    if (commitsAheadOfBase === 0 && !hasDirtyFiles(freshStatus)) {
      return fail(
        state,
        "preflight",
        "no-changes",
        `There are no commits on ${state.branch} to publish against ${state.base}.`,
      );
    }
  } catch (cause) {
    return fail(
      state,
      "preflight",
      "workspace-changed",
      safeFailure(cause, "The topic branch could not be compared with its base."),
    );
  }
  addReceipt(state, "preflight", "completed", "Branch is safe to publish.");

  if (hasDirtyFiles(freshStatus)) {
    operation = await doStageAll(cwd);
    if (!operation.ok) {
      return fail(
        state,
        "commit",
        "stage-failed",
        safeFailure(operation.error, "Working-tree changes could not be staged."),
      );
    }
    operation = await doCommit(cwd, input.commitMessage!);
    if (!operation.ok) {
      return fail(
        state,
        "commit",
        "commit-failed",
        safeFailure(operation.error, "Staged changes could not be committed."),
      );
    }
    state.committed = true;
    try {
      const commitHash = (await readHead(cwd)).trim();
      if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
        throw new Error("Git returned an invalid commit hash.");
      }
      state.commitHash = commitHash;
    } catch (cause) {
      return fail(
        state,
        "commit",
        "commit-failed",
        safeFailure(cause, "The new commit could not be verified."),
      );
    }
    addReceipt(
      state,
      "commit",
      "completed",
      `Created commit ${state.commitHash.slice(0, 12)}.`,
    );
  } else {
    addReceipt(state, "commit", "skipped", "The working tree is already clean.");
  }

  // Protect against a concurrent checkout between commit and push. We do not
  // reset or otherwise rewrite the user's worktree when this guard trips.
  let beforePushStatus: GitStatus;
  try {
    beforePushStatus = await getStatus(cwd);
  } catch (cause) {
    return fail(
      state,
      "push",
      "workspace-changed",
      safeFailure(cause, "The branch could not be verified before pushing."),
    );
  }
  if (
    beforePushStatus.detached ||
    beforePushStatus.branch !== state.branch ||
    beforePushStatus.hasConflicts ||
    beforePushStatus.behind > 0
  ) {
    return fail(
      state,
      "push",
      "workspace-changed",
      "The branch changed while publish was running. The local worktree was left intact.",
    );
  }

  operation = await doPush(cwd);
  if (!operation.ok) {
    return fail(
      state,
      "push",
      "push-failed",
      safeFailure(operation.error, "The topic branch could not be pushed."),
    );
  }
  state.pushed = true;
  addReceipt(state, "push", "completed", `Pushed ${state.branch}.`);

  if (!github.createPullRequest) {
    return fail(
      state,
      "create",
      "create-failed",
      "This GitHub adapter cannot create pull requests.",
    );
  }
  try {
    await github.createPullRequest({
      cwd,
      title: input.title,
      body: input.body,
      draft: input.draft,
      baseBranch: state.base!,
      headBranch: state.branch!,
    });
    addReceipt(state, "create", "completed", "Pull request creation requested.");
  } catch (cause) {
    // `gh pr create` can succeed remotely and then lose its response. Re-read
    // before reporting failure so retrying cannot create confusing duplicates.
    const recovered = await readOpenPullRequest(github, cwd);
    if (recovered) {
      addReceipt(
        state,
        "create",
        "completed",
        `Pull request #${recovered.number} already exists after the create attempt.`,
      );
      addReceipt(state, "verify", "completed", "Pull request verified on GitHub.");
      return succeed(state, "existing", recovered);
    }
    return fail(
      state,
      "create",
      "create-failed",
      safeFailure(cause, "GitHub could not create the pull request."),
    );
  }

  const createdPullRequest = await readOpenPullRequest(github, cwd);
  if (!createdPullRequest) {
    return fail(
      state,
      "verify",
      "verify-failed",
      "GitHub did not return the newly created pull request.",
    );
  }
  addReceipt(
    state,
    "verify",
    "completed",
    `Pull request #${createdPullRequest.number} verified on GitHub.`,
  );
  return succeed(state, "created", createdPullRequest);
}

// Remote Access and Electron IPC share the same local-workspace service.
export const publishGitHubWorkspace = publishGitHubWorktree;

export function parsePublishInput(value: unknown): GitHubPublishInput {
  if (!isRecord(value)) throw new Error("Publish input must be an object.");
  const title = boundedString(
    value.title,
    "Pull request title",
    GITHUB_PUBLISH_MAX_TITLE_LENGTH,
    false,
  ).trim();
  if (/[\r\n]/.test(title)) {
    throw new Error("Pull request title must be one line.");
  }
  const body = boundedString(
    value.body,
    "Pull request body",
    GITHUB_PUBLISH_MAX_BODY_LENGTH,
    true,
  );
  if (typeof value.draft !== "boolean") {
    throw new Error("Pull request draft mode must be true or false.");
  }
  const commitMessage =
    value.commitMessage === undefined
      ? undefined
      : boundedString(
          value.commitMessage,
          "Commit message",
          GITHUB_PUBLISH_MAX_COMMIT_MESSAGE_LENGTH,
          false,
        ).trim();
  return {
    title,
    body,
    draft: value.draft,
    ...(commitMessage === undefined ? {} : { commitMessage }),
  };
}

function preflightFailure(
  status: GitStatus,
  base: string | undefined,
  input: GitHubPublishInput,
): { code: GitHubPublishFailureCode; message: string } | null {
  if (!status.isRepo || status.error) {
    return { code: "not-repository", message: "Git status could not be read." };
  }
  if (status.detached || !status.branch) {
    return {
      code: "detached-head",
      message: "Check out a topic branch before publishing.",
    };
  }
  if (status.branch === base) {
    return {
      code: "default-branch",
      message: `Create a topic branch instead of publishing ${base}.`,
    };
  }
  if (status.hasConflicts) {
    return {
      code: "conflicts",
      message: "Resolve all merge conflicts before publishing.",
    };
  }
  if (status.behind > 0) {
    return {
      code: "behind",
      message: "Update the topic branch from its upstream before publishing.",
    };
  }
  if (hasDirtyFiles(status) && !input.commitMessage) {
    return {
      code: "commit-message-required",
      message: "A commit message is required to include working-tree changes.",
    };
  }
  return null;
}

async function readOpenPullRequest(
  github: GitHubCliAdapter,
  cwd: string,
): Promise<GitHubPullRequestSummary | null> {
  try {
    const pullRequest = await github.getCurrentPullRequest(cwd);
    return pullRequest?.state === "OPEN" ? pullRequest : null;
  } catch {
    return null;
  }
}

function hasDirtyFiles(status: GitStatus): boolean {
  return status.staged.length > 0 || status.unstaged.length > 0;
}

function succeed(
  state: PublishState,
  outcome: "created" | "existing",
  pullRequest: GitHubPullRequestSummary,
): GitHubPublishResult {
  return {
    ok: true,
    receipts: state.receipts,
    branch: state.branch!,
    base: state.base!,
    committed: state.committed,
    ...(state.commitHash ? { commitHash: state.commitHash } : {}),
    pushed: state.pushed,
    outcome,
    pullRequest,
  };
}

function fail(
  state: PublishState,
  phase: GitHubPublishPhase,
  code: GitHubPublishFailureCode,
  message: string,
): GitHubPublishResult {
  const safeMessage = boundedMessage(message);
  addReceipt(state, phase, "failed", safeMessage);
  return {
    ok: false,
    receipts: state.receipts,
    phase,
    code,
    message: safeMessage,
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.base ? { base: state.base } : {}),
    committed: state.committed,
    ...(state.commitHash ? { commitHash: state.commitHash } : {}),
    pushed: state.pushed,
  };
}

function addReceipt(
  state: PublishState,
  phase: GitHubPublishPhase,
  status: GitHubPublishPhaseReceipt["status"],
  message: string,
): void {
  state.receipts.push({ phase, status, message: boundedMessage(message) });
}

function safeFailure(cause: unknown, fallback: string): string {
  const candidate =
    typeof cause === "string" ? { message: cause } : cause;
  return sanitizeGitHubFailure(candidate, fallback);
}

function boundedMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_RECEIPT_MESSAGE_LENGTH);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    value.includes("\0") ||
    (!allowEmpty && !value.trim())
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertCwd(cwd: string): void {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > MAX_CWD_LENGTH) {
    throw new Error("A valid local workspace is required.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
