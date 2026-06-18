import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { FileListResult, FsEntry, FsFileContent, FsReadResult, PlanFile } from "@shared/types";
import { FS_READ_TEXT_LIMIT_BYTES } from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";

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

export async function writeTextFile(path: string, content: string): Promise<FsFileContent> {
  await writeFileAtomic(path, content);
  return readTextFile(path);
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
