// Attempt-scoped Git diff capture. A temporary index snapshots the complete
// working tree (including untracked files) against the worker's pre-launch
// checkpoint without touching the user's real index.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { WorkerDiffFile, WorkerDiffSummary } from "@shared/types";
import { runGit } from "../git-exec";
import { isRemotePath } from "@shared/remote";

// Enough detail to inspect a substantial worker without turning one expanded
// chat row into hundreds of DOM nodes. Totals always cover every file.
const MAX_DIFF_FILES = 50;

export interface CapturedWorkerDiff {
  summary: WorkerDiffSummary;
  patch: string;
}

function safePathspec(cwd: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const path = (isAbsolute(trimmed) ? relative(cwd, trimmed) : trimmed).replace(/\\/g, "/");
  if (!path || path === ".." || path.startsWith("../") || path.includes("\0")) return null;
  return path;
}

function parseCount(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function parseWorkerDiffNumstat(value: string): WorkerDiffSummary {
  const files: WorkerDiffFile[] = [];
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();
    if (!path) continue;
    const fileAdditions = parseCount(added);
    const fileDeletions = parseCount(deleted);
    additions += fileAdditions;
    deletions += fileDeletions;
    fileCount += 1;
    if (files.length < MAX_DIFF_FILES) {
      files.push({
        path,
        additions: fileAdditions,
        deletions: fileDeletions,
        ...(added === "-" || deleted === "-" ? { binary: true } : {}),
      });
    }
  }
  return { fileCount, additions, deletions, files };
}

export async function captureWorkerDiff(input: {
  cwd: string;
  baseSha: string | null | undefined;
  paths?: string[];
}): Promise<CapturedWorkerDiff | null> {
  if (!input.cwd || !input.baseSha || isRemotePath(input.cwd)) return null;
  const pathspecs = [...new Set((input.paths ?? []).map((path) => safePathspec(input.cwd, path)).filter(Boolean))] as string[];
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "codara-worker-diff-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: join(tempDir, "index"),
    };
    await runGit(input.cwd, ["read-tree", input.baseSha], { env });
    const scope = pathspecs.length > 0 ? ["--", ...pathspecs] : [];
    // Live refreshes often own only one or two declared files. Limit the
    // temporary staging walk to those paths instead of rescanning a large
    // repository after every edit tool.
    await runGit(input.cwd, ["add", "-A", ...scope], { env });
    const { stdout: numstat } = await runGit(
      input.cwd,
      ["diff", "--cached", "--numstat", "--no-renames", input.baseSha, ...scope],
      { env },
    );
    const { stdout: patch } = await runGit(
      input.cwd,
      ["diff", "--cached", "--binary", "--no-renames", input.baseSha, ...scope],
      { env },
    );
    return { summary: parseWorkerDiffNumstat(numstat), patch };
  } catch {
    return null;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
