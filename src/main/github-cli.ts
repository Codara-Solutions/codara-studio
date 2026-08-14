import { execFile } from "node:child_process";
import {
  GITHUB_PUBLISH_MAX_BODY_LENGTH,
  GITHUB_PUBLISH_MAX_TITLE_LENGTH,
} from "@shared/github";
import type {
  GitHubCheckSummary,
  GitHubIssueSummary,
  GitHubMergeStrategy,
  GitHubPullRequestCheckoutMetadata,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubRepositoryIdentity,
  GitHubWorkspaceStatus,
} from "@shared/github";
import { resolveBinary } from "./binary-resolver";

export type {
  GitHubCheckSummary,
  GitHubIssueSummary,
  GitHubPullRequestCheckoutMetadata,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubRepositoryIdentity,
  GitHubWorkspaceStatus,
} from "@shared/github";

// Host-side GitHub CLI adapter. Authentication remains entirely owned by `gh`
// on the computer: callers receive small validated projections, never tokens
// or raw auth configuration. The command runner and binary resolver are
// injectable so every argument, timeout and response boundary can be tested
// without requiring a GitHub account.

export const GITHUB_CLI_AUTH_TIMEOUT_MS = 8_000;
export const GITHUB_CLI_READ_TIMEOUT_MS = 20_000;
export const GITHUB_CLI_WRITE_TIMEOUT_MS = 90_000;
export const GITHUB_CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

// How long an authenticated `gh auth status` answer is trusted. Every workspace
// status and work-queue read opens with one, and it is a network round trip on
// top of the subprocess, so re-asking per read dominated the panel's latency.
export const GITHUB_CLI_DIAGNOSTIC_TTL_MS = 300_000;
// A missing or disconnected CLI expires far sooner: the fix is `gh auth login`
// in a terminal Codara never observes, so the only way the panel can notice is
// to re-ask. One refresh of patience, not five minutes of it.
export const GITHUB_CLI_DIAGNOSTIC_FAILURE_TTL_MS = 10_000;
// One workspace-status read is four `gh` subprocesses. The renderer already
// spaces its own background reads out; this bound exists to absorb bursts —
// desktop and phone landing together, a remount, focus and the fallback timer
// firing on the same alt-tab.
export const GITHUB_STATUS_CACHE_TTL_MS = 20_000;

const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_CWD_LENGTH = 16_384;
const MAX_REPOSITORY_NAME = 240;
const MAX_URL = 4_096;
const MAX_BRANCH_NAME = 1_024;
const MAX_PR_TITLE = 512;
const MAX_STATUS_NAME = 120;
const MAX_ISSUE_LABEL = 120;
const UNSAFE_GITHUB_TEXT =
  /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
export const GITHUB_ISSUE_LIST_LIMIT = 12;
export const GITHUB_PULL_REQUEST_LIST_LIMIT = 12;
/** Minimum `gh` release that accepts `baseRefOid` in `gh pr view --json`. */
export const GITHUB_CLI_MIN_IMPORT_VERSION = "2.63";

// Exactly the fields `parsePullRequestSummaryRecord` reads. `baseRefOid`,
// `headRepository` and `headRepositoryOwner` are deliberately absent: only pull
// request import consumes them, and `gh` rejected `baseRefOid` before 2.63.
// `gh` validates `--json` field names before it looks for a pull request, so
// asking for a field this projection discards would fail status reads on every
// branch — even branches with no pull request — on an older CLI.
const PULL_REQUEST_SUMMARY_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "isCrossRepository",
  "updatedAt",
  "reviewDecision",
  "mergeStateStatus",
  "headRefOid",
  "statusCheckRollup",
].join(",");

// Import pins the exact base and head commits plus the head repository
// identity, so it keeps the wider set and with it the gh 2.63 floor.
const PULL_REQUEST_CHECKOUT_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRepository",
  "headRepositoryOwner",
  "isCrossRepository",
  "updatedAt",
  "reviewDecision",
  "mergeStateStatus",
  "headRefOid",
  "statusCheckRollup",
].join(",");

export type GitHubCliErrorCode =
  | "not-installed"
  | "not-authenticated"
  | "command-failed"
  | "invalid-response";

export class GitHubCliError extends Error {
  readonly code: GitHubCliErrorCode;

  constructor(code: GitHubCliErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubCliError";
    this.code = code;
  }
}

export interface GitHubCliCommand {
  executablePath: string;
  args: readonly string[];
  cwd?: string;
  /** Optional bounded standard input. Used for PR bodies so text never enters argv. */
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GitHubCliCommandResult {
  stdout: string;
  stderr: string;
}

export type GitHubCliCommandRunner = (
  command: GitHubCliCommand,
) => Promise<GitHubCliCommandResult>;

export interface GitHubCliAdapterDependencies {
  resolveBinary?: (name: string) => Promise<string | null>;
  runCommand?: GitHubCliCommandRunner;
}

export interface GitHubCliDiagnostic {
  installed: boolean;
  authenticated: boolean;
  executablePath?: string;
  hint?: string;
}

export interface GitHubCliAdapter {
  diagnose(): Promise<GitHubCliDiagnostic>;
  resolveRepository(cwd: string): Promise<GitHubRepositoryIdentity>;
  getCurrentPullRequest(
    cwd: string,
    repository?: GitHubRepositoryIdentity,
  ): Promise<GitHubPullRequestSummary | null>;
  getPullRequest?(
    cwd: string,
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestSummary>;
  getPullRequestForCheckout?(
    cwd: string,
    repository: GitHubRepositoryIdentity,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestCheckoutMetadata>;
  getIssue(
    cwd: string,
    issueNumber: number,
    repository?: GitHubRepositoryIdentity,
  ): Promise<GitHubIssueSummary>;
  listOpenIssues?(
    cwd: string,
    repository?: GitHubRepositoryIdentity,
  ): Promise<GitHubIssueSummary[]>;
  listOpenPullRequests?(
    cwd: string,
    repository: GitHubRepositoryIdentity,
  ): Promise<GitHubPullRequestSummary[]>;
  createPullRequest?(input: {
    cwd: string;
    title: string;
    body: string;
    draft: boolean;
    baseBranch: string;
    headBranch: string;
  }): Promise<void>;
  markPullRequestReady?(input: {
    cwd: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<void>;
  mergePullRequest?(input: {
    cwd: string;
    repository: string;
    pullRequestNumber: number;
    strategy: GitHubMergeStrategy;
    expectedHeadCommitOid: string;
  }): Promise<void>;
}

interface CommandFailureLike {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  message?: unknown;
}

/**
 * The production command seam. `execFile` receives an absolute path from the
 * shared binary resolver, an explicit argv array, and `shell:false`; provider
 * output can therefore never be reinterpreted as a shell command. Interactive
 * prompts and update notices are disabled because these calls originate from
 * app UI where no terminal is attached.
 */
export function runGitHubCliCommand(
  command: GitHubCliCommand,
): Promise<GitHubCliCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error: Error | null,
      result?: GitHubCliCommandResult,
    ): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result ?? { stdout: "", stderr: "" });
    };
    const child = execFile(
      command.executablePath,
      [...command.args],
      {
        cwd: command.cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: "1",
        },
        maxBuffer: command.maxOutputBytes,
        timeout: command.timeoutMs,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & { stdout?: unknown; stderr?: unknown };
          failure.stdout = stdout;
          failure.stderr = stderr;
          finish(failure);
          return;
        }
        finish(null, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (command.stdin !== undefined) {
      if (!child.stdin) {
        child.kill();
        finish(new Error("GitHub CLI standard input is unavailable."));
        return;
      }
      child.stdin.on("error", (error) => {
        child.kill();
        finish(error);
      });
      child.stdin.end(command.stdin);
    }
  });
}

// ── Process-wide read caches ───────────────────────────────────────────────
// Both caches below live on the module rather than on an adapter instance, and
// that is deliberate: callers construct a fresh `createGitHubCliAdapter()` at
// every site (the work queue, publish, merge, mark-ready, issue and pull
// request workspaces, and this file's own status reader), so an instance-level
// cache would be a cache of one and would never be hit.

/**
 * Clock seam for the caches in this module. Production leaves it as
 * `Date.now`; the .cjs harness replaces it so TTL expiry is assertable without
 * sleeping. It is deliberately module-level rather than an adapter dependency —
 * the caches are shared by every adapter, so a per-instance clock would be
 * ambiguous about which one owns an entry.
 */
let cacheClock: () => number = Date.now;

/** Test seam. Pass `null` to restore the real clock. */
export function setGitHubCliCacheClock(clock: (() => number) | null): void {
  cacheClock = clock ?? Date.now;
}

interface DiagnosticCacheEntry {
  value: GitHubCliDiagnostic;
  expiresAt: number;
}

let cachedDiagnostic: DiagnosticCacheEntry | null = null;
let inflightDiagnostic: Promise<GitHubCliDiagnostic> | null = null;

/**
 * Drops the cached `gh auth status` answer. Production relies on the two TTLs
 * instead — Codara never runs `gh auth login` itself, so there is no in-app
 * event to hang invalidation off. The harness bundles this module once and
 * drives many adapters through it, so each case calls this to start clean.
 */
export function invalidateGitHubCliDiagnosticCache(): void {
  cachedDiagnostic = null;
  inflightDiagnostic = null;
}

async function cachedDiagnose(
  read: () => Promise<GitHubCliDiagnostic>,
): Promise<GitHubCliDiagnostic> {
  const cached = cachedDiagnostic;
  // Copied on the way out: one entry is handed to every caller, so a caller
  // that mutated it would rewrite what the rest of the process sees.
  if (cached && cached.expiresAt > cacheClock()) return { ...cached.value };
  // A cold cache with several readers arriving together — app boot, or one
  // alt-tab waking the status panel and the work queue at once — must still
  // spawn exactly one `gh`.
  if (inflightDiagnostic) return inflightDiagnostic.then((value) => ({ ...value }));
  const operation = read().then((value) => {
    cachedDiagnostic = {
      value,
      expiresAt:
        cacheClock() +
        (value.installed && value.authenticated
          ? GITHUB_CLI_DIAGNOSTIC_TTL_MS
          : GITHUB_CLI_DIAGNOSTIC_FAILURE_TTL_MS),
    };
    return value;
  });
  inflightDiagnostic = operation;
  try {
    return await operation;
  } finally {
    if (inflightDiagnostic === operation) inflightDiagnostic = null;
  }
}

export function createGitHubCliAdapter(
  dependencies: GitHubCliAdapterDependencies = {},
): GitHubCliAdapter {
  const resolveExecutable = dependencies.resolveBinary ?? resolveBinary;
  const runCommand = dependencies.runCommand ?? runGitHubCliCommand;

  async function executablePath(): Promise<string> {
    const executable = await resolveExecutable("gh");
    if (!executable) {
      throw new GitHubCliError(
        "not-installed",
        "GitHub CLI is not installed. Install `gh`, then run `gh auth login`.",
      );
    }
    return executable;
  }

  async function runRead(cwd: string, args: readonly string[]): Promise<string> {
    assertCwd(cwd);
    const executable = await executablePath();
    try {
      const result = await runCommand({
        executablePath: executable,
        args,
        cwd,
        timeoutMs: GITHUB_CLI_READ_TIMEOUT_MS,
        maxOutputBytes: GITHUB_CLI_MAX_OUTPUT_BYTES,
      });
      return result.stdout;
    } catch (cause) {
      const detail = commandFailureText(cause);
      const code = looksLikeAuthenticationFailure(detail)
        ? "not-authenticated"
        : "command-failed";
      throw new GitHubCliError(code, detail || "GitHub CLI command failed.", { cause });
    }
  }

  async function runWrite(
    cwd: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<string> {
    assertCwd(cwd);
    const executable = await executablePath();
    try {
      const result = await runCommand({
        executablePath: executable,
        args,
        cwd,
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: GITHUB_CLI_WRITE_TIMEOUT_MS,
        maxOutputBytes: GITHUB_CLI_MAX_OUTPUT_BYTES,
      });
      return result.stdout;
    } catch (cause) {
      const detail = commandFailureText(cause);
      const code = looksLikeAuthenticationFailure(detail)
        ? "not-authenticated"
        : "command-failed";
      throw new GitHubCliError(code, detail || "GitHub CLI command failed.", { cause });
    }
  }

  return {
    diagnose(): Promise<GitHubCliDiagnostic> {
      return cachedDiagnose(async () => {
        const executable = await resolveExecutable("gh");
        if (!executable) {
          return {
            installed: false,
            authenticated: false,
            hint: "Install GitHub CLI, then run `gh auth login`.",
          };
        }
        try {
          await runCommand({
            executablePath: executable,
            // With no forced hostname, gh validates the active account surface
            // instead of incorrectly rejecting machines authenticated only to
            // GitHub Enterprise.
            args: ["auth", "status"],
            timeoutMs: GITHUB_CLI_AUTH_TIMEOUT_MS,
            maxOutputBytes: GITHUB_CLI_MAX_OUTPUT_BYTES,
          });
          return { installed: true, authenticated: true, executablePath: executable };
        } catch (cause) {
          const detail = commandFailureText(cause);
          if (isMissingExecutableFailure(cause)) {
            return {
              installed: false,
              authenticated: false,
              hint: "GitHub CLI could not be launched. Reinstall `gh`, then try again.",
            };
          }
          return {
            installed: true,
            authenticated: false,
            executablePath: executable,
            hint: detail || "Run `gh auth login` to connect GitHub.",
          };
        }
      });
    },

    async resolveRepository(cwd: string): Promise<GitHubRepositoryIdentity> {
      const stdout = await runRead(cwd, [
        "repo",
        "view",
        "--json",
        "nameWithOwner,url,defaultBranchRef",
      ]);
      return parseRepositoryIdentity(stdout);
    },

    async getCurrentPullRequest(
      cwd: string,
      repository?: GitHubRepositoryIdentity,
    ): Promise<GitHubPullRequestSummary | null> {
      let stdout: string;
      try {
        stdout = await runRead(cwd, [
          "pr",
          "view",
          "--json",
          PULL_REQUEST_SUMMARY_JSON_FIELDS,
        ]);
      } catch (cause) {
        if (
          cause instanceof GitHubCliError &&
          cause.code === "command-failed" &&
          looksLikeMissingPullRequest(cause.message)
        ) {
          return null;
        }
        throw cause;
      }
      return parsePullRequestSummary(stdout, repository);
    },

    async getPullRequest(
      cwd: string,
      repository: string,
      pullRequestNumber: number,
    ): Promise<GitHubPullRequestSummary> {
      const repo = boundedRepository(repository);
      assertPullRequestNumber(pullRequestNumber);
      const stdout = await runRead(cwd, [
        "pr",
        "view",
        String(pullRequestNumber),
        "--repo",
        repo,
        "--json",
        PULL_REQUEST_SUMMARY_JSON_FIELDS,
      ]);
      const pullRequest = parsePullRequestSummary(stdout, {
        nameWithOwner: repo,
      });
      if (pullRequest.number !== pullRequestNumber) {
        throw invalidResponse("GitHub CLI returned a different pull request.");
      }
      return pullRequest;
    },

    async getPullRequestForCheckout(
      cwd: string,
      repository: GitHubRepositoryIdentity,
      pullRequestNumber: number,
    ): Promise<GitHubPullRequestCheckoutMetadata> {
      assertPullRequestNumber(pullRequestNumber);
      const stdout = await runRead(cwd, [
        "pr",
        "view",
        String(pullRequestNumber),
        "--repo",
        repositorySelector(repository),
        "--json",
        PULL_REQUEST_CHECKOUT_JSON_FIELDS,
      ]).catch((cause: unknown) => {
        // Import is the one read that needs a modern `gh`; say so instead of
        // reflecting the CLI's raw field listing into the import dialog.
        if (
          cause instanceof GitHubCliError &&
          cause.code === "command-failed" &&
          looksLikeUnsupportedJsonField(cause.message)
        ) {
          throw new GitHubCliError(
            "command-failed",
            `Importing a pull request needs GitHub CLI ${GITHUB_CLI_MIN_IMPORT_VERSION} or newer. Update \`gh\`, then try again.`,
            { cause },
          );
        }
        throw cause;
      });
      return parsePullRequestCheckoutMetadata(
        stdout,
        repository,
        pullRequestNumber,
      );
    },

    async getIssue(
      cwd: string,
      issueNumber: number,
      repository?: GitHubRepositoryIdentity,
    ): Promise<GitHubIssueSummary> {
      assertIssueNumber(issueNumber);
      const args = [
        "issue",
        "view",
        String(issueNumber),
        ...(repository
          ? ["--repo", repositorySelector(repository)]
          : []),
        "--json",
        "number,title,url,state,labels,updatedAt",
      ];
      const stdout = await runRead(cwd, args);
      return parseIssueSummary(stdout, issueNumber, repository);
    },

    async listOpenIssues(
      cwd: string,
      repository?: GitHubRepositoryIdentity,
    ): Promise<GitHubIssueSummary[]> {
      const args = [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        String(GITHUB_ISSUE_LIST_LIMIT),
        ...(repository
          ? ["--repo", repositorySelector(repository)]
          : []),
        "--json",
        "number,title,url,labels,updatedAt",
      ];
      const stdout = await runRead(cwd, args);
      return parseIssueSummaries(stdout, repository);
    },

    async listOpenPullRequests(
      cwd: string,
      repository: GitHubRepositoryIdentity,
    ): Promise<GitHubPullRequestSummary[]> {
      const stdout = await runRead(cwd, [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(GITHUB_PULL_REQUEST_LIST_LIMIT),
        "--repo",
        repositorySelector(repository),
        "--json",
        PULL_REQUEST_SUMMARY_JSON_FIELDS,
      ]);
      return parsePullRequestSummaries(stdout, repository);
    },

    async createPullRequest(input): Promise<void> {
      const title = boundedPublishText(
        input.title,
        "Pull request title",
        GITHUB_PUBLISH_MAX_TITLE_LENGTH,
        false,
      );
      const body = boundedPublishText(
        input.body,
        "Pull request body",
        GITHUB_PUBLISH_MAX_BODY_LENGTH,
        true,
      );
      const baseBranch = boundedBranch(input.baseBranch, "base branch");
      const headBranch = boundedBranch(input.headBranch, "head branch");
      if (typeof input.draft !== "boolean") {
        throw new GitHubCliError("command-failed", "Pull request draft mode is invalid.");
      }
      const args = [
        "pr",
        "create",
        "--base",
        baseBranch,
        "--head",
        headBranch,
        "--title",
        title,
        "--body-file",
        "-",
      ];
      if (input.draft) args.push("--draft");
      await runWrite(input.cwd, args, body);
    },

    async markPullRequestReady(input): Promise<void> {
      const repository = boundedRepository(input.repository);
      assertPullRequestNumber(input.pullRequestNumber);
      await runWrite(input.cwd, [
        "pr",
        "ready",
        String(input.pullRequestNumber),
        "--repo",
        repository,
      ]);
    },

    async mergePullRequest(input): Promise<void> {
      const repository = boundedRepository(input.repository);
      assertPullRequestNumber(input.pullRequestNumber);
      const strategy = boundedMergeStrategy(input.strategy);
      const expectedHeadCommitOid = boundedCommitOid(input.expectedHeadCommitOid);
      await runWrite(input.cwd, [
        "pr",
        "merge",
        String(input.pullRequestNumber),
        "--repo",
        repository,
        `--${strategy}`,
        "--match-head-commit",
        expectedHeadCommitOid,
      ]);
    },
  };
}

/**
 * Public renderer projection. Every expected failure is collapsed into a small
 * discriminated union so raw CLI output and Error objects never cross IPC.
 */
export async function readGitHubWorkspaceStatus(
  cwd: string,
  adapter: GitHubCliAdapter = createGitHubCliAdapter(),
): Promise<GitHubWorkspaceStatus> {
  try {
    assertCwd(cwd);
  } catch {
    return {
      kind: "error",
      message: "GitHub status requires a valid local workspace.",
    };
  }

  let diagnostic: GitHubCliDiagnostic;
  try {
    diagnostic = await adapter.diagnose();
  } catch {
    return {
      kind: "error",
      message: "GitHub CLI could not be inspected. Try refreshing Source Control.",
    };
  }
  if (!diagnostic.installed) {
    return {
      kind: "not-installed",
      message: "Install GitHub CLI (`gh`), then run `gh auth login` in a terminal.",
    };
  }
  if (!diagnostic.authenticated) {
    return {
      kind: "not-authenticated",
      message: "GitHub CLI is disconnected. Run `gh auth login`, then refresh.",
    };
  }

  let repository: GitHubRepositoryIdentity;
  try {
    repository = await adapter.resolveRepository(cwd);
  } catch (cause) {
    if (cause instanceof GitHubCliError && cause.code === "not-authenticated") {
      return {
        kind: "not-authenticated",
        message: "GitHub CLI is disconnected. Run `gh auth login`, then refresh.",
      };
    }
    if (
      cause instanceof GitHubCliError &&
      cause.code === "command-failed" &&
      looksLikeMissingRepository(cause.message)
    ) {
      return {
        kind: "not-repository",
        message: "No GitHub repository was found for this workspace. Add a GitHub remote, then refresh.",
      };
    }
    const outdated = outdatedCliStatus(cause);
    if (outdated) return outdated;
    return {
      kind: "error",
      message: "GitHub repository status could not be loaded. Try refreshing Source Control.",
    };
  }

  try {
    const [pullRequest, issueResult] = await Promise.all([
      adapter.getCurrentPullRequest(cwd, repository),
      adapter.listOpenIssues
        ? adapter.listOpenIssues(cwd, repository).then(
            (issues) => ({ ok: true as const, issues }),
            () => ({ ok: false as const, issues: [] as GitHubIssueSummary[] }),
          )
        : Promise.resolve({ ok: true as const, issues: [] as GitHubIssueSummary[] }),
    ]);
    return {
      kind: "ready",
      repository,
      pullRequest,
      issues: issueResult.issues,
      ...(!issueResult.ok
        ? { issuesError: "Open issues could not be loaded. Refresh to try again." }
        : {}),
    };
  } catch (cause) {
    if (cause instanceof GitHubCliError && cause.code === "not-authenticated") {
      return {
        kind: "not-authenticated",
        message: "GitHub CLI is disconnected. Run `gh auth login`, then refresh.",
      };
    }
    const outdated = outdatedCliStatus(cause);
    if (outdated) return outdated;
    return {
      kind: "error",
      message: "Pull request status could not be loaded. Try refreshing Source Control.",
    };
  }
}

// ── Workspace-status cache ─────────────────────────────────────────────────
// `readGitHubWorkspaceStatus` above stays deliberately uncached and adapter-
// injectable: it is the unit under test, and caching inside it would leak
// state between cases. Callers that serve a UI go through the wrapper below
// instead.

interface StatusCacheEntry {
  status: GitHubWorkspaceStatus;
  expiresAt: number;
}

const cachedStatuses = new Map<string, StatusCacheEntry>();
const inflightStatuses = new Map<string, Promise<GitHubWorkspaceStatus>>();
// Bumped by every invalidation and every forced read. A read that started
// under an older epoch has been overtaken and must not write its result back,
// or a slow background read would clobber the fresh answer a publish just
// produced. One counter for every cwd is intentionally coarse: it only ever
// suppresses a cache *write*, never serves a stale value.
let statusCacheEpoch = 0;

/**
 * Drops one workspace's cached GitHub status. Called after any operation that
 * changes what GitHub would report for it — publishing, marking ready, merging.
 */
export function invalidateGitHubStatusCache(cwd: string): void {
  statusCacheEpoch += 1;
  cachedStatuses.delete(cwd);
  inflightStatuses.delete(cwd);
}

/** Drops every cached workspace status. Test seam; production invalidates per cwd. */
export function invalidateAllGitHubStatusCaches(): void {
  statusCacheEpoch += 1;
  cachedStatuses.clear();
  inflightStatuses.clear();
}

/**
 * The UI-facing workspace status read: same answer as
 * `readGitHubWorkspaceStatus`, but a short TTL and in-flight coalescing so a
 * burst of callers costs one `gh` subprocess tree instead of four per caller.
 *
 * `refresh` is the user's own request — a Refresh click, a branch change, a
 * read that follows one of this app's own writes. It always goes to GitHub,
 * bypassing both the cached entry and any read already in flight, and
 * repopulates the cache on the way out. The renderer decides which reads are
 * loud; see `GitHubSection.tsx`, whose branch-change effect is what keeps this
 * cache honest across a `git checkout` typed into a terminal.
 */
export async function readCachedGitHubWorkspaceStatus(
  cwd: string,
  options: { refresh?: boolean; adapter?: GitHubCliAdapter } = {},
): Promise<GitHubWorkspaceStatus> {
  const read = (): Promise<GitHubWorkspaceStatus> =>
    readGitHubWorkspaceStatus(cwd, options.adapter);
  if (options.refresh === true) {
    statusCacheEpoch += 1;
    const epoch = statusCacheEpoch;
    const status = await read();
    if (statusCacheEpoch === epoch) {
      cachedStatuses.set(cwd, {
        status,
        expiresAt: cacheClock() + GITHUB_STATUS_CACHE_TTL_MS,
      });
    }
    return structuredClone(status);
  }

  const cached = cachedStatuses.get(cwd);
  if (cached && cached.expiresAt > cacheClock()) return structuredClone(cached.status);
  const inflight = inflightStatuses.get(cwd);
  if (inflight) return structuredClone(await inflight);

  const epoch = statusCacheEpoch;
  const operation = read().then((status) => {
    if (statusCacheEpoch === epoch) {
      cachedStatuses.set(cwd, {
        status,
        expiresAt: cacheClock() + GITHUB_STATUS_CACHE_TTL_MS,
      });
    }
    return status;
  });
  inflightStatuses.set(cwd, operation);
  try {
    return structuredClone(await operation);
  } finally {
    if (inflightStatuses.get(cwd) === operation) inflightStatuses.delete(cwd);
  }
}

/**
 * Turns an unknown-field rejection into the one instruction that fixes it. The
 * CLI's own text lists every field it does support, which is both unbounded and
 * useless inside a narrow panel, so it never reaches the renderer.
 */
function outdatedCliStatus(cause: unknown): GitHubWorkspaceStatus | null {
  if (
    !(cause instanceof GitHubCliError) ||
    cause.code !== "command-failed" ||
    !looksLikeUnsupportedJsonField(cause.message)
  ) {
    return null;
  }
  return {
    kind: "outdated-cli",
    message:
      "This GitHub CLI is too old for Codara Studio. Update `gh` to the latest version, then refresh.",
  };
}

function parseIssueSummaries(
  stdout: string,
  repository?: GitHubRepositoryIdentity,
): GitHubIssueSummary[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw invalidResponse("GitHub CLI returned invalid JSON for issues.");
  }
  if (!Array.isArray(value) || value.length > GITHUB_ISSUE_LIST_LIMIT) {
    throw invalidResponse("GitHub CLI returned an invalid issue list.");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw invalidResponse("GitHub CLI returned an invalid issue.");
    }
    return parseIssueSummaryRecord(entry, repository);
  });
}

function parseIssueSummary(
  stdout: string,
  expectedNumber: number,
  repository?: GitHubRepositoryIdentity,
): GitHubIssueSummary {
  const value = parseJsonObject(stdout, "issue");
  const number = requiredPositiveInteger(value, "number");
  if (number !== expectedNumber) {
    throw invalidResponse("GitHub CLI returned a different issue.");
  }
  const state = requiredString(value, "state", MAX_STATUS_NAME);
  if (state !== "OPEN") {
    throw invalidResponse("The selected GitHub issue is not open.");
  }
  return parseIssueSummaryRecord(value, repository);
}

function parseIssueSummaryRecord(
  value: Record<string, unknown>,
  repository?: GitHubRepositoryIdentity,
): GitHubIssueSummary {
  const labelsValue = value.labels;
  if (!Array.isArray(labelsValue)) {
    throw invalidResponse("GitHub CLI returned invalid issue labels.");
  }
  const labels = labelsValue.slice(0, 8).map((label) => {
    if (!isRecord(label)) {
      throw invalidResponse("GitHub CLI returned an invalid issue label.");
    }
    return requiredString(label, "name", MAX_ISSUE_LABEL);
  });
  const updatedAt = optionalIsoTimestamp(value.updatedAt, "updatedAt");
  const number = requiredPositiveInteger(value, "number");
  return {
    number,
    title: requiredString(value, "title", MAX_PR_TITLE),
    url: validatedRepositoryItemUrl(
      requiredString(value, "url", MAX_URL),
      repository,
      "issues",
      number,
    ),
    labels,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function assertCwd(cwd: string): void {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > MAX_CWD_LENGTH) {
    throw new GitHubCliError("command-failed", "A repository directory is required.");
  }
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new GitHubCliError(
      "command-failed",
      "A positive GitHub issue number is required.",
    );
  }
}

function assertPullRequestNumber(pullRequestNumber: number): void {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new GitHubCliError(
      "command-failed",
      "A positive GitHub pull request number is required.",
    );
  }
}

function boundedRepository(value: string): string {
  const parts = typeof value === "string" ? value.split("/") : [];
  if (
    typeof value !== "string" ||
    value.length > MAX_REPOSITORY_NAME ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new GitHubCliError("command-failed", "The GitHub repository identity is invalid.");
  }
  return value;
}

function repositorySelector(
  repository: GitHubRepositoryIdentity,
): string {
  const nameWithOwner = boundedRepository(repository.nameWithOwner);
  const hostname =
    typeof repository.hostname === "string"
      ? repository.hostname.trim().toLowerCase()
      : "";
  if (
    !hostname ||
    hostname.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname,
    )
  ) {
    throw new GitHubCliError(
      "command-failed",
      "The GitHub repository host is invalid.",
    );
  }
  let url: URL;
  try {
    url = new URL(repository.url);
  } catch {
    throw new GitHubCliError(
      "command-failed",
      "The GitHub repository URL is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    Boolean(url.port) ||
    Boolean(url.search) ||
    Boolean(url.hash) ||
    url.hostname.toLowerCase() !== hostname ||
    normalizedUrlPath(url) !== normalizedRepositoryPath(nameWithOwner)
  ) {
    throw new GitHubCliError(
      "command-failed",
      "The GitHub repository identity is inconsistent.",
    );
  }
  return hostname === "github.com"
    ? nameWithOwner
    : `${hostname}/${nameWithOwner}`;
}

function boundedMergeStrategy(value: GitHubMergeStrategy): GitHubMergeStrategy {
  if (value !== "squash" && value !== "merge" && value !== "rebase") {
    throw new GitHubCliError("command-failed", "The pull request merge strategy is invalid.");
  }
  return value;
}

function boundedCommitOid(value: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  ) {
    throw new GitHubCliError("command-failed", "The pull request head commit is invalid.");
  }
  return value.toLowerCase();
}

function boundedPublishText(
  value: string,
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
    throw new GitHubCliError("command-failed", `${label} is invalid.`);
  }
  const normalized = allowEmpty ? value : value.trim();
  if (!allowEmpty && /[\r\n]/.test(normalized)) {
    throw new GitHubCliError("command-failed", `${label} must be one line.`);
  }
  return normalized;
}

function boundedBranch(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_BRANCH_NAME ||
    value !== value.trim() ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value === "@" ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\]\\]/u.test(value) ||
    UNSAFE_GITHUB_TEXT.test(value) ||
    value
      .split("/")
      .some(
        (component) =>
          !component ||
          component.startsWith(".") ||
          component.toLowerCase().endsWith(".lock"),
      )
  ) {
    throw new GitHubCliError("command-failed", `Pull request ${label} is invalid.`);
  }
  return value;
}

function parseRepositoryIdentity(stdout: string): GitHubRepositoryIdentity {
  const value = parseJsonObject(stdout, "repository");
  const nameWithOwner = requiredString(value, "nameWithOwner", MAX_REPOSITORY_NAME);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) {
    throw invalidResponse("GitHub CLI returned an invalid repository name.");
  }
  const [owner, name] = nameWithOwner.split("/");
  const url = validatedUrl(requiredString(value, "url", MAX_URL));
  if (
    normalizedUrlPath(url) !==
    normalizedRepositoryPath(nameWithOwner)
  ) {
    throw invalidResponse("GitHub CLI returned a mismatched repository URL.");
  }
  const defaultBranchRef = optionalObject(value.defaultBranchRef, "defaultBranchRef");
  const defaultBranch = defaultBranchRef
    ? requiredString(defaultBranchRef, "name", MAX_BRANCH_NAME)
    : undefined;
  return {
    owner,
    name,
    nameWithOwner,
    url: url.toString(),
    hostname: url.hostname,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function parsePullRequestSummaries(
  stdout: string,
  repository: GitHubRepositoryIdentity,
): GitHubPullRequestSummary[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw invalidResponse("GitHub CLI returned invalid JSON for pull requests.");
  }
  if (
    !Array.isArray(value) ||
    value.length > GITHUB_PULL_REQUEST_LIST_LIMIT
  ) {
    throw invalidResponse("GitHub CLI returned an invalid pull request list.");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw invalidResponse("GitHub CLI returned an invalid pull request.");
    }
    const parsed = parsePullRequestSummaryRecord(entry, repository);
    if (parsed.state !== "OPEN") {
      throw invalidResponse("GitHub CLI returned a non-open pull request.");
    }
    return parsed;
  });
}

function parsePullRequestSummary(
  stdout: string,
  repository?: Pick<GitHubRepositoryIdentity, "nameWithOwner"> &
    Partial<Pick<GitHubRepositoryIdentity, "url">>,
): GitHubPullRequestSummary {
  return parsePullRequestSummaryRecord(
    parseJsonObject(stdout, "pull request"),
    repository,
  );
}

function parsePullRequestSummaryRecord(
  value: Record<string, unknown>,
  repository?: Pick<GitHubRepositoryIdentity, "nameWithOwner"> &
    Partial<Pick<GitHubRepositoryIdentity, "url">>,
): GitHubPullRequestSummary {
  const number = requiredPositiveInteger(value, "number");
  const title = requiredString(value, "title", MAX_PR_TITLE);
  const url = validatedRepositoryItemUrl(
    requiredString(value, "url", MAX_URL),
    repository,
    "pull",
    number,
  );
  const state = requiredString(value, "state", MAX_STATUS_NAME);
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw invalidResponse("GitHub CLI returned an unknown pull request state.");
  }
  const isDraft = requiredBoolean(value, "isDraft");
  const baseBranch = requiredRefName(value, "baseRefName", "base branch");
  const headBranch = requiredRefName(value, "headRefName", "head branch");
  const isCrossRepository =
    value.isCrossRepository === undefined ||
    value.isCrossRepository === null
      ? undefined
      : requiredBoolean(value, "isCrossRepository");
  const updatedAt = optionalIsoTimestamp(value.updatedAt, "updatedAt");
  const reviewDecision = optionalStatus(value.reviewDecision, "reviewDecision");
  const mergeStateStatus = optionalStatus(value.mergeStateStatus, "mergeStateStatus");
  const headCommitOid = optionalCommitOid(value.headRefOid, "headRefOid");
  const checks = parseCheckSummary(value.statusCheckRollup);

  return {
    number,
    title,
    url,
    state,
    isDraft,
    baseBranch,
    headBranch,
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(headCommitOid ? { headCommitOid } : {}),
    checks,
  };
}

function parsePullRequestCheckoutMetadata(
  stdout: string,
  repository: GitHubRepositoryIdentity,
  expectedNumber: number,
): GitHubPullRequestCheckoutMetadata {
  const value = parseJsonObject(stdout, "pull request checkout metadata");
  const number = requiredPositiveInteger(value, "number");
  if (number !== expectedNumber) {
    throw invalidResponse("GitHub CLI returned a different pull request.");
  }
  const state = requiredString(value, "state", MAX_STATUS_NAME);
  if (state !== "OPEN") {
    throw invalidResponse("The selected GitHub pull request is not open.");
  }
  const title = requiredString(value, "title", MAX_PR_TITLE);
  const url = validatedRepositoryItemUrl(
    requiredString(value, "url", MAX_URL),
    repository,
    "pull",
    number,
  );
  const baseBranch = requiredRefName(value, "baseRefName", "base branch");
  const headBranch = requiredRefName(value, "headRefName", "head branch");
  const baseCommitOid = requiredCommitOid(value.baseRefOid, "baseRefOid");
  const headCommitOid = requiredCommitOid(value.headRefOid, "headRefOid");
  if (baseCommitOid.length !== headCommitOid.length) {
    throw invalidResponse("GitHub CLI returned inconsistent commit OID formats.");
  }
  const isCrossRepository = requiredBoolean(value, "isCrossRepository");
  const headRepositoryRecord = requiredObject(
    value.headRepository,
    "headRepository",
  );
  const headRepositoryOwnerRecord = requiredObject(
    value.headRepositoryOwner,
    "headRepositoryOwner",
  );
  const headRepository = boundedRepository(
    `${requiredString(
      headRepositoryOwnerRecord,
      "login",
      MAX_REPOSITORY_NAME,
    )}/${requiredString(headRepositoryRecord, "name", MAX_REPOSITORY_NAME)}`,
  );
  const sameRepository =
    headRepository.toLowerCase() === repository.nameWithOwner.toLowerCase();
  if (
    (isCrossRepository && sameRepository) ||
    (!isCrossRepository && !sameRepository)
  ) {
    throw invalidResponse(
      "GitHub CLI returned inconsistent pull request repository identity.",
    );
  }
  const repositoryUrl = validatedUrl(repository.url);
  if (repositoryUrl.port) {
    throw invalidResponse(
      "GitHub pull request import does not support custom host ports.",
    );
  }
  const headRepositoryUrl = new URL(
    `/${headRepository}`,
    repositoryUrl.origin,
  ).toString().replace(/\/$/u, "");

  return {
    number,
    title,
    url,
    baseBranch,
    baseCommitOid,
    headBranch,
    headCommitOid,
    headRepository,
    headRepositoryUrl,
    isCrossRepository,
  };
}

function optionalCommitOid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  ) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return value.toLowerCase();
}

function requiredCommitOid(value: unknown, field: string): string {
  const oid = optionalCommitOid(value, field);
  if (!oid) {
    throw invalidResponse(`GitHub CLI response is missing ${field}.`);
  }
  return oid;
}

function parseCheckSummary(value: unknown): GitHubCheckSummary {
  if (value === undefined || value === null) {
    return { total: 0, successful: 0, failed: 0, pending: 0 };
  }
  if (!Array.isArray(value)) {
    throw invalidResponse("GitHub CLI returned invalid pull request checks.");
  }

  let successful = 0;
  let failed = 0;
  let pending = 0;
  for (const item of value) {
    if (!isRecord(item)) {
      throw invalidResponse("GitHub CLI returned an invalid pull request check.");
    }
    const conclusion = optionalStatus(item.conclusion, "check conclusion");
    const state = optionalStatus(item.state, "check state");
    const status = optionalStatus(item.status, "check status");
    const signal = conclusion || state || status;
    if (signal && successfulCheckStates.has(signal)) successful += 1;
    else if (signal && failedCheckStates.has(signal)) failed += 1;
    else pending += 1;
  }
  return { total: value.length, successful, failed, pending };
}

const successfulCheckStates = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const failedCheckStates = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STALE",
  "STARTUP_FAILURE",
]);

function parseJsonObject(stdout: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw invalidResponse(`GitHub CLI returned invalid JSON for ${label}.`);
  }
  if (!isRecord(value)) {
    throw invalidResponse(`GitHub CLI returned an invalid ${label} payload.`);
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidResponse(`GitHub CLI response is missing ${field}.`);
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    Buffer.byteLength(trimmed, "utf8") > maxLength ||
    UNSAFE_GITHUB_TEXT.test(trimmed)
  ) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return trimmed;
}

function requiredRefName(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidResponse(`GitHub CLI response is missing ${field}.`);
  }
  try {
    return boundedBranch(value, label);
  } catch {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
}

function requiredPositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return value as number;
}

function requiredBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return value;
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const object = optionalObject(value, field);
  if (!object) {
    throw invalidResponse(`GitHub CLI response is missing ${field}.`);
  }
  return object;
}

function optionalStatus(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  const normalized = value.trim().toUpperCase();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > MAX_STATUS_NAME ||
    UNSAFE_GITHUB_TEXT.test(normalized)
  ) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return normalized;
}

function optionalIsoTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100 || !Number.isFinite(Date.parse(value))) {
    throw invalidResponse(`GitHub CLI returned invalid ${field}.`);
  }
  return value;
}

function validatedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse("GitHub CLI returned an invalid URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidResponse("GitHub CLI returned an invalid URL.");
  }
  return url;
}

function validatedRepositoryItemUrl(
  value: string,
  repository:
    | (Pick<GitHubRepositoryIdentity, "nameWithOwner"> &
        Partial<Pick<GitHubRepositoryIdentity, "url">>)
    | undefined,
  segment: "issues" | "pull",
  number: number,
): string {
  const url = validatedUrl(value);
  if (!repository) return url.toString();

  const expectedPath = `${normalizedRepositoryPath(repository.nameWithOwner)}/${segment}/${number}`;
  if (normalizedUrlPath(url) !== expectedPath) {
    throw invalidResponse(`GitHub CLI returned a mismatched ${segment === "issues" ? "issue" : "pull request"} URL.`);
  }

  if (repository.url) {
    const repositoryUrl = validatedUrl(repository.url);
    if (
      url.origin.toLowerCase() !== repositoryUrl.origin.toLowerCase() ||
      normalizedUrlPath(repositoryUrl) !==
        normalizedRepositoryPath(repository.nameWithOwner)
    ) {
      throw invalidResponse(`GitHub CLI returned a mismatched ${segment === "issues" ? "issue" : "pull request"} URL.`);
    }
  }
  return url.toString();
}

function normalizedRepositoryPath(nameWithOwner: string): string {
  return `/${boundedRepository(nameWithOwner).toLowerCase()}`;
}

function normalizedUrlPath(url: URL): string {
  if (url.pathname.includes("%")) {
    throw invalidResponse("GitHub CLI returned a non-canonical URL.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw invalidResponse("GitHub CLI returned an invalid URL.");
  }
  return decoded.replace(/\/+$/u, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): GitHubCliError {
  return new GitHubCliError("invalid-response", message);
}

function commandFailureText(cause: unknown): string {
  const failure = (cause ?? {}) as CommandFailureLike;
  const candidates = [failure.stderr, failure.stdout, failure.message];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const text = redactSecrets(candidate)
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, MAX_DIAGNOSTIC_TEXT);
  }
  return "";
}

/**
 * Converts a provider/git failure into bounded text safe to cross IPC. The
 * publish service also uses this for git mutation failures so no credential or
 * unbounded command output is reflected into the renderer.
 */
export function sanitizeGitHubFailure(
  cause: unknown,
  fallback = "The GitHub operation failed.",
): string {
  return commandFailureText(cause) || fallback;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{12,}\b/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:access_token|token|auth)=)[^&\s]+/gi,
      "$1[redacted]",
    );
}

function looksLikeAuthenticationFailure(message: string): boolean {
  return /not logged|not authenticated|authentication failed|unauthorized|http 40[13]\b|gh auth login|oauth token|bad credentials/i.test(
    message,
  );
}

function looksLikeMissingPullRequest(message: string): boolean {
  return /no pull requests? found|could not find (?:a )?pull request|no pull request (?:is )?associated/i.test(
    message,
  );
}

/**
 * `gh` rejects unknown `--json` field names before it runs the query, so an
 * installed and authenticated CLI that predates a field Codara asks for fails
 * every read with this text. It is a stale-install signal, not a repository or
 * credential problem.
 */
function looksLikeUnsupportedJsonField(message: string): boolean {
  return /unknown json field|unsupported json field/i.test(message);
}

function looksLikeMissingRepository(message: string): boolean {
  return /not a git repository|no git remotes?|none of the git remotes|no configured push destination|does not have any remotes|repository .* not found|could not determine.*repository/i.test(
    message,
  );
}

function isMissingExecutableFailure(cause: unknown): boolean {
  const failure = (cause ?? {}) as CommandFailureLike;
  return failure.code === "ENOENT";
}
