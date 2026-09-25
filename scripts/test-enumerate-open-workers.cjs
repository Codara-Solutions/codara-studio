// The "route to worker" menu of preview selections lists the live agent
// panes a selection can be typed into (src/renderer/src/routing/
// enumerate-open-workers.ts). Guards that every agent a pane can run is
// offered, Pi included, and that exited agents and plain shells never are:
// injecting into a pane whose agent has quit would type the prompt at the
// shell.
//
//   node scripts/test-enumerate-open-workers.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/routing/enumerate-open-workers.ts")],
    bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  const { enumerateOpenWorkers, workerMenuLabel } = mod.exports;

  const manual = (paneId, runtime, agentRunning = true) => ({
    kind: "leaf",
    paneId,
    worker: { runtime, runId: "manual", workerTaskId: `manual-${paneId}`, attemptId: paneId, source: "manual", state: "running", agentRunning },
  });
  const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
  const tabs = [{
    kind: "terminal",
    id: "t1",
    title: "terminals",
    activePaneId: "p-pi",
    root: split(
      split(manual("p-pi", "pi"), manual("p-grok", "grok")),
      split(manual("p-gone", "pi", false), { kind: "leaf", paneId: "p-shell" }),
    ),
  }];
  const workers = enumerateOpenWorkers(tabs, []);
  assert.deepEqual(workers.map((worker) => worker.injectId), ["p-grok", "p-pi"]);
  assert.equal(workerMenuLabel(workers.find((worker) => worker.injectId === "p-pi")), "Manual Pi");
  assert.equal(workerMenuLabel(workers.find((worker) => worker.injectId === "p-grok")), "Manual Grok");

  console.log("Route-to-worker enumeration checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
