import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { FsEntry, FsFileContent, PlanFile } from "@shared/types";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PLAN_FILES = 200;
const MAX_PLAN_SCAN_DEPTH = 5;
const SKIPPED_PLAN_DIRS = new Set([".git", "node_modules", "out", "dist", "build", ".next", ".turbo"]);

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

export async function listMarkdownFiles(root: string): Promise<PlanFile[]> {
  const files: PlanFile[] = [];
  await collectMarkdownFiles(root, root, 0, files);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" }));
}

export async function writeTextFile(path: string, content: string): Promise<FsFileContent> {
  await fs.writeFile(path, content, "utf8");
  return readTextFile(path);
}

export async function renameFile(path: string, newName: string): Promise<FsEntry> {
  const cleanName = newName.trim();
  if (!cleanName) throw new Error("File name cannot be empty.");
  if (cleanName !== basename(cleanName)) {
    throw new Error("File name cannot include path separators.");
  }

  const st = await fs.stat(path);
  if (!st.isFile()) throw new Error("Only files can be renamed from the Explorer.");

  const nextPath = join(dirname(path), cleanName);
  if (nextPath === path) {
    return makeFileEntry(nextPath);
  }

  await fs.rename(path, nextPath);
  return makeFileEntry(nextPath);
}

export async function deleteFile(path: string): Promise<void> {
  const st = await fs.stat(path);
  if (!st.isFile()) throw new Error("Only files can be deleted from the Explorer.");
  await shell.trashItem(path);
}

async function makeFileEntry(path: string): Promise<FsEntry> {
  const st = await fs.stat(path);
  if (!st.isFile()) throw new Error("Path is not a file.");
  const name = basename(path);
  return {
    name,
    path,
    isDir: false,
    ext: extname(name).replace(/^\./, "").toLowerCase() || undefined,
  };
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
