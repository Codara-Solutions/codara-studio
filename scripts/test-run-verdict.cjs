#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadContract() {
  const graphNodes = path.join(ROOT, "src/renderer/src/components/runs/GraphNodes.tsx");
  const runFormat = path.join(ROOT, "src/renderer/src/components/runs/run-format.ts");
  const out = await esbuild.build({
    stdin: {
      contents:
        `export { runVerdict } from ${JSON.stringify(graphNodes)};\n` +
        `export { buildRunMaps } from ${JSON.stringify(runFormat)};`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

const stamp = (minute) => `2026-08-11T18:${String(minute).padStart(2, "0")}:00.000Z`;
const task = (id, stepId, taskClass) => ({
  id,
  runId: "run-verdict",
  stepId,
  taskClass,
  title: id,
  description: id,
  status: "accepted",
  runtimePreference: "codex",
  allowedPaths: [],
  forbiddenPaths: [],
  expectedOutputs: [],
  verificationCommands: [],
  canRunParallel: false,
  conflictsWith: [],
  createdBy: "spark",
  createdAt: stamp(1),
  updatedAt: stamp(9),
});
const attempt = (id, workerTaskId, started, finished) => ({
  id,
  runId: "run-verdict",
  workerTaskId,
  attemptNumber: 1,
  runtime: "codex",
  cwd: "/tmp",
  status: "succeeded",
  startedAt: stamp(started),
  finishedAt: stamp(finished),
});

async function main() {
  const { runVerdict, buildRunMaps } = await loadContract();
  const steps = [
    { id: "old-check", status: "complete", workerTaskIds: ["v-old"] },
    { id: "correction", status: "complete", workerTaskIds: ["impl-new"] },
    { id: "fresh-check", status: "complete", workerTaskIds: ["v-fresh"] },
  ];
  const run = {
    steps,
    workerTasks: [
      task("v-old", "old-check", "verifier"),
      task("impl-new", "correction", "feature"),
      task("v-fresh", "fresh-check", "verifier"),
    ],
    workerAttempts: [
      attempt("a-old", "v-old", 1, 2),
      attempt("a-impl", "impl-new", 3, 6),
      attempt("a-fresh", "v-fresh", 7, 9),
    ],
  };
  const reports = new Map([
    ["a-old", { verifier: { confidence: "FEEDBACK" } }],
    ["a-fresh", { verifier: { confidence: "VERIFIED" } }],
  ]);
  assert.equal(runVerdict(run, buildRunMaps(run), reports), "verified");

  run.workerTasks.push(task("v-peer", "fresh-check", "verifier"));
  run.workerAttempts.push(attempt("a-peer", "v-peer", 7, 9));
  steps[2].workerTaskIds.push("v-peer");
  reports.set("a-peer", { verifier: { confidence: "FEEDBACK" } });
  assert.equal(
    runVerdict(run, buildRunMaps(run), reports),
    "feedback",
    "fresh peer verdicts still combine by weakest-wins",
  );

  const noChangeRun = {
    steps: [
      { id: "checked", status: "complete", workerTaskIds: ["v-checked"] },
      { id: "no-change", status: "failed", workerTaskIds: ["impl-no-change"] },
    ],
    workerTasks: [
      task("v-checked", "checked", "verifier"),
      task("impl-no-change", "no-change", "feature"),
    ],
    workerAttempts: [
      attempt("a-checked", "v-checked", 1, 2),
      { ...attempt("a-no-change", "impl-no-change", 3, 4), status: "failed" },
    ],
  };
  const noChangeReports = new Map([
    ["a-checked", { verifier: { confidence: "FEEDBACK" } }],
    ["a-no-change", { filesChanged: [] }],
  ]);
  assert.equal(
    runVerdict(noChangeRun, buildRunMaps(noChangeRun), noChangeReports),
    "feedback",
    "a later failed/no-change attempt does not erase the last meaningful verifier result",
  );

  const unverifiedRun = {
    steps: [{ id: "forced", status: "completed_unverified", workerTaskIds: [] }],
    workerTasks: [],
    workerAttempts: [],
  };
  assert.equal(
    runVerdict(unverifiedRun, buildRunMaps(unverifiedRun), new Map()),
    "unverified-accepted",
    "a force-landed step stays visibly unverified",
  );

  console.log("PASS run verdict supersedes stale feedback after corrective implementation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
