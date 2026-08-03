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
    logLevel: "silent",
  });
  return require(path.join(outDir, outfile));
}

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

for (const runtime of ["claude", "codex"]) {
  const worker = state.createManualAgentLaunchWorker(runtime, `pane-${runtime}`);
  assert.equal(worker.runtime, runtime);
  assert.equal(worker.source, "manual");
  assert.equal(worker.agentRunning, true);
  assert.equal(worker.runtimeState, "launching");
}

const seededWorker = state.createManualAgentLaunchWorker("claude", "pane-1");
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

console.log(
  "PASS terminal agent launch identity, detector-confirmed injectability, and monotonic readiness state",
);
