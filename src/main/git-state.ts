// What git would say about a checkout, read from its files without starting
// git. The renderer's git reads ask for these fingerprints on one shared
// clock and run git only for checkouts whose fingerprint moved, so an idle
// window with dozens of workspaces starts no git at all.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRemotePath } from "@shared/remote";

export interface GitDirs {
  /** This checkout's own git directory (a linked worktree has its own). */
  gitDir: string;
  /** The directory every worktree of the repository shares: refs, config. */
  commonDir: string;
}

/** The git directories of the checkout holding `cwd`; null outside a local repository. */
export async function gitDirsOf(cwd: string): Promise<GitDirs | null> {
  if (!cwd.trim() || isRemotePath(cwd) || /^[a-z][a-z0-9+.-]*:\/\//i.test(cwd)) return null;
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    const found = await fs.stat(dotGit).catch(() => null);
    if (found?.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (found?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, "utf8").catch(() => ""));
      if (!pointer) return null;
      const gitDir = resolve(dir, pointer[1]);
      const common = (await fs.readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A ref with a slash (`perf/x`, `origin/feat/y`) is written into its own
// folder, whose time moves, not its parent's: every folder below counts.
const MAX_REF_FOLDERS = 256;

async function refFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  while (level.length > 0 && found.length < MAX_REF_FOLDERS) {
    found.push(...level);
    const next: string[] = [];
    for (const dir of level) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory()) next.push(join(dir, entry.name));
    }
    level = next;
  }
  return found.slice(0, MAX_REF_FOLDERS);
}

async function stamp(path: string): Promise<string> {
  const info = await fs.stat(path).catch(() => null);
  return info ? `${info.mtimeMs}:${info.size}` : "-";
}

/**
 * A fingerprint that moves when a commit, checkout, reset, stage, branch
 * update, stash or fetch that changed something lands in this checkout or a
 * branch of its repository. Edits to files in the working tree do not move
 * it (the file watcher covers those), nor do repositories using reftable.
 * Null outside a local repository.
 */
export async function gitStateSignature(cwd: string): Promise<string | null> {
  const dirs = await gitDirsOf(cwd);
  if (!dirs) return null;
  const { gitDir, commonDir } = dirs;
  const head = (await fs.readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  const folders = (
    await Promise.all(["heads", "remotes", "tags"].map((kind) => refFolders(join(commonDir, "refs", kind))))
  ).flat();
  // A fetch rewrites FETCH_HEAD every time; only what it names counts.
  const fetched = await fs.readFile(join(commonDir, "FETCH_HEAD")).catch(() => null);
  const stamps = await Promise.all([
    join(gitDir, "index"),
    join(gitDir, "logs", "HEAD"),
    join(commonDir, "packed-refs"),
    join(commonDir, "refs", "stash"),
    join(commonDir, "config"),
    // A worktree added or removed, with or without a branch of its own.
    join(commonDir, "worktrees"),
    ...(ref ? [join(commonDir, ref)] : []),
    ...folders,
  ].map(stamp));
  const fetchedHash = fetched ? createHash("sha1").update(fetched).digest("hex") : "-";
  return [head, fetchedHash, ...stamps].join("|");
}

/**
 * The branch HEAD names when its ref is a loose file, read without git.
 * Null when only git can tell (detached, packed, unborn, not a repository).
 */
export async function branchFromFiles(cwd: string): Promise<string | null> {
  const dirs = await gitDirsOf(cwd);
  if (!dirs) return null;
  const head = (await fs.readFile(join(dirs.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const name = /^ref:\s*refs\/heads\/(\S+)$/.exec(head)?.[1];
  if (!name) return null;
  const loose = await fs.stat(join(dirs.commonDir, "refs", "heads", name)).catch(() => null);
  return loose?.isFile() ? name : null;
}
