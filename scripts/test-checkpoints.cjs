#!/usr/bin/env node
// Executable coverage for the per-run workspace snapshots
// (src/main/orchestration/checkpoints.ts) against a throwaway git repository:
// a snapshot equals the worktree without touching the user's index, a failed
// snapshot reports why instead of failing silently, and the path-scoped
// restore used by the green-claim regression guard touches only the paths it
// is given.
//
//   node scripts/test-checkpoints.cjs

"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-checkpoints-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function loadCheckpoints() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "checkpoints.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [{
      name: "shared-alias",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function write(repo, rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

async function main() {
  const checkpoints = await loadCheckpoints();
  const repo = path.join(TMP, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "a.txt", "a1\n");
  write(repo, "b.txt", "b1\n");
  write(repo, "gone.txt", "gone\n");
  write(repo, ".gitignore", "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  // 1. A snapshot captures modified, new, and deleted files, respects
  // .gitignore, and leaves the user's index (including a staged change) alone.
  write(repo, "a.txt", "a2\n");
  write(repo, "b.txt", "b2 staged\n");
  git(repo, "add", "b.txt");
  write(repo, "new/c.txt", "c1\n");
  write(repo, "ignored.log", "noise\n");
  fs.rmSync(path.join(repo, "gone.txt"));
  const statusBefore = git(repo, "status", "--porcelain");
  const errors = [];
  const checkpoint = await checkpoints.createCheckpoint({
    runId: "run-1",
    cwd: repo,
    kind: "pre-worker",
    messagePointer: 0,
    label: "before worker",
    onError: (message) => errors.push(message),
  });
  assert.ok(checkpoint.sha, "a git workspace gets a snapshot");
  assert.deepEqual(errors, []);
  assert.equal(git(repo, "status", "--porcelain"), statusBefore, "the user's index and worktree are untouched");
  assert.equal(git(repo, "show", `${checkpoint.sha}:a.txt`), "a2");
  assert.equal(git(repo, "show", `${checkpoint.sha}:new/c.txt`), "c1");
  const files = git(repo, "ls-tree", "-r", "--name-only", checkpoint.sha).split("\n");
  assert.ok(!files.includes("gone.txt"), "a deleted file is absent from the snapshot");
  assert.ok(!files.includes("ignored.log"), "ignored files stay out");
  assert.equal(git(repo, "rev-parse", "refs/spark/runs/run-1"), checkpoint.sha);

  // 2. A failed snapshot still returns the sha-less entry and says why.
  const failed = await checkpoints.createCheckpoint({
    runId: "bad id with spaces",
    cwd: repo,
    kind: "pre-worker",
    messagePointer: 0,
    label: "broken ref",
    onError: (message) => errors.push(message),
  });
  assert.equal(failed.sha, null);
  assert.equal(errors.length, 1, "the failure is reported");
  assert.ok(errors[0].length > 0);

  // 3. The path-scoped restore touches only the paths it is given: a worker
  // changed a.txt and created new/d.txt; another area changed b.txt meanwhile.
  write(repo, "a.txt", "a3 broken\n");
  write(repo, "new/d.txt", "d1\n");
  write(repo, "b.txt", "b3 other area\n");
  const result = await checkpoints.restoreCheckpointPaths({
    cwd: repo,
    sha: checkpoint.sha,
    paths: ["a.txt", "new/d.txt", "../outside.txt"],
  });
  assert.deepEqual(result.restored, ["a.txt"]);
  assert.deepEqual(result.removed, ["new/d.txt"]);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "a2\n");
  assert.equal(fs.existsSync(path.join(repo, "new/d.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b3 other area\n", "other areas keep their work");
  assert.equal(fs.readFileSync(path.join(repo, "new/c.txt"), "utf8"), "c1\n");
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "b.txt", "the index is left as the user had it");

  // 3b. Worker reports list paths however they like: an absolute path inside
  // the workspace is restored, and a gitignored file the worker reported is
  // never deleted just because no snapshot can contain it.
  write(repo, "a.txt", "a4 broken again\n");
  write(repo, "ignored.log", "user data\n");
  const absolute = await checkpoints.restoreCheckpointPaths({
    cwd: repo,
    sha: checkpoint.sha,
    paths: [path.join(repo, "a.txt"), "ignored.log", path.join(TMP, "elsewhere.txt")],
  });
  assert.deepEqual(absolute.restored, ["a.txt"]);
  assert.deepEqual(absolute.removed, []);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "a2\n");
  assert.equal(fs.readFileSync(path.join(repo, "ignored.log"), "utf8"), "user data\n", "ignored files survive");

  // 3c. A workspace that is a subdirectory of the repository: snapshot trees
  // are rooted at the repository, so a root-relative lookup would miss every
  // file and delete it instead of restoring it.
  write(repo, "pkg/src/x.ts", "x1\n");
  const sub = path.join(repo, "pkg");
  const subCheckpoint = await checkpoints.createCheckpoint({
    runId: "run-sub",
    cwd: sub,
    kind: "pre-worker",
    messagePointer: 0,
    label: "subdirectory workspace",
  });
  assert.ok(subCheckpoint.sha);
  write(repo, "pkg/src/x.ts", "x2 broken\n");
  write(repo, "pkg/src/y.ts", "y new\n");
  const subResult = await checkpoints.restoreCheckpointPaths({
    cwd: sub,
    sha: subCheckpoint.sha,
    paths: ["src/x.ts", "./src/y.ts"],
  });
  assert.deepEqual(subResult.restored, ["src/x.ts"]);
  assert.deepEqual(subResult.removed, ["src/y.ts"]);
  assert.equal(fs.readFileSync(path.join(sub, "src/x.ts"), "utf8"), "x1\n", "restored, not deleted");
  assert.equal(fs.existsSync(path.join(sub, "src/y.ts")), false);

  // 4. The regression guard uses the scoped restore, refuses under a live
  // writer, and scopes claims to a lineage and the current user turn.
  const runStore = fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "run-store.ts"), "utf8");
  assert.match(runStore, /await restoreCheckpointPaths\(\{ cwd, sha: restoredSha, paths: restorePaths \}\)/);
  assert.match(runStore, /another worker is still writing, so nothing was restored/);
  assert.match(runStore, /greenClaims\[greenClaimKey\(lineage, claim\.claim\)\]/);
  assert.match(runStore, /delete draft\.greenClaims;/);
  assert.match(runStore, /type: checkpointError \? "run\.checkpoint_failed" : "run\.checkpoint_created"/);

  console.log("checkpoints (snapshot, failure report, scoped restore): ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
