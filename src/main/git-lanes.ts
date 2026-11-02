// What each checkout of a repository changed since it left its base, for the
// Source Control panel's agent lanes. The lanes poll every worktree, so reads
// are cached, run a few at a time and never lock the index: an agent's own git
// commands in that folder must not lose a race to a panel.
//
// Pure git through runGit plus local file reads; no Electron import, so
// scripts/test-source-lanes.cjs runs it against throwaway repositories.

import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { isRemotePath } from "@shared/remote";
import {
  MAX_LANE_FILES,
  MAX_LANE_READS,
  sortLaneFiles,
  type LaneChanges,
  type LaneFile,
  type LaneFileStatus,
} from "@shared/source-lanes";
import { errorText, runGit } from "./git-exec";
import { isSafeRefName, parseNameStatusZ, parseNumstatZ } from "./review/review-diff";

const CACHE_MS = 5_000;
const MAX_PARALLEL = 3;
/** Untracked files whose lines are counted. The rest still list, with no count. */
const MAX_COUNTED_UNTRACKED = 100;
const MAX_COUNTED_BYTES = 256 * 1024;
const MAX_UNTRACKED = 2_000;

export interface LaneBaseDeps {
  /** The base branch the workspace records for this folder, if any. */
  workspaceBase?(cwd: string): Promise<string | null>;
  /** The repository's default branch, such as "origin/main". */
  defaultBase?(cwd: string): Promise<string>;
}

const GIT_C = ["--no-optional-locks", "-c", "core.quotePath=false", "-c", "diff.relative=false"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M"];

async function text(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, [...GIT_C, ...args]).then((result) => result.stdout);
}

async function revision(cwd: string, name: string): Promise<string> {
  return text(cwd, ["rev-parse", "--verify", "-q", `${name}^{commit}`])
    .then((out) => out.trim())
    .catch(() => "");
}

// The point the branch left its base, so commits the base gained since do not
// read as deletions in the lane.
async function resolveCompare(cwd: string, deps: LaneBaseDeps): Promise<{ commit: string; base: string | null } | null> {
  const head = await revision(cwd, "HEAD");
  if (!head) return null;
  const candidates = [
    await deps.workspaceBase?.(cwd).catch(() => null),
    await deps.defaultBase?.(cwd).catch(() => null),
  ];
  for (const name of candidates) {
    if (!name || !isSafeRefName(name)) continue;
    const resolved = await revision(cwd, name);
    if (!resolved) continue;
    const shared = await text(cwd, ["merge-base", resolved, head])
      .then((out) => out.trim())
      .catch(() => "");
    return { commit: shared || resolved, base: name };
  }
  return { commit: head, base: null };
}

async function countLines(path: string): Promise<number | null> {
  // A link is shown by its name and never followed out of the worktree.
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_COUNTED_BYTES) return null;
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(info.size), 0, info.size, 0);
    const body = buffer.subarray(0, bytesRead);
    if (body.includes(0)) return null;
    let lines = 0;
    for (const byte of body) if (byte === 10) lines++;
    return bytesRead > 0 && body[bytesRead - 1] !== 10 ? lines + 1 : lines;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function fileStatus(status: string | undefined): LaneFileStatus {
  if (status === "added" || status === "deleted" || status === "renamed") return status;
  return "modified";
}

export async function computeLaneChanges(cwd: string, deps: LaneBaseDeps = {}): Promise<LaneChanges> {
  const empty: LaneChanges = { base: null, additions: 0, deletions: 0, fileCount: 0, files: [] };
  if (isRemotePath(cwd)) return { ...empty, error: "Lanes read local checkouts only." };
  try {
    const compare = await resolveCompare(cwd, deps);
    const files: LaneFile[] = [];
    if (compare) {
      const [numstat, statuses] = await Promise.all([
        text(cwd, ["diff", ...DIFF_FLAGS, "--numstat", "-z", compare.commit, "--"]),
        text(cwd, ["diff", ...DIFF_FLAGS, "--name-status", "-z", compare.commit, "--"]),
      ]);
      const statusByPath = parseNameStatusZ(statuses);
      for (const entry of parseNumstatZ(numstat)) {
        files.push({ ...entry, status: fileStatus(statusByPath.get(entry.path)) });
      }
    }
    const untracked = (await text(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED);
    for (const [index, path] of untracked.entries()) {
      const lines = index < MAX_COUNTED_UNTRACKED ? await countLines(join(cwd, path)) : null;
      files.push({ path, additions: lines ?? 0, deletions: 0, binary: false, status: "untracked" });
    }
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return {
      base: compare?.base ?? null,
      additions,
      deletions,
      fileCount: files.length,
      files: sortLaneFiles(files).slice(0, MAX_LANE_FILES),
    };
  } catch (cause) {
    return { ...empty, error: errorText(cause) };
  }
}

const cache = new Map<string, { at: number; value: Promise<LaneChanges> }>();

/** Reads several checkouts, a few at a time; a failed one carries its own error. */
export async function readLaneChanges(
  cwds: readonly string[],
  deps: LaneBaseDeps = {},
  now: () => number = Date.now,
): Promise<Record<string, LaneChanges>> {
  const wanted = [...new Set(cwds)].slice(0, MAX_LANE_READS);
  const out: Record<string, LaneChanges> = {};
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const cwd = wanted[next++];
      const hit = cache.get(cwd);
      if (hit && now() - hit.at < CACHE_MS) {
        out[cwd] = await hit.value;
        continue;
      }
      const value = computeLaneChanges(cwd, deps);
      cache.set(cwd, { at: now(), value });
      out[cwd] = await value;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, wanted.length) }, worker));
  for (const [cwd, entry] of cache) {
    if (now() - entry.at >= CACHE_MS) cache.delete(cwd);
  }
  return out;
}
