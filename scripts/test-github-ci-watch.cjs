#!/usr/bin/env node
"use strict";

// Unit tests for src/main/github-ci-watch.ts, the pull request watcher: the
// rows' pull request state, the agent told about failing checks, "Notify me
// when CI fails on my pull request" and the green note. The watcher is
// driven through its injected dependencies: scripted local refs and pull
// request reads, a fake clock and timers, a recorded publish, row entries
// and nudger; the REST parsers get GitHub's own JSON shapes; the local refs
// reader runs real git on a throwaway clone. No gh, network or Electron.

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
    "./preferences-store": `export function getPreferenceCached() { return undefined; } export function onPreferenceChange() { return () => {}; }`,
    "./storage": `export async function loadState() { throw new Error("production stub"); }`,
    "./pty-manager": `export function hasSession() { return false; } export function inject() {} export function sessionCwd() { return null; } export function hibernationSessionInfo() { return null; }`,
    "./terminal-agent-notify": `export function terminalAgentStateSnapshot() { return []; } export function noteTerminalUserInput() {}`,
  };
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-ci-watch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron"],
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

const PHASES = { OPEN: "open", MERGED: "merged", CLOSED: "closed", DRAFT: "draft" };

function pr(head, { failed = [], pending = 0, passed = 0, state = "OPEN", number = 42, title = "Add widgets", failedAt = 0 } = {}) {
  return {
    repository: "acme/widgets",
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    title,
    phase: PHASES[state],
    headOid: head,
    failed,
    failedAt,
    pending,
    passed,
  };
}

function refsOf(key) {
  return key ? { key, host: "github.com", repository: "acme/widgets", branch: "feat/widgets" } : null;
}

function harness(mod, { workspaces = [ws("ws-1", "/repo")], refs = { "/repo": "h1 u1" }, prs = {}, enabled = true } = {}) {
  const h = {
    now: 1_000_000,
    enabled,
    alerts: true,
    watching: true,
    off: new Set(),
    refs: { ...refs },
    prs: { ...prs },
    errors: {},
    reads: [],
    published: [],
    rearmed: [],
    entries: [],
    failing: [],
    settled: [],
    retained: [],
    refWatches: [],
    refWatchesClosed: [],
    gate: null,
    logs: [],
    timers: [],
    state: { workspaces, workspaceGroups: [], activeWorkspaceId: workspaces[0]?.id ?? null },
  };
  h.watch = mod.createGitHubCiWatch({
    loadState: async () => h.state,
    enabled: () => h.enabled,
    alertsEnabled: () => h.alerts,
    watchEnabled: () => h.watching,
    repositoryWatched: (repository) => !h.off.has(repository),
    pathExists: async (p) => !p.includes("missing"),
    localRefs: async (cwd) => refsOf(h.refs[cwd]),
    readPullRequest: async (cwd, refs) => {
      assert.equal(refs.branch, "feat/widgets");
      h.reads.push(cwd);
      if (h.gate) await h.gate;
      if (h.errors[cwd]) throw new Error(h.errors[cwd]);
      return h.prs[cwd] ?? null;
    },
    publish: (input) => h.published.push(input),
    rearm: (key) => h.rearmed.push(key),
    onEntry: (workspaceId, entry) => h.entries.push({ workspaceId, entry }),
    nudger: {
      failing: (workspace, failure) => h.failing.push({ workspaceId: workspace.id, ...failure }),
      settled: (repository, number) => h.settled.push(`${repository}#${number}`),
      retain: (list) => h.retained.push(list.map((item) => `${item.repository.toLowerCase()}#${item.number}`)),
    },
    watchRefs: (cwd, _refs, onChange) => {
      h.refWatches.push({ cwd, onChange });
      return () => h.refWatchesClosed.push(cwd);
    },
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

// ── GitHub's REST shapes ────────────────────────────────────────────────────

function pull(overrides = {}) {
  return {
    number: 42,
    title: "Add\n widgets",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: HEAD_A, ref: "feat/widgets" },
    ...overrides,
  };
}

function run(name, status, conclusion, times = {}) {
  return { name, status, conclusion, started_at: times.started ?? null, completed_at: times.completed ?? null };
}

test("parseRestPullRequest reads the newest pull request and its phase", ({ mod }) => {
  assert.deepEqual(mod.parseRestPullRequest([pull(), pull({ number: 7 })]), {
    repository: "acme/widgets",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add widgets",
    phase: "open",
    headOid: HEAD_A,
  });
  assert.equal(mod.parseRestPullRequest([pull({ draft: true })]).phase, "draft");
  assert.equal(mod.parseRestPullRequest([pull({ state: "closed", merged_at: "2026-10-01T10:00:00Z" })]).phase, "merged");
  assert.equal(mod.parseRestPullRequest([pull({ state: "closed" })]).phase, "closed");
  assert.equal(mod.parseRestPullRequest([]), null);
  assert.equal(mod.parseRestPullRequest(null), null);
  assert.equal(mod.parseRestPullRequest([pull({ head: { sha: "nope" } })]), null);
  assert.equal(mod.parseRestPullRequest([pull({ html_url: "ftp://x/a/b/pull/1" })]), null);
  // A newer closed duplicate does not hide the open pull request.
  assert.equal(mod.parseRestPullRequest([pull({ number: 50, state: "closed" }), pull({ number: 42 })]).number, 42);
});

test("summarizeRestChecks reads failing, running and passing checks and statuses", ({ mod }) => {
  const summary = mod.summarizeRestChecks(
    {
      check_runs: [
        run("build", "completed", "failure"),
        run("lint", "completed", "success"),
        run("docs", "completed", "skipped"),
        run("e2e", "in_progress", null),
        run("queued", "queued", null),
      ],
    },
    { state: "failure", statuses: [{ context: "ci/external", state: "error" }, { context: "ci/pending", state: "pending" }, { context: "deploy", state: "success" }] },
  );
  assert.deepEqual(summary, { failed: ["build", "ci/external"], failedAt: 0, pending: 3, passed: 3 });
  // When the failing checks finished: the last of them, by finish or else start time.
  const timed = mod.summarizeRestChecks(
    {
      check_runs: [
        run("build", "completed", "failure", { started: "2026-10-01T10:00:00Z", completed: "2026-10-01T10:05:00Z" }),
        run("lint", "completed", "success", { completed: "2026-10-01T11:00:00Z" }),
        run("e2e", "completed", "timed_out", { completed: "0001-01-01T00:00:00Z" }),
      ],
    },
    { statuses: [{ context: "ci/external", state: "failure", updated_at: "2026-10-01T10:07:00Z" }] },
  );
  assert.equal(timed.failedAt, Date.parse("2026-10-01T10:07:00Z"));
  assert.deepEqual(mod.summarizeRestChecks(null, null), { failed: [], failedAt: 0, pending: 0, passed: 0 });
});

test("summarizeRestChecks judges each check by its newest run", ({ mod }) => {
  // After "Re-run failed jobs" the failed attempt can be listed next to the
  // new one. A passing re-run must clear the failure, a running one is pending.
  const view = (runs) => mod.summarizeRestChecks({ check_runs: runs }, null);
  const failedRun = run("build", "completed", "failure", { started: "2026-10-01T10:00:00Z", completed: "2026-10-01T10:05:00Z" });
  const passedRerun = run("build", "completed", "success", { started: "2026-10-01T11:00:00Z", completed: "2026-10-01T11:05:00Z" });
  const runningRerun = run("build", "in_progress", null, { started: "2026-10-01T11:00:00Z" });
  assert.deepEqual([view([failedRun, passedRerun]).failed, view([passedRerun, failedRun]).failed], [[], []]);
  const running = view([failedRun, runningRerun]);
  assert.deepEqual([running.failed, running.pending], [[], 1]);
  // A run cancelled because a newer one started finishes after that one
  // started; the run that started last counts.
  const cancelledPush = run("build", "completed", "cancelled", { started: "2026-10-01T12:00:00Z", completed: "2026-10-01T12:00:09Z" });
  const prRun = run("build", "in_progress", null, { started: "2026-10-01T12:00:05Z" });
  for (const runs of [[cancelledPush, prRun], [prRun, cancelledPush]]) {
    const parsed = view(runs);
    assert.deepEqual([parsed.failed, parsed.pending], [[], 1]);
  }
});

test("same-named jobs in different workflows keep their own results", ({ mod }) => {
  const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;
  const runs = [
    { ...run("build", "completed", "failure", { started: at(0), completed: at(5) }), check_suite: { id: 1 } },
    { ...run("build", "completed", "success", { started: at(1), completed: at(6) }), check_suite: { id: 2 } },
  ];
  assert.deepEqual(mod.summarizeRestChecks({ check_runs: runs }, null).failed, ["build"]);
});

test("remote hosts: ssh aliases, GitHub's ssh endpoint and signed-in Enterprise hosts", ({ mod }) => {
  assert.deepEqual(mod.parseRemoteUrl("git@github.com-work:Acme/Widgets.git"), { host: "github.com-work", repository: "acme/widgets", ssh: true });
  assert.deepEqual(mod.parseRemoteUrl("ssh://git@ssh.github.com:443/acme/widgets"), { host: "ssh.github.com", repository: "acme/widgets", ssh: true });
  assert.deepEqual(mod.parseRemoteUrl("https://code.corp/acme/widgets"), { host: "code.corp", repository: "acme/widgets", ssh: false });
  assert.equal(mod.parseRemoteUrl("/srv/remote.git"), null);
  const signedIn = mod.parseGhHostsYaml("github.com:\n    user: e\n    git_protocol: ssh\ncode.corp:\n    user: e\n");
  assert.deepEqual([...signedIn], ["github.com", "code.corp"]);
  assert.equal(mod.githubHostFor("ssh.github.com", signedIn), "github.com");
  assert.equal(mod.githubHostFor("code.corp", signedIn), "code.corp");
  assert.equal(mod.githubHostFor("github.acme.corp", new Set()), "github.acme.corp");
  assert.equal(mod.githubHostFor("gitlab.com", signedIn), null);
});

test("parseGitHubRemoteUrl takes https, ssh and scp-like GitHub remotes only", ({ mod }) => {
  for (const url of [
    "https://github.com/Acme/Widgets.git",
    "https://github.com/acme/widgets",
    "https://user@github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets",
  ]) {
    assert.deepEqual(mod.parseGitHubRemoteUrl(url), { host: "github.com", repository: "acme/widgets" }, url);
  }
  assert.deepEqual(mod.parseGitHubRemoteUrl("git@github.acme.corp:team/app.git"), { host: "github.acme.corp", repository: "team/app" });
  for (const url of ["/srv/remote.git", "https://gitlab.com/acme/widgets.git", "", "https://github.com/acme"]) {
    assert.equal(mod.parseGitHubRemoteUrl(url), null, url);
  }
});

test("local refs: one git call a minute, the remote looked up once per interval", async ({ mod }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-ci-refs-"));
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = CI\n\temail = ci@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
  const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    try {
      git(temp, ["--version"]);
    } catch {
      return; // no git here: the scripted tests still cover the watcher
    }
    const remote = path.join(temp, "remote.git");
    const repo = path.join(temp, "repo");
    git(temp, ["init", "-q", "--bare", "-b", "main", remote]);
    git(temp, ["clone", "-q", remote, repo]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "a"]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    git(repo, ["checkout", "-q", "-b", "feat/x"]);
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "b"]);
    git(repo, ["push", "-q", "-u", "origin", "feat/x"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const calls = [];
    let now = 1_000;
    const read = async (cwd, args) => {
      calls.push(args.join(" "));
      try {
        return git(cwd, args).trim();
      } catch {
        return "";
      }
    };
    const localRefs = mod.createCiLocalRefsReader(read, () => now);
    assert.equal(await localRefs(repo), null, "a remote that is not GitHub has no pull request");
    git(repo, ["remote", "set-url", "origin", "https://github.com/Acme/Widgets.git"]);
    now += 15 * 60_000;
    calls.length = 0;
    const expected = { key: `${head} ${head}`, host: "github.com", repository: "acme/widgets", branch: "feat/x" };
    assert.deepEqual(await localRefs(repo), expected);
    assert.equal(calls.length, 3, "HEAD and upstream, then the default branch and the remote's address");
    calls.length = 0;
    assert.deepEqual(await localRefs(repo), expected);
    assert.equal(calls.length, 1, "one git call per look while the remote answers are fresh");
    git(repo, ["checkout", "-q", "main"]);
    assert.equal(await localRefs(repo), null, "the default branch has no pull request");
    git(repo, ["checkout", "-q", "-b", "feat/y"]);
    assert.equal(await localRefs(repo), null, "no upstream yet");
    git(repo, ["checkout", "-q", "--detach"]);
    assert.equal(await localRefs(repo), null, "a detached HEAD has no pull request");
    // An ssh host alias resolves to github.com before gh is asked.
    git(repo, ["checkout", "-q", "feat/x"]);
    git(repo, ["remote", "set-url", "origin", "git@github.com-work:Acme/Widgets.git"]);
    const aliases = [];
    const resolved = mod.createCiLocalRefsReader(read, () => now, {
      sshHost: async (alias) => {
        aliases.push(alias);
        return "github.com";
      },
      signedIn: async () => new Set(["github.com"]),
    });
    assert.deepEqual(await resolved(repo), expected);
    assert.deepEqual(aliases, ["github.com-work"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("review 5: a push moves the upstream ref and the watch hears it, loose or packed", async ({ mod }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-ci-push-"));
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = CI\n\temail = ci@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
  const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const read = async (cwd, args) => {
    try {
      return git(cwd, args).trim();
    } catch {
      return "";
    }
  };
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const commitAndPush = (repo, name) => {
    fs.writeFileSync(path.join(repo, name), name);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", name]);
    git(repo, ["push", "-q"]);
  };
  try {
    try {
      git(temp, ["--version"]);
    } catch {
      return;
    }
    const remote = path.join(temp, "remote.git");
    const repo = path.join(temp, "repo");
    git(temp, ["init", "-q", "--bare", "-b", "main", remote]);
    git(temp, ["clone", "-q", remote, repo]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "a"]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["checkout", "-q", "-b", "feat/x"]);
    git(repo, ["push", "-q", "-u", "origin", "feat/x"]);
    let heard = 0;
    let close = mod.watchUpstreamRef(read, repo, () => (heard += 1));
    await settle(300);
    commitAndPush(repo, "c.txt");
    await settle(500);
    assert.ok(heard > 0, "the push rewrote refs/remotes/origin/feat/x");
    close();
    const after = heard;
    commitAndPush(repo, "d.txt");
    await settle(300);
    assert.equal(heard, after, "closed: nothing more");
    // Only in packed-refs: the nearest existing folder is watched.
    git(repo, ["pack-refs", "--all"]);
    fs.rmSync(path.join(repo, ".git", "refs", "remotes", "origin", "feat"), { recursive: true, force: true });
    heard = 0;
    close = mod.watchUpstreamRef(read, repo, () => (heard += 1));
    await settle(300);
    commitAndPush(repo, "e.txt");
    await settle(500);
    close();
    assert.ok(heard > 0, "the push recreated the loose ref under the watched folder");
    // The watched folder itself goes away (git pack-refs): the watch moves up and still hears.
    heard = 0;
    close = mod.watchUpstreamRef(read, repo, () => (heard += 1));
    await settle(300);
    git(repo, ["pack-refs", "--all"]);
    fs.rmSync(path.join(repo, ".git", "refs", "remotes", "origin", "feat"), { recursive: true, force: true });
    await settle(500);
    heard = 0;
    commitAndPush(repo, "f.txt");
    await settle(500);
    close();
    assert.ok(heard > 0, "re-armed after its folder disappeared");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("formatCiFailure names up to three checks and the pull request", ({ mod }) => {
  assert.deepEqual(mod.formatCiFailure(pr(HEAD_A, { failed: ["build"] })), { title: "CI failed on pull request #42", body: "build · Add widgets" });
  const many = mod.formatCiFailure(pr(HEAD_A, { failed: ["a", "b", "c", "d", "e"], title: "t".repeat(100) }));
  assert.equal(many.body, `a, b, c and 2 more · ${"t".repeat(77)}...`);
});

// ── Failures: the user's alert and the agent ────────────────────────────────

test("a pull request already failing when first seen stays quiet, for the user and its agent", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"] }) } });
  await h.pass();
  assert.deepEqual(h.reads, ["/repo"]);
  assert.equal(h.published.length, 0);
  assert.equal(h.failing.length, 0);
  // GitHub says it failed before the watcher started: still quiet.
  const before = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"], failedAt: 1_000_000 - 60_000 }) } });
  await before.pass();
  assert.equal(before.published.length, 0);
  assert.equal(before.failing.length, 0);
});

test("a pull request first seen already failing alerts when it failed after the start", async ({ mod }) => {
  // Pushed while Codara runs, then opened in the browser: the watcher asked
  // at the push (no pull request yet) and next asks 15 minutes later.
  const h = harness(mod);
  await h.pass();
  assert.equal(h.reads.length, 1);
  h.advance(15 * 60_000);
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now - 5 * 60_000 });
  await h.pass();
  assert.equal(h.reads.length, 2);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].title, "CI failed on pull request #42");
  assert.deepEqual(h.failing, [
    { workspaceId: "ws-1", repository: "acme/widgets", number: 42, headOid: HEAD_A, failed: ["build"], branch: "feat/widgets" },
  ]);
  h.advance(15 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "the user hears once per failing commit");
  assert.equal(h.failing.length, 2, "the nudger hears every pass, and tells an agent once");
});

test("a new head commit that fails alerts once, with the workspace as target", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { failed: ["build"] }) } });
  await h.pass();
  // A push: the refs move, so GitHub is asked at once.
  h.refs["/repo"] = "h2 u2";
  h.prs["/repo"] = pr(HEAD_B, { pending: 2 });
  h.advance(30_000);
  await h.pass();
  assert.equal(h.reads.length, 2);
  assert.equal(h.published.length, 0, "running checks are not a failure");
  // Still running: asked again after a minute, not before.
  h.advance(30_000);
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
  assert.deepEqual(h.failing.map((f) => f.headOid), [HEAD_B]);
});

test("a re-run that fails again alerts again; first-seen pending then failing alerts", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  h.prs["/repo"] = pr(HEAD_A, { pending: 1 });
  h.advance(60_000);
  await h.pass();
  assert.deepEqual(h.settled, ["acme/widgets#42", "acme/widgets#42"], "running drops a line still waiting for the agent");
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(60_000);
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
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  assert.equal(h.failing.length, 1);
});

test("alerts off still tells the agent; watching off still alerts the user", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  h.alerts = false;
  await h.pass();
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 0);
  assert.equal(h.failing.length, 1);
  const quiet = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  quiet.watching = false;
  await quiet.pass();
  quiet.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  quiet.advance(60_000);
  await quiet.pass();
  assert.equal(quiet.published.length, 1);
  assert.equal(quiet.failing.length, 0);
  assert.deepEqual(quiet.entries, [], "and the rows show nothing");
});

// ── Green checks ────────────────────────────────────────────────────────────

test("checks that go green leave one quiet note; a first look or a repeat does not", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { passed: 2 }) } });
  await h.pass();
  assert.equal(h.published.length, 0, "green on the first look is not news");
  h.refs["/repo"] = "h2 u2";
  h.prs["/repo"] = pr(HEAD_B, { pending: 1, passed: 1 });
  await h.pass();
  h.prs["/repo"] = pr(HEAD_B, { passed: 2 });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  assert.deepEqual(h.published[0], {
    kind: "git.ci-passed",
    sourceKey: "github-ci:acme/widgets#42",
    title: "Checks passed on pull request #42",
    body: "Add widgets",
    tone: "success",
    soundKind: "done",
    silent: true,
    target: { type: "workspace", workspaceId: "ws-1", panel: "git" },
  });
  h.advance(2 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "still green is not news");
  // Failing, then fixed by a new commit.
  h.refs["/repo"] = "h3 u3";
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  await h.pass();
  h.refs["/repo"] = "h4 u4";
  h.prs["/repo"] = pr(HEAD_B, { passed: 2 });
  await h.pass();
  assert.deepEqual(h.published.map((p) => p.kind), ["git.ci-passed", "git.ci-failed", "git.ci-passed"]);
});

// ── Rows ────────────────────────────────────────────────────────────────────

test("rows get the pull request's phase and checks, once per change", async ({ mod }) => {
  const h = harness(mod, {
    workspaces: [ws("ws-1", "/repo"), ws("ws-2", "/repo")],
    prs: { "/repo": pr(HEAD_A, { pending: 1, passed: 1 }) },
  });
  await h.pass();
  assert.deepEqual(h.entries.map((e) => e.workspaceId), ["ws-1", "ws-2"], "one read, every row of that folder");
  assert.deepEqual(h.entries[0].entry, {
    workspaceId: "ws-1",
    repository: "acme/widgets",
    watching: true,
    pullRequest: {
      workspaceId: "ws-1",
      repository: "acme/widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      title: "Add widgets",
      phase: "open",
      checks: "pending",
      failed: [],
      headOid: HEAD_A,
    },
  });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.entries.length, 2, "an unchanged answer is not sent again");
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], passed: 1 });
  h.advance(60_000);
  await h.pass();
  assert.deepEqual(h.entries.slice(2).map((e) => [e.workspaceId, e.entry.pullRequest.checks, e.entry.pullRequest.failed]), [
    ["ws-1", "failing", ["build"]],
    ["ws-2", "failing", ["build"]],
  ]);
  h.refs["/repo"] = "h2 u2";
  h.prs["/repo"] = pr(HEAD_A, { state: "MERGED" });
  await h.pass();
  assert.deepEqual(h.entries.slice(4).map((e) => [e.entry.pullRequest.phase, e.entry.pullRequest.checks]), [
    ["merged", "none"],
    ["merged", "none"],
  ]);
  assert.deepEqual(h.watch.entries().map((e) => e.workspaceId), ["ws-1", "ws-2"]);
  // The workspace goes: its row's entry goes too.
  h.state.workspaces = [ws("ws-1", "/repo")];
  await h.pass();
  assert.deepEqual(h.entries.at(-1), { workspaceId: "ws-2", entry: null });
});

test("a repository switched off says so on its rows and tells no agent; it is read only for the user's alert", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  h.off.add("acme/widgets");
  h.advance(60_000);
  await h.pass();
  const off = { workspaceId: "ws-1", entry: { workspaceId: "ws-1", repository: "acme/widgets", watching: false } };
  assert.deepEqual(h.entries.at(-1), off);
  // "Notify me when CI fails" is its own setting and still holds.
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"] });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "the user is still alerted");
  assert.equal(h.failing.length, 0, "no agent is told");
  assert.deepEqual(h.entries.at(-1), off);
  // With that alert off too, the repository is not read at all.
  h.alerts = false;
  const reads = h.reads.length;
  h.advance(60 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, reads);
  h.off.clear();
  h.alerts = true;
  await h.pass();
  assert.equal(h.reads.length, reads + 1, "switched back on, it is read at once");
  assert.equal(h.entries.at(-1).entry.watching, true);
});

test("the row's repository is the remote's, which the switch is keyed on", async ({ mod }) => {
  // A fork's pull request lives on the parent; a renamed repository answers with its new name.
  const h = harness(mod, { prs: { "/repo": { ...pr(HEAD_A, { pending: 1 }), repository: "Upstream/Widgets" } } });
  await h.pass();
  const entry = h.entries.at(-1).entry;
  assert.equal(entry.repository, "acme/widgets");
  assert.equal(entry.pullRequest.repository, "upstream/widgets");
});

// ── Cadence ─────────────────────────────────────────────────────────────────

test("an open pull request is asked every minute, twice as long while nothing changes, up to 15 minutes", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { passed: 1 }) } });
  const readsAt = [];
  for (let minute = 0; minute <= 40; minute += 1) {
    const before = h.reads.length;
    await h.pass();
    if (h.reads.length > before) readsAt.push(minute);
    h.advance(60_000);
  }
  assert.deepEqual(readsAt, [0, 1, 3, 7, 15, 30], "1, 2, 4, 8, then 15 minute waits");
  // A change on GitHub's side starts over at one minute.
  h.prs["/repo"] = pr(HEAD_A, { passed: 1, failed: ["late"] });
  h.advance(15 * 60_000);
  await h.pass();
  const after = h.reads.length;
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, after + 1);
  // So does a commit or a push, at once.
  h.refs["/repo"] = "h9 u9";
  await h.pass();
  assert.equal(h.reads.length, after + 2);
});

test("review 4: checks that stay pending are asked every minute for ten minutes, then less and less", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  const readsAt = [];
  for (let minute = 0; minute <= 40; minute += 1) {
    const before = h.reads.length;
    await h.pass();
    if (h.reads.length > before) readsAt.push(minute);
    h.advance(60_000);
  }
  assert.deepEqual(readsAt, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 39], "a check queued forever stops costing a read a minute");
  // A check that finishes is a change: back to every minute.
  h.prs["/repo"] = pr(HEAD_A, { pending: 1, passed: 1 });
  h.advance(15 * 60_000);
  await h.pass();
  const after = h.reads.length;
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, after + 1);
});

test("branches with no pull request, merged and closed ones are asked every 15 minutes", async ({ mod }) => {
  const h = harness(mod, {
    workspaces: [ws("ws-1", "/repo"), ws("ws-6", "/closed")],
    refs: { "/repo": "h u", "/closed": "h u" },
    prs: { "/repo": null, "/closed": pr(HEAD_A, { failed: ["x"], state: "MERGED" }) },
  });
  await h.pass();
  h.advance(14 * 60_000);
  await h.pass();
  assert.equal(h.reads.length, 2);
  h.advance(60_000);
  await h.pass();
  assert.equal(h.reads.length, 4);
  assert.equal(h.published.length, 0);
  assert.equal(h.failing.length, 0, "a merged pull request's old failure tells nobody");
});

test("remote, missing and upstream-less workspaces cost nothing", async ({ mod }) => {
  const h = harness(mod, {
    workspaces: [ws("ws-1", "/repo"), ws("ws-2", "/no-upstream"), ws("ws-3", "ssh://box/srv"), ws("ws-4", "/missing")],
    refs: { "/repo": "h u", "/missing": "h u", "ssh://box/srv": "h u" },
  });
  await h.pass();
  assert.deepEqual(h.reads, ["/repo"]);
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

test("turned off: no reads, rows cleared, and turning it back on starts fresh", async ({ mod }) => {
  const h = harness(mod, { enabled: false, prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  assert.equal(h.reads.length, 0);
  h.enabled = true;
  await h.pass();
  assert.equal(h.reads.length, 1);
  h.enabled = false;
  await h.pass();
  assert.deepEqual(h.entries.at(-1), { workspaceId: "ws-1", entry: null });
  h.advance(30 * 60_000);
  h.enabled = true;
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now - 10 * 60_000 });
  await h.pass();
  assert.equal(h.reads.length, 2, "forgotten state means a fresh read");
  assert.equal(h.published.length, 0, "and a failure from while it was off is quiet");
});

test("review 1: the watcher withdraws a queued line it no longer stands behind", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  h.advance(60_000);
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now });
  await h.pass();
  assert.equal(h.failing.length, 1);
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  await h.pass();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"], "a pass that did not need to read it still stands behind it");
  h.off.add("acme/widgets");
  await h.pass();
  assert.deepEqual(h.retained.at(-1), [], "switched off from the row menu");
  h.off.clear();
  await h.pass();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  h.watching = false;
  await h.pass();
  assert.deepEqual(h.retained.at(-1), [], "Watch pull requests turned off");
  h.watching = true;
  await h.pass();
  h.advance(60_000);
  await h.pass();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], state: "MERGED" });
  h.refs["/repo"] = "h2 u2";
  await h.pass();
  assert.deepEqual(h.retained.at(-1), [], "merged while it waited");
  h.prs["/repo"] = pr(HEAD_B, { failed: ["build"], failedAt: h.now });
  h.refs["/repo"] = "h3 u3";
  await h.pass();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  h.state.workspaces = [];
  await h.pass();
  assert.deepEqual(h.retained.at(-1), [], "the worktree was removed");
  h.state.workspaces = [ws("ws-1", "/repo")];
  await h.pass();
  h.enabled = false;
  await h.pass();
  assert.deepEqual(h.retained.at(-1), [], "the watcher turned off altogether");
});

test("re-review 1: a setting change withdraws a waiting line at once, before any pass", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  await h.pass();
  h.advance(60_000);
  h.prs["/repo"] = pr(HEAD_A, { failed: ["build"], failedAt: h.now });
  await h.pass();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  h.off.add("acme/widgets");
  h.watch.recheck();
  assert.deepEqual(h.retained.at(-1), [], "the switch counts now, not at the next read");
  h.off.clear();
  h.watch.recheck();
  assert.deepEqual(h.retained.at(-1), ["acme/widgets#42"]);
  h.watching = false;
  h.watch.recheck();
  assert.deepEqual(h.retained.at(-1), []);
  h.watching = true;
  h.enabled = false;
  h.watch.recheck();
  assert.deepEqual(h.retained.at(-1), []);
});

test("re-review 2: a nudge during a pass keeps its earlier timer when the pass ends", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  h.watch.start();
  const first = h.timers[0];
  h.timers = [];
  let release;
  h.gate = new Promise((resolve) => (release = resolve));
  first.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.length, 1, "the pass is reading");
  h.refWatches[0].onChange();
  assert.deepEqual(h.timers.map((t) => t.ms), [1_000]);
  h.gate = null;
  release();
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.timers.map((t) => t.ms), [1_000], "not replaced by the minute tick");
  h.watch.stop();
});

test("review 5: a nudge during a running pass is not lost", async ({ mod }) => {
  const h = harness(mod, { prs: { "/repo": pr(HEAD_A, { pending: 1 }) } });
  let release;
  h.gate = new Promise((resolve) => (release = resolve));
  const first = h.watch.runPass();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.length, 1, "the first pass is reading");
  // Pushed while that pass waits on GitHub.
  h.refs["/repo"] = "h2 u2";
  const second = h.watch.runPass();
  h.gate = null;
  release();
  await first;
  await second;
  assert.equal(h.reads.length, 2, "a second pass ran after the first and saw the push");
});

test("review 5: a push or fetch of the branch's upstream asks again within a second", async ({ mod }) => {
  const h = harness(mod, { workspaces: [ws("ws-1", "/repo"), ws("ws-2", "/other")], refs: { "/repo": "h1 u1", "/other": "h1 u1" } });
  h.watch.start();
  await h.pass();
  assert.deepEqual(h.refWatches.map((w) => w.cwd), ["/repo", "/other"], "one watch per workspace folder");
  await h.pass();
  assert.equal(h.refWatches.length, 2, "kept, not reopened, while the refs stay");
  h.timers = [];
  h.refWatches[0].onChange();
  assert.deepEqual(h.timers.map((t) => t.ms), [1_000]);
  h.state.workspaces = [ws("ws-1", "/repo")];
  await h.pass();
  assert.deepEqual(h.refWatchesClosed, ["/other"], "a workspace that left stops being watched");
  h.watch.stop();
  assert.deepEqual(h.refWatchesClosed, ["/other", "/repo"], "stopping closes every watch");
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

test("timers: every five minutes while nobody uses the computer; shorter waits when asked", async ({ mod }) => {
  const timers = [];
  let idle = 0;
  const base = {
    loadState: async () => ({ workspaces: [], workspaceGroups: [], activeWorkspaceId: null }),
    enabled: () => true,
    pathExists: async () => true,
    localRefs: async () => null,
    readPullRequest: async () => null,
    publish: () => undefined,
    rearm: () => undefined,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    log: () => undefined,
    idleMs: () => idle,
  };
  const watch = mod.createGitHubCiWatch(base);
  const tick = async () => {
    const next = timers.shift();
    next.fn();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  watch.start();
  await tick();
  assert.deepEqual(timers.map((t) => t.ms), [60_000]);
  idle = 11 * 60_000;
  await tick();
  assert.deepEqual(timers.map((t) => t.ms), [5 * 60_000]);
  idle = 0;
  await tick();
  assert.deepEqual(timers.map((t) => t.ms), [60_000]);
  watch.stop();
  const fast = mod.createGitHubCiWatch({ ...base, intervals: { first: 700, tick: 700 } });
  fast.start();
  assert.deepEqual(timers.map((t) => t.ms), [700]);
  fast.stop();
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
