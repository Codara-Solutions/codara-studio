// Reads the context for "Fix with agent" in Source Control and turns it into
// a prompt (templates in src/shared/git-fix.ts): the failing checks of the
// branch's pull request with the end of each failed GitHub Actions job's log,
// the output of a commit a git hook rejected, the conflicted files of a merge
// or rebase, and the unresolved review threads of the pull request.
//
// GitHub is read through the user's own `gh`, the same access Source Control
// uses; nothing here ever sees or forwards a token. Every piece of text that
// leaves this module is capped and redacted before it can reach an agent.
// Effects are dependencies so scripts/test-git-fix-context.cjs drives it with
// a scripted `gh` and throwaway repositories.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isRemotePath } from "@shared/remote";
import {
  GIT_FIX_AGENT_RUNTIMES,
  GIT_FIX_COMMIT_HOOKS,
  GIT_FIX_KINDS,
  GIT_FIX_LIMITS,
  capText,
  checksRequest,
  conflictExcerpt,
  conflictsRequest,
  hookRequest,
  oneLine,
  plainLogText,
  redactSecrets,
  reviewRequest,
  sliceLogTail,
  tailText,
  type GitFixAgentsAvailable,
  type GitFixChecksContext,
  type GitFixConflictContext,
  type GitFixConflictFile,
  type GitFixConflictOperation,
  type GitFixFailingCheck,
  type GitFixHookContext,
  type GitFixKind,
  type GitFixPrepareInput,
  type GitFixPrepareResult,
  type GitFixPullRequestRef,
  type GitFixReviewContext,
  type GitFixReviewThread,
} from "@shared/git-fix";
import type { GitHubRepositoryIdentity } from "@shared/github";
import { resolveBinary } from "./binary-resolver";
import { runGit } from "./git-exec";
import {
  GitHubCliError,
  createGitHubCliAdapter,
  runGitHubCliCommand,
  sanitizeGitHubFailure,
  type GitHubCliAdapter,
  type GitHubCliCommand,
  type GitHubCliCommandRunner,
} from "./github-cli";
import { reviewSession } from "./github-review";

const GH_READ_TIMEOUT_MS = 20_000;
const LOG_TIMEOUT_MS = 45_000;
// Only the end of a job log is kept while it streams in, whatever its size.
const LOG_KEEP_BYTES = 512 * 1024;
const MAX_CONFLICT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HOOK_OUTPUT_INPUT = 400_000;

export class GitFixError extends Error {}

export interface GitFixContextDeps {
  runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  github: Pick<GitHubCliAdapter, "diagnose" | "resolveRepository" | "getCurrentPullRequest">;
  resolveBinary(name: string): Promise<string | null>;
  runGh: GitHubCliCommandRunner;
  /** Streams a command's stdout, keeping only its last `keepBytes`. */
  runGhTail(command: GitHubCliCommand, keepBytes: number): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mode: number } | null>;
  /** The path with every symbolic link resolved, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  platform: NodeJS.Platform;
}

export function productionGitFixDeps(): GitFixContextDeps {
  return {
    runGit: (cwd, args) => runGit(cwd, args, { internal: true }),
    github: createGitHubCliAdapter(),
    resolveBinary,
    runGh: runGitHubCliCommand,
    runGhTail: runGitHubCliTail,
    readFile: (path) => fs.readFile(path),
    stat: async (path) => {
      try {
        const info = await fs.stat(path);
        return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mode: info.mode };
      } catch {
        return null;
      }
    },
    realpath: (path) => fs.realpath(path).catch(() => null),
    platform: process.platform,
  };
}

/**
 * `gh` with stdout streamed instead of buffered: a CI log can be tens of
 * megabytes, and only its end is wanted. Same hardening as
 * runGitHubCliCommand (absolute path, argv array, no shell, no prompts).
 */
export function runGitHubCliTail(command: GitHubCliCommand, keepBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let kept = 0;
    let stderr = "";
    const child = spawn(command.executablePath, [...command.args], {
      cwd: command.cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error: Error | null, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(text ?? "");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Downloading the log took too long."));
    }, command.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      kept += chunk.length;
      while (chunks.length > 1 && kept - chunks[0].length >= keepBytes) kept -= chunks.shift()!.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(Object.assign(new Error(`gh exited with code ${code}`), { stderr }));
        return;
      }
      const all = Buffer.concat(chunks);
      const tail = all.length > keepBytes ? all.subarray(all.length - keepBytes) : all;
      finish(null, tail.toString("utf8").replace(/^�+/, ""));
    });
  });
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function git(deps: GitFixContextDeps, cwd: string, args: string[]): Promise<string> {
  return (await deps.runGit(cwd, args)).stdout;
}

async function gitOrEmpty(deps: GitFixContextDeps, cwd: string, args: string[]): Promise<string> {
  try {
    return (await git(deps, cwd, args)).trim();
  } catch {
    return "";
  }
}

function githubFailure(cause: unknown): GitFixError {
  if (cause instanceof GitFixError) return cause;
  if (cause instanceof GitHubCliError) {
    if (cause.code === "not-installed") return new GitFixError("Install GitHub CLI (gh) and run gh auth login, then try again.");
    if (cause.code === "not-authenticated") return new GitFixError("GitHub CLI is signed out. Run gh auth login, then try again.");
  }
  return new GitFixError(sanitizeGitHubFailure(cause, "GitHub could not be read. Refresh Source Control and try again."));
}

async function requireGh(deps: GitFixContextDeps): Promise<string> {
  const executable = await deps.resolveBinary("gh");
  if (!executable) throw new GitFixError("Install GitHub CLI (gh) and run gh auth login, then try again.");
  const diagnostic = await deps.github.diagnose();
  if (!diagnostic.installed) throw new GitFixError("Install GitHub CLI (gh) and run gh auth login, then try again.");
  if (!diagnostic.authenticated) throw new GitFixError("GitHub CLI is signed out. Run gh auth login, then try again.");
  return executable;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function pullRequestRef(value: Record<string, unknown>): GitFixPullRequestRef {
  const number = value.number;
  if (!Number.isSafeInteger(number) || Number(number) < 1) throw new GitFixError("GitHub returned an invalid pull request.");
  const oid = text(value.headRefOid, 64);
  return {
    number: Number(number),
    title: oneLine(text(value.title) ?? ""),
    url: oneLine(text(value.url) ?? "", 500),
    headBranch: oneLine(text(value.headRefName) ?? ""),
    baseBranch: oneLine(text(value.baseRefName) ?? ""),
    ...(oid && /^[a-f0-9]{40,64}$/i.test(oid) ? { headCommitOid: oid } : {}),
  };
}

// ── Failing checks ──────────────────────────────────────────────────────────

const CHECK_FIELDS = "number,title,url,state,headRefName,baseRefName,headRefOid,statusCheckRollup";
const FAILED_CHECK_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/**
 * The job id of a GitHub Actions check, when its details link is a job page
 * of this very repository. Anything else (another host, another repository,
 * an external CI) gets no log download.
 */
export function actionsJobId(detailsUrl: string | undefined, repository: GitHubRepositoryIdentity): string | null {
  if (!detailsUrl) return null;
  let url: URL;
  try {
    url = new URL(detailsUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.toLowerCase() !== repository.hostname.toLowerCase()) return null;
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d{1,20})\/?$/.exec(url.pathname);
  if (!match) return null;
  if (match[1].toLowerCase() !== repository.owner.toLowerCase() || match[2].toLowerCase() !== repository.name.toLowerCase()) return null;
  return match[3];
}

function logFailureNote(cause: unknown): string {
  const detail = sanitizeGitHubFailure(cause, "");
  if (/HTTP 410|HTTP 404|not found|gone/i.test(detail)) return "GitHub no longer has this job's log; open the details link.";
  if (/too long|timed out|ETIMEDOUT/i.test(detail)) return "the log took too long to download; open the details link.";
  return "the log could not be downloaded; open the details link.";
}

export async function readChecksContext(cwd: string, deps: GitFixContextDeps): Promise<GitFixChecksContext> {
  const executablePath = await requireGh(deps);
  let repository: GitHubRepositoryIdentity;
  let raw: Record<string, unknown> | null;
  try {
    repository = await deps.github.resolveRepository(cwd);
    const result = await deps.runGh({
      executablePath,
      cwd,
      args: ["pr", "view", "--json", CHECK_FIELDS],
      timeoutMs: GH_READ_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    });
    raw = record(JSON.parse(result.stdout));
  } catch (cause) {
    if (/no pull requests? found|no pull request (?:is )?associated|could not find (?:a )?pull request/i.test(sanitizeGitHubFailure(cause, ""))) {
      throw new GitFixError("This branch has no pull request on GitHub yet.");
    }
    throw githubFailure(cause);
  }
  if (!raw) throw new GitFixError("GitHub returned an invalid pull request.");
  const pullRequest = pullRequestRef(raw);
  if (raw.state !== "OPEN") throw new GitFixError(`Pull request #${pullRequest.number} is no longer open.`);
  const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
  const failing: Array<GitFixFailingCheck & { jobId: string | null }> = [];
  for (const item of rollup) {
    const check = record(item);
    if (!check) continue;
    const signal = [check.conclusion, check.state, check.status].find((value) => typeof value === "string" && value) as string | undefined;
    if (!signal || !FAILED_CHECK_STATES.has(signal.toUpperCase())) continue;
    const url = text(check.detailsUrl) ?? text(check.targetUrl);
    failing.push({
      name: oneLine(text(check.name) ?? text(check.context) ?? "Unnamed check", 160),
      ...(text(check.workflowName) ? { workflow: oneLine(text(check.workflowName)!, 160) } : {}),
      conclusion: signal.toUpperCase(),
      ...(url ? { url: oneLine(url, 500) } : {}),
      jobId: actionsJobId(url, repository),
    });
  }
  if (!failing.length) {
    throw new GitFixError(`No checks are failing on #${pullRequest.number} right now. Refresh Source Control to see the latest.`);
  }
  const listed = failing.slice(0, GIT_FIX_LIMITS.checks);
  let downloads = 0;
  await Promise.all(
    listed.map(async (check) => {
      if (!check.jobId) {
        check.logNote = "this check does not run on GitHub Actions; open the details link.";
        return;
      }
      if (downloads >= GIT_FIX_LIMITS.logJobs) {
        check.logNote = "only the first failed jobs' logs are attached; open the details link.";
        return;
      }
      downloads += 1;
      try {
        const log = await deps.runGhTail(
          {
            executablePath,
            cwd,
            args: ["api", "--hostname", repository.hostname, `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/jobs/${check.jobId}/logs`],
            timeoutMs: LOG_TIMEOUT_MS,
            maxOutputBytes: LOG_KEEP_BYTES,
          },
          LOG_KEEP_BYTES,
        );
        const tail = sliceLogTail(log);
        if (tail.text.trim()) check.logTail = tail.text;
        else check.logNote = "the job's log is empty; open the details link.";
      } catch (cause) {
        check.logNote = logFailureNote(cause);
      }
    }),
  );
  return {
    pullRequest,
    checks: listed.map(({ jobId: _jobId, ...check }) => check),
    omittedChecks: failing.length - listed.length,
  };
}

// ── Commit hooks ────────────────────────────────────────────────────────────

/** The commit hooks installed in a repository, core.hooksPath honoured. */
export async function readCommitHooks(cwd: string, deps: GitFixContextDeps): Promise<string[]> {
  if (isRemotePath(cwd)) return [];
  const hooksPath = await gitOrEmpty(deps, cwd, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksPath) return [];
  const dir = isAbsolute(hooksPath) ? hooksPath : resolve(cwd, hooksPath);
  const found: string[] = [];
  for (const name of GIT_FIX_COMMIT_HOOKS) {
    const info = await deps.stat(join(dir, name));
    // Git for Windows runs a hook through its own sh whatever the file mode.
    if (info?.isFile && (deps.platform === "win32" || (info.mode & 0o111) !== 0)) found.push(name);
  }
  return found;
}

export async function readHookContext(
  cwd: string,
  input: Pick<GitFixPrepareInput, "output" | "commitMessage">,
  deps: GitFixContextDeps,
): Promise<GitFixHookContext> {
  const hooks = await readCommitHooks(cwd, deps);
  if (!hooks.length) throw new GitFixError("This repository has no commit hook, so there is no hook output to fix.");
  const output = typeof input.output === "string" ? input.output.slice(-MAX_HOOK_OUTPUT_INPUT) : "";
  if (!output.trim()) throw new GitFixError("There is no failed commit to send. Commit again so Codara can capture the hook's output.");
  const tail = tailText(output, GIT_FIX_LIMITS.hookOutputLines, GIT_FIX_LIMITS.hookOutputChars);
  const branch = await gitOrEmpty(deps, cwd, ["branch", "--show-current"]);
  const staged = (await gitOrEmpty(deps, cwd, ["-c", "core.quotepath=off", "diff", "--cached", "--name-status"]))
    .split("\n")
    .map((line) => oneLine(line.replace(/\t/g, " "), 300))
    .filter(Boolean);
  const message = typeof input.commitMessage === "string" && input.commitMessage.trim()
    ? capText(redactSecrets(plainLogText(input.commitMessage.slice(0, 20_000)).trim()), GIT_FIX_LIMITS.commitMessageChars).text
    : undefined;
  return {
    hooks,
    ...(branch ? { branch } : {}),
    output: tail.text,
    outputTruncated: tail.truncated,
    ...(message ? { commitMessage: message } : {}),
    stagedFiles: staged.slice(0, GIT_FIX_LIMITS.stagedFiles),
    omittedFiles: Math.max(0, staged.length - GIT_FIX_LIMITS.stagedFiles),
  };
}

// ── Conflicts ───────────────────────────────────────────────────────────────

async function readGitFile(deps: GitFixContextDeps, path: string): Promise<string> {
  try {
    return (await deps.readFile(path)).toString("utf8").trim();
  } catch {
    return "";
  }
}

async function describeRef(deps: GitFixContextDeps, cwd: string, ref: string): Promise<string> {
  const name = await gitOrEmpty(deps, cwd, ["name-rev", "--name-only", "--no-undefined", "--exclude=refs/tags/*", ref]);
  if (name && !/[~^]/.test(name)) return oneLine(name.replace(/^remotes\//, ""), 160);
  return oneLine(await gitOrEmpty(deps, cwd, ["rev-parse", "--short", ref]), 40);
}

async function describeCommit(deps: GitFixContextDeps, cwd: string, ref: string): Promise<string | undefined> {
  const line = await gitOrEmpty(deps, cwd, ["log", "-1", "--format=%h %s", ref]);
  return line ? oneLine(line, 160) : undefined;
}

// A path relative to a root that stays below it. "..env" is a file name, not
// a step up, so only a whole ".." segment counts as leaving.
export function staysInside(rel: string): boolean {
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel);
}

function insideRoot(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null;
  const full = resolve(root, path);
  return staysInside(relative(root, full)) ? full : null;
}

async function conflictFile(deps: GitFixContextDeps, root: string, realRoot: string | null, path: string): Promise<GitFixConflictFile> {
  const displayPath = oneLine(path, 300);
  const full = insideRoot(root, path);
  const info = full ? await deps.stat(full) : null;
  if (!full || !info?.isFile) {
    return { path: displayPath, conflicts: 0, excerpt: "", truncated: false, note: "Deleted on one side and changed on the other: decide whether it stays (git status shows which side)." };
  }
  // Only files that really live in the working tree are quoted: a link that
  // points elsewhere is described, never read.
  const real = await deps.realpath(full);
  const rel = real && realRoot ? relative(realRoot, real) : "";
  if (!real || !staysInside(rel)) {
    return { path: displayPath, conflicts: 0, excerpt: "", truncated: false, note: "A link to somewhere else: open it in the repository to resolve it." };
  }
  if (info.size > MAX_CONFLICT_FILE_BYTES) {
    return { path: displayPath, conflicts: 0, excerpt: "", truncated: false, note: "Too large to quote here: open the file and search for <<<<<<<." };
  }
  const content = await deps.readFile(real);
  if (content.subarray(0, 8000).includes(0)) {
    return { path: displayPath, conflicts: 0, excerpt: "", truncated: false, note: "A binary file: pick a side with git checkout --ours or --theirs, or ask me." };
  }
  const excerpt = conflictExcerpt(content.toString("utf8"));
  if (!excerpt.conflicts) {
    return { path: displayPath, conflicts: 0, excerpt: "", truncated: false, note: "No conflict markers left in the file: check it, then stage it with git add." };
  }
  return { path: displayPath, ...excerpt };
}

export async function readConflictContext(cwd: string, deps: GitFixContextDeps): Promise<GitFixConflictContext> {
  const paths = (await gitOrEmpty(deps, cwd, ["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=U", "-z"]))
    .split("\0")
    .filter(Boolean);
  const unique = [...new Set(paths)];
  if (!unique.length) throw new GitFixError("There are no conflicted files right now.");
  const names = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const;
  const resolved = (await gitOrEmpty(deps, cwd, ["rev-parse", ...names.flatMap((name) => ["--git-path", name])]))
    .split("\n")
    .map((line) => line.trim());
  const at = (index: number): string | null => (resolved[index] ? (isAbsolute(resolved[index]) ? resolved[index] : resolve(cwd, resolved[index])) : null);
  const exists = async (index: number): Promise<boolean> => {
    const path = at(index);
    return path ? (await deps.stat(path)) !== null : false;
  };
  const [merge, rebaseMerge, rebaseApply, cherryPick, revert] = await Promise.all(names.map((_, index) => exists(index)));
  let operation: GitFixConflictOperation = "unknown";
  let branch = await gitOrEmpty(deps, cwd, ["branch", "--show-current"]);
  let incoming: string | undefined;
  let stoppedAt: string | undefined;
  if (rebaseMerge || rebaseApply) {
    operation = "rebase";
    const dir = at(rebaseMerge ? 1 : 2)!;
    const headName = await readGitFile(deps, join(dir, "head-name"));
    if (headName) branch = headName.replace(/^refs\/heads\//, "");
    const onto = await readGitFile(deps, join(dir, "onto"));
    if (/^[a-f0-9]{7,64}$/i.test(onto)) incoming = await describeRef(deps, cwd, onto);
    stoppedAt = await describeCommit(deps, cwd, "REBASE_HEAD");
  } else if (merge) {
    operation = "merge";
    incoming = await describeRef(deps, cwd, "MERGE_HEAD");
  } else if (cherryPick) {
    operation = "cherry-pick";
    stoppedAt = await describeCommit(deps, cwd, "CHERRY_PICK_HEAD");
  } else if (revert) {
    operation = "revert";
    stoppedAt = await describeCommit(deps, cwd, "REVERT_HEAD");
  }
  const listed = unique.slice(0, GIT_FIX_LIMITS.conflictFiles);
  // git names conflicted files from the top of the working tree, whichever
  // folder of it the workspace opened.
  const top = await gitOrEmpty(deps, cwd, ["rev-parse", "--show-toplevel"]);
  const root = top ? resolve(cwd, top) : cwd;
  const realRoot = await deps.realpath(root);
  const files = await Promise.all(listed.map((path) => conflictFile(deps, root, realRoot, path)));
  return {
    operation,
    ...(branch ? { branch: oneLine(branch, 160) } : {}),
    ...(incoming ? { incoming } : {}),
    ...(stoppedAt ? { stoppedAt } : {}),
    files,
    omittedFiles: unique.length - listed.length,
  };
}

// ── Review threads ──────────────────────────────────────────────────────────

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $cursor) {
      nodes { path line originalLine isResolved isOutdated
        comments(first: ${GIT_FIX_LIMITS.reviewCommentsPerThread}) { totalCount nodes { author { login } body url } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const REVIEW_PAGES = 2;

function reviewThread(value: unknown): (GitFixReviewThread & { resolved: boolean }) | null {
  const thread = record(value);
  if (!thread || typeof thread.isResolved !== "boolean") return null;
  const connection = record(thread.comments);
  const nodes = Array.isArray(connection?.nodes) ? connection!.nodes.slice(0, GIT_FIX_LIMITS.reviewCommentsPerThread) : [];
  const comments = nodes.flatMap((raw) => {
    const comment = record(raw);
    if (!comment || typeof comment.body !== "string") return [];
    const body = capText(redactSecrets(plainLogText(comment.body.slice(0, 64_000)).trim()), GIT_FIX_LIMITS.reviewCommentChars);
    const author = record(comment.author);
    const url = text(comment.url, 500);
    return [{
      author: oneLine(text(author?.login, 100) ?? "Deleted user", 100),
      body: body.text,
      truncated: body.truncated,
      ...(url && /^https:\/\//.test(url) ? { url } : {}),
    }];
  });
  const total = Number.isSafeInteger(connection?.totalCount) ? Number(connection!.totalCount) : comments.length;
  const line = thread.isOutdated === true ? thread.originalLine : thread.line;
  return {
    path: oneLine(text(thread.path) ?? "(unknown file)", 300),
    line: Number.isSafeInteger(line) && Number(line) > 0 ? Number(line) : null,
    outdated: thread.isOutdated === true,
    comments,
    moreComments: Math.max(0, total - comments.length),
    resolved: thread.isResolved,
  };
}

export async function readReviewContext(cwd: string, deps: GitFixContextDeps): Promise<GitFixReviewContext> {
  await requireGh(deps);
  let repository: GitHubRepositoryIdentity;
  let summary: Awaited<ReturnType<GitHubCliAdapter["getCurrentPullRequest"]>>;
  try {
    repository = await deps.github.resolveRepository(cwd);
    summary = await deps.github.getCurrentPullRequest(cwd, repository);
  } catch (cause) {
    throw githubFailure(cause);
  }
  if (!summary) throw new GitFixError("This branch has no pull request on GitHub yet.");
  if (summary.state !== "OPEN") throw new GitFixError(`Pull request #${summary.number} is no longer open.`);
  if (!summary.headCommitOid) throw new GitFixError("Refresh Source Control so Codara knows the pull request's latest commit.");
  const pullRequest: GitFixPullRequestRef = {
    number: summary.number,
    title: oneLine(summary.title),
    url: oneLine(summary.url, 500),
    headBranch: oneLine(summary.headBranch),
    baseBranch: oneLine(summary.baseBranch),
    headCommitOid: summary.headCommitOid,
  };
  const threads: GitFixReviewThread[] = [];
  try {
    const session = await reviewSession(
      cwd,
      { repositoryUrl: repository.url, pullRequestNumber: summary.number, expectedHeadCommitOid: summary.headCommitOid },
      { github: { resolveRepository: async () => repository }, resolveBinary: deps.resolveBinary, runCommand: deps.runGh },
    );
    let cursor: string | null = null;
    for (let page = 0; page < REVIEW_PAGES; page += 1) {
      const data = record(await session.graphql(REVIEW_THREADS_QUERY, {
        owner: repository.owner,
        name: repository.name,
        number: summary.number,
        cursor,
      }));
      const connection = record(record(record(data?.repository)?.pullRequest)?.reviewThreads);
      if (!connection || !Array.isArray(connection.nodes)) throw new GitFixError("GitHub returned an invalid list of review threads.");
      for (const node of connection.nodes) {
        const thread = reviewThread(node);
        if (thread && !thread.resolved) {
          const { resolved: _resolved, ...rest } = thread;
          threads.push(rest);
        }
      }
      const info = record(connection.pageInfo);
      if (info?.hasNextPage !== true || typeof info.endCursor !== "string") break;
      cursor = info.endCursor;
    }
  } catch (cause) {
    throw githubFailure(cause);
  }
  if (!threads.length) throw new GitFixError(`No unresolved review threads on #${summary.number}.`);
  return {
    pullRequest,
    threads: threads.slice(0, GIT_FIX_LIMITS.reviewThreads),
    omittedThreads: Math.max(0, threads.length - GIT_FIX_LIMITS.reviewThreads),
  };
}

// ── Entry points ────────────────────────────────────────────────────────────

function validInput(value: unknown): GitFixPrepareInput | null {
  const input = record(value);
  if (!input) return null;
  const cwd = input.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) return null;
  if (!GIT_FIX_KINDS.includes(input.kind as GitFixKind)) return null;
  return {
    cwd,
    kind: input.kind as GitFixKind,
    ...(typeof input.output === "string" ? { output: input.output } : {}),
    ...(typeof input.commitMessage === "string" ? { commitMessage: input.commitMessage } : {}),
  };
}

/** Reads one problem's context and builds the prompt the user reviews before sending. */
export async function prepareGitFix(raw: unknown, deps: GitFixContextDeps = productionGitFixDeps()): Promise<GitFixPrepareResult> {
  const input = validInput(raw);
  if (!input) return { ok: false, error: "Choose a workspace and a problem to fix." };
  if (isRemotePath(input.cwd)) return { ok: false, error: "Fix with agent works in local workspaces for now." };
  try {
    switch (input.kind) {
      case "checks":
        return { ok: true, request: checksRequest(await readChecksContext(input.cwd, deps)) };
      case "hook":
        return { ok: true, request: hookRequest(await readHookContext(input.cwd, input, deps)) };
      case "conflicts":
        return { ok: true, request: conflictsRequest(await readConflictContext(input.cwd, deps)) };
      case "review":
        return { ok: true, request: reviewRequest(await readReviewContext(input.cwd, deps)) };
    }
  } catch (cause) {
    if (cause instanceof GitFixError) return { ok: false, error: cause.message };
    return { ok: false, error: sanitizeGitHubFailure(cause, "Codara could not read this problem. Try again.") };
  }
}

/** Which agent CLIs a fix can start in a new terminal. */
export async function availableFixAgents(deps: Pick<GitFixContextDeps, "resolveBinary"> = { resolveBinary }): Promise<GitFixAgentsAvailable> {
  const found = await Promise.all(GIT_FIX_AGENT_RUNTIMES.map(async (runtime) => [runtime, Boolean(await deps.resolveBinary(runtime))] as const));
  return Object.fromEntries(found) as GitFixAgentsAvailable;
}
