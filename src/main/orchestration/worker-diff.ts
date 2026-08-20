// Attempt-scoped Git diff capture. A temporary index snapshots the complete
// working tree (including untracked files) against the worker's pre-launch
// checkpoint without touching the user's real index.

import { execFile } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkerDiffFile, WorkerDiffSummary } from "@shared/types";
import { runGit } from "../git-exec";
import { isRemotePath } from "@shared/remote";

// Enough detail to inspect a substantial worker without turning one expanded
// chat row into hundreds of DOM nodes. Totals always cover every file.
const MAX_DIFF_FILES = 50;
const MAX_BASELINE_FILES = 2_000;
const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const IGNORED_SNAPSHOT_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
  "out",
]);

export interface CapturedWorkerDiff {
  summary: WorkerDiffSummary;
  patch: string;
}

function safePathspec(cwd: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const path = (isAbsolute(trimmed) ? relative(cwd, trimmed) : trimmed).replace(/\\/g, "/");
  if (!path || path === ".." || path.startsWith("../") || /[\0\r\n\t]/.test(path)) return null;
  return path;
}

function scopedPaths(cwd: string, paths: string[]): string[] {
  return [...new Set(paths.map((path) => safePathspec(cwd, path)).filter(Boolean))] as string[];
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
  const pathspecs = scopedPaths(input.cwd, input.paths ?? []);
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

interface SnapshotBudget {
  files: number;
  bytes: number;
}

async function copySnapshotEntry(
  source: string,
  destination: string,
  budget: SnapshotBudget,
  seen: Set<string>,
  declaredRoot = false,
): Promise<void> {
  const canonical = resolve(source);
  if (seen.has(canonical)) return;
  seen.add(canonical);

  const stat = await lstat(source).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (!declaredRoot && IGNORED_SNAPSHOT_DIRECTORIES.has(basename(source))) return;
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      await copySnapshotEntry(
        join(source, entry.name),
        join(destination, entry.name),
        budget,
        seen,
        false,
      );
    }
    return;
  }
  if (!stat.isFile()) return;
  budget.files += 1;
  budget.bytes += stat.size;
  if (budget.files > MAX_BASELINE_FILES || budget.bytes > MAX_BASELINE_BYTES) {
    throw new Error("Worker filesystem snapshot exceeds its safety budget");
  }
  await mkdir(join(destination, ".."), { recursive: true });
  await copyFile(source, destination);
}

async function writeFilesystemSnapshot(input: {
  cwd: string;
  paths: string[];
  destination: string;
}): Promise<boolean> {
  if (!input.cwd || isRemotePath(input.cwd)) return false;
  const paths = scopedPaths(input.cwd, input.paths);
  if (paths.length === 0) return false;
  await rm(input.destination, { recursive: true, force: true });
  await mkdir(input.destination, { recursive: true });
  const budget: SnapshotBudget = { files: 0, bytes: 0 };
  const seen = new Set<string>();
  try {
    for (const path of paths) {
      await copySnapshotEntry(
        join(input.cwd, path),
        join(input.destination, path),
        budget,
        seen,
        true,
      );
    }
    return true;
  } catch {
    await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Non-Git workspaces still deserve truthful change counts. Snapshot only the
 * files the task owns before launch; this keeps the fallback cheap, bounded,
 * and isolated from unrelated workspace files.
 */
export async function captureWorkerFilesystemBaseline(input: {
  cwd: string;
  paths: string[];
  destination: string;
}): Promise<boolean> {
  return writeFilesystemSnapshot(input);
}

function runNoIndexNumstat(beforeDir: string, afterDir: string): Promise<string | null> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      ["diff", "--no-index", "--numstat", "--no-renames", "--", beforeDir, afterDir],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        // `git diff --no-index` uses 1 to mean "differences found".
        resolveResult(!error || exitCode === 1 ? stdout : null);
      },
    );
  });
}

function normalizeNoIndexPath(path: string, beforeDir: string, afterDir: string): string | null {
  let normalized = path.replace(/\\/g, "/");
  const before = beforeDir.replace(/\\/g, "/");
  const after = afterDir.replace(/\\/g, "/");
  // When the two snapshots are sibling directories Git shortens a modified
  // path to `.../{before => after}/file`. Expand that compact form first.
  normalized = normalized.replace(
    `{${basename(before)} => ${basename(after)}}`,
    basename(after),
  );
  const afterMarker = `${after.replace(/^\/+/, "")}/`;
  const afterAt = normalized.indexOf(afterMarker);
  if (afterAt >= 0) return normalized.slice(afterAt + afterMarker.length).replace(/}\s*$/, "");
  const beforeMarker = `${before.replace(/^\/+/, "")}/`;
  const beforeAt = normalized.indexOf(beforeMarker);
  if (beforeAt >= 0) return normalized.slice(beforeAt + beforeMarker.length).replace(/}\s*$/, "");

  // Added/deleted paths may be rendered as `{dev/null => /abs/path}`. The
  // absolute-root checks above normally handle them; this is a conservative
  // fallback for older Git path formatting.
  const candidates = normalized.replace(/^\{|}$/g, "").split(" => ").reverse();
  for (const candidate of candidates) {
    const clean = candidate.trim();
    if (clean && clean !== "/dev/null" && clean !== "dev/null") {
      const relativePath = safePathspec(afterDir, clean) ?? safePathspec(beforeDir, clean);
      if (relativePath) return relativePath;
    }
  }
  return null;
}

function normalizeNoIndexNumstat(value: string, beforeDir: string, afterDir: string): string {
  const lines: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = normalizeNoIndexPath(pathParts.join("\t"), beforeDir, afterDir);
    if (path) lines.push(`${added}\t${deleted}\t${path}`);
  }
  return lines.join("\n");
}

export async function captureWorkerFilesystemDiff(input: {
  cwd: string;
  paths: string[];
  baselineDir: string;
}): Promise<CapturedWorkerDiff | null> {
  const baseline = await lstat(input.baselineDir).catch(() => null);
  if (!baseline?.isDirectory()) return null;
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "codara-worker-snapshots-"));
    const beforeDir = join(tempDir, "before");
    const afterDir = join(tempDir, "after");
    await cp(input.baselineDir, beforeDir, { recursive: true, force: false });
    const captured = await writeFilesystemSnapshot({
      cwd: input.cwd,
      paths: input.paths,
      destination: afterDir,
    });
    if (!captured) return null;
    const numstat = await runNoIndexNumstat(beforeDir, afterDir);
    if (numstat === null) return null;
    return {
      summary: parseWorkerDiffNumstat(
        normalizeNoIndexNumstat(numstat, beforeDir, afterDir),
      ),
      patch: "",
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
