#!/usr/bin/env node
"use strict";

// Unit tests for the "Fix with agent" dialog's pure parts:
// src/renderer/src/components/git/fix/fix-targets.ts (which targets are
// offered and which one is picked) and agent-launcher.ts (waiting for a new
// agent CLI to be ready before its prompt is submitted, and the inbox
// fallback). No React, no Electron.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const FIX_DIR = path.join(ROOT, "src", "renderer", "src", "components", "git", "fix");

async function loadModules() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-git-fix-targets-"));
  const entry = path.join(temp, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(FIX_DIR, "fix-targets.ts"))};\nexport * from ${JSON.stringify(path.join(FIX_DIR, "agent-launcher.ts"))};\n`,
  );
  const outfile = path.join(temp, "fix.cjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const DESTINATIONS = [
  { id: "pane:p-claude", kind: "pane", paneId: "p-claude", agent: true, focused: true, label: "Claude Code · api", sublabel: "focused", group: "agents" },
  { id: "pane:p-shell", kind: "pane", paneId: "p-shell", agent: false, focused: false, label: "Terminal · zsh", sublabel: "no agent detected", group: "agents" },
  { id: "pane:p-codex", kind: "pane", paneId: "p-codex", agent: true, focused: false, label: "Codex · web", group: "agents" },
  { id: "chat:run-1", kind: "chat", runId: "run-1", label: "Cora chat · Fix nav", sublabel: "open", group: "chat" },
  { id: "chat-new", kind: "chat-new", label: "New Cora chat", group: "chat" },
  { id: "inbox", kind: "inbox", label: "Agent inbox", group: "inbox" },
];

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("targets: agent panes only, chats, installed CLIs, then the inbox", ({ mod }) => {
  const targets = mod.fixTargets(DESTINATIONS, { claude: true, codex: false, grok: true, pi: false });
  assert.deepEqual(targets.map((t) => t.id), ["pane:p-claude", "pane:p-codex", "chat:run-1", "chat-new", "agent-new:claude", "agent-new:grok", "inbox"]);
  assert.ok(!targets.some((t) => t.paneId === "p-shell"), "a plain shell is never offered");
  assert.equal(targets.find((t) => t.id === "agent-new:claude").label, "New Claude Code");
  assert.deepEqual(mod.fixTargets(DESTINATIONS, null).filter((t) => t.kind === "agent-new"), [], "nothing new to start while the check runs");
  const noWorkspace = mod.fixTargets([{ ...DESTINATIONS[4], disabled: true }], null);
  assert.equal(noWorkspace.find((t) => t.id === "chat-new").disabled, true);
  const asleep = mod.fixTargets([{ ...DESTINATIONS[0], sublabel: "asleep", disabled: true }, DESTINATIONS[2]], null);
  assert.equal(asleep.find((t) => t.id === "pane:p-claude").disabled, true, "a sleeping agent is shown but cannot be picked");
  assert.equal(mod.defaultFixTarget(asleep, "pane", "pane:p-claude"), "pane:p-codex", "nor is it the default");
});

test("default target: what was used last, else the focused agent, chat, new CLI, inbox", ({ mod }) => {
  const all = mod.fixTargets(DESTINATIONS, { claude: true, codex: false, grok: false, pi: false });
  assert.equal(mod.defaultFixTarget(all, null, "pane:p-claude"), "pane:p-claude");
  assert.equal(mod.defaultFixTarget(all, null, "pane:p-shell"), "pane:p-claude", "a shell default falls to the first agent pane");
  assert.equal(mod.defaultFixTarget(all, "pane", "chat:run-1"), "pane:p-claude");
  assert.equal(mod.defaultFixTarget(all, "chat", "pane:p-claude"), "chat:run-1");
  assert.equal(mod.defaultFixTarget(all, "chat-new", null), "chat-new");
  assert.equal(mod.defaultFixTarget(all, "agent-new:claude", null), "agent-new:claude");
  assert.equal(mod.defaultFixTarget(all, "agent-new:codex", null), "pane:p-claude", "a CLI no longer installed is not picked");
  assert.equal(mod.defaultFixTarget(all, "inbox", null), "inbox");
  const noPanes = mod.fixTargets(DESTINATIONS.filter((d) => d.kind !== "pane"), { claude: true, codex: false, grok: false, pi: false });
  assert.equal(mod.defaultFixTarget(noPanes, "pane", null), "chat:run-1");
  const bare = mod.fixTargets(DESTINATIONS.filter((d) => d.kind === "inbox" || d.kind === "chat-new"), { claude: true, codex: false, grok: false, pi: false });
  assert.equal(mod.defaultFixTarget(bare, null, null), "agent-new:claude");
  assert.equal(mod.defaultFixTarget(mod.fixTargets([], null), null, null), "inbox");
});

test("remembered targets parse strictly", ({ mod }) => {
  assert.equal(mod.parseRememberedFixTarget("pane"), "pane");
  assert.equal(mod.parseRememberedFixTarget("agent-new:pi"), "agent-new:pi");
  assert.equal(mod.parseRememberedFixTarget("agent-new:bash"), null);
  assert.equal(mod.parseRememberedFixTarget("pane:p-1"), null);
  assert.equal(mod.parseRememberedFixTarget(null), null);
  assert.equal(mod.rememberedFixTarget({ id: "pane:x", kind: "pane" }), "pane");
  assert.equal(mod.rememberedFixTarget({ id: "agent-new:codex", kind: "agent-new", runtime: "codex" }), "agent-new:codex");
});

test("the user's note goes first", ({ mod }) => {
  assert.equal(mod.fixPromptWithNote("PROMPT", "  "), "PROMPT");
  assert.equal(mod.fixPromptWithNote("PROMPT", " only touch src/ "), "Note from me before you start: only touch src/\n\nPROMPT");
});

function readySource() {
  const source = { handlers: new Set(), snapshotStates: [] };
  source.onState = (handler) => {
    source.handlers.add(handler);
    return () => source.handlers.delete(handler);
  };
  source.snapshot = async () => source.snapshotStates;
  source.emit = (payload) => {
    for (const handler of [...source.handlers]) handler(payload);
  };
  return source;
}

function fakeTimers() {
  const timers = { list: [] };
  timers.setTimeout = (fn, ms) => {
    const timer = { fn, ms };
    timers.list.push(timer);
    return timer;
  };
  timers.clearTimeout = (timer) => {
    timers.list = timers.list.filter((t) => t !== timer);
  };
  return timers;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Fires one pending fake timer, the way a real one leaves the queue.
function fire(timers, index) {
  const [timer] = timers.list.splice(index, 1);
  timer.fn();
}

test("waitForAgentReady waits for the tab's CLI to be idle, not a shell", async ({ mod }) => {
  const source = readySource();
  const timers = fakeTimers();
  let tabId = null;
  const ready = mod.waitForAgentReady(source, () => tabId, 90_000, timers);
  tabId = "term-1";
  source.emit({ workspaceId: "ws", tabId: "term-0", paneId: "p-other", runtime: "claude", state: "idle" });
  source.emit({ workspaceId: "ws", tabId: "term-1", paneId: "p-1", runtime: null, state: "idle" });
  source.emit({ workspaceId: "ws", tabId: "term-1", paneId: "p-1", runtime: "claude", state: "launching" });
  let settled = false;
  ready.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  source.emit({ workspaceId: "ws", tabId: "term-1", paneId: "p-1", runtime: "claude", state: "idle" });
  assert.deepEqual(await ready, { kind: "ready", paneId: "p-1" });
  assert.equal(source.handlers.size, 0, "the listener is removed");
  assert.equal(timers.list.length, 0, "the timeout is cleared");
});

test("waitForAgentReady reads the snapshot, and reports exits and timeouts", async ({ mod }) => {
  const fromSnapshot = readySource();
  fromSnapshot.snapshotStates = [{ workspaceId: "ws", tabId: "term-2", paneId: "p-2", runtime: "codex", state: "idle" }];
  assert.deepEqual(await mod.waitForAgentReady(fromSnapshot, () => "term-2", 90_000, fakeTimers()), { kind: "ready", paneId: "p-2" });

  const exits = readySource();
  const exited = mod.waitForAgentReady(exits, () => "term-3", 90_000, fakeTimers());
  exits.emit({ workspaceId: "ws", tabId: "term-3", paneId: "p-3", runtime: "claude", state: "error" });
  assert.deepEqual(await exited, { kind: "exited", paneId: "p-3" });

  const slow = readySource();
  const timers = fakeTimers();
  const waiting = mod.waitForAgentReady(slow, () => "term-4", 90_000, timers);
  slow.emit({ workspaceId: "ws", tabId: "term-4", paneId: "p-4", runtime: "claude", state: "blocked" });
  assert.equal(timers.list[0].ms, 90_000);
  timers.list[0].fn();
  assert.deepEqual(await waiting, { kind: "timeout", paneId: "p-4" });
});

function deliveryDeps(source, outcome) {
  const deps = {
    launched: [],
    delivered: [],
    slept: [],
    ready: source,
    timeoutMs: 50,
    launch: (runtime, cwd) => {
      deps.launched.push([runtime, cwd]);
      setImmediate(() => outcome(source));
      return "term-9";
    },
    deliver: async (request) => {
      if (deps.refuse?.(request)) throw new Error("That terminal is closed or belongs to another workspace.");
      deps.delivered.push(request);
      return { outcome: request.target.kind === "pane" ? "pasted" : "queued" };
    },
    sleep: async (ms) => {
      deps.slept.push(ms);
    },
  };
  return deps;
}

test("deliverToNewAgent submits to the new pane once it is ready", async ({ mod }) => {
  const deps = deliveryDeps(readySource(), (source) => source.emit({ workspaceId: "ws", tabId: "term-9", paneId: "p-9", runtime: "claude", state: "idle" }));
  const outcome = await mod.deliverToNewAgent(deps, { runtime: "claude", cwd: "/repo", workspaceId: "ws", text: "Fix it" });
  assert.deepEqual(outcome, { kind: "sent", paneId: "p-9" });
  assert.deepEqual(deps.launched, [["claude", "/repo"]]);
  assert.deepEqual(deps.slept, [mod.FIX_AGENT_SETTLE_MS]);
  assert.deepEqual(deps.delivered, [{ workspaceId: "ws", target: { kind: "pane", paneId: "p-9" }, text: "Fix it", submit: true, source: "git" }]);
});

test("deliverToNewAgent queues for the pane when the CLI is slow, or for anyone when it is gone", async ({ mod }) => {
  const slow = deliveryDeps(readySource(), (source) => source.emit({ workspaceId: "ws", tabId: "term-9", paneId: "p-9", runtime: "claude", state: "launching" }));
  const queued = await mod.deliverToNewAgent(slow, { runtime: "claude", cwd: "/repo", workspaceId: "ws", text: "Fix it" });
  assert.deepEqual(queued, { kind: "queued", paneId: "p-9", reason: "timeout" });
  assert.deepEqual(slow.delivered.map((r) => [r.target, r.submit]), [[{ kind: "inbox", paneId: "p-9" }, false]]);

  const closed = deliveryDeps(readySource(), (source) => source.emit({ workspaceId: "ws", tabId: "term-9", paneId: "p-9", runtime: "claude", state: "launching" }));
  closed.refuse = (request) => request.target.paneId === "p-9";
  const fallback = await mod.deliverToNewAgent(closed, { runtime: "claude", cwd: "/repo", workspaceId: "ws", text: "Fix it" });
  assert.deepEqual(fallback, { kind: "queued", paneId: null, reason: "timeout" });
  assert.deepEqual(closed.delivered.map((r) => r.target), [{ kind: "inbox", paneId: null }]);

  const crashed = deliveryDeps(readySource(), (source) => source.emit({ workspaceId: "ws", tabId: "term-9", paneId: "p-9", runtime: "claude", state: "done" }));
  const exited = await mod.deliverToNewAgent(crashed, { runtime: "claude", cwd: "/repo", workspaceId: "ws", text: "Fix it" });
  assert.deepEqual(exited, { kind: "queued", paneId: null, reason: "exited" });
  assert.deepEqual(crashed.delivered.map((r) => r.target), [{ kind: "inbox", paneId: null }]);
});

test("waitForAgentReady also follows the pane's chip in the tab strip", async ({ mod }) => {
  const source = readySource();
  const chip = { paneId: "p-5", state: "launching" };
  source.paneState = (tabId) => (tabId === "term-5" ? { ...chip } : null);
  const timers = fakeTimers();
  const ready = mod.waitForAgentReady(source, () => "term-5", 90_000, timers);
  assert.deepEqual(timers.list.map((t) => t.ms), [90_000, mod.FIX_AGENT_POLL_MS]);
  fire(timers, 1);
  assert.deepEqual(timers.list.map((t) => t.ms), [90_000, mod.FIX_AGENT_POLL_MS], "polls again while starting");
  chip.state = "idle";
  fire(timers, 1);
  assert.deepEqual(await ready, { kind: "ready", paneId: "p-5" });
  assert.deepEqual(timers.list, [], "the timeout and the poll are cleared");

  const gone = readySource();
  gone.paneState = () => ({ paneId: "p-6", state: "error" });
  const goneTimers = fakeTimers();
  const exited = mod.waitForAgentReady(gone, () => "term-6", 90_000, goneTimers);
  fire(goneTimers, 1);
  assert.deepEqual(await exited, { kind: "exited", paneId: "p-6" });
});

test("waitForAgentReady calls the window's timers bare, as a browser requires", async ({ mod }) => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // A browser throws "Illegal invocation" when setTimeout runs as another object's method.
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = function (handle) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realClearTimeout(handle);
  };
  try {
    const source = readySource();
    source.paneState = () => ({ paneId: "p-7", state: "idle" });
    assert.deepEqual(await mod.waitForAgentReady(source, () => "term-7", 5_000), { kind: "ready", paneId: "p-7" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("the host registry holds what App registers", ({ mod }) => {
  assert.equal(mod.fixAgentHost(), null);
  const host = { launch: () => "term-1", paneState: () => null };
  mod.setFixAgentHost(host);
  assert.equal(mod.fixAgentHost(), host);
  mod.setFixAgentHost(null);
  assert.equal(mod.fixAgentHost(), null);
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  const { mod, cleanup } = await loadModules();
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
  console.log(`\n${TESTS.length - failed}/${TESTS.length} git-fix-targets tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
