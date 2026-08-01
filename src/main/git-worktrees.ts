import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { GitCopyWorktreeResult, GitOpResult } from "@shared/types";
import { errorText, readGitText, runGit } from "./git-exec";

// Worktree provisioning for the "Create copy branch" workspace action. Pure
// git + fs — NO electron import — so the path base (sparkHome) is passed in by
// the caller (ipc.ts). Keep this dependency-light: the integration test bundles
// it with esbuild and the only runtime import is ./git-exec.

export interface CreateCopyWorktreeInput {
  repoCwd: string;
  // Base dir for THIS repo's worktrees, e.g. ~/.SparkAgent/worktrees/<repo>.
  // Caller (ipc.ts) computes it from sparkHome so this module stays
  // electron-free and testable.
  worktreesRoot: string;
  baseBranch?: string;
  // Name for the NEW branch the worktree is created on. User-provided for the
  // Create copy dialog; generated ("sandbox-N") for autopilot sandboxes.
  newBranch: string;
}

export interface CreateCheckoutWorktreeInput {
  repoCwd: string;
  worktreesRoot: string;
  // Local branch name ("feature/x"), or a remote-tracking ref like
  // "origin/feature/x" when isRemote is set.
  branch: string;
  isRemote?: boolean;
}

export interface RemoveCopyWorktreeInput {
  repoCwd: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
  deleteBranch?: boolean;
}

const MANAGED_REPO_HASH_HEX_LENGTH = 12;

/**
 * Stable per-repository namespace for all newly managed worktrees.
 *
 * Existing worktrees are deliberately never migrated: their persisted
 * absolute paths remain valid and cleanup/recovery consumes those paths
 * directly. Canonicalizing both the basename and hash makes symlink aliases
 * converge while keeping unrelated same-named repositories isolated.
 */
export function managedWorktreesRoot(
  sparkHomeDir: string,
  repoCwd: string,
): string {
  const absolute = resolve(repoCwd);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // Provisioning will report the real git/path failure. Root derivation
    // remains deterministic if the path disappeared after user selection.
  }
  const suffix = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, MANAGED_REPO_HASH_HEX_LENGTH);
  return join(
    sparkHomeDir,
    "worktrees",
    `${basename(canonical)}-${suffix}`,
  );
}

async function branchExists(repoCwd: string, name: string): Promise<boolean> {
  try {
    await runGit(repoCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function remoteRefExists(repoCwd: string, name: string): Promise<boolean> {
  try {
    await runGit(repoCwd, ["show-ref", "--verify", "--quiet", `refs/remotes/${name}`]);
    return true;
  } catch {
    return false;
  }
}

// The ref a new copy-branch forks from, à la Conductor ("Branched <city> from
// origin/main"). Prefer the REMOTE default branch so a copy reflects canonical
// main rather than a possibly-stale or dirty local main; fall back through the
// local default branches to the current HEAD for repos without a remote. (The
// name is historical — it returns a start-point ref, which may be a remote one
// like "origin/main"; git worktree add resolves it to a commit either way.)
export async function resolveDefaultBranch(repoCwd: string): Promise<string> {
  const originHead = await readGitText(repoCwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.startsWith("origin/")) return originHead; // e.g. "origin/main"
  if (await remoteRefExists(repoCwd, "origin/main")) return "origin/main";
  if (await remoteRefExists(repoCwd, "origin/master")) return "origin/master";
  if (await branchExists(repoCwd, "main")) return "main";
  if (await branchExists(repoCwd, "master")) return "master";
  const current = await readGitText(repoCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current || "main";
}

async function localBranchNames(repoCwd: string): Promise<Set<string>> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function existingWorktreeDirs(worktreesRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

// Unique throwaway name for a sandbox worktree: "sandbox", "sandbox-2", … —
// must be free both as a local branch name and as a worktree directory.
async function pickSandboxBranchName(repoCwd: string, worktreesRoot: string): Promise<string> {
  const used = new Set<string>([
    ...(await localBranchNames(repoCwd)),
    ...(await existingWorktreeDirs(worktreesRoot)),
  ]);
  if (!used.has("sandbox")) return "sandbox";
  for (let n = 2; ; n += 1) {
    const candidate = `sandbox-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// Count tracked files materialized into the worktree, for the chat banner's
// "copied N files" line (Conductor shows the same).
async function countTrackedFiles(worktreePath: string): Promise<number> {
  const out = await readGitText(worktreePath, ["ls-files"]);
  if (!out) return 0;
  return out.split(/\r?\n/).filter((line) => line.trim()).length;
}

export async function createCopyWorktree(
  input: CreateCopyWorktreeInput,
): Promise<GitCopyWorktreeResult> {
  try {
    const branch = input.newBranch.trim();
    if (!branch) return { ok: false, error: "No branch name given." };
    const baseBranch = input.baseBranch?.trim() || (await resolveDefaultBranch(input.repoCwd));
    const dirName = await pickCheckoutDirName(input.worktreesRoot, branch);
    const path = join(input.worktreesRoot, dirName);
    if (existsSync(path)) {
      return { ok: false, error: `Worktree path already exists: ${path}` };
    }
    mkdirSync(input.worktreesRoot, { recursive: true });
    // Invalid or already-taken branch names are left to git's own refusals —
    // its messages ("a branch named 'x' already exists", "not a valid branch
    // name") surface verbatim in the dialog.
    await runGit(input.repoCwd, ["worktree", "add", path, "-b", branch, baseBranch]);
    const fileCount = await countTrackedFiles(path);
    return { ok: true, path, branch, city: dirName, baseBranch, mode: "fork", fileCount };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// Branch names may contain characters a directory name can't ("feature/x"),
// so the worktree dir gets a flattened slug while git checks out the real name.
export function slugifyBranchName(name: string): string {
  const slug = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "branch";
}

// Worktree directory name for a branch: the slug, with a numeric suffix on
// collision. Only directory collisions matter — the slug never becomes a
// branch name (the real, possibly-slashed name is what git checks out).
async function pickCheckoutDirName(worktreesRoot: string, branchName: string): Promise<string> {
  const used = await existingWorktreeDirs(worktreesRoot);
  const base = slugifyBranchName(branchName);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function branchWorktreePath(repoCwd: string, name: string): Promise<string | null> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(worktreepath)",
    `refs/heads/${name}`,
  ]);
  return out.trim() || null;
}

// Check an EXISTING branch out into a new worktree — the "open this branch as
// a workspace" half of Create copy (createCopyWorktree is the fork half). For
// a remote-tracking ref the local namesake is reused when free, or created
// with tracking when absent. Occupied local branches are left to git's own
// atomic refusal ("already used by worktree ...") rather than a racy pre-check.
export async function createCheckoutWorktree(
  input: CreateCheckoutWorktreeInput,
): Promise<GitCopyWorktreeResult> {
  try {
    const branch = input.branch.trim();
    if (!branch) return { ok: false, error: "No branch given." };
    const shortName = input.isRemote ? branch.replace(/^[^/]+\//, "") : branch;

    let addArgs: string[];
    if (input.isRemote && !(await branchExists(input.repoCwd, shortName))) {
      // Remote-only branch: create the local counterpart, tracking the remote.
      addArgs = ["-b", shortName, branch];
    } else {
      if (input.isRemote) {
        // The local namesake exists; only reusable when nothing has it checked
        // out. Pre-checked here because the free case runs a different command.
        const usedAt = await branchWorktreePath(input.repoCwd, shortName);
        if (usedAt) {
          return {
            ok: false,
            error: `Branch '${shortName}' is already checked out at ${usedAt}`,
          };
        }
      }
      addArgs = [shortName];
    }

    const dirName = await pickCheckoutDirName(input.worktreesRoot, shortName);
    const path = join(input.worktreesRoot, dirName);
    if (existsSync(path)) {
      return { ok: false, error: `Worktree path already exists: ${path}` };
    }
    mkdirSync(input.worktreesRoot, { recursive: true });
    await runGit(input.repoCwd, ["worktree", "add", path, ...addArgs]);
    const fileCount = await countTrackedFiles(path);
    return { ok: true, path, branch: shortName, city: dirName, mode: "checkout", fileCount };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// --- Sandbox worktrees for unattended/autopilot workers ---------------------
// Same machinery as the "Create copy" action, but driven by the orchestrator
// to filesystem-isolate each unattended worker. The fork point is the run's
// checkpoint (refs/spark/runs/{runId}, resolved to a ref/sha by the caller)
// passed as `startPoint`; when omitted, createCopyWorktree falls back to
// resolveDefaultBranch. The sandbox-N name is picked over the SANDBOX
// worktreesRoot the caller hands in (kept distinct from the copy-branch
// root). Electron-free, exactly like createCopyWorktree.

export interface CreateSandboxWorktreeInput {
  repoCwd: string;
  // Base dir for sandbox worktrees, computed by the caller from sparkHome so
  // this module stays electron-free.
  worktreesRoot: string;
  // Run checkpoint ref or sha to fork from. Omit to let createCopyWorktree
  // resolve the repo's default branch.
  startPoint?: string;
}

export interface RemoveSandboxWorktreeInput {
  repoCwd: string;
  worktreePath: string;
  branch: string;
}

export async function createSandboxWorktree(
  input: CreateSandboxWorktreeInput,
): Promise<GitCopyWorktreeResult> {
  const name = await pickSandboxBranchName(input.repoCwd, input.worktreesRoot);
  return createCopyWorktree({
    repoCwd: input.repoCwd,
    worktreesRoot: input.worktreesRoot,
    // startPoint is the run checkpoint ref/sha; undefined => resolveDefaultBranch.
    baseBranch: input.startPoint,
    newBranch: name,
  });
}

// Force-remove a sandbox worktree and delete its throwaway branch on run
// cleanup. Thin re-export of removeCopyWorktree with force + deleteBranch.
// NOTE: deleteBranch uses git branch -d (safe delete), which refuses if the
// branch carries unmerged commits — intended, so unmerged sandbox work isn't
// silently dropped; callers wanting hard removal can fall back to
// removeCopyWorktree directly.
export async function removeSandboxWorktree(
  input: RemoveSandboxWorktreeInput,
): Promise<GitOpResult> {
  return removeCopyWorktree({
    repoCwd: input.repoCwd,
    worktreePath: input.worktreePath,
    branch: input.branch,
    force: true,
    deleteBranch: true,
  });
}

// Pipe a patch to `git apply` over stdin. execFile can't stream stdin, so spawn
// directly here with the same hardening flags as git-exec.runGit. Mirrors the
// approach in git-apply.ts, kept local so this module stays import-light (only
// node built-ins + ./git-exec).
function gitApplyStdin(cwd: string, args: string[], patch: string): Promise<GitOpResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, "-c", "credential.interactive=false", ...args], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `git apply exited with code ${code}` });
    });
    child.stdin.on("error", () => {
      /* ignore EPIPE if git rejected the patch before reading stdin */
    });
    child.stdin.end(patch.endsWith("\n") ? patch : `${patch}\n`);
  });
}

export interface MergeBackSandboxWorktreeInput {
  // The run workspace repo the worktree was forked from; merge-back targets
  // this repo's working tree.
  repoCwd: string;
  // The sandbox worktree the unattended worker ran inside.
  worktreePath: string;
}

export type MergeBackSandboxResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

// Converge a sandboxed worker's edits back into the run workspace. Unattended
// workers run inside an isolated worktree forked off the run checkpoint and
// edit files in place without committing, so the worker's contribution is the
// worktree's diff against its own HEAD (the fork point). We stage everything in
// the worktree (`add -A`, which covers adds/mods/deletes), emit a binary-safe
// patch of that index against HEAD, and apply it to the base repo's working
// tree — leaving the changes unstaged for review, matching how checkpoint
// restore surfaces work as pending changes.
//
// `changed:false` means the worker touched nothing (empty diff) — a no-op
// success, not an error. The base repo's working tree is only ever appended to
// via `git apply`; we never reset, checkout, or otherwise discard existing work
// there, so the non-sandbox path and any concurrent state are untouched.
export async function mergeBackSandboxWorktree(
  input: MergeBackSandboxWorktreeInput,
): Promise<MergeBackSandboxResult> {
  try {
    // Stage all worker edits in the worktree so new and deleted files are
    // captured, not just modifications. Writes only the worktree's own index.
    await runGit(input.worktreePath, ["add", "-A"]);
    // Full, binary-safe patch of the worker's changes vs. the fork point.
    // --cached compares the index (just staged) to HEAD; HEAD is the fork
    // commit because unattended workers don't commit inside the worktree.
    const { stdout: patch } = await runGit(input.worktreePath, [
      "diff",
      "--binary",
      "--cached",
      "HEAD",
    ]);
    if (!patch.trim()) {
      return { ok: true, changed: false };
    }
    // Apply to the base repo's working tree (no --cached: leave it unstaged for
    // review). Plain `git apply` validates the whole patch up front and is
    // effectively all-or-nothing, so a patch that doesn't apply cleanly (e.g.
    // the base drifted from the fork point) fails without half-writing or
    // leaving conflict markers — we surface that as an error and leave the
    // worktree intact rather than partially mutating the workspace.
    // --whitespace=nowarn keeps the git output quiet.
    const applied = await gitApplyStdin(
      input.repoCwd,
      ["apply", "--whitespace=nowarn"],
      patch,
    );
    if (!applied.ok) return applied;
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// Normalize a path for comparison: forward slashes, no trailing slash, lower
// case. git emits worktree paths with `/` (and sometimes a different drive-
// letter case) on Windows, while Codara hands us native `\` paths — so we can't
// compare them raw.
function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Is `worktreePath` currently a registered worktree of `repoCwd`? We parse
// `git worktree list --porcelain` rather than matching git's error text, which
// is locale-dependent ("is not a working tree" only in English).
async function isRegisteredWorktree(repoCwd: string, worktreePath: string): Promise<boolean> {
  try {
    const out = await readGitText(repoCwd, ["worktree", "list", "--porcelain"]);
    const target = normalizePathForCompare(worktreePath);
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalizePathForCompare(line.slice("worktree ".length).trim()))
      .includes(target);
  } catch {
    return false;
  }
}

// Clear an orphaned worktree directory off disk. Heavily guarded: we only ever
// delete a path that is non-empty, distinct from the repo root, and NOT an
// ancestor of the repo (so a bad input can never wipe the repository itself).
async function removeOrphanWorktreeDir(repoCwd: string, worktreePath: string): Promise<GitOpResult> {
  const target = normalizePathForCompare(worktreePath);
  const repo = normalizePathForCompare(repoCwd);
  if (!target || target === repo || repo.startsWith(`${target}/`)) {
    return { ok: false, error: `Refusing to remove unsafe worktree path: ${worktreePath}` };
  }
  try {
    if (existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export interface RemoveCopyWorktreeHooks {
  // Invoked once, the first time removal fails because of a transient directory
  // lock (a process — usually a shell or agent pane — holding the worktree as
  // its cwd, which makes Windows reject the rmdir with EBUSY). The caller uses
  // this to tear down the worktree's PTYs before we retry. Awaited; a throw is
  // swallowed so a faulty hook can't abort the retry loop.
  onBusy?: () => Promise<void> | void;
}

// Path/FS error fragments that mean "momentarily locked" rather than "can't be
// done" — almost always a live shell or editor still holding the worktree as
// its cwd on Windows. Once that process is torn down the lock clears, so these
// are retried rather than surfaced.
const BUSY_FS_CODE = /\b(EBUSY|EPERM|EACCES|ENOTEMPTY|ETXTBSY)\b/i;
const BUSY_GIT_MSG =
  /(unable to remove|permission denied|being used by another process|directory not empty|resource busy|is locked)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One removal attempt. Returns success, or an error plus whether it's a
// transient lock worth retrying (vs. a hard refusal like uncommitted changes
// without --force, which must be surfaced immediately rather than looped on).
async function tryRemoveWorktreeOnce(
  input: RemoveCopyWorktreeInput,
): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
  try {
    if (!input.force) {
      const status = await readGitText(input.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      if (status.trim()) {
        return {
          ok: false,
          error: "Worktree has uncommitted changes. Use force removal to discard them.",
          retryable: false,
        };
      }
    }
    await runGit(input.repoCwd, [
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      input.worktreePath,
    ]);
    return { ok: true };
  } catch (err) {
    const msg = errorText(err);
    // Still a registered worktree? Then git declined for a concrete reason:
    // either a transient lock (retry) or a real refusal like local
    // modifications without --force (surface it).
    if (await isRegisteredWorktree(input.repoCwd, input.worktreePath)) {
      return { ok: false, error: msg, retryable: BUSY_GIT_MSG.test(msg) };
    }
    // Orphaned/broken copy: the linkage is gone (admin entry pruned or the
    // worktree's own .git pointer lost), so the path is no longer a registered
    // worktree and git fails with "is not a working tree". Clear the directory
    // off disk directly so a broken copy is never permanently undeletable.
    const cleanup = await removeOrphanWorktreeDir(input.repoCwd, input.worktreePath);
    if (cleanup.ok) return { ok: true };
    return {
      ok: false,
      error: cleanup.error ?? msg,
      retryable: BUSY_FS_CODE.test(cleanup.error ?? ""),
    };
  }
}

export async function removeCopyWorktree(
  input: RemoveCopyWorktreeInput,
  hooks?: RemoveCopyWorktreeHooks,
): Promise<GitOpResult> {
  // Retry briefly on a transient lock. On Windows a shell or agent pane whose
  // cwd is the worktree holds the directory open, so removal fails with EBUSY
  // / "unable to remove" until that process is gone. On the first such failure
  // we ask the caller (via onBusy) to kill the worktree's PTYs, then keep
  // retrying while ConPTY + taskkill tear them down asynchronously (~1s).
  const backoffMs = [0, 150, 300, 600, 1000, 1500];
  let lastError = "worktree removal not attempted";
  let removed = false;
  let askedToRelease = false;
  for (const delayMs of backoffMs) {
    if (delayMs) await sleep(delayMs);
    const attempt = await tryRemoveWorktreeOnce(input);
    if (attempt.ok) {
      removed = true;
      break;
    }
    lastError = attempt.error;
    if (!attempt.retryable) break;
    if (!askedToRelease && hooks?.onBusy) {
      askedToRelease = true;
      try {
        await hooks.onBusy();
      } catch {
        /* best-effort: the caller's release hook must never abort the retry */
      }
    }
  }
  if (!removed) return { ok: false, error: lastError };

  // Best-effort prune of any stale admin entry left behind.
  try {
    await runGit(input.repoCwd, ["worktree", "prune"]);
  } catch {
    /* ignore — prune failure is not fatal */
  }
  if (input.deleteBranch) {
    try {
      // Safe delete: git refuses (-d) if the branch has unmerged commits.
      await runGit(input.repoCwd, ["branch", "-d", input.branch]);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
  return { ok: true };
}
