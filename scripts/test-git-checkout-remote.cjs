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
//   - a repository with per-worktree config, or a global or system config
//     file that includes another (an `includeIf "onbranch:..."` can give one
//     worktree its own remote), asks git in every checkout;
//   - a read that failed is neither kept nor handed to another checkout;
//   - a bare repository inside another repository keeps its own identity.
//
//   node scripts/test-git-checkout-remote.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
// The module reads the files git reads, so this process's environment is the
// one git runs with: a global file of the test's own, no system file.
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_SYSTEM;
const git = (cwd, args) => execFileSync("git", args, { cwd, env: process.env, encoding: "utf8" }).trim();

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-checkout-remote-"));
  try {
    const globalConfig = path.join(dir, "global.gitconfig");
    fs.writeFileSync(globalConfig, "[core]\n\tautocrlf = false\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    const outfile = path.join(dir, "remote.cjs");
    await esbuild.build({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "git-checkout-remote.ts"))};`,
          `export { gitDirsOf } from ${JSON.stringify(path.join(ROOT, "src", "main", "git-state.ts"))};`,
        ].join("\n"),
        resolveDir: ROOT,
        loader: "ts",
      },
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
        return null;
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
      [
        "config -z --list",
        "remote",
        "remote get-url fork",
        "remote get-url origin",
        "var GIT_CONFIG_GLOBAL",
        "var GIT_CONFIG_SYSTEM",
      ],
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

    // A `git remote` that failed is not kept for the other worktrees of the
    // repository.
    await new Promise((resolve) => setTimeout(resolve, 20));
    git(repo, ["config", "branch.four.remote", "origin"]);
    let failNext = true;
    const flaky = async (cwd, args) => {
      if (failNext && args[0] === "remote" && args.length === 1) {
        failNext = false;
        return null;
      }
      return read(cwd, args);
    };
    assert.equal(await mod.checkoutRemote(trees[0], flaky), "origin", "the checkout asks git itself");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await mod.checkoutRemote(trees[1], flaky), "fork", "the next worktree asks again");
    console.log("PASS a failed remote listing is asked again by the next worktree");

    // A failed read of what branches track, or of a URL, is neither kept nor
    // handed to the checkouts waiting on it: they ask git themselves, and the
    // next checkout reads it again.
    const failing = (match) => {
      let left = 1;
      return async (cwd, args) => {
        if (left > 0 && match(args.join(" "))) {
          left -= 1;
          // Slow enough that the second checkout waits on this read.
          await new Promise((resolve) => setTimeout(resolve, 100));
          return null;
        }
        return read(cwd, args);
      };
    };
    mod.forgetCheckoutRemotes();
    const noTracking = failing((call) => call.startsWith("config -z"));
    const [whileFailing, alongside] = await Promise.all([
      mod.checkoutRemote(trees[1], noTracking),
      mod.checkoutRemote(trees[1], noTracking),
    ]);
    assert.deepEqual([whileFailing, alongside], ["fork", "fork"], "a failed tracking read is not an empty one");
    calls.length = 0;
    assert.equal(await mod.checkoutRemote(trees[1], read), "fork", "the next checkout reads what branches track");
    assert.ok(calls.includes("config -z --list"), "the failure was not kept");
    const noUrl = failing((call) => call === "remote get-url fork");
    const urls = await Promise.all([
      mod.checkoutRemoteUrl(trees[1], "fork", noUrl),
      mod.checkoutRemoteUrl(trees[1], "fork", noUrl),
    ]);
    const forkUrl = "https://github.com/someone/fork.git";
    assert.deepEqual(urls, [forkUrl, forkUrl], "a failed URL read is not an empty URL");
    assert.equal(await mod.checkoutRemoteUrl(trees[2], "fork", read), forkUrl, "nor kept for the next checkout");
    console.log("PASS failed tracking and URL reads are asked again, not shared");

    // A global or system file that includes another can make one worktree's
    // answer differ (here `includeIf "onbranch:one"` gives it its own remote):
    // every checkout asks git. So does a git that cannot name those files.
    const special = path.join(dir, "special.gitconfig");
    fs.writeFileSync(
      special,
      '[remote "special"]\n\turl = https://github.com/example/special.git\n[branch "one"]\n\tremote = special\n',
    );
    fs.appendFileSync(globalConfig, `[includeIf "onbranch:one"]\n\tpath = ${special}\n`);
    mod.forgetCheckoutRemotes();
    calls.length = 0;
    assert.equal(await mod.checkoutRemote(repo, read), "origin");
    assert.equal(await mod.checkoutRemote(trees[0], read), "special", "worktree one follows the remote its include gives it");
    assert.equal(calls.filter((call) => call === "remote").length, 2, "each checkout reads its own remotes");
    fs.writeFileSync(globalConfig, "[core]\n\tautocrlf = false\n");
    const systemConfig = path.join(dir, "system.gitconfig");
    fs.writeFileSync(systemConfig, `[include]\n\tpath = ${special}\n`);
    delete process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_SYSTEM = systemConfig;
    mod.forgetCheckoutRemotes();
    calls.length = 0;
    await mod.checkoutRemote(trees[1], read);
    await mod.checkoutRemote(trees[2], read);
    assert.equal(calls.filter((call) => call === "remote").length, 2, "an include in the system file: per checkout");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_CONFIG_SYSTEM;
    const oldGit = async (cwd, args) => (args[0] === "var" ? null : read(cwd, args));
    mod.forgetCheckoutRemotes();
    calls.length = 0;
    await mod.checkoutRemote(trees[1], oldGit);
    await mod.checkoutRemote(trees[2], oldGit);
    assert.equal(calls.filter((call) => call === "remote").length, 2, "a git that cannot name its files: per checkout");
    mod.forgetCheckoutRemotes();
    calls.length = 0;
    await mod.checkoutRemote(trees[1], read);
    await mod.checkoutRemote(trees[2], read);
    assert.equal(calls.filter((call) => call === "remote").length, 1, "plain files again: shared");
    console.log("PASS a global or system include, or an unknown git, reads per checkout");

    // A bare repository inside a checkout is its own repository: git stops
    // there and so do the files.
    const nested = path.join(repo, "nested.git");
    git(repo, ["init", "-q", "--bare", "nested.git"]);
    git(nested, ["remote", "add", "upstream", "https://github.com/example/nested.git"]);
    assert.equal(await mod.gitDirsOf(nested), null, "a bare repository is not read as the enclosing checkout");
    assert.equal(await mod.gitDirsOf(path.join(nested, "refs")), null, "nor a folder inside it");
    assert.notEqual(await mod.gitDirsOf(repo), null, "the enclosing checkout still reads from its files");
    assert.equal(await mod.checkoutRemote(nested, read), "upstream", "the bare repository keeps its own remote");
    assert.equal(await mod.checkoutRemote(repo, read), "origin");
    fs.rmSync(nested, { recursive: true, force: true });
    console.log("PASS a bare repository inside a checkout keeps its own identity");

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
