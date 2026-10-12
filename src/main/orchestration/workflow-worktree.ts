// Worktree isolation for workflow agents (agent(..., { isolation: "worktree" })).
// Each such call gets a fresh checkout on its own `codara/wf/<run>/<label>-<seq>`
// branch, forked from one base commit per run so every isolated agent starts
// from the same tree. When the agent finishes, its changes are committed to
// that branch and the directory is removed: many agents must not leave many
// checkouts (disk, file watchers) behind. The branch is the result.
//
// No Electron import: the root directory is passed in, so the suite drives it
// against throwaway repositories.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { withRepoLock } from "../agent-worktrees";
import { errorText, readGitText, runGit } from "../git-exec";
import type { JournalWorktree } from "./workflow-journal";

export interface WorkflowWorktree {
  repoCwd: string;
  path: string;
  branch: string;
  base: string;
}

export function workflowBranchPrefix(runId: string): string {
  return `codara/wf/${runId.replace(/^run-/, "").slice(0, 8)}`;
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned || "agent";
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    return (await readGitText(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** The commit isolated agents of a run fork from: the workspace's HEAD. */
export async function workflowBaseCommit(repoCwd: string): Promise<string> {
  if (!(await isGitRepository(repoCwd))) {
    throw new Error("isolation: 'worktree' needs a git repository, and this workspace is not one");
  }
  const sha = await readGitText(repoCwd, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error("isolation: 'worktree' needs a repository with at least one commit");
  }
  return sha;
}

export async function createWorkflowWorktree(input: {
  repoCwd: string;
  root: string;
  runId: string;
  label: string;
  seq: number;
  base: string;
}): Promise<WorkflowWorktree> {
  const name = `${slug(input.label)}-${input.seq}`;
  const branch = `${workflowBranchPrefix(input.runId)}/${name}`;
  const path = join(input.root, name);
  // Creation serializes per repository with every other worktree operation;
  // parallel `git worktree add` calls race on the repository's index lock.
  await withRepoLock(input.repoCwd, async () => {
    mkdirSync(input.root, { recursive: true });
    if (existsSync(path)) {
      // A leftover from a stopped run: start this call over from the base.
      await runGit(input.repoCwd, ["worktree", "remove", "--force", path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
      await runGit(input.repoCwd, ["worktree", "prune"]).catch(() => undefined);
    }
    await runGit(input.repoCwd, ["worktree", "add", "-B", branch, path, input.base]);
  });
  return { repoCwd: input.repoCwd, path, branch, base: input.base };
}

async function commitAll(path: string, message: string): Promise<void> {
  await runGit(path, ["add", "-A"]);
  // --no-verify: a throwaway branch per agent would otherwise run the
  // repository's hooks dozens of times in parallel. Without a configured
  // identity the commit still lands, under a per-command Codara identity;
  // nothing is written to any git config.
  try {
    await runGit(path, ["commit", "--no-verify", "-q", "-m", message]);
  } catch (err) {
    if (!/user\.(name|email)|identity|tell me who you are/i.test(errorText(err))) throw err;
    await runGit(path, [
      "-c",
      "user.name=Codara workflow",
      "-c",
      "user.email=workflow@codara.invalid",
      "commit",
      "--no-verify",
      "-q",
      "-m",
      message,
    ]);
  }
}

/**
 * Commits the agent's changes to its branch when there are any, then removes
 * the checkout. Unchanged: the branch goes too. Never throws; a failure is
 * reported in the returned note and the checkout is left for the user.
 */
export async function finishWorkflowWorktree(
  worktree: WorkflowWorktree,
  message: string,
): Promise<JournalWorktree & { note?: string }> {
  try {
    const status = await readGitText(worktree.path, ["status", "--porcelain"]);
    if (status.trim()) await commitAll(worktree.path, message);
    const commit = await readGitText(worktree.path, ["rev-parse", "HEAD"]);
    const changed = commit !== worktree.base;
    const filesChanged = changed
      ? (await readGitText(worktree.path, ["diff", "--name-only", `${worktree.base}..${commit}`]))
          .split("\n")
          .filter((line) => line.trim()).length
      : 0;
    await withRepoLock(worktree.repoCwd, async () => {
      await runGit(worktree.repoCwd, ["worktree", "remove", "--force", worktree.path]);
      if (!changed) await runGit(worktree.repoCwd, ["branch", "-D", worktree.branch]).catch(() => undefined);
    });
    return changed
      ? { branch: worktree.branch, base: worktree.base, commit, changed: true, filesChanged }
      : { branch: worktree.branch, base: worktree.base, changed: false };
  } catch (err) {
    return {
      branch: worktree.branch,
      base: worktree.base,
      changed: false,
      note: `the agent's worktree could not be finished, so it was left at ${worktree.path}: ${errorText(err)}`,
    };
  }
}

/**
 * Removes every checkout of the repository that lives under `root` (a run's
 * worktree folder), committing uncommitted edits to its branch first, then
 * prunes git's records of them. Never throws for one checkout; returns the
 * paths it removed.
 */
export async function removeWorkflowWorktrees(repoCwd: string, root: string, message: string): Promise<string[]> {
  if (!(await isGitRepository(repoCwd))) return [];
  let rootReal = resolve(root);
  try {
    rootReal = realpathSync(root);
  } catch {
    // Already gone: only git's records of it can be left.
  }
  const inside = (path: string) => {
    const resolved = resolve(path);
    return [resolve(root), rootReal].some((base) => resolved.startsWith(base + sep));
  };
  const listing = await readGitText(repoCwd, ["worktree", "list", "--porcelain"]);
  const paths = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(inside);
  const removed: string[] = [];
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const status = await readGitText(path, ["status", "--porcelain"]);
        if (status.trim()) await commitAll(path, message);
      } catch {
        // A checkout git cannot read has nothing to keep.
      }
    }
    const ok = await withRepoLock(repoCwd, () => runGit(repoCwd, ["worktree", "remove", "--force", path]))
      .then(() => true)
      .catch(() => false);
    if (ok) removed.push(path);
  }
  await withRepoLock(repoCwd, () => runGit(repoCwd, ["worktree", "prune"])).catch(() => undefined);
  return removed;
}

/**
 * Deleting a run deletes its branches whose tips are already merged into the
 * repository's current branch and lists the rest; unmerged work is never
 * dropped.
 */
export async function cleanupWorkflowBranches(
  repoCwd: string,
  runId: string,
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = [];
  const kept: string[] = [];
  if (!(await isGitRepository(repoCwd))) return { deleted, kept };
  const prefix = workflowBranchPrefix(runId);
  const listing = await readGitText(repoCwd, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}/`]);
  const branches = listing.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const branch of branches) {
    const merged = await runGit(repoCwd, ["merge-base", "--is-ancestor", branch, "HEAD"])
      .then(() => true)
      .catch(() => false);
    if (!merged) {
      kept.push(branch);
      continue;
    }
    await withRepoLock(repoCwd, () => runGit(repoCwd, ["branch", "-D", branch]))
      .then(() => deleted.push(branch))
      .catch(() => kept.push(branch));
  }
  return { deleted, kept };
}
