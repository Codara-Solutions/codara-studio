// Where a worktree's setup record lives, and the two things removal needs
// from it: taking linked folders out before the worktree is deleted, and
// telling copies Codara made apart from files someone wrote.
//
// The record sits in the worktree's own git admin folder
// (<repo>/.git/worktrees/<name>/codara-setup), so nothing shows up in the
// checkout and `git worktree remove` or `prune` deletes it with the worktree.
//
// Node built-ins only: git-worktrees.ts and agent-worktrees.ts import this
// and their tests bundle them without the rest of the setup code.

import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const SETUP_DIR_NAME = "codara-setup";
export const SETUP_MANIFEST_FILE = "manifest.json";
export const SETUP_STATUS_FILE = "status.json";
export const SETUP_LOG_FILE = "setup.log";

export interface SetupManifestCopy {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SetupManifestLink {
  path: string;
  target: string;
}

export interface SetupManifest {
  version: 1;
  sourceRoot: string;
  // Every file Codara copied, as it was right after the copy.
  copies: SetupManifestCopy[];
  // Relative links inside copied folders, with the text they point at.
  copiedLinks?: SetupManifestLink[];
  links: SetupManifestLink[];
}

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The git admin folder of a linked worktree, read from its `.git` file.
 * Null for a main checkout (where `.git` is a folder) or anything else.
 */
export async function worktreeGitDir(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, ".git");
  const stat = await fsp.lstat(dotGit).catch(() => null);
  if (!stat?.isFile() || stat.size > 4096) return null;
  const text = await fsp.readFile(dotGit, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return null;
  const gitDir = isAbsolute(match[1]) ? match[1] : resolve(worktreePath, match[1]);
  const dirStat = await fsp.stat(gitDir).catch(() => null);
  if (!dirStat?.isDirectory()) return null;
  // A linked worktree's admin folder always has these two files.
  const [commondir, gitdirFile] = await Promise.all([
    fsp.stat(join(gitDir, "commondir")).catch(() => null),
    fsp.stat(join(gitDir, "gitdir")).catch(() => null),
  ]);
  if (!commondir?.isFile() || !gitdirFile?.isFile()) return null;
  return gitDir;
}

export async function setupDirFor(worktreePath: string): Promise<string | null> {
  const gitDir = await worktreeGitDir(worktreePath);
  return gitDir ? join(gitDir, SETUP_DIR_NAME) : null;
}

function isManifest(value: unknown): value is SetupManifest {
  const record = value as Partial<SetupManifest> | null;
  return (
    !!record &&
    record.version === 1 &&
    typeof record.sourceRoot === "string" &&
    Array.isArray(record.copies) &&
    Array.isArray(record.links)
  );
}

export async function readSetupManifest(worktreePath: string): Promise<SetupManifest | null> {
  const dir = await setupDirFor(worktreePath);
  if (!dir) return null;
  const file = join(dir, SETUP_MANIFEST_FILE);
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MANIFEST_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!isManifest(parsed)) return null;
    return {
      version: 1,
      sourceRoot: parsed.sourceRoot,
      copies: parsed.copies.filter(
        (entry) =>
          entry && typeof entry.path === "string" && typeof entry.size === "number" && typeof entry.mtimeMs === "number",
      ),
      copiedLinks: (Array.isArray(parsed.copiedLinks) ? parsed.copiedLinks : []).filter(
        (entry) => entry && typeof entry.path === "string" && typeof entry.target === "string",
      ),
      links: parsed.links.filter((entry) => entry && typeof entry.path === "string" && typeof entry.target === "string"),
    };
  } catch {
    return null;
  }
}

function safeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function withoutLongPathPrefix(value: string): string {
  return value.replace(/^\\\\\?\\/, "");
}

async function linkStillOurs(absolute: string, target: string): Promise<boolean> {
  const pointsAt = await linkTarget(absolute);
  if (pointsAt === null) return false;
  const normalize = (value: string) => resolve(withoutLongPathPrefix(value)).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(pointsAt) === normalize(target);
}

/** What the link or junction at `absolute` points at; null when it is not one. */
async function linkTarget(absolute: string): Promise<string | null> {
  const stat = await fsp.lstat(absolute).catch(() => null);
  // A junction reads as a symbolic link to lstat on Windows.
  if (!stat?.isSymbolicLink()) return null;
  return fsp.readlink(absolute).catch(() => null);
}

/** Removes a link or junction itself, never what it points at. */
export async function removeLinkEntry(absolute: string): Promise<boolean> {
  try {
    await fsp.unlink(absolute);
    return true;
  } catch {
    // Some Windows builds want rmdir for a junction. rmdir never deletes
    // what a link points at, and fails on a real folder that is not empty.
    try {
      await fsp.rmdir(absolute);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Takes out the folder links setup made, so removing the worktree can never
 * reach into the main checkout through them. A link or junction at a path
 * setup linked goes even when something repointed it since: git for Windows
 * follows any junction while deleting, whatever it points at. Removing a
 * link never touches what it points at; each comes back with the target it
 * had when the removal fails.
 */
export async function releaseWorktreeLinks(worktreePath: string): Promise<SetupManifestLink[]> {
  const manifest = await readSetupManifest(worktreePath).catch(() => null);
  if (!manifest) return [];
  const released: SetupManifestLink[] = [];
  for (const link of manifest.links) {
    if (!safeRelative(link.path)) continue;
    const absolute = join(worktreePath, ...link.path.split("/"));
    const pointsAt = await linkTarget(absolute);
    if (pointsAt === null) continue;
    const target = (await linkStillOurs(absolute, link.target))
      ? link.target
      : resolve(dirname(absolute), withoutLongPathPrefix(pointsAt));
    if (await removeLinkEntry(absolute)) released.push({ path: link.path, target });
  }
  return released;
}

/** True when no setup writes in the worktree any more. */
let beforeRemoval: ((worktreePath: string) => Promise<boolean>) | null = null;

/** Lets the setup service stop a setup still running in a worktree about to go. */
export function setBeforeWorktreeRemoval(hook: ((worktreePath: string) => Promise<boolean>) | null): void {
  beforeRemoval = hook;
}

/**
 * Stops the worktree's setup, then releases its links. For every removal
 * path. Throws, with the links put back, when the setup would not stop or a
 * link it made is still there: git for Windows can follow a junction while
 * deleting the worktree and empty the main checkout's folder.
 */
export async function prepareWorktreeRemoval(worktreePath: string): Promise<SetupManifestLink[]> {
  if (beforeRemoval && !(await beforeRemoval(worktreePath).catch(() => false))) {
    throw new Error("The worktree's setup did not stop in time. Stop it from the setup tray, then remove the worktree again.");
  }
  const released = await releaseWorktreeLinks(worktreePath);
  const manifest = await readSetupManifest(worktreePath).catch(() => null);
  for (const link of manifest?.links ?? []) {
    if (!safeRelative(link.path)) continue;
    if ((await linkTarget(join(worktreePath, ...link.path.split("/")))) !== null) {
      await restoreWorktreeLinks(worktreePath, released);
      throw new Error(
        `Could not take out the linked folder ${link.path} before removing the worktree. Close what uses it, then try again.`,
      );
    }
  }
  return released;
}

/** Puts back links released for a removal that then failed. */
export async function restoreWorktreeLinks(worktreePath: string, links: readonly SetupManifestLink[]): Promise<void> {
  for (const link of links) {
    if (!safeRelative(link.path)) continue;
    const absolute = join(worktreePath, ...link.path.split("/"));
    if (await fsp.lstat(absolute).catch(() => null)) continue;
    const target = await fsp.stat(link.target).catch(() => null);
    if (!target?.isDirectory()) continue;
    try {
      await fsp.symlink(link.target, absolute, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Best effort: the worktree still works, only without that folder.
    }
  }
}

const REGENERABLE_WALK_LIMIT = 20_000;

/**
 * The ignored entries (as `git ls-files --others --ignored --directory`
 * lists them) that are only what setup put there: a folder link, a copied
 * file nobody changed since, or a folder holding nothing else. Removing them
 * loses nothing, because the main checkout still has the originals.
 */
export async function setupProvidedEntries(worktreePath: string, entries: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const manifest = await readSetupManifest(worktreePath).catch(() => null);
  if (!manifest || (!manifest.copies.length && !manifest.links.length)) return out;
  const copies = new Map(manifest.copies.map((copy) => [copy.path, copy]));
  const links = new Set(manifest.links.map((link) => link.path));
  const copiedLinks = new Map((manifest.copiedLinks ?? []).map((link) => [link.path, link.target]));
  const unchangedFile = async (relative: string): Promise<boolean> => {
    const recorded = copies.get(relative);
    if (!recorded) return false;
    const stat = await fsp.lstat(join(worktreePath, ...relative.split("/"))).catch(() => null);
    return !!stat?.isFile() && stat.size === recorded.size && Math.abs(stat.mtimeMs - recorded.mtimeMs) < 1;
  };
  let budget = REGENERABLE_WALK_LIMIT;
  const onlyCopies = async (relative: string): Promise<boolean> => {
    const children = await fsp.readdir(join(worktreePath, ...relative.split("/")), { withFileTypes: true }).catch(() => null);
    if (!children) return false;
    for (const child of children) {
      budget -= 1;
      if (budget < 0) return false;
      const path = `${relative}/${child.name}`;
      if (child.isDirectory()) {
        if (!(await onlyCopies(path))) return false;
      } else if (child.isSymbolicLink()) {
        if (links.has(path)) continue;
        const recorded = copiedLinks.get(path);
        const pointsAt = recorded === undefined ? null : await fsp.readlink(join(worktreePath, ...path.split("/"))).catch(() => null);
        if (recorded === undefined || pointsAt !== recorded) return false;
      } else if (!(await unchangedFile(path))) {
        return false;
      }
    }
    return true;
  };
  for (const entry of entries) {
    const relative = entry.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!safeRelative(relative)) continue;
    if (links.has(relative)) {
      const link = manifest.links.find((candidate) => candidate.path === relative)!;
      if (await linkStillOurs(join(worktreePath, ...relative.split("/")), link.target)) out.add(entry);
      continue;
    }
    if (entry.endsWith("/")) {
      if (await onlyCopies(relative)) out.add(entry);
    } else if (await unchangedFile(relative)) {
      out.add(entry);
    }
  }
  return out;
}
