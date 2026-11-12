const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-terminal-agent-readiness-"));

function compile(entry, outfile) {
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(outDir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(root, "src", "shared") },
    logLevel: "silent",
  });
  return require(path.join(outDir, outfile));
}

const tabBar = fs.readFileSync(
  path.join(root, "src/renderer/src/tabs/TabBar.tsx"),
  "utf8",
);
const styles = fs.readFileSync(
  path.join(root, "src/renderer/src/styles.css"),
  "utf8",
);
assert.match(
  tabBar,
  /liveTerminalRuntime\(leaf\.worker\)/,
  "the tab glyph must follow the live worker chip, not a leftover agentSession runtime",
);
assert.match(tabBar, /<CodaraMark size=\{11\} \/>/);
assert.doesNotMatch(
  tabBar,
  /spark-tab--agent|--agent-accent/,
  "agent activity belongs in the runtime glyph, not a full-tab tint",
);
assert.doesNotMatch(
  styles,
  /\.spark-tab--agent/,
  "agent terminals must use the same calm selected-tab surface as every other tab",
);

const launches = compile(
  "src/renderer/src/workers/launch-commands.ts",
  "launch-commands.cjs",
);
const state = compile(
  "src/renderer/src/tabs/terminalAgentState.ts",
  "terminal-agent-state.cjs",
);

assert.equal(
  launches.runtimeFromAgentSessionLaunchCommand("claude --dangerously-skip-permissions"),
  "claude",
);
assert.equal(
  launches.runtimeFromAgentSessionLaunchCommand("claude --dangerously-skip-permissions --resume abc"),
  "claude",
);
assert.equal(
  launches.runtimeFromAgentSessionLaunchCommand("codex --yolo"),
  "codex",
);
assert.equal(
  launches.runtimeFromAgentSessionLaunchCommand("codex resume abc --yolo"),
  "codex",
);
assert.equal(launches.runtimeFromAgentSessionLaunchCommand("npm test"), null);
// A Pi launch stays an ordinary command in an integrated shell; only its
// restore command runs the way agent launches do.
assert.equal(launches.runtimeFromAgentSessionLaunchCommand(launches.PI_LAUNCH_COMMAND), null);
assert.equal(
  launches.buildAgentResumeCommand({ runtime: "pi", sessionId: "01a0d846-6ded-7009-8e06-51c7f805f522" }),
  "pi --session 01a0d846-6ded-7009-8e06-51c7f805f522",
  "Pi resumes with the command it prints when you quit it",
);
assert.equal(
  launches.buildAgentResumeCommand({ runtime: "grok", sessionId: "g" }),
  "grok --yolo --resume g",
);

for (const runtime of ["claude", "codex"]) {
  const worker = state.createManualAgentLaunchWorker(runtime, `pane-${runtime}`);
  assert.equal(worker.runtime, runtime);
  assert.equal(worker.source, "manual");
  assert.equal(worker.agentRunning, true);
  assert.equal(worker.runtimeState, "launching");
}

const seededWorker = state.createManualAgentLaunchWorker("claude", "pane-1");
const idleLeaf = {
  kind: "leaf", paneId: "idle",
  worker: { ...seededWorker, runtimeState: "idle" },
};
const workingLeaf = {
  kind: "leaf", paneId: "busy",
  worker: { ...seededWorker, runtime: "codex", runtimeState: "working" },
};
const terminalTabs = [{
  id: "terminal", kind: "terminal", title: "terminals", activePaneId: "idle",
  root: { kind: "split", direction: "horizontal", ratio: 0.5, a: idleLeaf, b: workingLeaf },
}];
assert.deepEqual(state.terminalAgentCensus(terminalTabs), { total: 2, working: 1 },
  "live restored chips count before notifier events arrive");
assert.deepEqual(state.terminalAgentCensus(terminalTabs, { idle: true, busy: true }, { busy: true }),
  { total: 2, working: 1 }, "renderer and daemon observations of one pane are not double-counted");
assert.deepEqual(state.terminalAgentCensus([{ ...terminalTabs[0], root: {
  ...idleLeaf, worker: { ...seededWorker, runtimeState: "background" },
} }]), { total: 1, working: 1 }, "an agent working in the background counts as working");
// The number agrees with the agent lines (terminalAgentPlacement): a quiet
// agent mid-turn ("No output") and one starting count as working; one
// waiting on the user, ready or stopped does not.
for (const runtimeState of ["stalled", "launching"]) {
  assert.deepEqual(state.terminalAgentCensus([{ ...terminalTabs[0], root: {
    ...idleLeaf, worker: { ...seededWorker, runtimeState },
  } }], { idle: true }, {}), { total: 1, working: 1 }, `a ${runtimeState} agent counts as working`);
}
for (const runtimeState of ["blocked", "idle", "error"]) {
  assert.deepEqual(state.terminalAgentCensus([{ ...terminalTabs[0], root: {
    ...idleLeaf, worker: { ...seededWorker, runtimeState },
  } }], { idle: true }, { idle: true }), { total: 1, working: 0 }, `a ${runtimeState} agent is not working`);
}
assert.equal(
  state.visibleWorkerChip({ ...seededWorker, state: "done", runtimeState: "background" })?.runtimeState,
  "background",
  "a chip working in the background stays on its pane",
);
assert.deepEqual(state.terminalAgentCensus([], { hidden: true }, { hidden: true }),
  { total: 1, working: 1 }, "unmounted background terminals remain in the daemon census");
assert.deepEqual(state.terminalAgentCensus([{ ...terminalTabs[0], root: {
  kind: "leaf", paneId: "saved", agentSession: { runtime: "claude", active: true, sessionId: "saved" },
} }]), { total: 0, working: 0 }, "a durable resume pointer is not a live agent");
for (const worker of [{ ...seededWorker, source: "spark" }, { ...seededWorker, agentRunning: false }]) {
  assert.deepEqual(state.terminalAgentCensus([{ ...terminalTabs[0], root: { ...idleLeaf, worker } }],
    { idle: true }, { idle: true }), { total: 0, working: 0 },
    "run-owned workers and exited agents do not inflate manual terminal counts");
}
assert.equal(
  state.isPaneAgentInjectable(seededWorker, undefined),
  false,
  "seeded launch metadata is not detector-confirmed readiness",
);
assert.equal(
  state.isPaneAgentInjectable(seededWorker, { altScreenActive: true }),
  true,
  "detector-confirmed alt-screen state is safe for injection",
);

assert.equal(state.mergeTerminalRuntimeState(undefined, "launching"), "launching");
for (const established of ["working", "blocked", "idle", "done", "error", "stalled"]) {
  assert.equal(
    state.mergeTerminalRuntimeState(established, "launching"),
    established,
    `a stale launching snapshot must not replace ${established}`,
  );
}
assert.equal(state.mergeTerminalRuntimeState("launching", "idle"), "idle");
assert.equal(state.mergeTerminalRuntimeState("idle", "working"), "working");

const liveWorker = state.createManualAgentLaunchWorker("claude", "pane-live");
assert.equal(state.liveTerminalRuntime(liveWorker), "claude");
assert.equal(state.visibleWorkerChip(liveWorker)?.runtime, "claude");
assert.equal(
  state.liveTerminalRuntime({ ...liveWorker, agentRunning: false }),
  null,
  "a standing terminal must drop the Claude tab glyph once the TUI has exited",
);
assert.equal(
  state.visibleWorkerChip({ ...liveWorker, agentRunning: false }),
  null,
);
assert.equal(state.liveTerminalRuntime(null), null);
assert.equal(
  state.liveTerminalRuntime({ ...liveWorker, runtime: "pi" }),
  "pi",
  "a live Pi chip paints the Pi mark on its tab",
);
assert.equal(
  state.liveTerminalRuntime({
    ...liveWorker,
    source: "spark",
    state: "done",
    agentRunning: false,
  }),
  null,
);

// ── "crashed" only for an agent whose process died ──
// A turn that failed (a usage limit) while Claude kept running painted
// "error" from main's notifier; the pane then held it against every later
// state and the chip read CLAUDE CRASHED while the agent worked.
const failedTurn = { ...liveWorker, runtimeState: "error" };
assert.equal(
  state.applyTerminalAgentState(failedTurn, "working")?.runtimeState,
  "working",
  "a failed turn clears the moment the live agent works again",
);
assert.equal(
  state.applyTerminalAgentState(failedTurn, "background")?.runtimeState,
  "background",
  "a failed turn clears when the live agent goes back to background work",
);
assert.equal(state.workerFault(failedTurn), "stopped", "a live agent whose turn failed is stopped, not crashed");
assert.equal(state.workerFault({ ...liveWorker, runtimeState: "working" }), null);
assert.equal(state.workerFault({ ...liveWorker, runtimeState: "background" }), null,
  "work running in the background is not a fault");

// The pty died on its own (onTerminalPaneExit): final, and still crashed.
const deadManual = { ...liveWorker, agentRunning: false, runtimeState: "error" };
assert.equal(state.applyTerminalAgentState(deadManual, "working"), deadManual,
  "a delayed notifier snapshot never paints over a dead pty");
assert.equal(state.workerFault(deadManual), "crashed", "a dead agent is still crashed");
const deadSpark = {
  ...liveWorker, source: "spark", runId: "run-1", state: "running", agentRunning: false, runtimeState: "error",
};
assert.equal(state.workerFault(deadSpark), "crashed", "a Cora worker whose pty died is crashed");
assert.equal(state.workerFault({ ...deadSpark, agentRunning: undefined }), "crashed",
  "a Cora attempt the run store reports broken is crashed");
assert.equal(state.workerFault({ ...deadSpark, state: "done" }), null, "a finished worker's outcome is settled");

// Resumed in the same pane after the pty died: the new process is alive.
const resumedManual = state.workerForRunningAgent(deadManual, "claude", "pane-live");
assert.equal(resumedManual?.agentRunning, true);
assert.equal(state.workerFault(resumedManual), null, "a resumed manual agent is not crashed");
assert.equal(state.applyTerminalAgentState(resumedManual, "working")?.runtimeState, "working");
const resumedSpark = state.workerForRunningAgent(deadSpark, "claude", "pane-live");
assert.equal(resumedSpark?.runId, "run-1", "a resumed Cora worker keeps its run");
assert.equal(state.workerFault(resumedSpark), null, "a resumed Cora worker is not crashed");
const brokenSpark = { ...deadSpark, agentRunning: true };
assert.equal(state.workerForRunningAgent(brokenSpark, "claude", "pane-live")?.runtimeState, "error",
  "the run store's own verdict on a live Cora worker is not the pane's to clear");
assert.equal(state.workerForRunningAgent(null, null, "pane-vim"), undefined, "vim sprouts no chip");

console.log(
  "PASS terminal agent launch identity, detector-confirmed injectability, and monotonic readiness state",
);
