#!/usr/bin/env node
"use strict";

// Stashing from the Source Control panel against REAL git while something
// else holds the index lock: the panel's own status reads must not take the
// optional lock, a stash that fails before saving anything because the
// index is busy is retried, and one that stays blocked leaves the user's
// files, the lock and the stash list exactly as they were.
// Everything happens in a temp repository.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(temp, entry, name) {
  const outfile = path.join(temp, `${name}.cjs`);
  const STUBS = {
    "./remote/remote-git": `export function runRemoteGit() { throw new Error("no remote workspaces in this test"); }`,
    "./git-ops": `export function invalidateGitCache() {}`,
  };
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\/(git-ops|remote\/remote-git)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
        },
      },
    ],
  });
  return require(outfile);
}

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-stash-")));
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    const exec = await load(temp, "git-exec.ts", "exec");
    const stash = await load(temp, "git-stash.ts", "stash");
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repo, "tracked"), "original\n");
    git("add", ".");
    git("commit", "-q", "-m", "initial");

    // A file whose stat changed but whose content did not: a status read
    // that may take the optional lock refreshes and rewrites the index.
    const index = path.join(repo, ".git", "index");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(repo, "tracked"), later, later);
    const indexBefore = fs.readFileSync(index);
    await exec.runGit(repo, ["status", "--porcelain"]);
    assert.ok(fs.readFileSync(index).equals(indexBefore), "a background status read rewrote the index");
    execFileSync("git", ["-C", repo, "status", "--porcelain"]);
    assert.ok(!fs.readFileSync(index).equals(indexBefore), "this git never refreshes the index, so the check above proves nothing");
    console.log("PASS a status read leaves the index and its lock alone");

    fs.writeFileSync(path.join(repo, "tracked"), "changed\n");
    fs.writeFileSync(path.join(repo, "new"), "untracked\n");
    const lock = path.join(repo, ".git", "index.lock");
    fs.writeFileSync(lock, "owned by another process");
    const timer = setTimeout(() => fs.unlinkSync(lock), 250);
    const saved = await stash.saveStash(repo, { message: "lock recovery", includeUntracked: true });
    clearTimeout(timer);
    assert.equal(saved.ok, true, saved.error);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal((await stash.listStashes(repo)).entries.length, 1, "the retry stashed twice");
    assert.equal((await stash.popStash(repo, "stash@{0}")).ok, true);
    assert.equal(fs.readFileSync(path.join(repo, "tracked"), "utf8"), "changed\n");
    assert.equal(fs.readFileSync(path.join(repo, "new"), "utf8"), "untracked\n");
    console.log("PASS a stash blocked by a lock another process lets go of is retried");

    fs.writeFileSync(lock, "still owned");
    const blocked = await stash.saveStash(repo, { includeUntracked: true });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Another Git operation/);
    assert.equal(fs.readFileSync(lock, "utf8"), "still owned", "the other process's lock was touched");
    assert.equal(fs.readFileSync(path.join(repo, "tracked"), "utf8"), "changed\n");
    assert.equal(fs.readFileSync(path.join(repo, "new"), "utf8"), "untracked\n");
    assert.equal((await stash.listStashes(repo)).entries.length, 0);
    fs.unlinkSync(lock);
    console.log("PASS a stash that stays blocked changes nothing and says why");

    assert.equal((await stash.saveStash(repo, { includeUntracked: true })).ok, true);
    assert.match((await stash.saveStash(repo)).error, /No local changes/);
    assert.equal((await stash.applyStash(repo, "stash@{0}")).ok, true);
    assert.equal((await stash.listStashes(repo)).entries.length, 1);
    assert.equal((await stash.dropStash(repo, "stash@{0}")).ok, true);
    assert.equal((await stash.listStashes(repo)).entries.length, 0);
    console.log("PASS save, apply, drop and an empty save");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
