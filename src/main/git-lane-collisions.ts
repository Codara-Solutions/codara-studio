// Which running lanes would clash if both merged, from their committed work.
// `git merge-tree` works on commits alone and touches no worktree or index, so
// it cannot get in an agent's way. It does write tree objects, which git cleans
// up itself; a result is cached by the two commits, so a pair is merged once.
// It runs with no click behind it, so it must not start any program the repository
// configures: one with a custom merge driver is skipped, and so is a partial clone
// or one holding a submodule, which may be one, because a missing file means a
// fetch that can run an ssh command or credential helper. Git 2.45 and later also
// refuse that fetch outright through GIT_NO_LAZY_FETCH. Renormalizing, which runs
// clean and smudge filters, is turned off.
//
// No Electron import: scripts/test-lane-collisions.cjs runs it on real repositories.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { isRemotePath } from "@shared/remote";
import { MAX_COLLISION_LANES, type LaneCollisions } from "@shared/lane-collisions";
import { runGit } from "./git-exec";
import { gitSupportsMergeTreeWriteTree } from "./git-worktrees";

const MAX_PARALLEL = 3;
const MAX_CACHED_PAIRS = 500;
const GIT_C = ["--no-optional-locks", "-c", "core.quotePath=false"];

const cache = new Map<string, string[]>();

export interface LaneCollisionDeps {
  run?: typeof runGit;
  supported?: (cwd: string) => Promise<boolean>;
}

async function mergedFiles(cwd: string, a: string, b: string, run: typeof runGit): Promise<string[] | null> {
  const parts = (stdout: string) => stdout.split("\0").filter(Boolean).slice(1);
  try {
    const args = [...GIT_C, "-c", "merge.renormalize=false", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b];
    return parts((await run(cwd, args, { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } })).stdout);
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: unknown };
    // 1 is git's answer "these conflict". Anything else says nothing about the pair.
    return failure.code === 1 && typeof failure.stdout === "string" ? parts(failure.stdout) : null;
  }
}

async function safeToMerge(cwd: string, run: typeof runGit): Promise<boolean> {
  try {
    const { stdout } = await run(cwd, [
      ...GIT_C,
      "config",
      "--get-regexp",
      "^(merge\\..*\\.driver|remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone|submodule\\..*\\.url)$",
    ]).then(
      (result) => result,
      (cause: { code?: unknown }) => {
        if (cause.code === 1) return { stdout: "" };
        throw cause;
      },
    );
    if (stdout.trim()) return false;
    // A deinitialized submodule drops its setting but keeps its repository, and one
    // set up in a linked worktree keeps it in that worktree's private git dir.
    const { stdout: located } = await run(cwd, [...GIT_C, "rev-parse", "--git-common-dir", "--git-path", "modules"]);
    const [common, own] = located.split(/\r?\n/).map((line) => line.trim());
    if (!common || !own) return false;
    const inside = (path: string) => (isAbsolute(path) ? path : join(cwd, path));
    return !existsSync(join(inside(common), "modules")) && !existsSync(inside(own));
  } catch {
    // Exit 1 above is git's "no such setting"; any other failure could not rule them out.
    return false;
  }
}

export async function readLaneCollisions(paths: readonly string[], deps: LaneCollisionDeps = {}): Promise<LaneCollisions> {
  const run = deps.run ?? runGit;
  // Sorted after the cap, so a lane changing place does not merge its pairs again.
  const wanted = [...new Set(paths)].filter((path) => !isRemotePath(path)).slice(0, MAX_COLLISION_LANES).sort();
  const out: LaneCollisions = {};
  if (wanted.length < 2) return out;
  if (!(await (deps.supported ?? gitSupportsMergeTreeWriteTree)(wanted[0]))) return out;

  const heads = new Map<string, string>();
  await Promise.all(
    wanted.map(async (path) => {
      if (!(await safeToMerge(path, run))) return;
      const head = await run(path, [...GIT_C, "rev-parse", "--verify", "-q", "HEAD^{commit}"]).then(
        (result) => result.stdout.trim(),
        () => "",
      );
      if (head) heads.set(path, head);
    }),
  );

  const pairs: Array<[string, string]> = [];
  const located = wanted.filter((path) => heads.has(path));
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      if (heads.get(located[i]) !== heads.get(located[j])) pairs.push([located[i], located[j]]);
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const [a, b] = pairs[next++];
      const [left, right] = [heads.get(a)!, heads.get(b)!].sort();
      // By folder too: another clone of the same commits can have other merge settings.
      const key = `${a}\0${left}:${right}`;
      let files = cache.get(key);
      if (!files) {
        const merged = await mergedFiles(a, left, right, run);
        if (!merged) continue;
        files = merged;
        cache.set(key, files);
        if (cache.size > MAX_CACHED_PAIRS) cache.delete(cache.keys().next().value!);
      }
      if (files.length === 0) continue;
      (out[a] ??= []).push({ otherPath: b, files });
      (out[b] ??= []).push({ otherPath: a, files });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, pairs.length) }, worker));
  return out;
}
