// "Undo message and code" against a real git repository
// (src/main/orchestration/checkpoints.ts): files created after the checkpoint
// are removed, changed and deleted files come back, ignored files and the
// user's unrelated staged work are left alone, and the state just before the
// undo is saved on refs/spark/undo/<runId> so nothing is lost for good.
//
//   node scripts/test-checkpoint-restore.cjs
//
// Needs git on PATH.

"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-checkpoint-restore-"));
const REPO = path.join(TMP, "repo");

function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
}

function write(relative, content) {
  const target = path.join(REPO, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function read(relative) {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

async function main() {
  const outfile = path.join(TMP, "checkpoints.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "checkpoints.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "shared-alias",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
        }));
      },
    }],
  });
  const checkpoints = require(outfile);

  fs.mkdirSync(REPO, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write(".gitignore", "build/\n");
  write("a.txt", "original a\n");
  write("b.txt", "original b\n");
  write("d.txt", "original d\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");

  // The user staged their own change before Cora's turn.
  write("d.txt", "user staged d\n");
  git("add", "d.txt");

  const checkpoint = await checkpoints.createCheckpoint({
    runId: "run-undo",
    cwd: REPO,
    kind: "user-message",
    messagePointer: 1,
    label: "before Cora",
  });
  assert.ok(checkpoint.sha, "a git workspace gets a snapshot");
  assert.equal(checkpoint.snapshotError, undefined);

  // Cora's turn: edits, creates and deletes files; a build writes ignored output.
  write("a.txt", "cora changed a\n");
  write("new.ts", "export const created = true;\n");
  write("src/deep/x.ts", "export const nested = true;\n");
  fs.rmSync(path.join(REPO, "b.txt"));
  write("build/out.log", "ignored build output\n");

  const result = await checkpoints.restoreCheckpointCode({
    cwd: REPO,
    sha: checkpoint.sha,
    runId: "run-undo",
  });

  assert.equal(read("a.txt"), "original a\n", "a changed file is restored");
  assert.equal(read("b.txt"), "original b\n", "a deleted file comes back");
  assert.ok(!fs.existsSync(path.join(REPO, "new.ts")), "a file created after the checkpoint is removed");
  assert.ok(!fs.existsSync(path.join(REPO, "src")), "its emptied directories go too");
  assert.equal(read("build/out.log"), "ignored build output\n", "ignored files are never touched");
  assert.deepEqual([...result.restored].sort(), ["a.txt", "b.txt"]);
  assert.deepEqual([...result.removed].sort(), ["new.ts", "src/deep/x.ts"]);
  console.log("PASS the workspace matches the checkpoint, created files included");

  assert.match(git("diff", "--cached", "--name-only"), /^d\.txt$/m, "the user's unrelated staged change stays staged");
  assert.equal(read("d.txt"), "user staged d\n");
  console.log("PASS the user's index outside the restored paths is preserved");

  assert.equal(git("rev-parse", "refs/spark/undo/run-undo").trim(), result.preRestoreSha);
  assert.equal(git("show", `${result.preRestoreSha}:new.ts`), "export const created = true;\n");
  assert.equal(git("show", `${result.preRestoreSha}:a.txt`), "cora changed a\n");
  console.log("PASS the state just before the undo is saved and recoverable");

  await checkpoints.deleteRunCheckpoints(REPO, "run-undo");
  assert.throws(() => git("rev-parse", "--verify", "--quiet", "refs/spark/undo/run-undo"));
  console.log("PASS deleting the run drops its undo ref too");

  const plain = fs.mkdtempSync(path.join(TMP, "plain-"));
  const noGit = await checkpoints.createCheckpoint({
    runId: "run-plain",
    cwd: plain,
    kind: "run-start",
    messagePointer: 0,
    label: "start",
  });
  assert.equal(noGit.sha, null);
  assert.equal(noGit.snapshotError, undefined, "a folder that is not a repository is not an error");
  console.log("PASS a non-git workspace records no snapshot and no error");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
