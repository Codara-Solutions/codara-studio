// "Open this file for the user": codara_open_file, Quick Open's picks outside
// the workspace and the desktop command. This module checks the request: the
// path must name a file an editor tab can show, as text or in the previewer
// its name picks (@shared/preview-kind, the table the tabs use). The file is
// read only far enough to tell what it holds, and its bytes are never
// returned, logged or kept. Electron-free so the unit suite can drive it.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { looksLikeText, previewKindForPath, previewReadsText, sniffPreviewContent, type PreviewKind } from "@shared/preview-kind";
import { FS_READ_BYTES_LIMIT_BYTES, FS_READ_TEXT_LIMIT_BYTES } from "@shared/types";

// The editor's own binary sniff (fs-tree readFileEx) looks for a NUL byte in
// the whole file; the start of it is enough to refuse a build output up
// front, and holds every signature sniffPreviewContent looks for.
const SNIFF_BYTES = 8 * 1024;

export type OpenFileCheck =
  | { ok: true; path: string; real: string; line?: number }
  | {
      ok: false;
      // "binary": no view of Studio shows what the file holds under its name.
      reason: "invalid" | "missing" | "directory" | "binary" | "too_large";
      message: string;
    };

const KIND_NOUNS: Record<PreviewKind, string> = {
  image: "an image",
  svg: "an SVG image",
  pdf: "a PDF",
  video: "a video",
  audio: "a recording",
  docx: "a Word document",
  pptx: "a presentation",
  spreadsheet: "a spreadsheet",
  whiteboard: "a whiteboard",
  html: "a web page",
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
  // The tab picks its view by the name asked for, so this does too.
  const kind = previewKindForPath(target);
  const viewer = kind !== null && !previewReadsText(kind);
  const limit = viewer ? FS_READ_BYTES_LIMIT_BYTES : FS_READ_TEXT_LIMIT_BYTES;
  if (size > limit) {
    return {
      ok: false,
      reason: "too_large",
      message: `the file is larger than ${Math.round(limit / (1024 * 1024))} MB, the most the ${viewer ? "viewer" : "editor"} opens`,
    };
  }
  const refusal = viewRefusal(kind, await readHead(real, size));
  if (refusal) return { ok: false, reason: "binary", message: refusal };
  // The tab keeps the name the agent asked for: a .env that links to a
  // config.txt is still a .env to the editor, which keeps its text away from
  // inline completion.
  return { ok: true, path: await kernelPath(target), real, ...(line !== undefined ? { line } : {}) };
}

/**
 * Why the view the name picks cannot show these bytes, or null when it can.
 * Bytes no signature names still open in a viewer, as the Explorer opens
 * them: the viewer says so itself when it cannot decode them.
 */
export function viewRefusal(kind: PreviewKind | null, head: Uint8Array): string | null {
  const sniffed = sniffPreviewContent(head);
  if (kind !== null && !previewReadsText(kind)) {
    if (sniffed) {
      return sniffed.kinds.includes(kind) ? null : `the file is ${sniffed.label}, not ${KIND_NOUNS[kind]}; the viewer cannot show it`;
    }
    if (head.length === 0) return `the file is empty, not ${KIND_NOUNS[kind]}; the viewer cannot show it`;
    return looksLikeText(head) ? `the file holds text, not ${KIND_NOUNS[kind]}; the viewer cannot show it` : null;
  }
  if (!head.includes(0)) return null;
  if (sniffed) return `the file is ${sniffed.label} but is not named like one; the editor cannot show it`;
  return "the file is binary and Studio has no viewer for it; the editor cannot show it";
}

async function readHead(file: string, size: number): Promise<Uint8Array> {
  const length = Math.min(size, SNIFF_BYTES);
  if (length === 0) return new Uint8Array(0);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
