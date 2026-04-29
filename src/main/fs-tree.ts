import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import type { FsEntry, FsFileContent } from "@shared/types";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

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

export async function writeTextFile(path: string, content: string): Promise<FsFileContent> {
  await fs.writeFile(path, content, "utf8");
  return readTextFile(path);
}
