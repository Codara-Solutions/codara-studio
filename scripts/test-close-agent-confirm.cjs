#!/usr/bin/env node
"use strict";

// Unit tests for src/renderer/src/tabs/closeConfirm.ts: whether a close the
// user asked for would stop a working agent, and what the question says.
//
//   node scripts/test-close-agent-confirm.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-close-confirm-"));
  const outfile = path.join(temp, "close-confirm.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "renderer", "src", "tabs", "closeConfirm.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const terminal = (id, root, extra = {}) => ({ id, kind: "terminal", title: id, root, activePaneId: root.paneId ?? "", ...extra });
const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
const agent = (runtimeState, extra = {}) => ({
  runtime: "claude",
  runId: "manual",
  workerTaskId: "w",
  attemptId: "a",
  source: "manual",
  state: "running",
  agentRunning: true,
  runtimeState,
  ...extra,
});

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("a working agent asks, naming the agent and the tab", ({ mod }) => {
  const tabs = [terminal("api", leaf("p1", { worker: agent("working") }))];
  const agents = mod.closingAgents(tabs, [{ tabId: "api" }]);
  assert.deepEqual(agents, [{ paneId: "p1", runtime: "claude", tabTitle: "api", state: "working" }]);
  assert.deepEqual(mod.closeConfirmText(agents), {
    title: "Close Claude in api?",
    text: "It is still working and its work will stop.",
    items: [],
  });
});

test("background work, a quiet turn and a question for the user ask too", ({ mod }) => {
  for (const state of ["background", "stalled"]) {
    assert.equal(mod.closingAgentState(leaf("p", { worker: agent(state) })), "working", state);
  }
  assert.equal(mod.closingAgentState(leaf("p", { worker: agent("blocked") })), "waiting");
  const text = mod.closeConfirmText(mod.closingAgents([terminal("web", leaf("p", { worker: agent("blocked", { runtime: "codex" }) }))], [{ tabId: "web" }]));
  assert.equal(text.title, "Close Codex in web?");
  assert.equal(text.text, "It is waiting for your answer and its work will stop.");
});

test("idle, finished, starting, failed, exited and sleeping agents close at once", ({ mod }) => {
  const quiet = [
    leaf("idle", { worker: agent("idle") }),
    leaf("done", { worker: agent("done") }),
    leaf("starting", { worker: agent("launching") }),
    leaf("failed", { worker: agent("error") }),
    leaf("exited", { worker: agent("working", { agentRunning: false }) }),
    leaf("asleep", { worker: agent("working"), hibernation: { runtime: "claude", since: 1 } }),
    leaf("shell"),
  ];
  for (const item of quiet) assert.equal(mod.closingAgentState(item), null, item.paneId);
  const tabs = quiet.map((item) => terminal(`t-${item.paneId}`, item));
  assert.equal(mod.closeConfirmText(mod.closingAgents(tabs, tabs.map((tab) => ({ tabId: tab.id })))), null);
});

test("non-terminal tabs never ask", ({ mod }) => {
  const tabs = [
    { id: "run-1", kind: "chat", title: "Cora" },
    { id: "b", kind: "preview", title: "Docs", url: "https://example.invalid" },
    { id: "e", kind: "editor", title: "a.ts", path: "/a.ts", entry: {}, dirty: true },
  ];
  assert.deepEqual(mod.closingAgents(tabs, tabs.map((tab) => ({ tabId: tab.id }))), []);
});

test("main's working flag counts for a pane whose chip has no state yet, never for an exited agent", ({ mod }) => {
  const flags = { p1: true, p2: true };
  assert.equal(mod.closingAgentState(leaf("p1"), flags), "working");
  assert.equal(mod.closingAgentState(leaf("p2", { worker: agent(undefined, { agentRunning: false }) }), flags), null);
  assert.equal(mod.closingAgentState(leaf("p3"), flags), null);
  const text = mod.closeConfirmText(mod.closingAgents([terminal("t", leaf("p1"))], [{ tabId: "t" }], flags));
  assert.equal(text.title, "Close the agent in t?");
});

test("closing one pane of a split asks only about that pane", ({ mod }) => {
  const tabs = [terminal("t", split(leaf("busy", { worker: agent("working") }), leaf("calm", { worker: agent("idle") })))];
  assert.equal(mod.closingAgents(tabs, [{ tabId: "t", paneId: "calm" }]).length, 0);
  assert.equal(mod.closingAgents(tabs, [{ tabId: "t", paneId: "busy" }]).length, 1);
  assert.equal(mod.closingAgents(tabs, [{ tabId: "t" }]).length, 1);
});

test("a bulk close names how many agents would stop and lists them", ({ mod }) => {
  const tabs = [
    terminal("keep", leaf("k", { worker: agent("working") })),
    terminal("api", leaf("a", { worker: agent("working") })),
    terminal("web", leaf("w", { worker: agent("blocked", { runtime: "codex" }) })),
    terminal("idle", leaf("i", { worker: agent("idle") })),
    { id: "run-1", kind: "chat", title: "Cora" },
    terminal("worker", leaf("x", { worker: agent("working", { source: "spark", runId: "run-1" }) }), { scope: { kind: "workers", runId: "run-1" } }),
  ];
  const targets = mod.closeOthersTargets(tabs, "keep");
  assert.deepEqual(targets.map((target) => target.tabId), ["api", "web", "idle"]);
  assert.deepEqual(mod.closeConfirmText(mod.closingAgents(tabs, targets)), {
    title: "Close 2 working agents?",
    text: "They are still working and their work will stop.",
    items: ["Claude in api", "Codex in web (waiting for you)"],
  });
  assert.deepEqual(mod.closeOthersTargets(tabs, "missing"), []);
});

async function main() {
  const { mod, cleanup } = await load();
  let failed = 0;
  try {
    for (const { name, fn } of TESTS) {
      try {
        await fn({ mod });
        console.log(`ok - ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`not ok - ${name}`);
        console.error(error);
      }
    }
  } finally {
    cleanup();
  }
  if (failed > 0) {
    console.error(`${failed} of ${TESTS.length} failed`);
    process.exit(1);
  }
  console.log(`all ${TESTS.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
