import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
// Restoring "chat + code" runs `read-tree -u --reset <sha>` to make the
// worktree match the snapshot, then `reset HEAD` so the index falls back to
// HEAD — the user sees the restoration as a clean set of pending changes
// against their real branch.

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

export interface CreateCheckpointInput {
  runId: string;
  cwd: string;
  kind: Checkpoint["kind"];
  messageId?: string;
  messagePointer: number;
  label: string;
  /** Called with the reason when a git workspace could not be snapshotted. */
  onError?: (message: string) => void;
}

// Seed the temp index from the real one so `add -A` keeps git's stat cache and
// hashes only changed files; seeding from `read-tree HEAD` re-hashes every
// tracked file, which on a large repository outlasts TIMEOUT_MS. A split index
// keeps its entries in a separate sharedindex file, so copying the main file
// alone would corrupt it; those repositories fall back to read-tree.
async function seedTempIndex(
  cwd: string,
  tempIndex: string,
  env: NodeJS.ProcessEnv,
  headSha: string | null,
): Promise<void> {
  try {
    const splitIndex = await git(cwd, ["config", "--bool", "core.splitIndex"]).catch(() => null);
    const { stdout } = await git(cwd, ["rev-parse", "--git-path", "index"]);
    const realIndex = resolve(cwd, stdout.trim());
    const shared = (await readdir(dirname(realIndex)).catch(() => [] as string[]))
      .some((name) => name.startsWith("sharedindex."));
    if (splitIndex?.stdout.trim() !== "true" && !shared && (await stat(realIndex)).isFile()) {
      await copyFile(realIndex, tempIndex);
      return;
    }
  } catch {
    // No usable index (fresh repository): fall through to HEAD.
  }
  if (headSha) {
    // Seed the temp index with HEAD so files we don't touch keep their mode
    // bits, and binary blobs stay deduped against the existing pack.
    await git(cwd, ["read-tree", "HEAD"], env);
  }
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
    const tempIndex = join(tempDir, "index");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: tempIndex,
    };

    const headSha = await refSha(cwd, "HEAD");
    await seedTempIndex(cwd, tempIndex, env, headSha);

    // -A picks up modifications, additions, and deletions, all relative to
    // gitignore. This is the same surface area as a normal stage-all commit.
    await git(cwd, ["add", "-A"], env);

    const { stdout: treeOut } = await git(cwd, ["write-tree"], env);
    const tree = treeOut.trim();
    if (!tree) return baseCheckpoint;

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
    // sha-less entry so the undo-chat-only path still works; the caller hears
    // why, so the run can say undo and regression restore are unavailable.
    input.onError?.(error instanceof Error ? error.message.slice(0, 500) : String(error));
    return baseCheckpoint;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Restore the workspace to a checkpoint's snapshot. The worktree is updated to
// match the snapshot exactly (including removing files that didn't exist at
// the checkpoint), then the index is reset back to HEAD so the restoration
// shows up as a normal set of pending changes the user can review and commit.
export async function restoreCheckpointCode(input: {
  cwd: string;
  sha: string;
}): Promise<void> {
  const { cwd, sha } = input;
  if (!cwd) throw new Error("Workspace path missing — cannot restore code.");
  if (!(await isGitRepo(cwd))) throw new Error("Workspace is not a git repository.");

  const exists = await refSha(cwd, sha);
  if (!exists) throw new Error("Checkpoint commit is missing from the shadow ref.");

  // -u updates the worktree to match; --reset blows away conflicting changes
  // (the user explicitly asked for an undo). After this the worktree matches
  // the snapshot and the index does too.
  await git(cwd, ["read-tree", "-u", "--reset", sha]);
  // Pull the index back to HEAD so the user keeps their branch pointer and
  // sees the restored files as pending changes against HEAD.
  await git(cwd, ["reset", "HEAD"]);
}

// Restore only `paths` (workspace-relative) to their content in a checkpoint,
// leaving every other file and the index alone. A path the snapshot does not
// contain was created after it and is removed. Used by the automatic
// green-claim regression restore, which must not touch work outside the
// regressing worker's own files.
export async function restoreCheckpointPaths(input: {
  cwd: string;
  sha: string;
  paths: string[];
}): Promise<{ restored: string[]; removed: string[] }> {
  const { cwd, sha } = input;
  if (!cwd) throw new Error("Workspace path missing; cannot restore code.");
  if (!(await isGitRepo(cwd))) throw new Error("Workspace is not a git repository.");
  if (!(await refSha(cwd, sha))) throw new Error("Checkpoint commit is missing from the shadow ref.");
  const root = resolve(cwd);
  const restored: string[] = [];
  const removed: string[] = [];
  for (const raw of input.paths) {
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const absolute = resolve(root, path);
    if (!path || isAbsolute(path) || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) continue;
    const inSnapshot = await git(cwd, ["cat-file", "-e", `${sha}:${path}`]).then(() => true, () => false);
    if (inSnapshot) {
      await git(cwd, ["restore", `--source=${sha}`, "--worktree", "--", path]);
      restored.push(path);
    } else {
      await rm(absolute, { force: true, recursive: false }).catch(() => undefined);
      removed.push(path);
    }
  }
  return { restored, removed };
}

// Drop the run's shadow ref when the run is deleted. Best-effort — a missing
// ref is fine.
export async function deleteRunCheckpoints(cwd: string, runId: string): Promise<void> {
  if (!cwd || !(await isGitRepo(cwd))) return;
  await git(cwd, ["update-ref", "-d", shadowRef(runId)]).catch(() => undefined);
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
