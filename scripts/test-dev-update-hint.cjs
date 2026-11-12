#!/usr/bin/env node
"use strict";

// The dev build's "Studio is N changes behind main" line: the pure decision
// (src/shared/dev-update-hint.ts) and the watch that reads the folder the app
// runs from (src/main/dev-update-hint.ts), against throwaway repositories.
// git-auto-fetch is stubbed: only its fetch arguments are used.

const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(scratch) {
  const outfile = path.join(scratch, "dev-update-hint.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "dev-update-hint.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\/git-auto-fetch$/ }, () => ({ path: "git-auto-fetch", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `
              export const GIT_AUTO_FETCH_TIMEOUT_MS = 45000;
              export function autoFetchEnv(base) { return { ...base, GIT_TERMINAL_PROMPT: "0" }; }
              export function autoFetchGitArgs(remote) { return ["-c", "gc.auto=0", "fetch", "--quiet", "--no-tags", "--", remote]; }
            `,
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function realRunGit(calls) {
  return (cwd, args, opts = {}) => {
    calls.push(args);
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: opts.timeout, env: opts.env ?? process.env }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr }),
      );
    });
  };
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codara-dev-update-"));
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    const mod = await load(scratch);
    const shared = await (async () => {
      const outfile = path.join(scratch, "shared.cjs");
      await esbuild.build({ entryPoints: [path.join(ROOT, "src", "shared", "dev-update-hint.ts")], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
      return require(outfile);
    })();
    const facts = (over) => ({
      packaged: false,
      appDir: "/home/me/studio",
      upstreamBranch: "main",
      behind: 0,
      headAtStart: "a".repeat(40),
      headNow: "a".repeat(40),
      missing: [],
      ...over,
    });

    await check("behind its upstream: the count, the branch, the command and what is missing", async () => {
      const hint = shared.devUpdateHint(facts({ behind: 7, missing: ["fix one", "fix two"] }));
      assert.equal(hint.kind, "behind");
      assert.equal(hint.text, "Studio is 7 changes behind main · restart to update");
      assert.match(hint.detail, /^Update with: git -C \/home\/me\/studio pull --ff-only$/m);
      assert.match(hint.detail, /• fix one\n• fix two\nand 5 more$/);
      assert.equal(shared.devUpdateHint(facts({ behind: 1, upstreamBranch: "trunk" })).text, "Studio is 1 change behind trunk · restart to update");
      assert.match(shared.devUpdateHint(facts({ behind: 2, appDir: "/a b/it's" })).detail, /git -C '\/a b\/it'\\''s' pull --ff-only/);
    });

    await check("pulled but not restarted says restart; up to date, no upstream or no HEAD says nothing", async () => {
      const hint = shared.devUpdateHint(facts({ headNow: "b".repeat(40) }));
      assert.equal(hint.kind, "restart");
      assert.equal(hint.text, "Restart to load the update");
      assert.equal(shared.devUpdateHint(facts({})), null);
      assert.equal(shared.devUpdateHint(facts({ upstreamBranch: null, behind: 3 })), null);
      assert.equal(shared.devUpdateHint(facts({ headNow: null, behind: 3 })), null);
      assert.equal(shared.devUpdateHint(facts({ behind: null })), null);
    });

    await check("a packaged build shows nothing, whatever the facts", async () => {
      assert.equal(shared.devUpdateHint(facts({ packaged: true, behind: 9, headNow: "c".repeat(40) })), null);
    });

    await check("a packaged build computes nothing: no git, no timers, no broadcast", async () => {
      const calls = [];
      const told = [];
      const watch = new mod.DevUpdateWatch({
        packaged: true,
        appDir: scratch,
        runGit: async (...args) => {
          calls.push(args);
          return { stdout: "", stderr: "" };
        },
        autoFetched: async () => [],
        broadcast: (hint) => told.push(hint),
        log: () => undefined,
        now: () => Date.now(),
      });
      watch.start();
      assert.equal(await watch.status(), null);
      assert.equal(await watch.check(true), null);
      mod.startDevUpdateHint({ ...watchDepsStub(), packaged: true });
      assert.equal(await mod.devUpdateStatus(), null);
      assert.deepEqual([calls.length, told.length], [0, 0]);
      watch.stop();
    });

    // A checkout that tracks origin/main, and someone else pushing to it.
    const origin = path.join(scratch, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(scratch, "seed");
    execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "-q", "-m", "first");
    git(seed, "push", "-q", "origin", "main");
    const app = path.join(scratch, "app");
    execFileSync("git", ["clone", "-q", origin, app]);
    for (const subject of ["fix the rail", "fix the toast"]) {
      fs.writeFileSync(path.join(seed, "a.txt"), `${subject}\n`);
      git(seed, "commit", "-q", "-am", subject);
    }
    git(seed, "push", "-q", "origin", "main");

    const calls = [];
    const told = [];
    let fetchedBy = [];
    let clock = 1_000_000;
    const watch = new mod.DevUpdateWatch({
      packaged: false,
      appDir: app,
      runGit: realRunGit(calls),
      autoFetched: async () => fetchedBy,
      broadcast: (hint) => told.push(hint),
      log: () => undefined,
      now: () => clock,
    });
    watch.start();
    const fetches = () => calls.filter((args) => args.includes("fetch")).length;

    await check("the renderer's read never fetches; the timer's does, and finds what is missing", async () => {
      assert.equal(await watch.status(), null, "origin/main is not fetched yet");
      assert.equal(fetches(), 0);
      const hint = await watch.check(true);
      assert.equal(fetches(), 1);
      assert.equal(hint.text, "Studio is 2 changes behind main · restart to update");
      assert.match(hint.detail, /• fix the toast\n• fix the rail$/);
      assert.deepEqual(told.map((entry) => entry?.kind ?? null), ["behind"]);
    });

    await check("a fetch is at most every 30 minutes, and none when the auto-fetch covers this repository", async () => {
      await watch.check(true);
      assert.equal(fetches(), 1, "not due yet");
      clock += mod.DEV_UPDATE_FETCH_MS;
      fetchedBy = [{ cwd: app, remote: "origin" }];
      await watch.check(true);
      assert.equal(fetches(), 1, "the auto-fetch does it");
      clock += mod.DEV_UPDATE_FETCH_MS;
      fetchedBy = [{ cwd: seed, remote: "origin" }];
      await watch.check(true);
      assert.equal(fetches(), 2, "another clone's fetch does not count");
    });

    await check("pulled but still running the old code: restart; nothing left to say once it matches", async () => {
      git(app, "pull", "-q", "--ff-only");
      const hint = await watch.status();
      assert.equal(hint.kind, "restart");
      assert.equal(told.at(-1).kind, "restart");
      const fresh = new mod.DevUpdateWatch({ ...watchDepsStub(), appDir: app, runGit: realRunGit([]) });
      fresh.start();
      assert.equal(await fresh.status(), null, "a process started after the pull has nothing to say");
      fresh.stop();
    });

    await check("a detached HEAD, a branch with no upstream or a folder that is not a checkout: nothing", async () => {
      git(app, "checkout", "-q", "--detach", "HEAD~1");
      assert.equal(await watch.status(), null);
      git(app, "checkout", "-q", "-b", "local-only");
      assert.equal(await watch.status(), null);
      const plain = path.join(scratch, "plain");
      fs.mkdirSync(plain);
      const none = new mod.DevUpdateWatch({ ...watchDepsStub(), appDir: plain, runGit: realRunGit([]) });
      none.start();
      assert.equal(await none.check(true), null);
      none.stop();
    });
    watch.stop();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
}

function watchDepsStub() {
  return {
    packaged: false,
    appDir: os.tmpdir(),
    runGit: async () => ({ stdout: "", stderr: "" }),
    autoFetched: async () => [],
    broadcast: () => undefined,
    log: () => undefined,
    now: () => Date.now(),
  };
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
