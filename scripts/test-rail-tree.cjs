#!/usr/bin/env node
"use strict";

// Unit tests for src/shared/rail-tree.ts: which worktree nests under which
// project in the workspace rail, which row each agent shows on, the order of
// the worktrees and the merged fold.
//
//   node scripts/test-rail-tree.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-tree-"));
  const outfile = path.join(temp, "rail-tree.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "shared", "rail-tree.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const project = (id, cwd) => ({ id, cwd });
const worktree = (id, repoCwd, paneId) => ({
  id,
  cwd: `/wt/${id}`,
  copyBranch: { repoCwd, ...(paneId ? { createdBy: { kind: "agent", paneId } } : {}) },
});
const line = (paneId, state, since = 1, workspaceId = "ws-app") => ({
  key: `pane:${paneId}`,
  workspaceId,
  name: `Claude Code · ${paneId}`,
  state,
  text: null,
  fromNote: false,
  since,
  target: null,
});

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("worktrees nest under the project whose folder they were made from", ({ mod }) => {
  const tree = mod.buildRailTree([
    project("ws-app", "/repo/app"),
    worktree("wt-a", "/repo/app"),
    project("ws-web", "/repo/web/"),
    worktree("wt-b", "/repo/app/"),
    worktree("wt-c", "/repo/web"),
    worktree("wt-lost", "/repo/gone"),
  ]);
  assert.deepEqual(Object.fromEntries(tree.childrenOf), { "ws-app": ["wt-a", "wt-b"], "ws-web": ["wt-c"] });
  assert.equal(tree.parentOf.get("wt-a"), "ws-app");
  assert.equal(tree.parentOf.has("wt-lost"), false, "a worktree whose project is not in the rail stays its own row");
});

test("the first project with that folder wins, and a worktree is never a project", ({ mod }) => {
  const tree = mod.buildRailTree([
    worktree("wt-x", "/repo/app"),
    project("ws-first", "/repo/app"),
    project("ws-second", "/repo/app"),
    // A worktree made from another worktree's folder is not nested two deep.
    { id: "wt-y", cwd: "/wt/y", copyBranch: { repoCwd: "/wt/wt-x" } },
  ]);
  assert.deepEqual(Object.fromEntries(tree.childrenOf), { "ws-first": ["wt-x"] });
  assert.equal(tree.parentOf.has("wt-y"), false);
});

test("each agent shows on the row it works in", ({ mod }) => {
  const family = mod.buildRailFamily({
    projectLines: [line("coordinator", "working", 5), line("creator-a", "working", 4), line("creator-b", "needs-you", 3)],
    children: [
      { workspaceId: "wt-a", lines: [], creatorPaneId: "creator-a", merged: false },
      { workspaceId: "wt-b", lines: [], creatorPaneId: "creator-b", merged: false },
      { workspaceId: "wt-c", lines: [line("inside-c", "idle", 2, "wt-c")], merged: false },
    ],
  });
  assert.deepEqual(family.own.map((l) => l.key), ["pane:coordinator"], "an agent that made no worktree stays on the project");
  assert.deepEqual(
    family.active.map((row) => [row.workspaceId, row.agents.map((l) => l.key)]),
    [
      ["wt-b", ["pane:creator-b"]],
      ["wt-a", ["pane:creator-a"]],
      ["wt-c", ["pane:inside-c"]],
    ],
    "the agent that created a worktree works in it; one in the worktree's own panes too",
  );
  assert.equal(family.all.length, 4, "the roll-up counts each agent once");
  assert.equal(family.all[0].state, "needs-you");
});

test("worktrees sort by their most urgent agent, rail order among equals; merged ones fold", ({ mod }) => {
  const family = mod.buildRailFamily({
    projectLines: [],
    children: [
      { workspaceId: "none-1", lines: [], merged: false },
      { workspaceId: "idle", lines: [line("i", "idle", 1, "idle")], merged: false },
      { workspaceId: "merged-working", lines: [line("m", "working", 1, "merged-working")], merged: true },
      { workspaceId: "working", lines: [line("w", "working", 1, "working")], merged: false },
      { workspaceId: "none-2", lines: [], merged: false },
      { workspaceId: "done", lines: [line("d", "done", 1, "done")], merged: false },
      { workspaceId: "merged", lines: [], merged: true },
      { workspaceId: "needs", lines: [line("n", "idle", 1, "needs"), line("n2", "needs-you", 1, "needs")], merged: false },
    ],
  });
  assert.deepEqual(
    family.active.map((row) => row.workspaceId),
    ["needs", "working", "done", "idle", "none-1", "none-2"],
  );
  assert.deepEqual(family.active[0].agents.map((l) => l.state), ["needs-you", "idle"], "most urgent agent first");
  assert.deepEqual(family.merged.map((row) => row.workspaceId), ["merged-working", "merged"]);
});

test("a creator whose worktree has an agent inside stays on the project", ({ mod }) => {
  // A coordinator that opened a worker's terminal in a new worktree.
  const family = mod.buildRailFamily({
    projectLines: [line("coordinator", "working", 2)],
    children: [{ workspaceId: "wt", lines: [line("worker", "needs-you", 1, "wt")], creatorPaneId: "coordinator", merged: false }],
  });
  assert.deepEqual(family.active[0].agents.map((l) => l.key), ["pane:worker"]);
  assert.deepEqual(family.own.map((l) => l.key), ["pane:coordinator"]);
  assert.equal(family.all.length, 2);
});

(async () => {
  const { mod, cleanup } = await load();
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
  console.log(`\n${TESTS.length - failed}/${TESTS.length} rail-tree tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
