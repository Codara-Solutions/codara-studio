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
const harness = esbuild.transformSync(`
  module.exports = function (runtime = "codex", readOnly = false) {
    let disposed = false;
    let activeRuntime = runtime;
    let agentStateRevision = 0;
    let authoritativeAgentState = null;
    const sessionId = "pane";
    const states = [];
    const reports = [];
    const exits = [];
    const readOnlyRef = { current: readOnly };
    const onRuntimeStateRef = { current: state => states.push(state) };
    const window = { spark: { terminalState: { report: value => reports.push(value) } } };
    const resetAgentPhase = value => { exits.push(value); activeRuntime = null; };
    ${reporter}
    ${observer}
    return { states, reports, exits, observe: observeAgentState, report: reportRuntimeState,
      dispose: () => { disposed = true; } };
  };
`, { loader: "ts", format: "cjs", target: "node22" });
const compiled = { exports: {} };
new Function("module", harness.code)(compiled);
const createHarness = compiled.exports;

for (const runtime of ["codex", "claude"]) {
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
console.log("Terminal agent state delivery and poller ordering checks passed.");
