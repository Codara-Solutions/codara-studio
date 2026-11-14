#!/usr/bin/env node
"use strict";

// Which remote a checkout follows (src/main/git-checkout-remote.ts), against
// real repositories: the background fetcher and the push watch ask it for
// every workspace at start.
//   - worktrees of one plain repository share one read of the remotes, of
//     what each branch tracks and of each remote's URL; the branch comes from
//     HEAD's file;
//   - each worktree still gets its own branch's remote;
//   - a config change is read again;
//   - a repository with per-worktree config asks git in every checkout.
//
//   node scripts/test-git-checkout-remote.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-checkout-remote-"));
  try {
    const outfile = path.join(dir, "remote.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "git-checkout-remote.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      logLevel: "silent",
    });
    const mod = require(outfile);

    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.invalid"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "a"]);
    git(repo, ["remote", "add", "origin", "https://github.com/example/main.git"]);
    git(repo, ["remote", "add", "fork", "https://github.com/someone/fork.git"]);
    const trees = [];
    for (const lane of ["one", "two", "three", "four"]) {
      const tree = path.join(dir, lane);
      git(repo, ["worktree", "add", "-q", "-b", lane, tree]);
      trees.push(tree);
    }
    git(repo, ["config", "branch.two.remote", "fork"]);

    const calls = [];
    const read = async (cwd, args) => {
      calls.push(args.join(" "));
      try {
        return git(cwd, args);
      } catch {
        return "";
      }
    };
    // What the per-checkout reads answered before: the expected answers.
    const direct = async (cwd) => {
      const remotes = git(cwd, ["remote"]).split("\n").filter(Boolean);
      const branch = git(cwd, ["branch", "--show-current"]);
      let tracked = "";
      try {
        tracked = git(cwd, ["config", "--get", `branch.${branch}.remote`]);
      } catch {
        /* none */
      }
      return tracked && remotes.includes(tracked) ? tracked : remotes.includes("origin") ? "origin" : null;
    };

    const all = [repo, ...trees];
    const answers = [];
    for (const cwd of all) {
      const remote = await mod.checkoutRemote(cwd, read);
      answers.push(remote);
      assert.equal(remote, await direct(cwd), `${path.basename(cwd)} follows the same remote as before`);
      assert.equal(await mod.checkoutRemoteUrl(cwd, remote, read), git(cwd, ["remote", "get-url", remote]));
    }
    assert.deepEqual(answers, ["origin", "origin", "fork", "origin", "origin"]);
    assert.deepEqual(
      calls.sort(),
      ["config -z --get-regexp ^branch\\..*\\.remote$", "remote", "remote get-url fork", "remote get-url origin"],
      "five checkouts of one repository: one read of each kind",
    );
    console.log("PASS worktrees of one repository share one read of their remotes");

    // A changed config is read again (a branch now tracks the fork).
    await new Promise((resolve) => setTimeout(resolve, 20));
    git(repo, ["config", "branch.three.remote", "fork"]);
    calls.length = 0;
    assert.equal(await mod.checkoutRemote(trees[2], read), "fork");
    assert.ok(calls.includes("remote"), "the remotes are read again after a config change");
    console.log("PASS a config change is read again");

    // A detached checkout has no branch: origin, as before.
    git(trees[3], ["checkout", "-q", "--detach"]);
    assert.equal(await mod.checkoutRemote(trees[3], read), "origin");
    console.log("PASS a detached checkout follows origin");

    // Per-worktree config: every checkout asks git, as before.
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
    git(trees[0], ["config", "--worktree", "branch.one.remote", "fork"]);
    calls.length = 0;
    assert.equal(await mod.checkoutRemote(trees[0], read), "fork");
    assert.equal(await mod.checkoutRemote(trees[1], read), "fork");
    assert.equal(calls.filter((call) => call === "remote").length, 2, "each checkout reads its own");
    assert.ok(calls.includes("branch --show-current"));
    console.log("PASS a repository with per-worktree config is read per checkout");

    assert.deepEqual(
      [...mod.parseBranchRemotes("branch.a.b.remote\norigin\0branch.x.remote\nfork\0branch.x.remote\nupstream\0junk")],
      [["a.b", "origin"], ["x", "upstream"]],
      "dotted names keep their dots; the last value wins",
    );
    console.log("PASS branch remotes parse like git config --get answers");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL which remote a checkout follows");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
