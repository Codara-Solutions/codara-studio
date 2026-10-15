#!/usr/bin/env node
"use strict";

// Unit tests for src/main/github-ci-watch.ts: "Notify me when CI fails on my
// pull request". The watcher is driven through its injected dependencies:
// scripted local refs and pull request reads, a fake clock and timers, and a
// recorded publish; the local refs reader runs real git on a throwaway
// clone. No gh, network or Electron.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-ci-watch-"));
  const outfile = path.join(temp, "github-ci-watch.cjs");
  // Production wiring loads these lazily; the tests never reach it.
  const STUBS = {
    "./git-exec": `export async function runGit() { throw new Error("production stub"); }`,
    "./binary-resolver": `export async function resolveBinary() { return null; }`,
    "./github-cli": `export async function runGitHubCliCommand() { throw new Error("production stub"); } export function sanitizeGitHubFailure(_c, f) { return f; } export const GITHUB_CLI_READ_TIMEOUT_MS = 1; export const GITHUB_CLI_MAX_OUTPUT_BYTES = 1;`,
    "./notify": `export function publish() { throw new Error("production stub"); } export function rearm() {}`,
    "./preferences-store": `export function getPreferenceCached() { return undefined; }`,
    "./storage": `export async function loadState() { throw new Error("production stub"); }`,
  };
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-ci-watch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "gh-ci-watch-stubs",
        setup(build) {
          for (const specifier of Object.keys(STUBS)) {
            build.onResolve({ filter: new RegExp(`^${specifier.replace(/[./]/g, "\\$&")}$`) }, () => ({ path: specifier, namespace: "stub" }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ loader: "js", contents: STUBS[args.path], resolveDir: ROOT }));
        },
      },
    ],
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function ws(id, cwd) {
  return { id, name: id, cwd, color: "#000", workers: [] };
}

function pr(head, { failed = [], pending = 0, state = "OPEN", number = 42, title = "Add widgets", failedAt = 0 } = {}) {
  return { repository: "acme/widgets", number, title, state, headOid: head, failed, failedAt, pending };
}

function harness(mod, { workspaces = [ws("ws-1", "/repo")], refs = { "/repo": "h1 u1" }, prs = {}, enabled = true } = {}) {
  const h = {
    now: 1_000_000,
    enabled,
    refs: { ...refs },
    prs: { ...prs },
    errors: {},
    reads: [],
    published: [],
    rearmed: [],
    logs: [],
    timers: [],
    state: { workspaces, workspaceGroups: [], activeWorkspaceId: workspaces[0]?.id ?? null },
  };
  h.watch = mod.createGitHubCiWatch({
    loadState: async () => h.state,
    enabled: () => h.enabled,
    pathExists: async (p) => !p.includes("missing"),
    localRefs: async (cwd) => h.refs[cwd] ?? null,
    readPullRequest: async (cwd) => {
      h.reads.push(cwd);
      if (h.errors[cwd]) throw new Error(h.errors[cwd]);
      return h.prs[cwd] ?? null;
    },
    publish: (input) => h.published.push(input),
    rearm: (key) => h.rearmed.push(key),
    now: () => h.now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      h.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      h.timers = h.timers.filter((t) => t !== timer);
    },
    log: (message) => h.logs.push(message),
  });
  h.pass = () => h.watch.runPass();
  h.advance = (ms) => {
    h.now += ms;
  };
  return h;
}

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("parseCiPullRequest reads failing and running checks", ({ mod }) => {
  const parsed = mod.parseCiPullRequest(JSON.stringify({
    number: 42,
    title: "Add\n widgets",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    headRefOid: HEAD_A,
    statusCheckRollup: [
      { name: "build", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
      { name: "e2e", status: "IN_PROGRESS", conclusion: "" },
      { context: "ci/external", state: "ERROR" },
      { context: "ci/queued", state: "PENDING" },
    ],
  }));
  assert.deepEqual(parsed, { repository: "acme/widgets", number: 42, title: "Add widgets", state: "OPEN", headOid: HEAD_A, failed: ["build", "ci/external"], failedAt: 0, pending: 2 });
  // When the failing checks finished: the last of them, by finish or else start time.
  const timed = mod.parseCiPullRequest(JSON.stringify({
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    headRefOid: HEAD_A,
    statusCheckRollup: [
      { name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-01T10:05:00Z" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-01T11:00:00Z" },
      { context: "ci/external", state: "ERROR", startedAt: "2026-10-01T10:07:00Z" },
      { name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT", completedAt: "0001-01-01T00:00:00Z" },
    ],
  }));
  assert.equal(timed.failedAt, Date.parse("2026-10-01T10:07:00Z"));
  assert.equal(mod.parseCiPullRequest(JSON.stringify({ number: 1, url: "https://github.com/a/b/pull/1", headRefOid: "nope" })), null);
  assert.equal(mod.parseCiPullRequest(JSON.stringify({ number: 1, url: "ftp://x/a/b/pull/1", headRefOid: HEAD_A })), null);
  assert.equal(mod.parseCiPullRequest("null"), null);
});

test("parseCiPullRequest judges each check by its newest run", ({ mod }) => {
  // After "Re-run failed jobs" GitHub can list the failed attempt next to the
  // new one. A passing re-run must clear the failure, a running one is pending.
  const view = (rollup) => mod.parseCiPullRequest(JSON.stringify({
    number: 42,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    headRefOid: HEAD_A,
    statusCheckRollup: rollup,
  }));
  const failedRun = { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-01T10:05:00Z" };
  const passedRerun = { ...failedRun, conclusion: "SUCCESS", startedAt: "2026-10-01T11:00:00Z", completedAt: "2026-10-01T11:05:00Z" };
  const runningRerun = { ...failedRun, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-10-01T11:00:00Z", completedAt: "0001-01-01T00:00:00Z" };
  assert.deepEqual([view([failedRun, passedRerun]).failed, view([passedRerun, failedRun]).failed], [[], []]);
  const running = view([failedRun, runningRerun]);
  assert.deepEqual([running.failed, running.pending], [[], 1]);
  // Same name in another workflow is another check.
  const other = view([failedRun, { ...passedRerun, workflowName: "Nightly" }]);
  assert.deepEqual([other.failed, other.pending], [["build"], 0]);
  // A push run cancelled (cancel-in-progress) just after the pull request's
  // run of the same job started finishes later than that run started; the
  // run that started last is the one that counts, not the cancelled one.
  const cancelledPush = { ...failedRun, conclusion: "CANCELLED", startedAt: "2026-10-01T12:00:00Z", completedAt: "2026-10-01T12:00:09Z" };
  const prRun = { ...runningRerun, startedAt: "2026-10-01T12:00:05Z" };
  for (const rollup of [[cancelledPush, prRun], [prRun, cancelledPush]]) {
    const parsed = view(rollup);
    assert.deepEqual([parsed.failed, parsed.pending], [[], 1]);
  }
  // A check with no start time is placed by its finish time.
  const noStart = { ...passedRerun, startedAt: undefined, completedAt: "2026-10-01T13:00:00Z" };
  assert.deepEqual(view([failedRun, noStart]).failed, []);
});

test("local refs: one git call a minute, the default branch looked up once per interval", async ({ mod }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-ci-refs-"));
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = CI\n\temail = ci@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
  const run = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    try {
      run(temp, ["--version"]);
    } catch {
      return; // no git here: the scripted tests above still cover the watcher
    }
    const remote = path.join(temp, "remote.git");
    const repo = path.join(temp, "repo");
    run(temp, ["init", "-q", "--bare", "-b", "main", remote]);
    run(temp, ["clone", "-q", remote, repo]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    run(repo, ["add", "-A"]);
    run(repo, ["commit", "-q", "-m", "a"]);
    run(repo, ["push", "-q", "-u", "origin", "main"]);
    run(repo, ["remote", "set-head", "origin", "main"]);
    const calls = [];
    let now = 1_000;
    const read = async (cwd, args) => {
      calls.push(args.join(" "));
      try {
        return run(cwd, args).trim();
      } catch {
        return "";
      }
    };
    const localRefs = mod.createCiLocalRefsReader(read, () => now);
    assert.equal(await localRefs(repo), null, "the default branch has no pull request");
    run(repo, ["checkout", "-q", "-b", "feat/x"]);
    assert.equal(await localRefs(repo), null, "no upstream yet");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    run(repo, ["add", "-A"]);
    run(repo, ["commit", "-q", "-m", "b"]);
    run(repo, ["push", "-q", "-u", "origin", "feat/x"]);
    const head = run(repo, ["rev-parse", "HEAD"]).trim();
    calls.length = 0;
    assert.equal(await localRefs(repo), `${head} ${head}`);
    assert.equal(await localRefs(repo), `${head} ${head}`);
    assert.equal(calls.filter((call) => call.startsWith("symbolic-ref")).length, 0, "the default branch answer is reused");
    assert.equal(calls.length, 2, "one git call per look");
    now += 15 * 60_000;
    await localRefs(repo);
    assert.equal(calls.filter((call) => call.startsWith("symbolic-ref")).length, 1, "and looked up again after the interval");
    run(repo, ["checkout", "-q", "--detach"]);
    assert.equal(await localRefs(repo), null, "a detached HEAD has no pull request");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("formatCiFailure names up to three checks and the pull request", ({ mod }) => {
  assert.deepEqual(mod.formatCiFailure(pr(HEAD_A, { failed: ["build"] })), { title: "CI failed on pull request #42", body: "build · Add widgets" });
  const many = mod.formatCiFailure(pr(HEAD_A, { failed: ["a", "b", "c", "d", "e"], title: "t".repeat(100) }));
  assert.equal(many.body, `a, b, c and 2 more · ${"t".repeat(77)}...`);
});

test("a pull request already failing when first seen stays quiet", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"] }) } });
  await h.pass();
  assert.deepEqual(h.reads, ["/repo"]);
  assert.equal(h.published.length, 0);
  // GitHub says it failed before the watcher started: still quiet.
  const before = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"], failedAt: 1_000_000 - 60_000 }) } });
  await before.pass();
  assert.equal(before.published.length, 0);
});

test("a pull request first seen already failing alerts when it failed after the start", async ({ mod }) => {
  // Pushed while Codara runs, then opened in the browser: the watcher asked
  // at the push (no pull request yet) and next asks 15 minutes later, when
  // the checks have finished.
  const h = harness(mod);
  await h.pass();
  assert.equal(h.reads.length, 1);
  h.advance(15 * 60_000);
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now - 5 * 60_000 });
  await h.pass();
  assert.equal(h.reads.length, 2);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].title, "CI failed on pull request #42");
  h.advance(15 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "once per failing commit");
});

test("a new head commit that fails alerts once, with the workspace as target", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"] }) } });
  await h.pass();
  // A push: the refs move, so GitHub is asked at once.
  h.refs["/repo"] = "h2 u2";
  h.prs["/repo"] = pr(HEAD_B, { pending: 2 });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, 2);
  assert.equal(h.published.length, 0, "running checks are not a failure");
  // Still running: asked again after 90 seconds, not before.
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, 2);
  h.prs["/repo"] = pr(HEAD_B, { failed: ["build", "lint"] });
  h.advance(30_000);
  await h.pass();
  assert.equal(h.reads.length, 3);
  assert.equal(h.published.length, 1);
  assert.deepEqual(h.published[0], {
    kind: "git.ci-failed",
    sourceKey: "github-ci:acme/widgets#42",
    title: "CI failed on pull request #42",
    body: "build, lint · Add widgets",
    tone: "danger",
    soundKind: "needs-you",
    target: { type: "workspace", workspaceId: "ws-1", panel: "git" },
  });
  assert.deepEqual(h.rearmed, ["github-ci:acme/widgets#42"]);
  // Settled: the next read is 15 minutes later, and the same failure is not news.
  h.advance(10 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, 3);
  h.advance(5 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, 4);
  assert.equal(h.published.length, 1);
});

test("a re-run that fails again alerts again; first-seen pending then failing alerts", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(90_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  h.prs["/repo"] = pr(HEAD_A, { pending: 1 });
  h.advance(15 * 60_000);
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(90_000);
  await h.pass();
  assert.equal(h.published.length, 2);
});

test("a failing pull request seen first goes quiet until a re-run fails", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"] }) } });
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { pending: 1 });
  h.advance(15 * 60_000);
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(90_000);
  await h.pass();
  assert.equal(h.published.length, 1);
});

test("branches with no pull request, closed ones, remote and missing workspaces cost nothing", async ({ mod }) => {
  const h = harness(mod, {
    workspaces: [ws("ws-1", "/repo"), ws("ws-2", "/no-upstream"), ws("ws-3", "ssh://box/srv"), ws("ws-4", "/missing"), ws("ws-5", "/repo"), ws("ws-6", "/closed")],
    refs: { "/repo": "h u", "/closed": "h u", "/missing": "h u", "ssh://box/srv": "h u" },
    prs: { "/repo": null, "/closed": pr(HEAD_A, { failed: ["x"], state: "MERGED" }) },
  });
  await h.pass();
  assert.deepEqual(h.reads, ["/repo", "/closed"], "one read per local folder with an upstream");
  h.state.workspaces[5] = ws("ws-6", "/closed");
  h.prs["/closed"] = pr(HEAD_B, { failed: ["x"], state: "CLOSED" });
  h.refs["/closed"] = "h2 u2";
  await h.pass();
  assert.equal(h.published.length, 0);
});

test("a GitHub error backs off for ten minutes", async ({ mod }) => {
  const h = harness(mod);
  h.errors["/repo"] = "gh: HTTP 502";
  await h.pass();
  assert.equal(h.reads.length, 1);
  assert.match(h.logs[0], /HTTP 502/);
  h.advance(9 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, 1);
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, 2);
  assert.equal(h.logs.length, 1, "one log line per streak of errors");
  delete h.errors["/repo"];
  h.prs["/repo"] = pr(HEAD_A, { pending: 1 });
  h.advance(10 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, 3);
  h.errors["/repo"] = "gh: HTTP 401";
  h.refs["/repo"] = "h2 u2";
  await h.pass();
  assert.equal(h.logs.length, 2, "a new streak logs again");
});

test("turned off: no reads, and turning it back on starts fresh", async ({ mod }) => {
  const h = harness(mod, { enabled: false, prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  assert.equal(h.reads.length, 0);
  h.enabled = true;
  await h.pass();
  assert.equal(h.reads.length, 1);
  h.enabled = false;
  await h.pass();
  h.advance(30 * 60_000);
  h.enabled = true;
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now - 10 * 60_000 });
  await h.pass();
  assert.equal(h.reads.length, 2, "forgotten state means a fresh read");
  assert.equal(h.published.length, 0, "and a failure from while it was off is quiet");
});

test("timers: first pass after 45 seconds, then every minute; nudge and stop", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  h.watch.start();
  assert.deepEqual(h.timers.map((t) => t.ms), [45_000]);
  h.watch.nudge();
  assert.deepEqual(h.timers.map((t) => t.ms), [5_000]);
  const first = h.timers[0];
  h.timers = [];
  first.fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.timers.map((t) => t.ms), [60_000]);
  h.watch.stop();
  assert.deepEqual(h.timers, []);
  h.watch.nudge();
  assert.deepEqual(h.timers, [], "a stopped watcher ignores nudges");
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  const { mod, cleanup } = await loadModule();
  let failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn({ mod });
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  cleanup();
  console.log(`\n${TESTS.length - failed}/${TESTS.length} github-ci-watch tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
