// An automation's own branch: its workers edit a separate checkout instead of
// the user's, and when the loop ends the work lands on a branch and, when asked
// and the run went well, in a draft pull request. Only for automations that
// turned it on; without it a run works in the workspace folder as it always did.
//
// This never force-pushes, never touches the user's checkout and never pushes
// to an existing branch: each cycle has a new, uniquely named one. Failures keep
// the work and say where it is. Git's own messages stay out of what is recorded,
// since a remote URL in one can carry a token.

import { isRemotePath } from "@shared/remote";
import {
  AUTOMATION_BRANCH_PREFIX,
  type AutomationBranchResult,
  type AutomationOwnBranchState,
  type ScheduledJob,
} from "@shared/types";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveBinary } from "../binary-resolver";
import { codaraHome } from "../codara-home";
import { runGit } from "../git-exec";
import { GITHUB_CLI_MAX_OUTPUT_BYTES, runGitHubCliCommand } from "../github-cli";
import { managedWorktreesRoot } from "../git-worktrees";

const LOCAL_GIT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const PR_BODY_CHARS = 4000;

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "run"
  );
}

async function read(cwd: string, args: string[]): Promise<string | null> {
  try {
    const res = await runGit(cwd, args, { timeout: LOCAL_GIT_TIMEOUT_MS, internal: true });
    return res.stdout.trim();
  } catch {
    return null;
  }
}

export type OpenOwnBranchResult = { ok: true; own: AutomationOwnBranchState } | { ok: false; problem: string };

export async function openOwnBranch(job: ScheduledJob, nowMs: number = Date.now()): Promise<OpenOwnBranchResult> {
  const repo = job.input.cwd;
  if (isRemotePath(repo)) {
    return { ok: false, problem: "Working on its own branch needs a local workspace, so this run did not start." };
  }
  if ((await read(repo, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
    return { ok: false, problem: "This workspace is not a git repository, so it cannot work on its own branch. This run did not start." };
  }
  // Best effort: offline it starts from the last known state of the remote.
  await read(repo, ["fetch", "--quiet", "origin"]);
  // From the default branch rather than whatever happens to be checked out, so
  // a draft pull request holds this run's work and nothing else.
  const remoteHead = await read(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const startPoint = remoteHead || "HEAD";
  const baseSha = await read(repo, ["rev-parse", "--verify", "--quiet", `${startPoint}^{commit}`]);
  if (!baseSha) {
    return { ok: false, problem: "This repository has no commits yet, so it cannot work on its own branch. This run did not start." };
  }
  const baseBranch = remoteHead
    ? remoteHead.slice(remoteHead.indexOf("/") + 1)
    : await read(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const id = `${slug(job.name)}-${nowMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const branch = `${AUTOMATION_BRANCH_PREFIX}${id}`;
  const path = join(managedWorktreesRoot(codaraHome(), repo), "automations", id);
  try {
    mkdirSync(dirname(path), { recursive: true });
    await runGit(repo, ["worktree", "add", "--quiet", "-b", branch, path, baseSha], {
      timeout: NETWORK_TIMEOUT_MS,
      internal: true,
    });
  } catch {
    return { ok: false, problem: "Could not create a separate copy of the repository, so this run did not start." };
  }
  return { ok: true, own: { path, branch, baseSha, ...(baseBranch && baseBranch !== "HEAD" ? { baseBranch } : {}) } };
}

// Rebuilt by a tool, so losing them loses nothing. Any other ignored file may be
// the only copy of what a run produced, such as a report in an ignored folder.
const REBUILT_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".turbo",
  ".cache",
]);

async function leftIgnoredOutput(path: string): Promise<boolean> {
  const status = await read(path, ["status", "--porcelain", "--ignored"]);
  if (status === null) return true;
  return status
    .split("\n")
    .filter((line) => line.startsWith("!! "))
    .some((line) => !line.slice(3).split("/").some((part) => REBUILT_FOLDERS.has(part)));
}

// Never forced: git refuses while anything uncommitted is left, and that is
// exactly when the copy has to stay. Git does not count ignored files, so those
// are checked here.
async function removeCheckout(repo: string, path: string): Promise<boolean> {
  if (await leftIgnoredOutput(path)) return false;
  return (await read(repo, ["worktree", "remove", path])) !== null;
}

function stillThere(path: string): string {
  return ` Some files were not committed, so its copy is still in ${path}.`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function openDraftPullRequest(
  job: ScheduledJob,
  own: AutomationOwnBranchState,
  summary: string | undefined,
  resolveGh: () => Promise<string | null>,
): Promise<{ url?: string; problem?: string }> {
  const gh = await resolveGh();
  if (!gh) return { problem: "No pull request: the GitHub CLI (gh) is not installed." };
  if (!own.baseBranch) return { problem: "No pull request: it could not tell which branch to target." };
  const run = (args: string[]): Promise<string> =>
    runGitHubCliCommand({
      executablePath: gh,
      args,
      cwd: own.path,
      timeoutMs: NETWORK_TIMEOUT_MS,
      maxOutputBytes: GITHUB_CLI_MAX_OUTPUT_BYTES,
    }).then((res) => res.stdout);
  const urlIn = (text: string): string | undefined => /https:\/\/\S+\/pull\/\d+/.exec(text)?.[0];
  const body = [
    (summary ?? "").trim().slice(0, PR_BODY_CHARS),
    `Opened by the Codara Studio automation "${oneLine(job.name)}".`,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const url = urlIn(
      await run(["pr", "create", "--draft", "--base", own.baseBranch, "--head", own.branch, "--title", oneLine(job.name), "--body", body]),
    );
    if (url) return { url };
  } catch {
    // The worker may have opened one itself.
  }
  const existing = await run(["pr", "view", own.branch, "--json", "url", "--jq", ".url"]).catch(() => "");
  const url = urlIn(existing);
  return url ? { url } : { problem: "No pull request: GitHub did not accept it." };
}

export async function closeOwnBranch(
  job: ScheduledJob,
  own: AutomationOwnBranchState,
  opts: { openPullRequest: boolean; summary?: string; resolveGh?: () => Promise<string | null> },
): Promise<AutomationBranchResult> {
  const repo = job.input.cwd;
  const { branch, path } = own;
  if (!existsSync(path)) {
    const ahead = await read(repo, ["rev-list", "--count", `${own.baseSha}..${branch}`]);
    return { branch, changed: Number(ahead) > 0, note: "Its separate copy was gone when the run ended." };
  }
  const dirty = await read(path, ["status", "--porcelain"]);
  if (dirty === null) return { branch, changed: true, note: `Could not read its changes. They are still in ${path}.` };
  if (dirty) {
    try {
      await runGit(path, ["add", "-A"], { timeout: LOCAL_GIT_TIMEOUT_MS, internal: true });
      // Through the repository's own hooks: a secret scan must still get its say.
      await runGit(path, ["commit", "--quiet", "-m", oneLine(job.name) || "Automation run"], {
        timeout: NETWORK_TIMEOUT_MS,
        internal: true,
      });
    } catch {
      return { branch, changed: true, note: `Could not commit its changes, so they are still in ${path}.` };
    }
  }
  // A worker can detach HEAD or switch branch. What it made must be on the branch
  // this reports, or removing the copy would leave its commits unreferenced. Only
  // ever forward: a worker that looked at an older commit has not undone its work.
  const head = await read(path, ["rev-parse", "--verify", "HEAD"]);
  const tip = await read(path, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!head || !tip) {
    return { branch, changed: true, note: `Could not read its commits. Its work is still in ${path}.` };
  }
  if (head !== tip) {
    if ((await read(path, ["merge-base", "--is-ancestor", tip, head])) !== null) {
      if ((await read(path, ["update-ref", `refs/heads/${branch}`, head, tip])) === null) {
        return { branch, changed: true, note: `Could not read its commits. Its work is still in ${path}.` };
      }
    } else if ((await read(path, ["merge-base", "--is-ancestor", head, tip])) === null) {
      return { branch, changed: true, note: `Its commits went two different ways, so nothing was pushed. Its work is still in ${path}.` };
    }
  }
  const count = await read(path, ["rev-list", "--count", `${own.baseSha}..${branch}`]);
  // Unsure means keep everything: a failed read must not look like "no commits".
  if (count === null || !/^\d+$/.test(count)) {
    return { branch, changed: true, note: `Could not read its commits. Its work is still in ${path}.` };
  }
  if (Number(count) === 0) {
    if (await removeCheckout(repo, path)) await read(repo, ["branch", "-D", branch]);
    else return { branch, changed: true, note: `It made no commits, but its copy was kept because of files it left there. It is in ${path}.` };
    return { branch, changed: false, note: "It changed nothing, so there is no branch to look at." };
  }
  const saved = `Its work is on the branch ${branch}.`;
  if (!opts.openPullRequest) {
    const removed = await removeCheckout(repo, path);
    return { branch, changed: true, note: removed ? saved : `${saved}${stillThere(path)}` };
  }
  try {
    await runGit(path, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
      timeout: NETWORK_TIMEOUT_MS,
      internal: true,
    });
  } catch {
    const removed = await removeCheckout(repo, path);
    return { branch, changed: true, note: `${saved} No pull request: it could not push.${removed ? "" : stillThere(path)}` };
  }
  const pull = await openDraftPullRequest(job, own, opts.summary, opts.resolveGh ?? (() => resolveBinary("gh")));
  const removed = await removeCheckout(repo, path);
  const left = removed ? "" : stillThere(path);
  if (pull.url) return { branch, changed: true, prUrl: pull.url, ...(left ? { note: left.trim() } : {}) };
  return { branch, changed: true, note: `${saved} ${pull.problem ?? ""}${left}`.trim() };
}
