#!/usr/bin/env node
"use strict";

// Integration test for src/main/git-auto-fetch.ts against REAL git: a bare
// file:// remote, a workspace clone, a teammate clone that pushes, and a
// worktree of the workspace. Proves the actual command shapes (for-each-ref
// format, the fetch flag set, rev-list/log ranges, config reads, common-dir
// resolution) work on the installed git — the unit test only drives a fake.
// Everything is local; no network, no credentials.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-auto-fetch-git-"));
  const outfile = path.join(temp, "git-auto-fetch.cjs");
  const STUBS = {
    // Real ./git-exec stays; only its SSH-remote branch is stubbed out.
    "./remote/remote-git": `export function runRemoteGit() { throw new Error("no remote workspaces in this test"); }`,
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
    entryPoints: [path.join(ROOT, "src", "main", "git-auto-fetch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
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

const JORGE = { GIT_AUTHOR_NAME: "Jorge", GIT_AUTHOR_EMAIL: "jorge@codara.test", GIT_COMMITTER_NAME: "Jorge", GIT_COMMITTER_EMAIL: "jorge@codara.test" };
const ETIENNE = { GIT_AUTHOR_NAME: "Etienne", GIT_AUTHOR_EMAIL: "etienne@codara.test", GIT_COMMITTER_NAME: "Etienne", GIT_COMMITTER_EMAIL: "etienne@codara.test" };

function commit(cwd, file, message, who) {
  fs.writeFileSync(path.join(cwd, file), `${message}\n${Date.now()}\n`);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message], who);
}

(async () => {
  const { mod, cleanup } = await loadModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-auto-fetch-repos-"));
  try {
    const remote = path.join(root, "remote.git");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);

    // Teammate clone seeds main.
    const etienne = path.join(root, "etienne");
    git(root, ["clone", "-q", remote, etienne]);
    git(etienne, ["config", "user.name", "Etienne"]);
    git(etienne, ["config", "user.email", "etienne@codara.test"]);
    git(etienne, ["checkout", "-q", "-b", "main"]);
    commit(etienne, "README.md", "init", ETIENNE);
    git(etienne, ["push", "-q", "-u", "origin", "main"]);

    // Jorge's workspace clone.
    const workspace = path.join(root, "codara-studio");
    git(root, ["clone", "-q", remote, workspace]);
    git(workspace, ["config", "user.name", "Jorge"]);
    git(workspace, ["config", "user.email", "jorge@codara.test"]);
    assert.equal(git(workspace, ["rev-parse", "--abbrev-ref", "origin/HEAD"]), "origin/main");

    const h = {
      now: 1_000_000,
      prefs: { gitAutoFetchEnabled: true, gitAutoFetchIntervalMinutes: 3, notifyTeammatePushes: true },
      published: [],
      invalidated: [],
      broadcasts: [],
      logs: [],
      stateListeners: [],
      state: {
        workspaces: [{ id: "ws", name: "codara-studio", cwd: workspace, color: "#000", workers: [] }],
        workspaceGroups: [],
        activeWorkspaceId: "ws",
      },
    };
    await mod.startGitAutoFetch({
      loadState: async () => h.state,
      onStateSaved: (l) => { h.stateListeners.push(l); return () => {}; },
      publish: (e) => h.published.push(e),
      invalidateGitCache: (cwd) => h.invalidated.push(cwd),
      getPreference: (k) => h.prefs[k],
      broadcastRemoteUpdated: (cwds) => h.broadcasts.push(cwds),
      now: () => h.now,
      setTimeout: () => ({}),
      clearTimeout: () => {},
      random: () => 0,
      log: (m) => h.logs.push(m),
    });
    const snap = () => mod.getGitAutoFetchSnapshot();
    assert.equal(snap().length, 1, `expected one repo, logs: ${h.logs.join(" | ")}`);
    assert.equal(snap()[0].remote, "origin");

    // Seed pass (real fetch with the full flag set against git 2.x).
    h.now += 120_000;
    await mod.runGitAutoFetchPass();
    assert.equal(snap()[0].seeded, true, `seed failed: ${h.logs.join(" | ")} paused=${snap()[0].paused}`);
    assert.equal(h.published.length, 0);

    // Nothing new → zero side effects.
    h.now += 3 * 60_000;
    await mod.runGitAutoFetchPass();
    assert.equal(h.published.length, 0);
    assert.equal(h.invalidated.length, 0);

    // Etienne pushes a new branch with two commits.
    git(etienne, ["checkout", "-q", "-b", "feat/x"]);
    commit(etienne, "a.txt", "first", ETIENNE);
    commit(etienne, "b.txt", "wire it up", ETIENNE);
    git(etienne, ["push", "-q", "-u", "origin", "feat/x"]);
    h.now += 3 * 60_000;
    await mod.runGitAutoFetchPass();
    assert.equal(h.published.length, 1, `logs: ${h.logs.join(" | ")}`);
    assert.equal(h.published[0].title, "Etienne pushed to codara-studio");
    assert.equal(h.published[0].body, "2 commits to feat/x — wire it up");
    assert.deepEqual(h.published[0].target, { type: "workspace", workspaceId: "ws", panel: "git" });
    assert.deepEqual(h.invalidated, [workspace]);
    assert.deepEqual(h.broadcasts, [[workspace]]);
    // The workspace's remote-tracking ref really moved (no --prune, no FETCH_HEAD).
    assert.equal(git(workspace, ["rev-parse", "origin/feat/x"]), git(etienne, ["rev-parse", "feat/x"]));
    assert.ok(!fs.existsSync(path.join(workspace, ".git", "FETCH_HEAD")), "--no-write-fetch-head honoured");

    // Jorge pushes from the teammate clone (his own email) → refresh, no alert.
    git(etienne, ["checkout", "-q", "main"]);
    commit(etienne, "c.txt", "mine from another machine", JORGE);
    git(etienne, ["push", "-q", "origin", "main"]);
    h.now += 3 * 60_000;
    await mod.runGitAutoFetchPass();
    assert.equal(h.published.length, 1, "own push must not alert");
    assert.equal(h.invalidated.length, 2, "but the panel is told to refresh");
    assert.equal(git(workspace, ["rev-list", "--count", "HEAD..origin/main"]), "1", "workspace is now 1 behind");

    // Add a worktree on feat/x as a second workspace: one repo, two cwds; a
    // push to feat/x targets the worktree.
    const worktree = path.join(root, "wt-feat-x");
    git(workspace, ["worktree", "add", "-q", worktree, "feat/x"]);
    h.state = {
      ...h.state,
      workspaces: [
        ...h.state.workspaces,
        {
          id: "wt",
          name: "feat/x worktree",
          cwd: worktree,
          color: "#000",
          workers: [],
          copyBranch: { repoCwd: workspace, branch: "feat/x", city: "x", createdAt: "" },
        },
      ],
    };
    for (const l of h.stateListeners) l(h.state);
    await mod.waitForGitAutoFetchRebuild();
    assert.equal(snap().length, 1, "worktree shares the common dir → one repo");
    assert.deepEqual(snap()[0].cwds, [workspace, worktree]);
    assert.equal(snap()[0].seeded, true, "runtime state survives the rebuild");

    git(etienne, ["checkout", "-q", "feat/x"]);
    commit(etienne, "d.txt", "follow-up on the worktree branch", ETIENNE);
    git(etienne, ["push", "-q", "origin", "feat/x"]);
    const fetchesBefore = h.broadcasts.length;
    h.now += 3 * 60_000;
    await mod.runGitAutoFetchPass();
    assert.equal(h.published.length, 2);
    assert.equal(h.published[1].target.workspaceId, "wt", "routes to the worktree checked out on feat/x");
    assert.equal(h.published[1].body, "1 commit to feat/x — follow-up on the worktree branch");
    assert.deepEqual(h.broadcasts[fetchesBefore], [workspace, worktree]);

    mod.stopGitAutoFetch();
    console.log("PASS: git-auto-fetch against real git");
  } finally {
    cleanup();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle briefly; the temp dir is disposable */
    }
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
