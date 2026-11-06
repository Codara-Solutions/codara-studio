import { createHash, type Hash } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// Ignored files a fresh checkout cannot bring back (data/, .env.local) are
// copied out of a worktree before it is removed, into
// <root>/<YYYY-MM-DD>/<repo>--<branch>/ with their paths kept. The copy is
// counted again on the far side, files and bytes, before anything is
// deleted: a copy that does not match is removed and the worktree stays.
// Day folders older than ARCHIVE_RETENTION_DAYS go at startup.

export const ARCHIVE_RETENTION_DAYS = 30;

/** ~/.codarastudio/worktree-archive, under Codara's own home. */
export function worktreeArchiveRoot(home: string): string {
  return join(home, "worktree-archive");
}
// Room left on the disk after the copy, so an archive never fills it.
const FREE_MARGIN_BYTES = 1024 * 1024 * 1024;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

export interface ArchiveResult {
  dir: string;
  files: number;
  bytes: number;
}

interface Tally {
  files: number;
  bytes: number;
  // Of the source only: every entry's kind, size, times and inode, and each
  // link's target, so a change during the copy shows (a link swapped for
  // another counts the same in files and bytes).
  digest?: Hash;
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "worktree";
}

// The entries as git lists them, folders with a trailing slash; one inside
// another listed folder is copied with that folder. Names are kept exactly:
// on Linux "a\\b" and "a/b" are two files.
function topEntries(entries: readonly string[]): string[] {
  const clean = [...new Set(entries.map((entry) => entry.replace(/\/+$/, "")).filter(Boolean))].sort();
  return clean.filter((entry, index) => !clean.slice(0, index).some((other) => entry.startsWith(`${other}/`)));
}

async function tally(path: string, into: Tally): Promise<void> {
  const info = await fsp.lstat(path);
  const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  if (info.isSymbolicLink()) {
    into.files += 1;
    into.digest?.update(`${path}\0l\0${await fsp.readlink(path)}\0${stamp}\0`);
  } else if (info.isFile()) {
    into.files += 1;
    into.bytes += info.size;
    into.digest?.update(`${path}\0f\0${stamp}\0`);
  } else if (info.isDirectory()) {
    into.digest?.update(`${path}\0d\0`);
    for (const name of await fsp.readdir(path)) await tally(join(path, name), into);
  } else {
    throw new Error(`${path} is not a file, folder or link`);
  }
}

// Links are copied as links, never followed: one may point anywhere.
async function copyTree(from: string, to: string): Promise<void> {
  const info = await fsp.lstat(from);
  if (info.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(from), to);
  } else if (info.isFile()) {
    // A clone where the file system can (btrfs, APFS, XFS), a copy otherwise.
    await fsp.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await fsp.chmod(to, info.mode & 0o777);
  } else if (info.isDirectory()) {
    // Owner-only and writable whatever the original's mode, so the copy can
    // fill it and the pruning can empty it.
    await fsp.mkdir(to, { mode: 0o700 });
    for (const name of await fsp.readdir(from)) await copyTree(join(from, name), join(to, name));
  } else {
    throw new Error(`${from} is not a file, folder or link`);
  }
}

/** A new folder for one worktree's archive; a second one the same day gets -2, -3, ... */
export async function archiveFolderFor(root: string, now: Date, repoName: string, branch: string | null): Promise<string> {
  const day = join(root, now.toISOString().slice(0, 10));
  await fsp.mkdir(day, { recursive: true, mode: 0o700 });
  const base = `${safeName(repoName)}--${safeName(branch ?? "detached")}`;
  for (let n = 1; n < 1000; n += 1) {
    const dir = join(day, n === 1 ? base : `${base}-${n}`);
    try {
      await fsp.mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
  }
  throw new Error("no free archive folder name is left for today");
}

/**
 * Copies `entries` (relative to `worktree`) into a new archive folder and
 * checks the copy. Throws, with the partial copy removed, when anything does
 * not match; the worktree is never touched.
 */
export async function archiveIgnoredFiles(input: {
  worktree: string;
  entries: readonly string[];
  root: string;
  repoName: string;
  branch: string | null;
  now: Date;
  // Tests change the source here, between the copy and its last count.
  afterCopy?: () => Promise<void>;
}): Promise<ArchiveResult> {
  const base = resolve(input.worktree);
  const entries = topEntries(input.entries);
  const sourceTally = async (): Promise<Tally & { digest: Hash }> => {
    const out = { files: 0, bytes: 0, digest: createHash("sha256") };
    for (const entry of entries) {
      const from = resolve(base, entry);
      if (!from.startsWith(`${base}${sep}`)) throw new Error(`${entry} is outside the worktree`);
      await tally(from, out);
    }
    return out;
  };
  const source = await sourceTally();
  const before = source.digest.digest("hex");
  await fsp.mkdir(input.root, { recursive: true, mode: 0o700 });
  const free = await fsp.statfs(input.root).then(
    (stats) => stats.bavail * stats.bsize,
    () => null,
  );
  if (free === null) throw new Error("the free space on the archive's disk could not be read");
  if (free < source.bytes + FREE_MARGIN_BYTES) {
    throw new Error(`the archive's disk has too little free space for ${source.bytes} bytes`);
  }
  const dir = await archiveFolderFor(input.root, input.now, input.repoName, input.branch);
  try {
    const copied: Tally = { files: 0, bytes: 0 };
    for (const entry of entries) {
      const to = join(dir, entry);
      await fsp.mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyTree(resolve(base, entry), to);
      await tally(to, copied);
    }
    if (copied.files !== source.files || copied.bytes !== source.bytes) {
      throw new Error(
        `the copy holds ${copied.files} files and ${copied.bytes} bytes, the worktree ${source.files} and ${source.bytes}`,
      );
    }
    await input.afterCopy?.();
    if ((await sourceTally()).digest.digest("hex") !== before) throw new Error("they changed while they were being copied");
    return { dir, ...copied };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** Removes the day folders under `root` older than the retention. Returns how many went. */
export async function pruneWorktreeArchive(root: string, now: Date, days = ARCHIVE_RETENTION_DAYS): Promise<number> {
  const names = await fsp.readdir(root).catch(() => [] as string[]);
  const cutoff = now.getTime() - days * 24 * 60 * 60_000;
  let removed = 0;
  for (const name of names) {
    if (!DAY_NAME.test(name)) continue;
    // Counted from the end of that UTC day, as the recovery refs are.
    const end = Date.parse(`${name}T00:00:00Z`) + 24 * 60 * 60_000;
    if (!Number.isFinite(end) || end >= cutoff) continue;
    const path = join(root, name);
    if (!(await fsp.lstat(path)).isDirectory()) continue;
    await fsp.rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
