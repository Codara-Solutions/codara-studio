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

test("the first project in rail order wins, whatever the array order", ({ mod }) => {
  // Dropping a row reorders the workspaces array; the rail order is what the user sees.
  const workspaces = [project("ws-second", "/repo/app"), project("ws-first", "/repo/app"), worktree("wt", "/repo/app")];
  const tree = mod.buildRailTree(workspaces, ["ws-first", "ws-second", "wt"]);
  assert.equal(tree.parentOf.get("wt"), "ws-first");
  // A project filed in a folder ranks where its folder sits.
  const filed = [project("ws-second", "/repo/app"), { ...project("ws-first", "/repo/app"), groupId: "g1" }, worktree("wt", "/repo/app")];
  assert.equal(mod.buildRailTree(filed, ["g1", "ws-second", "wt"]).parentOf.get("wt"), "ws-first");
  assert.equal(mod.buildRailTree(filed, ["ws-second", "g1", "wt"]).parentOf.get("wt"), "ws-second");
});

test("a creator never moves into a merged worktree, and into one worktree at most", ({ mod }) => {
  // A coordinator made worktree A, A merged, it keeps working in the project.
  const merged = mod.buildRailFamily({
    projectLines: [line("p1", "working", 2)],
    children: [{ workspaceId: "wtA", lines: [], creatorPaneId: "p1", merged: true }],
  });
  assert.deepEqual(merged.own.map((l) => l.key), ["pane:p1"]);
  assert.deepEqual(merged.merged.map((row) => [row.workspaceId, row.agents.length]), [["wtA", 0]]);
  // One pane made two empty worktrees: it shows on the newest only.
  const twice = mod.buildRailFamily({
    projectLines: [line("p1", "working", 2)],
    children: [
      { workspaceId: "older", lines: [], creatorPaneId: "p1", createdAt: "2026-10-25T10:00:00Z", merged: false },
      { workspaceId: "newer", lines: [], creatorPaneId: "p1", createdAt: "2026-10-25T11:00:00Z", merged: false },
    ],
  });
  assert.deepEqual(
    twice.active.map((row) => [row.workspaceId, row.agents.map((l) => l.key)]),
    [
      ["newer", ["pane:p1"]],
      ["older", []],
    ],
  );
  assert.equal(twice.own.length, 0);
  assert.equal(twice.all.length, 1);
});

test("a creator waits until its worktree's merge state is known", ({ mod }) => {
  // The rail loads merge states after the rows: null is not known yet.
  const loading = mod.buildRailFamily({
    projectLines: [line("p1", "working", 2)],
    children: [{ workspaceId: "wtA", lines: [], creatorPaneId: "p1", merged: null }],
  });
  assert.deepEqual(loading.own.map((l) => l.key), ["pane:p1"]);
  assert.deepEqual(loading.active.map((row) => [row.workspaceId, row.agents.length]), [["wtA", 0]]);
  assert.equal(loading.merged.length, 0);
});

test("a row's merge state is unknown only until the first read finished", ({ mod }) => {
  // Remote worktrees are never read, and a failed read leaves no state:
  // neither may keep the creator off its worktree for good.
  assert.equal(mod.railMergeState(undefined, { remote: false, loaded: false }), null);
  assert.equal(mod.railMergeState(undefined, { remote: false, loaded: true }), false);
  assert.equal(mod.railMergeState(undefined, { remote: true, loaded: false }), false);
  assert.equal(mod.railMergeState(true, { remote: false, loaded: true }), true);
  assert.equal(mod.railMergeState(false, { remote: false, loaded: false }), false);
});

test("a project's number counts its worktrees' agents too", ({ mod }) => {
  // The roll-up line no longer counts agents, so a folded project shows
  // through its number that agents work inside it.
  const rows = [
    { workspaceId: "wt-a", agents: [line("a1", "working", 1, "wt-a"), line("a2", "idle", 1, "wt-a")] },
    { workspaceId: "wt-b", agents: [] },
    { workspaceId: "wt-c", agents: [line("c1", "idle", 1, "wt-c")] },
  ];
  assert.deepEqual(
    mod.railFamilyAgentCount(
      { total: 1, working: 0, sleeping: 0 },
      [{ total: 2, working: 1, sleeping: 0 }, undefined, { total: 1, working: 0, sleeping: 1 }],
      rows,
    ),
    { total: 4, working: 1, sleeping: 1, inWorktrees: 3 },
  );
  assert.deepEqual(
    mod.railFamilyAgentCount(undefined, [{ total: 1, working: 1 }], [{ agents: [line("w1", "working", 1, "wt-a")] }]),
    { total: 1, working: 1, sleeping: 0, inWorktrees: 1 },
    "a project with no agent of its own still counts its worktree's",
  );
  assert.deepEqual(
    mod.railFamilyAgentCount({ total: 2, working: 2, sleeping: 0 }, []),
    { total: 2, working: 2, sleeping: 0, inWorktrees: 0 },
    "a project without worktrees counts its own",
  );
});

test("an agent of the project's pane working in the worktree it made counts as in the worktree", ({ mod }) => {
  // The creator's pane is in the project's workspace, so the census counts it
  // there; buildRailFamily shows it on the worktree, and so does the label.
  const family = mod.buildRailFamily({
    projectLines: [line("creator", "working"), line("coord", "idle")],
    children: [{ workspaceId: "wt-a", lines: [], creatorPaneId: "creator", merged: false }],
  });
  const count = mod.railFamilyAgentCount({ total: 2, working: 1, sleeping: 0 }, [{ total: 0, working: 0 }], [
    ...family.active,
    ...family.merged,
  ]);
  assert.deepEqual(count, { total: 2, working: 1, sleeping: 0, inWorktrees: 1 });
  // A line the census does not count yet never makes the label exceed the number.
  assert.equal(
    mod.railFamilyAgentCount({ total: 1 }, [], [{ agents: [line("x", "idle"), line("y", "idle")] }]).inWorktrees,
    1,
  );
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
