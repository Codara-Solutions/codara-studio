#!/usr/bin/env node
"use strict";

// Unit tests for src/renderer/src/tabs/railTabCount.ts and the shell markers
// behind it (src/main/shell-activity.ts): the number at a rail row's right
// edge counts the workspace's tabs and how many of them run.
//
//   node scripts/test-rail-tab-count.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-tab-count-"));
  const build = async (entry, name) => {
    const outfile = path.join(temp, `${name}.cjs`);
    await esbuild.build({
      entryPoints: [path.join(ROOT, ...entry)],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      logLevel: "silent",
    });
    return require(outfile);
  };
  const count = await build(["src", "renderer", "src", "tabs", "railTabCount.ts"], "rail-tab-count");
  const shell = await build(["src", "main", "shell-activity.ts"], "shell-activity");
  return { mod: { ...count, ...shell }, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const terminal = (id, root) => ({ id, kind: "terminal", title: id, root, activePaneId: root.paneId ?? "" });
const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
const agent = (runtimeState) => ({
  runtime: "claude",
  runId: "manual",
  workerTaskId: "w",
  attemptId: "a",
  source: "manual",
  state: "running",
  agentRunning: true,
  runtimeState,
});
const quiet = { runningRunIds: new Set(), busyShellPaneIds: new Set() };

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("every tab of the bar counts; a working agent, a busy shell and a live chat run", ({ mod }) => {
  const tabs = [
    terminal("t-agent", leaf("p-agent", { worker: agent("working") })),
    terminal("t-shell", leaf("p-shell")),
    { id: "run-1", kind: "chat", title: "Cora" },
    { id: "b", kind: "preview", title: "Docs", url: "https://example.invalid" },
    { id: "e", kind: "editor", title: "a.ts", path: "/a.ts", entry: {}, dirty: false },
  ];
  const signals = { runningRunIds: new Set(["run-1"]), busyShellPaneIds: new Set(["p-shell"]) };
  assert.deepEqual(mod.railTabCount(tabs, signals), { open: 5, running: 3 });
});

test("nothing running reads as open tabs only", ({ mod }) => {
  const tabs = [
    terminal("t-idle-agent", leaf("p1", { worker: agent("idle") })),
    terminal("t-shell", leaf("p2")),
    { id: "run-1", kind: "chat", title: "Cora" },
  ];
  assert.deepEqual(mod.railTabCount(tabs, quiet), { open: 3, running: 0 });
});

test("a workspace with no tab shows nothing", ({ mod }) => {
  assert.deepEqual(mod.railTabCount([], quiet), { open: 0, running: 0 });
});

test("an idle agent's shell is busy with the agent, which does not make its tab run", ({ mod }) => {
  const busy = { ...quiet, busyShellPaneIds: new Set(["p1", "p2", "p3"]) };
  const tabs = [
    terminal("chip", leaf("p1", { worker: agent("idle") })),
    terminal("detected", leaf("p2")),
    terminal("restored", leaf("p3", { agentSession: { runtime: "claude", sessionId: "s", cwd: "/", capturedAt: "", active: true } })),
  ];
  assert.deepEqual(mod.railTabCount(tabs, { ...busy, agentPaneIds: { p2: true } }), { open: 3, running: 0 });
});

test("an agent working in a hidden pane counts before its chip exists", ({ mod }) => {
  const tabs = [terminal("t", leaf("p1")), terminal("t2", leaf("p2", { worker: { ...agent("idle"), agentRunning: false } }))];
  const signals = { ...quiet, workingPaneIds: { p1: true, p2: true } };
  assert.deepEqual(mod.railTabCount(tabs, signals), { open: 2, running: 1 });
});

test("a split tab runs once any pane does, and counts once", ({ mod }) => {
  const tabs = [terminal("t", split(leaf("p1"), leaf("p2", { worker: agent("background") })))];
  assert.deepEqual(mod.railTabCount(tabs, quiet), { open: 1, running: 1 });
});

test("worker and Runs tabs and docked tabs have no pill, so they do not count", ({ mod }) => {
  const tabs = [
    { ...terminal("workers", leaf("w1", { worker: agent("working") })), scope: { kind: "workers", runId: "run-1" } },
    { id: "runs", kind: "runs", title: "Runs", runId: "run-1" },
    terminal("host", split(leaf("p1"), leaf("dock_1", { content: { type: "tab", tabId: "run-1", tabKind: "chat" } }))),
    { id: "run-1", kind: "chat", title: "Cora" },
  ];
  const signals = { ...quiet, runningRunIds: new Set(["run-1"]) };
  assert.deepEqual(mod.railTabCount(tabs, signals), { open: 1, running: 1 }, "the host runs through its docked chat");
});

test("shell markers: C runs a command until D or the next prompt", ({ mod }) => {
  const C = "\x1b]133;C\x07";
  const D = "\x1b]133;D;0\x07";
  const A = "\x1b]633;A\x07";
  assert.equal(mod.chunkShellActivity(Buffer.from("plain output, no marker")), null);
  assert.equal(mod.chunkShellActivity(Buffer.from(`$ npm run dev${C}listening`)), "running");
  assert.equal(mod.chunkShellActivity(Buffer.from(`done${D}${A}$ `)), "idle");
  assert.equal(mod.chunkShellActivity(Buffer.from(`${C}${D}`)), "idle", "the last marker wins");
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
  console.log(`\n${TESTS.length - failed}/${TESTS.length} rail-tab-count tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
