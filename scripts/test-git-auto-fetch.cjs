#!/usr/bin/env node
"use strict";

// Unit tests for src/main/git-auto-fetch.ts — the background fetch scheduler
// that keeps remote-tracking refs current. It raises no notifications
// (github-push-watch.ts owns those); several cases below assert exactly that.
// The module is esbuild-bundled straight from src/ with its side-effecting
// siblings replaced by inline stubs, and driven through its injected
// dependencies with a scripted fake `runGit`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const UNIT = "\x1f";
// Mirrors git-auto-fetch's repo key derivation (path.resolve + lowercase on
// win32) so expectations hold on every platform.
const keyOf = (k) =>
  process.platform === "win32" ? path.resolve(k).toLowerCase() : path.resolve(k);

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-git-auto-fetch-"));
  const outfile = path.join(temp, "git-auto-fetch.cjs");
  const entry = path.join(ROOT, "src", "main", "git-auto-fetch.ts");
  const STUBS = {
    "./git-exec": `
      export function runGit() { throw new Error("production stub"); }
      export function errorText(err) {
        const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
        if (stderr) return stderr;
        const message = typeof err?.message === "string" ? err.message.trim() : "";
        return message || String(err);
      }
      export function isGitNetworkOpInFlight() { return false; }
      export function onGitNetworkOpSucceeded() { return () => {}; }
    `,
    "./git-ops": `export function invalidateGitCache() {}`,
    "./storage": `
      export function loadState() { throw new Error("production stub"); }
      export function onStateSaved() { return () => {}; }
    `,
    "./notify": `
      export function publish() { throw new Error("production stub"); }
      export function rearm() {}
    `,
    "./preferences-store": `export function getPreferenceCached() { return undefined; }`,
    "./github-work-queue": `
      import { createHash } from "node:crypto";
      export function createLimiter(limit) {
        let active = 0; const waiting = [];
        return async (work) => {
          if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
          active += 1;
          try { return await work(); } finally { active -= 1; waiting.shift()?.(); }
        };
      }
      export function workQueueRelevantFingerprint(state) {
        const relevant = state.workspaces.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, copyBranch: w.copyBranch ?? null }));
        return createHash("sha1").update(JSON.stringify(relevant)).digest("hex");
      }
    `,
  };
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "git-auto-fetch-stubs",
        setup(build) {
          for (const specifier of Object.keys(STUBS)) {
            build.onResolve(
              { filter: new RegExp(`^${specifier.replace(/[./]/g, "\\$&")}$`) },
              () => ({ path: specifier, namespace: "auto-fetch-stub" }),
            );
          }
          build.onLoad({ filter: /.*/, namespace: "auto-fetch-stub" }, (args) => ({
            loader: "js",
            contents: STUBS[args.path],
            resolveDir: ROOT,
          }));
        },
      },
    ],
  });
  return {
    mod: require(outfile),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

// ── Fake git ────────────────────────────────────────────────────────────────
// A tiny model of N repositories: remote refs (name → sha), commits (sha →
// metadata), and a per-repo "pending push" that the next fetch applies.

const ME = "jorge@codara.test";

function makeWorld() {
  const world = {
    repos: new Map(), // key → { remotes, refs, commits, pending, failNext, branchByCwd }
    calls: [],
  };
  world.addRepo = (key, opts = {}) => {
    world.repos.set(key, {
      key,
      remotes: opts.remotes ?? ["origin"],
      refs: new Map(opts.refs ?? [["refs/remotes/origin/HEAD", "m1"], ["refs/remotes/origin/main", "m1"]]),
      commits: new Map(opts.commits ?? [["m1", { an: "Jorge", ae: ME, ce: ME, s: "init", parents: [] }]]),
      pending: null,
      failNext: null,
      branchByCwd: opts.branchByCwd ?? {},
      userEmail: opts.userEmail === undefined ? ME : opts.userEmail,
      globalEmail: opts.globalEmail ?? "",
      cwds: new Set(),
    });
    return world.repos.get(key);
  };
  world.bind = (cwd, key) => world.repos.get(key).cwds.add(cwd);
  world.repoFor = (cwd) => {
    for (const repo of world.repos.values()) if (repo.cwds.has(cwd)) return repo;
    throw new Error(`no fake repo bound to ${cwd}`);
  };
  // Queue a push: commits get appended on top of `parentSha`, ref moves.
  world.push = (key, ref, commits, { parentSha } = {}) => {
    const repo = world.repos.get(key);
    const base = parentSha ?? repo.refs.get(ref) ?? null;
    let parent = base;
    const shas = [];
    for (const c of commits) {
      repo.commits.set(c.sha, { an: c.an, ae: c.ae, ce: c.ce ?? c.ae, s: c.s, parents: parent ? [parent] : [] });
      parent = c.sha;
      shas.push(c.sha);
    }
    repo.pending = repo.pending ?? [];
    repo.pending.push({ ref, sha: parent });
  };
  // The user's own fetch/pull landed outside the auto-fetcher: refs already moved.
  world.applyPending = (key) => {
    const repo = world.repos.get(key);
    for (const { ref, sha } of repo.pending ?? []) repo.refs.set(ref, sha);
    repo.pending = null;
  };
  // Ancestors of a sha (inclusive), newest first (linear histories only).
  function history(repo, sha) {
    const out = [];
    let cur = sha;
    while (cur) {
      const c = repo.commits.get(cur);
      if (!c) break;
      out.push({ sha: cur, ...c });
      cur = c.parents[0] ?? null;
    }
    return out;
  }
  function resolveRange(repo, args) {
    const positives = [];
    const negatives = [];
    for (const a of args) {
      if (a.startsWith("--")) continue;
      if (a.includes("..")) {
        const [o, n] = a.split("..");
        negatives.push(o);
        positives.push(n);
      } else if (a.startsWith("^")) negatives.push(a.slice(1));
      else positives.push(a);
    }
    const resolve = (r) => repo.refs.get(r) ?? r;
    const excluded = new Set();
    for (const n of negatives) for (const c of history(repo, resolve(n))) excluded.add(c.sha);
    const out = [];
    for (const p of positives) {
      for (const c of history(repo, resolve(p))) {
        if (excluded.has(c.sha)) break;
        out.push(c);
      }
    }
    return out;
  }
  world.runGit = async (cwd, args, opts) => {
    world.calls.push({ cwd, args, opts });
    const repo = world.repoFor(cwd);
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    switch (sub) {
      case "rev-parse":
        return { stdout: `${repo.key}\n`, stderr: "" };
      case "remote":
        return { stdout: repo.remotes.join("\n") + "\n", stderr: "" };
      case "branch":
        return { stdout: (repo.branchByCwd[cwd] ?? "main") + "\n", stderr: "" };
      case "config": {
        if (args.includes("--global")) return { stdout: repo.globalEmail + "\n", stderr: "" };
        if (args.includes("user.email")) return { stdout: repo.userEmail + "\n", stderr: "" };
        return { stdout: "origin\n", stderr: "" }; // branch.<x>.remote
      }
      case "for-each-ref": {
        const prefix = args[args.length - 1];
        const lines = [...repo.refs].filter(([r]) => r.startsWith(prefix)).map(([r, s]) => `${r}${UNIT}${s}`);
        return { stdout: lines.join("\n") + "\n", stderr: "" };
      }
      case "fetch": {
        if (repo.failNext) {
          const message = repo.failNext;
          repo.failNext = null;
          const err = new Error("git fetch failed");
          err.stderr = message;
          throw err;
        }
        for (const { ref, sha } of repo.pending ?? []) repo.refs.set(ref, sha);
        repo.pending = null;
        return { stdout: "", stderr: "" };
      }
      case "rev-list": {
        const cap = Number(args.find((a) => a.startsWith("--max-count=")).slice(12));
        const n = Math.min(cap, resolveRange(repo, args.slice(args.indexOf("rev-list") + 1)).length);
        return { stdout: `${n}\n`, stderr: "" };
      }
      case "log": {
        const cap = Number(args.find((a) => a.startsWith("--max-count=")).slice(12));
        const rows = resolveRange(repo, args.slice(args.indexOf("log") + 1)).slice(0, cap);
        return {
          stdout: rows.map((c) => [c.sha, c.an, c.ae, c.ce, c.s].join(UNIT)).join("\n"),
          stderr: "",
        };
      }
      default:
        throw new Error(`fake git: unhandled ${sub} ${args.join(" ")}`);
    }
  };
  return world;
}

function ws(id, cwd, extra = {}) {
  return { id, name: extra.name ?? id, cwd, color: "#000", workers: [], ...extra };
}

// ── Harness ─────────────────────────────────────────────────────────────────

async function makeHarness(mod, { workspaces, world, prefs = {}, idleSeconds = 0, online = true }) {
  const state = { workspaces, workspaceGroups: [], activeWorkspaceId: workspaces[0]?.id ?? null };
  const h = {
    world,
    state,
    now: 1_000_000,
    prefs: { gitAutoFetchEnabled: true, gitAutoFetchIntervalMinutes: 3, notifyTeammatePushes: true, ...prefs },
    idleSeconds,
    online,
    inFlight: new Set(),
    published: [],
    rearmed: [],
    invalidated: [],
    broadcasts: [],
    logs: [],
    timers: [],
    stateListeners: [],
    netListeners: [],
  };
  await mod.startGitAutoFetch({
    runGit: world.runGit,
    isGitNetworkOpInFlight: (cwd) => h.inFlight.has(cwd),
    onGitNetworkOpSucceeded: (l) => { h.netListeners.push(l); return () => {}; },
    invalidateGitCache: (cwd) => h.invalidated.push(cwd),
    loadState: async () => h.state,
    onStateSaved: (l) => { h.stateListeners.push(l); return () => {}; },
    publish: (e) => h.published.push(e),
    rearm: (k) => h.rearmed.push(k),
    getPreference: (k) => h.prefs[k],
    canonicalizePath: async (p) => p,
    pathExists: async (p) => !p.includes("missing"),
    isOnline: () => h.online,
    idleSeconds: () => h.idleSeconds,
    broadcastRemoteUpdated: (cwds) => h.broadcasts.push(cwds),
    env: () => ({ PATH: "x" }),
    now: () => h.now,
    setTimeout: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimeout: (t) => { h.timers = h.timers.filter((x) => x !== t); },
    random: () => 0,
    log: (m) => h.logs.push(m),
  });
  // Make every repo due right now so tests don't have to wait out the boot delay.
  h.advancePastBoot = () => { h.now += 120_000; };
  h.pass = async () => { await mod.runGitAutoFetchPass(); };
  h.fetchCalls = () => world.calls.filter((c) => c.args.includes("fetch"));
  h.saveState = async (next) => {
    h.state = next;
    for (const l of h.stateListeners) l(next);
    await mod.waitForGitAutoFetchRebuild();
  };
  return h;
}

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

// ── Cases ───────────────────────────────────────────────────────────────────

test("pure helpers: classifyFailure / args / env / format", async ({ mod }) => {
  assert.equal(mod.classifyFailure("fatal: could not read Username for 'https://github.com'"), "auth");
  assert.equal(mod.classifyFailure("git@github.com: Permission denied (publickey)."), "auth");
  assert.equal(mod.classifyFailure("error: unknown option `no-write-fetch-head'"), "auth");
  assert.equal(mod.classifyFailure("error: cannot lock ref 'refs/remotes/origin/main'"), "soft");
  assert.equal(mod.classifyFailure("fatal: Unable to create '.git/index.lock': File exists."), "soft");
  assert.equal(mod.classifyFailure("fatal: unable to access 'https://x/': Could not resolve host"), "hard");

  const args = mod.autoFetchGitArgs("origin");
  assert.ok(args.includes("gc.auto=0"));
  assert.ok(args.includes("maintenance.auto=false"));
  assert.ok(args.includes("--no-tags"));
  assert.ok(args.includes("--no-write-fetch-head"));
  assert.ok(!args.includes("--prune"));
  assert.ok(!args.includes("--all"));
  assert.equal(args[args.length - 1], "origin");

  const env = mod.autoFetchEnv({ PATH: "p", GIT_SSH_COMMAND: "ssh -i key" });
  assert.equal(env.PATH, "p");
  assert.equal(env.GIT_SSH_COMMAND, "ssh -i key", "must not clobber the user's ssh command");
  assert.equal(env.GIT_ASKPASS, "echo");
  assert.equal(env.SSH_ASKPASS_REQUIRE, "never");
});

test("no ref change → zero side effects; first pass seeds silently", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, { workspaces: [ws("w1", "/r1")], world });
  // Boot delay: nothing runs before it.
  await h.pass();
  assert.equal(h.fetchCalls().length, 0, "must wait out the boot delay");
  h.advancePastBoot();
  await h.pass();
  assert.equal(h.fetchCalls().length, 1);
  assert.equal(h.published.length, 0);
  assert.equal(h.invalidated.length, 0);
  assert.equal(h.broadcasts.length, 0);
  const [repo] = mod.getGitAutoFetchSnapshot();
  assert.equal(repo.seeded, true);
  assert.equal(repo.nextDueAt, h.now + 3 * 60_000, "next due = now + interval");
  // Second pass with nothing new: still nothing.
  h.now = repo.nextDueAt;
  await h.pass();
  assert.equal(h.fetchCalls().length, 2);
  assert.equal(h.published.length, 0);
  assert.equal(h.invalidated.length, 0);
  // Fetch invocation shape.
  const fetch = h.fetchCalls()[0];
  assert.equal(fetch.opts.internal, true);
  assert.equal(fetch.opts.timeout, mod.GIT_AUTO_FETCH_TIMEOUT_MS);
  assert.equal(fetch.opts.env.GIT_ASKPASS, "echo");
  mod.stopGitAutoFetch();
});

test("a moved ref refreshes the panel and raises no notification (github-push-watch owns alerts)", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, { workspaces: [ws("w1", "/r1", { name: "codara-studio" })], world });
  h.advancePastBoot();
  await h.pass(); // seed
  world.push("/r1/.git", "refs/remotes/origin/feat/x", [
    { sha: "e1", an: "Etienne", ae: "etienne@codara.test", s: "first" },
    { sha: "e2", an: "Etienne", ae: "etienne@codara.test", s: "second" },
    { sha: "e3", an: "Etienne", ae: "etienne@codara.test", s: "wire it up" },
  ], { parentSha: "m1" });
  h.now += 3 * 60_000;
  await h.pass();
  assert.equal(h.published.length, 0, "the fetcher must never notify");
  assert.equal(h.rearmed.length, 0);
  assert.deepEqual(h.invalidated, ["/r1"]);
  assert.deepEqual(h.broadcasts, [["/r1"]]);
  // A second push to the same branch later: publishes again (rearm each time).
  world.push("/r1/.git", "refs/remotes/origin/feat/x", [
    { sha: "e4", an: "Etienne", ae: "etienne@codara.test", s: "more" },
  ]);
  h.now += 3 * 60_000;
  await h.pass();
  assert.equal(h.published.length, 0);
  assert.deepEqual(h.broadcasts, [["/r1"], ["/r1"]], "each real change refreshes again");
  mod.stopGitAutoFetch();
});

test("worktrees sharing one common dir → one fetch; click targets the workspace on that branch", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git", { branchByCwd: { "/r1": "main", "/wt/feat": "feat/x" } });
  world.bind("/r1", "/r1/.git");
  world.bind("/wt/feat", "/r1/.git");
  const h = await makeHarness(mod, {
    workspaces: [
      ws("main", "/r1", { name: "codara-studio" }),
      ws("wt", "/wt/feat", { copyBranch: { repoCwd: "/r1", branch: "feat/x", city: "x", createdAt: "" } }),
    ],
    world,
  });
  assert.equal(mod.getGitAutoFetchSnapshot().length, 1);
  assert.deepEqual(mod.getGitAutoFetchSnapshot()[0].cwds, ["/r1", "/wt/feat"]);
  h.advancePastBoot();
  await h.pass();
  assert.equal(h.fetchCalls().length, 1, "one fetch for two workspaces");
  world.push("/r1/.git", "refs/remotes/origin/feat/x", [
    { sha: "e1", an: "Etienne", ae: "etienne@codara.test", s: "on the worktree branch" },
  ], { parentSha: "m1" });
  h.now += 3 * 60_000;
  await h.pass();
  assert.equal(h.fetchCalls().length, 2);
  assert.equal(h.published.length, 0);
  assert.deepEqual(h.invalidated, ["/r1", "/wt/feat"], "every workspace of the repo refreshes");
  mod.stopGitAutoFetch();
});

test("hard failure backs off ×2 (capped); soft failure retries; auth failure pauses until a user op succeeds", async ({ mod }) => {
  const world = makeWorld();
  const repo = world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, { workspaces: [ws("w1", "/r1")], world });
  h.advancePastBoot();
  const interval = 3 * 60_000;

  repo.failNext = "fatal: unable to access 'https://x/': Could not resolve host: github.com";
  await h.pass();
  let [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.backoffMs, interval * 2);
  assert.equal(snap.nextDueAt, h.now + interval * 2);
  h.now = snap.nextDueAt;
  repo.failNext = "fatal: unable to access 'https://x/': Could not resolve host: github.com";
  await h.pass();
  [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.backoffMs, interval * 4);
  // Drive it to the cap.
  for (let i = 0; i < 8; i++) {
    h.now = snap.nextDueAt;
    repo.failNext = "fatal: unable to access 'https://x/': Could not resolve host: github.com";
    await h.pass();
    [snap] = mod.getGitAutoFetchSnapshot();
  }
  assert.equal(snap.backoffMs, mod.GIT_AUTO_FETCH_MAX_BACKOFF_MS);

  // Soft failure: no escalation, quick retry.
  h.now = snap.nextDueAt;
  repo.failNext = "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def";
  await h.pass();
  [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.nextDueAt, h.now + mod.GIT_AUTO_FETCH_MIN_TICK_MS);
  assert.equal(snap.paused, false);

  // Success resets backoff.
  h.now = snap.nextDueAt;
  await h.pass();
  [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.backoffMs, 0);

  // Auth failure pauses; no further fetches.
  h.now = snap.nextDueAt;
  const fetchesBefore = h.fetchCalls().length;
  repo.failNext = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
  await h.pass();
  [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.paused, true);
  assert.equal(h.logs.length, 1);
  h.now += 10 * interval;
  await h.pass();
  assert.equal(h.fetchCalls().length, fetchesBefore + 1, "paused repo is not fetched");
  // User pushes successfully from the panel → unpaused, re-seeds silently.
  for (const l of h.netListeners) l("/r1");
  [snap] = mod.getGitAutoFetchSnapshot();
  assert.equal(snap.paused, false);
  world.push("/r1/.git", "refs/remotes/origin/main", [
    { sha: "e1", an: "Etienne", ae: "etienne@codara.test", s: "arrived via the user's fetch" },
  ]);
  world.applyPending("/r1/.git");
  await h.pass();
  assert.equal(h.fetchCalls().length, fetchesBefore + 2);
  assert.equal(h.published.length, 0, "what the user's own fetch brought in is not re-reported");
  mod.stopGitAutoFetch();
});

test("in-flight user op skips the repo; offline skips the pass; disabled pref stops everything", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, { workspaces: [ws("w1", "/r1")], world });
  h.advancePastBoot();

  h.inFlight.add("/r1");
  await h.pass();
  assert.equal(h.fetchCalls().length, 0);
  assert.equal(mod.getGitAutoFetchSnapshot()[0].nextDueAt, h.now + mod.GIT_AUTO_FETCH_MIN_TICK_MS);
  h.inFlight.clear();

  h.now += mod.GIT_AUTO_FETCH_MIN_TICK_MS;
  h.online = false;
  await h.pass();
  assert.equal(h.fetchCalls().length, 0);
  assert.equal(mod.getGitAutoFetchSnapshot()[0].nextDueAt, h.now + 3 * 60_000, "offline: pushed a full interval");
  h.online = true;

  h.now += 3 * 60_000;
  h.prefs.gitAutoFetchEnabled = false;
  await h.pass();
  assert.equal(h.fetchCalls().length, 0);
  h.prefs.gitAutoFetchEnabled = true;
  await h.pass();
  assert.equal(h.fetchCalls().length, 1);
  mod.stopGitAutoFetch();
});

test("idle machine stretches the interval ×5", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, { workspaces: [ws("w1", "/r1")], world, idleSeconds: 901 });
  h.advancePastBoot();
  await h.pass();
  assert.equal(mod.getGitAutoFetchSnapshot()[0].nextDueAt, h.now + 15 * 60_000);
  h.idleSeconds = 0;
  world.push("/r1/.git", "refs/remotes/origin/main", [
    { sha: "e1", an: "Etienne", ae: "etienne@codara.test", s: "quiet" },
  ]);
  h.now += 15 * 60_000;
  await h.pass();
  assert.equal(h.published.length, 0);
  assert.deepEqual(h.invalidated, ["/r1"]);
  mod.stopGitAutoFetch();
});

test("state changes: unchanged fingerprint = no rebuild; changed = rebuild keeping runtime state; ssh:// and missing paths skipped; >cap dropped", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/r1/.git");
  world.bind("/r1", "/r1/.git");
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1"), ws("remote", "ssh://host/srv/repo"), ws("gone", "/missing/repo")],
    world,
  });
  assert.equal(mod.getGitAutoFetchSnapshot().length, 1);
  h.advancePastBoot();
  await h.pass();
  const revParseCalls = () => world.calls.filter((c) => c.args.includes("rev-parse")).length;
  const before = revParseCalls();
  // Same workspaces, different activeWorkspaceId → fingerprint unchanged.
  await h.saveState({ ...h.state, activeWorkspaceId: "remote" });
  assert.equal(revParseCalls(), before);
  // Add a second repo → rebuild; the first keeps its seeded/nextDueAt state,
  // and the memoized repo key means no second rev-parse for /r1.
  world.addRepo("/r2/.git");
  world.bind("/r2", "/r2/.git");
  const firstBefore = mod.getGitAutoFetchSnapshot()[0];
  await h.saveState({ ...h.state, workspaces: [...h.state.workspaces, ws("w2", "/r2")] });
  const snaps = mod.getGitAutoFetchSnapshot();
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].seeded, true);
  assert.equal(snaps[0].nextDueAt, firstBefore.nextDueAt);
  assert.equal(snaps[1].seeded, false);
  assert.equal(revParseCalls(), before + 1, "only the new cwd is resolved");
  mod.stopGitAutoFetch();

  // Cap.
  const big = makeWorld();
  const many = [];
  for (let i = 0; i < mod.GIT_AUTO_FETCH_MAX_REPOS + 3; i++) {
    big.addRepo(`/x${i}/.git`);
    big.bind(`/x${i}`, `/x${i}/.git`);
    many.push(ws(`x${i}`, `/x${i}`));
  }
  const h2 = await makeHarness(mod, { workspaces: many, world: big });
  assert.equal(mod.getGitAutoFetchSnapshot().length, mod.GIT_AUTO_FETCH_MAX_REPOS);
  assert.equal(h2.logs.length, 1);
  assert.match(h2.logs[0], /3 repositories beyond/);
  mod.stopGitAutoFetch();
});

test("repo with no remote or two non-origin remotes is skipped; scheduler timer follows the earliest due repo", async ({ mod }) => {
  const world = makeWorld();
  world.addRepo("/a/.git", { remotes: [] });
  world.addRepo("/b/.git", { remotes: ["fork", "upstream"] });
  world.addRepo("/c/.git", { remotes: ["only"] });
  world.bind("/a", "/a/.git");
  world.bind("/b", "/b/.git");
  world.bind("/c", "/c/.git");
  const h = await makeHarness(mod, { workspaces: [ws("a", "/a"), ws("b", "/b"), ws("c", "/c")], world });
  const snaps = mod.getGitAutoFetchSnapshot();
  assert.deepEqual(snaps.map((s) => s.key), [keyOf("/c/.git")]);
  assert.equal(snaps[0].remote, "only");
  // Timer armed for the boot delay (clamped into [min, max]).
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, mod.GIT_AUTO_FETCH_FIRST_DELAY_MS);
  // Nudge on focus is a no-op right after a pass, but resume always pulls it in.
  h.advancePastBoot();
  await h.pass();
  const due = mod.getGitAutoFetchSnapshot()[0].nextDueAt;
  mod.nudgeGitAutoFetch("focus");
  assert.equal(mod.getGitAutoFetchSnapshot()[0].nextDueAt, due, "focus right after a pass: no nudge");
  mod.nudgeGitAutoFetch("resume");
  assert.equal(mod.getGitAutoFetchSnapshot()[0].nextDueAt, h.now + mod.GIT_AUTO_FETCH_NUDGE_DELAY_MS);
  assert.equal(h.timers[h.timers.length - 1].ms, mod.GIT_AUTO_FETCH_MIN_TICK_MS);
  mod.stopGitAutoFetch();
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
    } finally {
      try {
        mod.stopGitAutoFetch();
      } catch {
        /* ignore */
      }
    }
  }
  cleanup();
  console.log(`\n${TESTS.length - failed}/${TESTS.length} git-auto-fetch tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
