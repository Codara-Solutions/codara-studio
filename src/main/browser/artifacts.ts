// Files the browser tools write for an agent instead of inlining them: a
// screenshot is returned as an image and as a path (for agents that cannot
// read image content), a long body is cut and its full text saved. Each
// kind keeps its newest files only.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { workspaceDataDir } from "../workspace-data";

export type BrowserArtifactKind =
  | "screenshots"
  | "network"
  | "console"
  | "snapshots"
  | "audits"
  | "traces"
  | "recordings"
  | "diffs";

export const ARTIFACTS_KEPT_PER_KIND = 200;

export function browserArtifactDir(workspaceId: string | null, kind: BrowserArtifactKind): string {
  return workspaceDataDir(workspaceId, "browser", kind);
}

function slug(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

/** Writes the file and returns its absolute path. */
export async function writeBrowserArtifact(
  workspaceId: string | null,
  kind: BrowserArtifactKind,
  input: { label: string; ext: string; data: Buffer | string },
): Promise<string> {
  const dir = browserArtifactDir(workspaceId, kind);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 6);
  const file = join(dir, `${stamp}-${random}-${slug(input.label)}.${input.ext.replace(/^\./, "")}`);
  await fs.writeFile(file, input.data);
  void pruneArtifacts(dir).catch(() => {});
  return file;
}

async function pruneArtifacts(dir: string): Promise<void> {
  const names = (await fs.readdir(dir)).sort();
  const excess = names.length - ARTIFACTS_KEPT_PER_KIND;
  for (const name of names.slice(0, Math.max(0, excess))) {
    await fs.rm(join(dir, name), { force: true });
  }
}

export interface CompactText {
  text: string;
  truncated: boolean;
  totalChars: number;
  /** Where the full text was saved, when it was cut. */
  fullPath?: string;
}

export const DEFAULT_COMPACT_CHARS = 4_000;

/**
 * Keep a result small enough for any model's context: the head of the text,
 * a note on what was cut, and the full text in a file.
 */
export async function compactText(
  workspaceId: string | null,
  kind: BrowserArtifactKind,
  label: string,
  text: string,
  maxChars = DEFAULT_COMPACT_CHARS,
  ext = "txt",
): Promise<CompactText> {
  if (text.length <= maxChars) return { text, truncated: false, totalChars: text.length };
  const fullPath = await writeBrowserArtifact(workspaceId, kind, { label, ext, data: text });
  return {
    text: `${text.slice(0, maxChars)}\n[cut at ${maxChars} of ${text.length} characters; full text in ${fullPath}]`,
    truncated: true,
    totalChars: text.length,
    fullPath,
  };
}
