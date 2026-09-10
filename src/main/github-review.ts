import type { GitHubRepositoryIdentity } from "@shared/github";
import { validGitHubReviewInput, validGitHubReviewTarget, type GitHubReviewFile, type GitHubReviewInput, type GitHubReviewPage, type GitHubReviewResult, type GitHubReviewTarget } from "@shared/github-review";
import { resolveBinary } from "./binary-resolver";
import { createGitHubCliAdapter, invalidateGitHubStatusCache, runGitHubCliCommand, sanitizeGitHubFailure, type GitHubCliAdapter, type GitHubCliCommandRunner } from "./github-cli";

interface ReviewDependencies {
  github?: Pick<GitHubCliAdapter, "resolveRepository">;
  resolveBinary?: typeof resolveBinary;
  runCommand?: GitHubCliCommandRunner;
}

const FILES_PER_PAGE = 10;
const MAX_PATCH_BYTES = 32 * 1024;

function boundedPatch(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_PATCH_BYTES) return text;
  const prefix = bytes.subarray(0, MAX_PATCH_BYTES).toString("utf8");
  return prefix.slice(0, prefix.lastIndexOf("\n"));
}

export function parseGitHubReviewFiles(value: unknown): GitHubReviewFile[] {
  if (!Array.isArray(value) || value.length > FILES_PER_PAGE) throw new Error("GitHub returned an invalid file page.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.filename !== "string" || !item.filename || item.filename.length > 4096 ||
        typeof item.status !== "string" || !Number.isSafeInteger(item.additions) || item.additions < 0 ||
        !Number.isSafeInteger(item.deletions) || item.deletions < 0) throw new Error("GitHub returned an invalid changed file.");
    const patch = typeof item.patch === "string" ? boundedPatch(item.patch) : null;
    const lines = patch?.split("\n") ?? [];
    return {
      path: item.filename, ...(typeof item.previous_filename === "string" ? { previousPath: item.previous_filename.slice(0, 4096) } : {}),
      status: item.status.slice(0, 40), additions: item.additions, deletions: item.deletions, patch,
      incomplete: patch === null || patch !== item.patch || lines.filter((line) => line.startsWith("+")).length !== item.additions ||
        lines.filter((line) => line.startsWith("-")).length !== item.deletions,
    };
  });
}

export async function reviewSession(cwd: string, input: GitHubReviewTarget, dependencies: ReviewDependencies) {
  if (!validGitHubReviewTarget(input)) throw new Error("Choose a valid pull request and commit to review.");
  const github = dependencies.github ?? createGitHubCliAdapter();
  const repository = await github.resolveRepository(cwd);
  if (repository.url.toLowerCase() !== input.repositoryUrl.toLowerCase()) {
    throw new Error("This workspace now points at a different repository. Refresh before reviewing.");
  }
  const executablePath = await (dependencies.resolveBinary ?? resolveBinary)("gh");
  if (!executablePath) throw new Error("Install GitHub CLI in Studio and sign in before reviewing.");
  const run = dependencies.runCommand ?? runGitHubCliCommand;
  const endpoint = `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${input.pullRequestNumber}`;
  const api = async (suffix: string, body?: unknown): Promise<unknown> => {
    try {
      const result = await run({
        executablePath, cwd,
        args: ["api", "--hostname", repository.hostname, `${endpoint}${suffix}`, "--method", body === undefined ? "GET" : "POST",
          "-H", "Accept: application/vnd.github+json", ...(body === undefined ? [] : ["--input", "-"])],
        ...(body === undefined ? {} : { stdin: JSON.stringify(body) }), timeoutMs: body === undefined ? 20000 : 90000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch (cause) {
      throw new Error(sanitizeGitHubFailure(cause, "The GitHub review request failed."));
    }
  };
  const checkHead = async () => {
    const value = await api("") as { number?: unknown; state?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown } };
    if (!value || value.number !== input.pullRequestNumber || value.state !== "open" || value.head?.sha !== input.expectedHeadCommitOid ||
        typeof value.base?.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.base.sha) ||
        (input.expectedBaseCommitOid !== undefined && value.base.sha !== input.expectedBaseCommitOid)) {
      throw new Error("This pull request changed or closed. Refresh and review its current commit before submitting.");
    }
    return value.base.sha;
  };
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    try {
      const result = await run({
        executablePath, cwd,
        args: ["api", "--hostname", repository.hostname, "graphql", "--method", "POST", "--input", "-"],
        stdin: JSON.stringify({ query, variables }), timeoutMs: 20000, maxOutputBytes: 4 * 1024 * 1024,
      });
      const value = JSON.parse(result.stdout);
      if (!value || value.errors?.length || !value.data) throw new Error("GitHub could not complete this request.");
      return value.data;
    } catch (cause) {
      throw new Error(sanitizeGitHubFailure(cause, "The GitHub API request failed."));
    }
  };
  return { api, checkHead, repository, graphql };
}

export async function readGitHubReviewPage(cwd: string, input: GitHubReviewTarget & { page?: number }, dependencies: ReviewDependencies = {}): Promise<GitHubReviewPage> {
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 300) throw new Error("Choose a valid diff page.");
  const session = await reviewSession(cwd, input, dependencies);
  const baseCommitOid = await session.checkHead();
  const files = parseGitHubReviewFiles(await session.api(`/files?per_page=${FILES_PER_PAGE}&page=${page}`));
  // GitHub's file endpoint follows the live PR. A second read makes a push
  // during pagination fail explicitly instead of mixing two revisions.
  if (await session.checkHead() !== baseCommitOid) throw new Error("The PR base changed while loading. Refresh before reviewing.");
  return { headCommitOid: input.expectedHeadCommitOid, baseCommitOid, files,
    ...(files.length === FILES_PER_PAGE ? page < 300 ? { nextPage: page + 1 } : { fileLimitReached: true } : {}) };
}

export async function submitGitHubReview(cwd: string, input: GitHubReviewInput, dependencies: ReviewDependencies = {}): Promise<GitHubReviewResult> {
  if (!validGitHubReviewInput(input)) return { kind: "failed", message: "Check the review text, comments and selected commit." };
  let session: Awaited<ReturnType<typeof reviewSession>>;
  try {
    session = await reviewSession(cwd, input, dependencies);
    await session.checkHead();
  } catch (error) {
    return { kind: "failed", message: sanitizeGitHubFailure(error) };
  }
  try {
    const result = await session.api("/reviews", {
      commit_id: input.expectedHeadCommitOid, event: input.event, body: input.body,
      comments: input.comments.map(({ path, line, side, body }) => ({ path, line, side, body })),
    }) as { id?: unknown; state?: unknown; commit_id?: unknown };
    const state = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[input.event];
    if (!result || !Number.isSafeInteger(result.id) || Number(result.id) <= 0 || result.state !== state || result.commit_id !== input.expectedHeadCommitOid) {
      throw new Error("GitHub returned an unconfirmed review result.");
    }
    return { kind: "submitted", url: reviewUrl(session.repository, input.pullRequestNumber, Number(result.id)), headCommitOid: input.expectedHeadCommitOid };
  } catch (error) {
    const message = sanitizeGitHubFailure(error);
    if (/^gh: [^\n]+ \(HTTP (?:400|401|403|404|422)\)(?:\n|$)/m.test(message)) {
      return { kind: "failed", message };
    }
    // A timed-out POST can have succeeded. The phone retains the request ID
    // and the remote mutation ledger prevents it from publishing twice.
    return { kind: "unknown", message: `The review outcome could not be confirmed. Check this PR on GitHub before submitting another review. ${message}` };
  } finally {
    invalidateGitHubStatusCache(cwd);
  }
}

function reviewUrl(repository: GitHubRepositoryIdentity, number: number, reviewId: number): string {
  return `${repository.url}/pull/${number}#pullrequestreview-${reviewId}`;
}
