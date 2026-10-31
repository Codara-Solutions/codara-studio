// An agent's "open this file for the user" (the codara_open_file MCP tool).
// This module checks the request: the path must name a text file the editor
// can show. The file's text is read only far enough to tell text from binary
// and is never returned, logged or kept. Electron-free so the unit suite can
// drive it.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FS_READ_TEXT_LIMIT_BYTES } from "@shared/types";

// The editor's own binary sniff (fs-tree readFileEx) looks for a NUL byte in
// the whole file; the start of it is enough to refuse an image or a build
// output up front.
const BINARY_SNIFF_BYTES = 8 * 1024;

export type OpenFileCheck =
  | { ok: true; path: string; real: string; line?: number }
  | {
      ok: false;
      reason: "invalid" | "missing" | "directory" | "binary" | "too_large";
      message: string;
    };

const PARENT_SEGMENT_RE = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * The path with its ".." resolved the way the kernel reads it: the folders
 * first, links included, then "..". path.normalize would cancel "link/.."
 * without looking at the link and name another file. Paths without ".." keep
 * their spelling (a folder link the user opened stays as they named it).
 */
export async function kernelPath(p: string): Promise<string> {
  if (!PARENT_SEGMENT_RE.test(p)) return path.normalize(p);
  try {
    return path.join(await fsp.realpath(path.dirname(p)), path.basename(p));
  } catch {
    return path.normalize(p);
  }
}

export interface OpenFileDeps {
  homeDir?: () => string;
}

/** A 1-based line, or undefined when absent. Throws a message for a bad one. */
function readLine(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10_000_000) {
    throw new Error("line must be a whole number, 1 or more");
  }
  return raw;
}

export async function checkOpenFile(rawPath: unknown, rawLine: unknown, deps: OpenFileDeps = {}): Promise<OpenFileCheck> {
  // Never trimmed: "notes.txt " is another file than "notes.txt".
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.length > 4096 || rawPath.includes("\0")) {
    return { ok: false, reason: "invalid", message: "path must be a file path" };
  }
  let line: number | undefined;
  try {
    line = readLine(rawLine);
  } catch (error) {
    return { ok: false, reason: "invalid", message: (error as Error).message };
  }
  let target = rawPath;
  if (/^~(?=[\\/]|$)/.test(target)) target = path.join((deps.homeDir ?? os.homedir)(), target.slice(1));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || !path.isAbsolute(target)) {
    return { ok: false, reason: "invalid", message: "path must be an absolute path on this computer" };
  }
  let real: string;
  let size: number;
  try {
    real = await fsp.realpath(target);
    const stat = await fsp.stat(real);
    if (stat.isDirectory()) {
      return { ok: false, reason: "directory", message: "that path is a folder, not a file" };
    }
    if (!stat.isFile()) return { ok: false, reason: "missing", message: "that path is not a regular file" };
    size = stat.size;
  } catch {
    return { ok: false, reason: "missing", message: "file not found" };
  }
  if (size > FS_READ_TEXT_LIMIT_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `the file is larger than ${Math.round(FS_READ_TEXT_LIMIT_BYTES / (1024 * 1024))} MB, the most the editor opens`,
    };
  }
  if (await startsBinary(real, size)) {
    return { ok: false, reason: "binary", message: "the file is binary, not text; the editor cannot show it" };
  }
  // The tab keeps the name the agent asked for: a .env that links to a
  // config.txt is still a .env to the editor, which keeps its text away from
  // inline completion.
  return { ok: true, path: await kernelPath(target), real, ...(line !== undefined ? { line } : {}) };
}

async function startsBinary(file: string, size: number): Promise<boolean> {
  const length = Math.min(size, BINARY_SNIFF_BYTES);
  if (length === 0) return false;
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
