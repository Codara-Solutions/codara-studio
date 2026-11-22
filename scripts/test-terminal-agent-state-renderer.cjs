const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/components/Terminal/useTerminalSession.ts"), "utf8");
function between(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing terminal adapter: ${start}`);
  return source.slice(first, last);
}

// Run the real event adapter and reporter without mounting an Electron window.
const reporter = between("const reportRuntimeState =", "const stopStatePoller =");
const observer = between("const observeAgentState =", "const offAgentState =");
const arming = between("const promoteAgentRuntime =", "const resetAgentPhase =");
const harness = esbuild.transformSync(`
  module.exports = function (runtime = "codex", readOnly = false, fromLaunch = false) {
    let disposed = false;
    let activeRuntime = null;
    let activeRuntimeFromLaunch = false;
    let agentPhase = "idle";
    let agentPhaseRevision = 0;
    let agentStateRevision = 0;
    let authoritativeAgentState = null;
    let redetectSuppressedAfterExit = false;
    let agentMarkerCarry = "";
    let agentTextRing = "";
    let genericArmRingFrom = 0;
    let genericArmBudget = 0;
    const POST_ARM_PROMOTE_BUDGET_BYTES = 4096;
    const sessionId = "pane";
    const states = [];
    const reports = [];
    const exits = [];
    const agents = [];
    const pollers = [];
    const readOnlyRef = { current: readOnly };
    const agentRunningRef = { current: false };
    const onRuntimeStateRef = { current: state => states.push(state) };
    const onAgentStateRef = { current: state => agents.push(state) };
    const window = { spark: { terminalState: { report: value => reports.push(value) } } };
    const resetAgentPhase = value => { exits.push(value); activeRuntime = null; agentPhase = "idle"; };
    const markRecentAgentInput = () => {};
    const cancelAltScreenExitConfirm = () => {};
    const coercePublicRuntime = value =>
      ["claude", "codex", "grok", "pi", "antigravity"].includes(value) ? value : null;
    const startStatePoller = value => { activeRuntime = value; pollers.push(value); };
    ${reporter}
    ${arming}
    ${observer}
    if (runtime) setAgentRunning(runtime, fromLaunch);
    states.length = 0;
    reports.length = 0;
    agents.length = 0;
    pollers.length = 0;
    return { states, reports, exits, agents, pollers, observe: observeAgentState, report: reportRuntimeState,
      arm: setAgentRunning, runtime: () => activeRuntime, dispose: () => { disposed = true; } };
  };
`, { loader: "ts", format: "cjs", target: "node22" });
const compiled = { exports: {} };
new Function("module", harness.code)(compiled);
const createHarness = compiled.exports;

for (const runtime of ["codex", "claude", "pi", "antigravity"]) {
  const adapter = createHarness(runtime);
  const event = state => ({ paneId: "pane", runtime, state });
  adapter.observe(event("idle"));
  // The local poller confirms this frame before main's one-second sweep.
  // Its report is overridden by the previous authoritative idle state.
  adapter.report("working");
  assert.equal(adapter.states.at(-1), "idle");
  adapter.observe(event("working"));
  assert.equal(adapter.states.at(-1), "working", `${runtime}: main's late working event must update an unchanged local frame`);
  adapter.observe(event("idle"));
  assert.equal(adapter.states.at(-1), "idle", `${runtime}: completion must update a frozen or hidden renderer`);
  const count = adapter.states.length;
  adapter.observe({ paneId: "other", runtime, state: "working" });
  adapter.observe({ paneId: "pane", runtime: "grok", state: "working" });
  assert.equal(adapter.states.length, count, "foreign pane or runtime events cannot replace the badge");
  adapter.dispose();
  adapter.observe(event("working"));
  assert.equal(adapter.states.length, count, "disposed panes ignore late events");
}

const mirror = createHarness("codex", true);
mirror.observe({ paneId: "pane", runtime: "codex", state: "working" });
assert.deepEqual(mirror.states, ["working"], "read-only mirrors display authoritative activity");
assert.deepEqual(mirror.reports, [], "mirrors cannot report activity back into the owning run");
mirror.observe({ paneId: "pane", runtime: "codex", state: "done" });
assert.deepEqual(mirror.exits, [{ exitSignal: true }], "a real Codex exit still clears the agent phase");

// A Pi pane launched or restored without shell integration has no prompt
// marker; main's process tree or Pi's resume line is what reports the exit.
const pi = createHarness("pi");
pi.observe({ paneId: "pane", runtime: "pi", state: "done" });
assert.deepEqual(pi.exits, [{ exitSignal: true }], "main's done clears a Pi agent phase");
const claude = createHarness("claude");
claude.observe({ paneId: "pane", runtime: "claude", state: "done" });
assert.deepEqual(claude.exits, [], "Claude keeps relying on its own exit signals");

// Antigravity printed Claude Code's mode line, so the pane armed as Claude
// from its screen and Claude's classifier saw a working turn. Main's process
// check names agy: the pane follows it, poller and worker included.
const relabel = createHarness("claude");
relabel.report("working");
relabel.observe({ paneId: "pane", runtime: "antigravity", state: "launching" });
relabel.observe({ paneId: "pane", runtime: "antigravity", state: "idle" });
assert.equal(relabel.runtime(), "antigravity", "main's runtime replaces one read off the screen");
assert.deepEqual(relabel.pollers, ["antigravity"], "the poller restarts with Antigravity's classifier");
assert.deepEqual(relabel.agents, [{ runtime: "antigravity", running: true }], "the pane's worker is told its agent changed");
assert.equal(relabel.states.at(-1), "idle");
relabel.report("working");
assert.equal(relabel.states.at(-1), "idle", "main's state drives an Antigravity pane");

// A runtime from the typed command or a restored session pointer is not a
// guess: a different name from main does not replace it.
const launched = createHarness("antigravity", false, true);
launched.observe({ paneId: "pane", runtime: "claude", state: "idle" });
assert.equal(launched.runtime(), "antigravity", "a launched agent keeps its name");
assert.deepEqual(launched.pollers, []);

// Main named the agent before its text reached the renderer.
const early = createHarness(null);
early.observe({ paneId: "pane", runtime: "antigravity", state: "idle" });
early.arm("claude");
assert.equal(early.runtime(), "antigravity", "a screen guess yields to main's earlier name");
assert.deepEqual(early.agents.at(-1), { runtime: "antigravity", running: true });
const earlyLaunch = createHarness(null);
earlyLaunch.observe({ paneId: "pane", runtime: "antigravity", state: "idle" });
earlyLaunch.arm("codex", true);
assert.equal(earlyLaunch.runtime(), "codex", "a typed launch is a new agent");

// Shift+Enter: Pi reads ESC CR as Alt+Enter (queue follow-up, which submits
// an idle draft), so an agent newline in a Pi pane is LF (its Ctrl+J).
const newline = between("const payload = shouldUseAgentNewline()", ";");
const payloadFor = (agent, activeRuntime, recentAgentInputRuntime = null) =>
  new Function(
    "shouldUseAgentNewline",
    "activeRuntime",
    "recentAgentInputRuntime",
    `${newline}; return payload;`,
  )(() => agent, activeRuntime, recentAgentInputRuntime);
assert.equal(payloadFor(true, "pi"), "\n", "Pi gets its Ctrl+J newline");
assert.equal(payloadFor(true, null, "pi"), "\n", "a recently interrupted Pi still gets Ctrl+J");
assert.equal(payloadFor(true, "claude"), "\x1b\r", "Claude keeps ESC CR");
assert.equal(payloadFor(true, "codex"), "\x1b\r", "Codex keeps ESC CR");
assert.equal(payloadFor(false, null), "\\\n", "a shell keeps the backslash continuation");
console.log("Terminal agent state delivery and poller ordering checks passed.");
