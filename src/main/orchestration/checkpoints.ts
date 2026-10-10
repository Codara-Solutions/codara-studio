import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Checkpoint } from "@shared/types";
import { makeId } from "@shared/ids";

// Per-run workspace snapshots stored under refs/spark/runs/{runId}. The
// snapshot is a low-level commit-tree pointing at a write-tree of the index
// after `git add -A`, so we capture the full worktree (respecting .gitignore)
// without touching HEAD, the index that the user sees, or any branch. Each
// new checkpoint is parented to the previous one on the same ref, which keeps
// `git log refs/spark/runs/{runId}` browsable for debugging.
//
// Restoring "chat + code" first snapshots the CURRENT worktree onto
// refs/spark/undo/{runId}, so the undo itself can be undone, then rewrites
// only the paths that differ between the checkpoint and now: changed and
// deleted files come back from the checkpoint, files created since are
// removed. Only those paths fall back to HEAD in the index; whatever else the
// user staged stays staged.

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;

interface RunResult {
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const { stdout, stderr } = await execFileAsync(
    "git",
    ["-C", cwd, "-c", "credential.interactive=false", ...args],
    {
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function shadowRef(runId: string): string {
  return `refs/spark/runs/${runId}`;
}

async function refSha(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

// Resolve the commit sha at the tip of the run's checkpoint shadow ref, or null
// when the run has no checkpoint yet. Lets a caller choose between forking a
// sandbox worktree off the checkpoint vs. the default branch.
export async function runCheckpointStartPoint(
  cwd: string,
  runId: string,
): Promise<string | null> {
  return refSha(cwd, shadowRef(runId));
}

// Write the whole worktree (respecting .gitignore) as a tree object through a
// private index, so neither HEAD nor the index the user sees is touched.
async function snapshotWorktreeTree(
  cwd: string,
  indexFile: string,
): Promise<{ tree: string; headSha: string | null }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: indexFile,
  };
  const headSha = await refSha(cwd, "HEAD");
  if (headSha) {
    // Seed the temp index with HEAD so files we don't touch keep their mode
    // bits, and binary blobs stay deduped against the existing pack.
    await git(cwd, ["read-tree", "HEAD"], env);
  }
  // -A picks up modifications, additions, and deletions, all relative to
  // gitignore. This is the same surface area as a normal stage-all commit.
  await git(cwd, ["add", "-A"], env);
  const { stdout: treeOut } = await git(cwd, ["write-tree"], env);
  return { tree: treeOut.trim(), headSha };
}

export interface CreateCheckpointInput {
  runId: string;
  cwd: string;
  kind: Checkpoint["kind"];
  messageId?: string;
  messagePointer: number;
  label: string;
}

// Create a snapshot of `cwd` and append a checkpoint to the shadow ref. Returns
// a Checkpoint with sha=null when the workspace is not a git repo — the caller
// still records the entry so the chat-only undo dimension keeps working.
export async function createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
  const { runId, cwd, kind, messageId, messagePointer, label } = input;
  const baseCheckpoint: Checkpoint = {
    id: makeId("ckpt"),
    kind,
    messagePointer,
    sha: null,
    messageId,
    label,
    createdAt: new Date().toISOString(),
  };

  if (!cwd || !(await isGitRepo(cwd))) return baseCheckpoint;

  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "spark-ckpt-"));
    const { tree, headSha } = await snapshotWorktreeTree(cwd, join(tempDir, "index"));
    if (!tree) return { ...baseCheckpoint, snapshotError: "Git wrote no snapshot of the workspace." };

    const parents: string[] = [];
    const parentRef = await refSha(cwd, shadowRef(runId));
    if (parentRef) {
      parents.push("-p", parentRef);
    } else if (headSha) {
      // First checkpoint for this run — parent to HEAD so `git log` walks back
      // into real history if someone goes spelunking on the shadow ref.
      parents.push("-p", headSha);
    }

    const message = `spark-checkpoint ${kind} ${baseCheckpoint.id}\n\n${label}`;
    const { stdout: commitOut } = await git(cwd, [
      "commit-tree",
      tree,
      ...parents,
      "-m",
      message,
    ]);
    const commit = commitOut.trim();
    if (!commit) return baseCheckpoint;

    await git(cwd, ["update-ref", shadowRef(runId), commit]);

    return { ...baseCheckpoint, sha: commit };
  } catch (error) {
    // Checkpoint creation is best-effort. A failed snapshot returns the
    // sha-less entry so the undo-chat-only path still works, with the reason
    // the code undo is unavailable.
    return { ...baseCheckpoint, snapshotError: gitErrorText(error) || "Git could not snapshot the workspace." };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface CheckpointRestoreResult {
  /** The workspace as it was just before the restore (also the tip of
   * refs/spark/undo/{runId} when a run id was given). */
  preRestoreSha: string;
  /** Paths written back from the checkpoint. */
  restored: string[];
  /** Paths created after the checkpoint and removed. */
  removed: string[];
}

// Restore the workspace to a checkpoint's snapshot: every file the snapshot
// covers ends up as it was at the checkpoint, including files created since
// (removed) and files deleted since (restored). The restored paths show up as
// pending changes against HEAD the user can review and commit.
export async function restoreCheckpointCode(input: {
  cwd: string;
  sha: string;
  runId?: string;
}): Promise<CheckpointRestoreResult> {
  const { cwd, sha } = input;
  if (!cwd) throw new Error("Workspace path missing — cannot restore code.");
  if (!(await isGitRepo(cwd))) throw new Error("Workspace is not a git repository.");

  const exists = await refSha(cwd, sha);
  if (!exists) throw new Error("Checkpoint commit is missing from the shadow ref.");

  const tempDir = await mkdtemp(join(tmpdir(), "spark-restore-"));
  try {
    // Nothing is touched unless the current state is saved first: an undo
    // also reverts edits the user or another chat made since the checkpoint,
    // and this snapshot is the only way back from that.
    let current: { tree: string; headSha: string | null };
    try {
      current = await snapshotWorktreeTree(cwd, join(tempDir, "current-index"));
    } catch (error) {
      throw new Error(
        `Codara could not save the current workspace before undoing, so no file was changed. ${gitErrorText(error)}`,
      );
    }
    const undoRef = input.runId ? undoRefFor(input.runId) : null;
    const previousUndo = undoRef ? await refSha(cwd, undoRef) : null;
    const { stdout: preOut } = await git(cwd, [
      "commit-tree",
      current.tree,
      "-p",
      previousUndo ?? sha,
      "-m",
      `spark-pre-undo ${sha}\n\nWorkspace just before restoring checkpoint ${sha}`,
    ]);
    const preRestoreSha = preOut.trim();
    if (!preRestoreSha) throw new Error("Codara could not save the current workspace before undoing, so no file was changed.");
    if (undoRef) await git(cwd, ["update-ref", undoRef, preRestoreSha]);

    const { stdout: diffOut } = await git(cwd, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--name-status",
      sha,
      preRestoreSha,
    ]);
    const restored: string[] = [];
    const removed: string[] = [];
    const fields = diffOut.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i];
      const path = fields[i + 1];
      if (!status || !path) continue;
      if (status === "A") removed.push(path);
      else restored.push(path);
    }

    // diff-tree paths are relative to the repository root, and the workspace
    // may be a folder inside a larger repository.
    const { stdout: topOut } = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = resolve(topOut.trim() || cwd);
    // Removals go first: on a case-insensitive filesystem a file renamed only
    // in case since the checkpoint is both a removed and a restored path, and
    // removing it after the restore would delete the file just written back.
    for (const path of removed) {
      const target = resolve(root, path);
      if (!target.startsWith(`${root}${sep}`)) continue;
      // Non-recursive on purpose: a path that is a directory now (a nested
      // repository, a submodule) is left alone rather than deleted wholesale.
      await rm(target, { force: true }).catch(() => undefined);
      await removeEmptyParents(dirname(target), root);
    }
    if (restored.length > 0) {
      // A private index holding the checkpoint writes those files back
      // without touching the user's index.
      const restoreEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_INDEX_FILE: join(tempDir, "restore-index"),
      };
      await git(root, ["read-tree", sha], restoreEnv);
      for (const chunk of pathChunks(restored)) {
        await git(root, ["checkout-index", "-f", "--", ...chunk], restoreEnv);
      }
    }

    const touched = [...restored, ...removed];
    if (touched.length > 0 && current.headSha) {
      for (const chunk of pathChunks(touched)) {
        // Literal, so a file named like a glob ("[ab].txt") cannot unstage
        // the user's other files that the pattern happens to match.
        await git(root, ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...chunk]);
      }
    }
    return { preRestoreSha, restored, removed };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Paths per git invocation, bounded by count and by total length so one
// command line stays well under the Windows limit of 32K characters.
const PATH_CHUNK_COUNT = 200;
const PATH_CHUNK_CHARS = 8_000;

function pathChunks(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (current.length > 0 && (current.length >= PATH_CHUNK_COUNT || chars + path.length > PATH_CHUNK_CHARS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 3;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function removeEmptyParents(dir: string, root: string): Promise<void> {
  let current = dir;
  while (current !== root && current.startsWith(root)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function undoRefFor(runId: string): string {
  return `refs/spark/undo/${runId}`;
}

function gitErrorText(error: unknown): string {
  const err = error as { killed?: boolean; signal?: string; message?: string };
  if (err?.killed || err?.signal === "SIGTERM") {
    return `Git did not finish within ${TIMEOUT_MS / 1000} seconds.`;
  }
  const message = err?.message ?? String(error);
  return message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

// Drop the run's shadow ref when the run is deleted. Best-effort — a missing
// ref is fine.
export async function deleteRunCheckpoints(cwd: string, runId: string): Promise<void> {
  if (!cwd || !(await isGitRepo(cwd))) return;
  await git(cwd, ["update-ref", "-d", shadowRef(runId)]).catch(() => undefined);
  await git(cwd, ["update-ref", "-d", undoRefFor(runId)]).catch(() => undefined);
}

// Rewind the run's shadow ref so its tip points to `sha` (or delete the ref
// when sha is null). Called after an undo: the checkpoints we just dropped
// from the RunState shouldn't keep dangling on the ref where future
// checkpoints would otherwise be parented to a stale tip.
export async function rewindShadowRef(input: {
  cwd: string;
  runId: string;
  sha: string | null;
}): Promise<void> {
  const { cwd, runId, sha } = input;
  if (!cwd || !(await isGitRepo(cwd))) return;
  if (sha) {
    await git(cwd, ["update-ref", shadowRef(runId), sha]).catch(() => undefined);
  } else {
    await git(cwd, ["update-ref", "-d", shadowRef(runId)]).catch(() => undefined);
  }
}
