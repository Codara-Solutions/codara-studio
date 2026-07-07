import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { FileListResult, FsEntry, FsFileContent, FsReadResult, FsWriteResult, PlanFile } from "@shared/types";
import { FS_READ_TEXT_LIMIT_BYTES } from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";
import { recordEditorWrite } from "./editor-write-tracker";

const MAX_TEXT_FILE_BYTES = FS_READ_TEXT_LIMIT_BYTES;
const MAX_FILE_LIST_FILES = 10000;
const MAX_PLAN_FILES = 200;
const MAX_PLAN_SCAN_DEPTH = 5;
const SKIPPED_PLAN_DIRS = new Set([".git", "node_modules", "out", "dist", "build", ".next", ".turbo"]);
const SKIPPED_FILE_LIST_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

export async function listDir(dir: string): Promise<FsEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return [];
    throw err;
  }

  const out: FsEntry[] = [];
  for (const e of entries) {
    const isDir = e.isDirectory() || (e.isSymbolicLink() && await isDirSafe(join(dir, e.name)));
    out.push({
      name: e.name,
      path: join(dir, e.name),
      isDir,
      ext: isDir ? undefined : extname(e.name).replace(/^\./, "").toLowerCase() || undefined,
    });
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return out;
}

export async function listFiles(root: string): Promise<FileListResult> {
  const files: FsEntry[] = [];
  await collectFiles(root, files, root);
  files.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
  );
  return {
    files,
    truncated: files.length >= MAX_FILE_LIST_FILES,
  };
}

async function isDirSafe(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function readTextFile(path: string): Promise<FsFileContent> {
  const st = await fs.stat(path);
  if (!st.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (st.size > MAX_TEXT_FILE_BYTES) {
    throw new Error("File is too large to open in the editor.");
  }

  const buffer = await fs.readFile(path);
  if (buffer.includes(0)) {
    throw new Error("Binary files cannot be opened in the editor.");
  }

  return {
    path,
    content: buffer.toString("utf8"),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

// Discriminated-union read used by the CodeMirror editor so it can render a
// dedicated banner for binary/oversize files instead of throwing. Mirrors
// the terax-scout pattern (kind: text | binary | toolarge).
export async function readFileEx(path: string): Promise<FsReadResult> {
  const st = await fs.stat(path);
  if (!st.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (st.size > MAX_TEXT_FILE_BYTES) {
    return { kind: "toolarge", path, size: st.size, limit: MAX_TEXT_FILE_BYTES };
  }
  const buffer = await fs.readFile(path);
  if (buffer.includes(0)) {
    return { kind: "binary", path, size: st.size };
  }
  return {
    kind: "text",
    path,
    content: buffer.toString("utf8"),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

export async function listMarkdownFiles(root: string): Promise<PlanFile[]> {
  const files: PlanFile[] = [];
  await collectMarkdownFiles(root, root, 0, files);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" }));
}

// Conflict-aware editor save. When `expectedMtimeMs` is provided (autosave),
// the write is refused if the file on disk changed since the buffer was
// loaded — an agent in a terminal, a git operation, or a checkpoint restore
// may have rewritten it, and a stale buffer must not silently win. Manual
// Ctrl+S omits the option and always writes (explicit user intent).
export async function writeTextFile(
  path: string,
  content: string,
  opts?: { expectedMtimeMs?: number },
): Promise<FsWriteResult> {
  if (opts?.expectedMtimeMs != null) {
    let before;
    try {
      before = await fs.stat(path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "conflict", path, reason: "deleted", diskMtimeMs: null };
      }
      throw err;
    }
    if (before.mtimeMs !== opts.expectedMtimeMs) {
      return { kind: "conflict", path, reason: "modified", diskMtimeMs: before.mtimeMs };
    }
  }
  await writeFileAtomic(path, content);
  const st = await fs.stat(path);
  recordEditorWrite(path, st.mtimeMs);
  return { kind: "ok", path, size: st.size, mtimeMs: st.mtimeMs };
}

export async function renameFile(path: string, newName: string): Promise<FsEntry> {
  const cleanName = sanitizeName(newName);

  const st = await fs.stat(path);

  const nextPath = join(dirname(path), cleanName);
  if (nextPath === path) {
    return makeEntry(nextPath, st.isDirectory());
  }

  // Guard against accidental clobber.
  try {
    await fs.access(nextPath);
    throw new Error(`A file named "${cleanName}" already exists in this folder.`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  await fs.rename(path, nextPath);
  return makeEntry(nextPath, st.isDirectory());
}

export async function deleteFile(path: string): Promise<void> {
  // Allow trashing both files and directories.
  await shell.trashItem(path);
}

// Copy a set of external paths (files or folders) into `destDir`, the way an
// OS drag-and-drop "copy" works. Each source keeps its own basename; a name
// collision inside the destination is resolved by appending " (1)", " (2)", …
// before the extension rather than overwriting. Directories are copied
// recursively. Returns an FsEntry for every entry actually created so the
// renderer can refresh / reveal them.
export async function importEntries(destDir: string, sourcePaths: string[]): Promise<FsEntry[]> {
  const destStat = await fs.stat(destDir);
  if (!destStat.isDirectory()) {
    throw new Error("Drop target is not a folder.");
  }

  const created: FsEntry[] = [];
  for (const src of sourcePaths) {
    if (typeof src !== "string" || src.length === 0) continue;

    let srcStat: import("node:fs").Stats;
    try {
      srcStat = await fs.stat(src);
    } catch {
      // Source vanished between drop and copy — skip it rather than abort the
      // whole batch.
      continue;
    }

    const isDir = srcStat.isDirectory();
    const name = basename(src);
    if (!name) continue;

    const target = await uniqueDestPath(destDir, name);

    // Refuse to copy a folder into itself or one of its own descendants — that
    // recurses forever (and `fs.cp` would error mid-copy, leaving a partial
    // tree behind).
    if (isDir) {
      const rel = relative(src, target);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        throw new Error("Cannot copy a folder into itself.");
      }
    }

    await fs.cp(src, target, { recursive: true, errorOnExist: false, force: false });
    created.push(await makeEntry(target, isDir));
  }
  return created;
}

// Move a set of workspace paths (files or folders) into `destDir`, the way a
// drag-and-drop "move" works inside a file manager. Each source keeps its own
// basename. Unlike importEntries — a copy that resolves collisions by appending
// " (n)" — a move is rename-like: a name collision in the destination is an
// ERROR (mirroring `renameFile`'s clobber guard), never a silent overwrite or
// auto-suffix. Drops that wouldn't change anything are skipped silently rather
// than erroring: a source whose current parent already IS `destDir`, or a
// folder dropped onto its own row (`src === destDir`). Cross-volume moves fall
// back to a recursive copy + delete because `fs.rename` rejects with EXDEV
// across devices. Returns an FsEntry for every entry actually moved so the
// renderer can refresh both the destination and each source's former parent.
export async function moveEntries(destDir: string, sourcePaths: string[]): Promise<FsEntry[]> {
  const destStat = await fs.stat(destDir);
  if (!destStat.isDirectory()) {
    throw new Error("Drop target is not a folder.");
  }

  const moved: FsEntry[] = [];
  for (const src of sourcePaths) {
    if (typeof src !== "string" || src.length === 0) continue;

    let srcStat: import("node:fs").Stats;
    try {
      srcStat = await fs.stat(src);
    } catch {
      // Source vanished between drop and move — skip it rather than abort the
      // whole batch (matches importEntries).
      continue;
    }

    const isDir = srcStat.isDirectory();
    const name = basename(src);
    if (!name) continue;

    // No-op drops: onto the folder the source already lives in, or (for a
    // folder) onto its own row. Neither is an error — silently skip so the
    // renderer shows no banner. Checked before the descendant guard below so a
    // folder dropped on itself isn't misreported as "into itself".
    if (dirname(src) === destDir || src === destDir) continue;

    const target = join(destDir, name);

    // Refuse to move a folder into itself or one of its own descendants — that
    // would strand the subtree mid-rename.
    if (isDir) {
      const rel = relative(src, target);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        throw new Error("Cannot move a folder into itself.");
      }
    }

    // A move never clobbers or auto-suffixes: refuse when the destination
    // already holds an entry with this basename (mirrors renameFile). The one
    // exception is when `target` IS the source itself under a different path
    // spelling — a case-insensitive filesystem, an NFC/NFD unicode difference,
    // or a symlinked root can make the raw no-op check above miss an own-parent
    // drop. Same device + inode ⇒ it's the same file, so treat it as the silent
    // no-op it is instead of a spurious "already exists" error.
    if (await pathExists(target)) {
      let sameFile = false;
      try {
        const targetStat = await fs.stat(target);
        sameFile = targetStat.dev === srcStat.dev && targetStat.ino === srcStat.ino;
      } catch {
        // Fall through and report the collision if we can't stat the target.
      }
      if (sameFile) continue;
      throw new Error(`A file named "${name}" already exists in this folder.`);
    }

    try {
      await fs.rename(src, target);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw err;
      // Cross-device move: `fs.rename` can't span volumes, so copy the tree
      // over then delete the original. The pathExists guard above already
      // ruled out an existing target, so this can't clobber.
      await fs.cp(src, target, { recursive: true, errorOnExist: false, force: false });
      await fs.rm(src, { recursive: true, force: true });
    }
    moved.push(await makeEntry(target, isDir));
  }
  return moved;
}

// Pick a non-colliding path inside `destDir` for `name`. Returns `destDir/name`
// when free, else inserts a " (n)" suffix before the extension.
async function uniqueDestPath(destDir: string, name: string): Promise<string> {
  const direct = join(destDir, name);
  if (!(await pathExists(direct))) return direct;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const candidate = join(destDir, `${stem} (${i})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Too many files named like "${name}" already exist here.`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function createFile(parentPath: string, name: string): Promise<FsEntry> {
  const cleanName = sanitizeName(name);
  const target = join(parentPath, cleanName);
  // wx mode = exclusive create; fail if exists.
  const handle = await fs.open(target, "wx");
  await handle.close();
  return makeEntry(target, false);
}

export async function createFolder(parentPath: string, name: string): Promise<FsEntry> {
  const cleanName = sanitizeName(name);
  const target = join(parentPath, cleanName);
  await fs.mkdir(target, { recursive: false });
  return makeEntry(target, true);
}

function sanitizeName(name: string): string {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Name cannot be empty.");
  if (cleanName !== basename(cleanName)) {
    throw new Error("Name cannot include path separators.");
  }
  if (cleanName === "." || cleanName === "..") {
    throw new Error("Name cannot be '.' or '..'.");
  }
  // Reject reserved Windows characters that node will accept silently.
  if (/[<>:"|?*]/.test(cleanName)) {
    throw new Error("Name contains invalid characters.");
  }
  return cleanName;
}

async function makeEntry(path: string, isDir: boolean): Promise<FsEntry> {
  const name = basename(path);
  return {
    name,
    path,
    isDir,
    ext: isDir ? undefined : extname(name).replace(/^\./, "").toLowerCase() || undefined,
  };
}

async function collectFiles(
  dir: string,
  files: FsEntry[],
  root: string,
): Promise<void> {
  if (files.length >= MAX_FILE_LIST_FILES) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return;
    throw err;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILE_LIST_FILES) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== root && SKIPPED_FILE_LIST_DIRS.has(entry.name)) continue;
      await collectFiles(path, files, root);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      name: entry.name,
      path,
      isDir: false,
      ext: extname(entry.name).replace(/^\./, "").toLowerCase() || undefined,
    });
  }
}

async function collectMarkdownFiles(
  root: string,
  dir: string,
  depth: number,
  files: PlanFile[],
): Promise<void> {
  if (files.length >= MAX_PLAN_FILES || depth > MAX_PLAN_SCAN_DEPTH) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return;
    throw err;
  }

  for (const entry of entries) {
    if (files.length >= MAX_PLAN_FILES) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_PLAN_DIRS.has(entry.name)) {
        await collectMarkdownFiles(root, path, depth + 1, files);
      }
      continue;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    files.push({
      name: entry.name,
      path,
      relativePath: relative(root, path) || entry.name,
    });
  }
}
