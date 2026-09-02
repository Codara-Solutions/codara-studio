#!/usr/bin/env node
"use strict";

// Unit tests for src/main/github-push-watch.ts — "a teammate pushed" alerts
// sourced from GitHub's Events API. The module is esbuild-bundled from src/
// with its side-effecting siblings stubbed, and driven through its injected
// dependencies with a scripted HTTP layer (no network, no gh, no Electron).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-push-watch-"));
  const outfile = path.join(temp, "github-push-watch.cjs");
  const STUBS = {
    "./git-exec": `export function runGit() { throw new Error("production stub"); }`,
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
          if (active >= limit) await new Promise((r) => waiting.push(r));
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
    entryPoints: [path.join(ROOT, "src", "main", "github-push-watch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "gh-push-watch-stubs",
        setup(build) {
          for (const specifier of Object.keys(STUBS)) {
            build.onResolve(
              { filter: new RegExp(`^${specifier.replace(/[./]/g, "\\$&")}$`) },
              () => ({ path: specifier, namespace: "stub" }),
            );
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            loader: "js",
            contents: STUBS[args.path],
            resolveDir: ROOT,
          }));
        },
      },
    ],
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const VIEWER = "Jorgeherrero10";
let eventSeq = 1000;

function pushEvent(actor, branch, { head = "h" + eventSeq, before = "b" + eventSeq, id } = {}) {
  const eventId = id ?? String(++eventSeq);
  return {
    id: eventId,
    type: "PushEvent",
    actor: { login: actor },
    payload: { ref: `refs/heads/${branch}`, head, before },
  };
}

function ws(id, cwd, extra = {}) {
  return { id, name: extra.name ?? id, cwd, color: "#000", workers: [], ...extra };
}

// Scripted HTTP: /user, /events (with ETag), /compare, /commits.
function makeHttp() {
  const http = {
    calls: [],
    events: new Map(), // "owner/name" -> { list, etag, status, pollInterval }
    compare: { ahead_by: 1, commits: [{ commit: { message: "subject line\n\nbody" } }] },
  };
  http.setEvents = (repo, list, opts = {}) => {
    http.events.set(repo, {
      list,
      etag: opts.etag ?? `etag-${list.length}-${Math.random()}`,
      status: opts.status ?? 200,
      pollInterval: opts.pollInterval ?? 60,
    });
  };
  http.get = async (url, headers) => {
    http.calls.push({ url, headers });
    if (url.endsWith("/user")) {
      return { status: 200, headers: {}, body: { login: VIEWER } };
    }
    const eventsMatch = /\/repos\/([^/]+)\/([^/]+)\/events/.exec(url);
    if (eventsMatch) {
      const key = `${eventsMatch[1]}/${eventsMatch[2]}`;
      const entry = http.events.get(key);
      if (!entry) return { status: 404, headers: {}, body: null };
      if (entry.status !== 200) return { status: entry.status, headers: {}, body: null };
      if (headers["If-None-Match"] && headers["If-None-Match"] === entry.etag) {
        return { status: 304, headers: { etag: entry.etag, "x-poll-interval": String(entry.pollInterval) }, body: null };
      }
      return {
        status: 200,
        headers: { etag: entry.etag, "x-poll-interval": String(entry.pollInterval) },
        body: entry.list,
      };
    }
    if (url.includes("/compare/")) return { status: 200, headers: {}, body: http.compare };
    if (url.includes("/commits/")) {
      return { status: 200, headers: {}, body: { commit: { message: "first commit" } } };
    }
    return { status: 404, headers: {}, body: null };
  };
  return http;
}

async function makeHarness(mod, { workspaces, http, remotes = {}, prefs = {}, token = "tok" }) {
  const h = {
    http,
    now: 1_000_000,
    prefs: {
      gitAutoFetchEnabled: true,
      notifyTeammatePushes: true,
      notifyPullRequests: true,
      gitAutoFetchIntervalMinutes: 3,
      ...prefs,
    },
    online: true,
    published: [],
    rearmed: [],
    logs: [],
    timers: [],
    stateListeners: [],
    state: { workspaces, workspaceGroups: [], activeWorkspaceId: workspaces[0]?.id ?? null },
  };
  await mod.startGitHubPushWatch({
    loadState: async () => h.state,
    onStateSaved: (l) => { h.stateListeners.push(l); return () => {}; },
    runGit: async (cwd, args) => {
      const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
      if (sub === "remote" && args.includes("get-url")) {
        const url = remotes[cwd];
        if (!url) throw new Error("no remote");
        return { stdout: url + "\n", stderr: "" };
      }
      if (sub === "remote") return { stdout: remotes[cwd] ? "origin\n" : "", stderr: "" };
      if (sub === "branch") return { stdout: "main\n", stderr: "" };
      if (sub === "config") return { stdout: "origin\n", stderr: "" };
      throw new Error("unexpected git " + args.join(" "));
    },
    getToken: async () => token,
    httpGet: http.get,
    publish: (e) => h.published.push(e),
    rearm: (k) => h.rearmed.push(k),
    getPreference: (k) => h.prefs[k],
    pathExists: async (p) => !p.includes("missing"),
    isOnline: () => h.online,
    now: () => h.now,
    setTimeout: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimeout: (t) => { h.timers = h.timers.filter((x) => x !== t); },
    random: () => 0,
    log: (m) => h.logs.push(m),
  });
  h.advance = (ms) => { h.now += ms; };
  h.pass = () => mod.runGitHubPushWatchPass();
  h.eventCalls = () => http.calls.filter((c) => c.url.includes("/events"));
  h.saveState = async (next) => {
    h.state = next;
    for (const l of h.stateListeners) l(next);
    await mod.waitForGitHubPushWatchRebuild();
  };
  return h;
}

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

// ── Cases ───────────────────────────────────────────────────────────────────

test("parseGitHubRemote accepts every remote URL shape; non-GitHub is not watched", async ({ mod }) => {
  const p = mod.parseGitHubRemote;
  for (const url of [
    "https://github.com/Codara-Solutions/codara-internal-studio.git",
    "https://github.com/Codara-Solutions/codara-internal-studio",
    "git@github.com:Codara-Solutions/codara-internal-studio.git",
    "ssh://git@github.com/Codara-Solutions/codara-internal-studio.git",
    "github.com/Codara-Solutions/codara-internal-studio",
    "https://github.com/Codara-Solutions/codara-internal-studio/",
  ]) {
    assert.deepEqual(p(url), { owner: "Codara-Solutions", name: "codara-internal-studio" }, url);
  }
  for (const url of [
    "https://gitlab.com/o/n.git",
    "git@bitbucket.org:o/n.git",
    "https://github.enterprise.internal/o/n.git",
    "",
    "not a url",
  ]) {
    assert.equal(p(url), null, url);
  }
});

test("notification copy: one branch names the subject, several summarise", async ({ mod }) => {
  const f = mod.formatPushNotification;
  assert.deepEqual(f("codara-studio", ["Ed3scomb3s"], [{ branch: "feat/x", count: 3, subject: "wire it up" }]), {
    title: "Ed3scomb3s pushed to codara-studio",
    body: "3 commits to feat/x — wire it up",
  });
  assert.equal(f("r", ["A"], [{ branch: "main", count: 1, subject: "s" }]).body, "1 commit to main — s");
  assert.equal(f("r", ["A", "B"], [{ branch: "main", count: 1, subject: "" }]).title, "A and B pushed to r");
  assert.equal(f("r", ["A", "B", "C"], [{ branch: "m", count: 1, subject: "" }]).title, "3 teammates pushed to r");
  assert.equal(
    f("r", ["A"], [
      { branch: "a", count: 2, subject: "" },
      { branch: "b", count: 3, subject: "" },
      { branch: "c", count: 1, subject: "" },
    ]).body,
    "6 commits to a, b and 1 more",
  );
});

test("first poll seeds silently; a later teammate push publishes once, silent and routed", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("Codara-Solutions/studio", [pushEvent(VIEWER, "main", { id: "1" })]);
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1", { name: "codara-studio" })],
    http,
    remotes: { "/r1": "git@github.com:Codara-Solutions/studio.git" },
  });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 0, "the first poll must not announce history");
  assert.equal(mod.getGitHubPushWatchSnapshot()[0].seeded, true);

  http.setEvents("Codara-Solutions/studio", [
    pushEvent("Ed3scomb3s", "feat/x", { id: "2", before: "b1", head: "h1" }),
    pushEvent(VIEWER, "main", { id: "1" }),
  ]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  const [event] = h.published;
  assert.equal(event.kind, "git.teammate-push");
  assert.equal(event.title, "Ed3scomb3s pushed to codara-studio");
  assert.equal(event.body, "1 commit to feat/x — subject line");
  assert.equal(event.silent, true, "push alerts are informational: no chime");
  assert.deepEqual(event.target, { type: "workspace", workspaceId: "w1", panel: "git" });
  assert.deepEqual(h.rearmed, ["github-push:codara-solutions/studio"]);
  mod.stopGitHubPushWatch();
});

function prEvent(actor, action, number, { id, title = "Fix the thing", draft = false, branch = "fix/thing" } = {}) {
  eventSeq += 1;
  return {
    id: id ?? String(eventSeq),
    type: "PullRequestEvent",
    actor: { login: actor },
    payload: {
      action,
      pull_request: {
        number,
        title,
        draft,
        html_url: `https://github.com/o/n/pull/${number}`,
        head: { ref: branch },
      },
    },
  };
}

test("a teammate's pull request alerts once per PR with a chime; drafts and my own stay quiet", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("Codara-Solutions/studio", [pushEvent(VIEWER, "main", { id: "1" })]);
  const h = await makeHarness(mod, {
    workspaces: [
      ws("w1", "/r1", { name: "codara-studio" }),
      ws("w2", "/r1-fix", { name: "fix", copyBranch: { branch: "fix/thing" } }),
    ],
    http,
    remotes: {
      "/r1": "git@github.com:Codara-Solutions/studio.git",
      "/r1-fix": "git@github.com:Codara-Solutions/studio.git",
    },
  });
  h.advance(60_000);
  await h.pass();
  assert.equal(h.published.length, 0);

  http.setEvents("Codara-Solutions/studio", [
    prEvent("Ed3scomb3s", "opened", 21, { id: "p4", draft: true, title: "WIP" }),
    prEvent(VIEWER, "opened", 20, { id: "p3", title: "Mine" }),
    prEvent("Ed3scomb3s", "closed", 19, { id: "p2" }),
    prEvent("Ed3scomb3s", "opened", 18, { id: "p1", title: "Stash the draft first" }),
    pushEvent(VIEWER, "main", { id: "1" }),
  ]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "only the teammate's non-draft opened PR alerts");
  const [event] = h.published;
  assert.equal(event.kind, "git.pull-request");
  assert.equal(event.title, "Ed3scomb3s opened PR #18 in codara-studio");
  assert.equal(event.body, "Stash the draft first");
  assert.equal(event.silent, undefined, "a review request chimes");
  assert.deepEqual(event.target, { type: "workspace", workspaceId: "w2", panel: "git" });
  assert.deepEqual(h.rearmed, ["github-pr:codara-solutions/studio#18"]);

  // The same events again: already seen, nothing new.
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1);

  // The draft becoming ready is the moment it asks for attention.
  http.setEvents("Codara-Solutions/studio", [
    prEvent("Ed3scomb3s", "ready_for_review", 21, { id: "p5", title: "WIP" }),
    prEvent("Ed3scomb3s", "opened", 21, { id: "p4", draft: true, title: "WIP" }),
  ]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 2);
  assert.equal(h.published[1].title, "Ed3scomb3s marked ready PR #21 in codara-studio");

  // PR alerts off, pushes on: PR events are ignored but the poll continues.
  h.prefs.notifyPullRequests = false;
  http.setEvents("Codara-Solutions/studio", [prEvent("Ed3scomb3s", "opened", 22, { id: "p6" })]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 2);
  mod.stopGitHubPushWatch();
});

test("my own pushes never notify — including squash merges the email filter used to miss", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [pushEvent("someone", "main", { id: "seed" })]);
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1")],
    http,
    remotes: { "/r1": "https://github.com/o/n.git" },
  });
  h.advance(60_000);
  await h.pass();
  http.setEvents("o/n", [
    pushEvent(VIEWER, "main", { id: "mine-1" }),
    pushEvent(VIEWER.toUpperCase(), "main", { id: "mine-2" }),
    pushEvent("someone", "main", { id: "seed" }),
  ]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 0, "actor.login === viewer is me, whatever the commit emails say");
  mod.stopGitHubPushWatch();
});

test("304 costs nothing and publishes nothing; ETag is sent back", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [pushEvent("mate", "main", { id: "1" })], { etag: "E1" });
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1")],
    http,
    remotes: { "/r1": "https://github.com/o/n.git" },
  });
  h.advance(60_000);
  await h.pass();
  const afterSeed = h.eventCalls().length;
  h.advance(3 * 60_000);
  await h.pass();
  const conditional = h.eventCalls()[afterSeed];
  assert.equal(conditional.headers["If-None-Match"], "E1", "second poll is conditional");
  assert.equal(h.published.length, 0);
  mod.stopGitHubPushWatch();
});

test("several pushes collapse into one alert; tag pushes are ignored", async ({ mod }) => {
  const http = makeHttp();
  http.compare = { ahead_by: 4, commits: [{ commit: { message: "latest on main" } }] };
  http.setEvents("o/n", [pushEvent("mate", "main", { id: "seed" })]);
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1", { name: "repo" })],
    http,
    remotes: { "/r1": "https://github.com/o/n.git" },
  });
  h.advance(60_000);
  await h.pass();
  http.setEvents("o/n", [
    { id: "t1", type: "PushEvent", actor: { login: "mate" }, payload: { ref: "refs/tags/v1", head: "x", before: "y" } },
    pushEvent("mate", "main", { id: "p3", before: "b2", head: "h3" }),
    pushEvent("mate", "main", { id: "p2", before: "b1", head: "h2" }),
    pushEvent("mate", "main", { id: "seed" }),
  ]);
  h.advance(3 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1, "one alert per repository per pass");
  assert.equal(h.published[0].body, "4 commits to main — latest on main");
  const compareCall = http.calls.find((c) => c.url.includes("/compare/"));
  assert.ok(compareCall.url.endsWith("/compare/b1...h3"), `spans oldest..newest, got ${compareCall.url}`);
  mod.stopGitHubPushWatch();
});

test("404/403 pauses the repository instead of retrying forever", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [], { status: 404 });
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1")],
    http,
    remotes: { "/r1": "https://github.com/o/n.git" },
  });
  h.advance(60_000);
  await h.pass();
  assert.equal(mod.getGitHubPushWatchSnapshot()[0].paused, true);
  const calls = h.eventCalls().length;
  h.advance(60 * 60_000);
  await h.pass();
  assert.equal(h.eventCalls().length, calls, "a paused repo is not polled again");
  assert.equal(h.logs.length, 1);
  mod.stopGitHubPushWatch();
});

test("disabled preference, offline, missing token and non-GitHub remotes all stay silent", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [pushEvent("mate", "main", { id: "1" })]);
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1"), ws("w2", "/gitlab"), ws("w3", "/missing/x")],
    http,
    remotes: { "/r1": "https://github.com/o/n.git", "/gitlab": "https://gitlab.com/o/n.git" },
  });
  assert.deepEqual(
    mod.getGitHubPushWatchSnapshot().map((r) => r.key),
    ["o/n"],
    "only the GitHub-remote workspace is watched",
  );
  h.advance(60_000);

  h.prefs.notifyTeammatePushes = false;
  h.prefs.notifyPullRequests = false;
  await h.pass();
  assert.equal(h.eventCalls().length, 0, "both notify prefs off → no polling at all");

  h.prefs.notifyTeammatePushes = true;
  h.prefs.notifyPullRequests = true;
  h.online = false;
  await h.pass();
  assert.equal(h.eventCalls().length, 0, "offline → no polling");

  h.online = true;
  await h.pass();
  assert.equal(h.eventCalls().length, 1);
  mod.stopGitHubPushWatch();
});

test("worktrees of one repo are watched once; X-Poll-Interval is honoured as a floor", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [pushEvent("mate", "main", { id: "1" })], { pollInterval: 600 });
  const h = await makeHarness(mod, {
    workspaces: [
      ws("main", "/r1", { name: "repo" }),
      ws("wt", "/wt", { copyBranch: { repoCwd: "/r1", branch: "feat/x", city: "x", createdAt: "" } }),
    ],
    http,
    remotes: {
      "/r1": "https://github.com/o/n.git",
      "/wt": "https://github.com/o/n.git",
    },
  });
  const snap = mod.getGitHubPushWatchSnapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].cwds, ["/r1", "/wt"]);
  h.advance(60_000);
  await h.pass();
  assert.equal(h.eventCalls().length, 1, "one poll covers both workspaces");

  // A push to the worktree's branch routes the click to that worktree.
  http.setEvents(
    "o/n",
    [pushEvent("mate", "feat/x", { id: "wt1", before: "b1", head: "h1" }), pushEvent("mate", "main", { id: "1" })],
    { pollInterval: 600 },
  );
  h.advance(20 * 60_000);
  await h.pass();
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].target.workspaceId, "wt", "routes to the worktree on feat/x");
  // 600s advertised beats the 3-minute preference.
  assert.equal(mod.getGitHubPushWatchSnapshot()[0].nextDueAt, h.now + 600_000);
  mod.stopGitHubPushWatch();
});

test("adding a workspace rebuilds the table and keeps existing repos seeded", async ({ mod }) => {
  const http = makeHttp();
  http.setEvents("o/n", [pushEvent("mate", "main", { id: "1" })]);
  http.setEvents("o/second", [pushEvent("mate", "main", { id: "9" })]);
  const h = await makeHarness(mod, {
    workspaces: [ws("w1", "/r1")],
    http,
    remotes: { "/r1": "https://github.com/o/n.git", "/r2": "https://github.com/o/second.git" },
  });
  h.advance(60_000);
  await h.pass();
  assert.equal(mod.getGitHubPushWatchSnapshot()[0].seeded, true);
  await h.saveState({ ...h.state, workspaces: [...h.state.workspaces, ws("w2", "/r2")] });
  const snaps = mod.getGitHubPushWatchSnapshot();
  assert.equal(snaps.length, 2);
  assert.equal(snaps.find((r) => r.key === "o/n").seeded, true, "existing repo keeps its seed");
  assert.equal(snaps.find((r) => r.key === "o/second").seeded, false);
  mod.stopGitHubPushWatch();
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
        mod.stopGitHubPushWatch();
      } catch {
        /* ignore */
      }
    }
  }
  cleanup();
  console.log(`\n${TESTS.length - failed}/${TESTS.length} github-push-watch tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
