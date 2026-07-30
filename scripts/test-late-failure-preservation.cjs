// Regression harness for the iteration-failed-after-success defects
// (run-ms76e9rj-m9rak7, run-ms6dbgso-5yr98b).
//
// Defect 1: a provider error arriving AFTER the worker wrote its final report
// (a Codex "servers overloaded" during session shutdown, 97s after the
// validated status:"complete" report) hit runPiWorkerSession's catch, whose
// writeAutoFailureReport unconditionally overwrote final-report.json with a
// synthetic failure. The finished work then settled as FAILED.
//
// Defect 2: the runtime-fallback replacement task minted by
// maybeQueueCliLaunchFallback omitted loomNodeId, so newestAttemptForNode
// (which maps a loom node to its newest attempt via the tasks stamped with the
// node id) judged the node on the ORIGINAL failed attempt forever; a fully
// successful fallback attempt was invisible to finalizeDirectRun.
//
// Pins, in order:
//   1. writeAutoFailureReport preserves an existing non-failed report (appends
//      the late error to risks, returns preservedExisting: true) and still
//      writes the synthetic failure when no usable report exists;
//   2. end to end on the REAL run-store: a direct run whose attempt fails late
//      but whose preserved report is "complete" settles the run as complete;
//   3. newestAttemptForNode picks the NEWEST attempt across original plus
//      fallback tasks sharing a loomNodeId;
//   4. end to end with a loomPass: a node whose first attempt failed and whose
//      loomNodeId-stamped fallback attempt succeeded finalizes as complete,
//      while the pre-fix shape (fallback without the stamp) finalizes failed;
//   5. source pins: the fallback literal carries loomNodeId plus the
//      node-derived fence hints, and the Pi session catch settles as succeeded
//      when the report was preserved.
//
// Bundles the REAL worker-launch.ts and run-store.ts against electron/node-pty
// stubs and drives fabricated run.json files under a throwaway
// CODARA_HOME_DIR, same trick as scripts/test-wedged-run-recovery.cjs.
//
//   node scripts/test-late-failure-preservation.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const WORKER_LAUNCH_TS = path.join(ROOT, "src", "main", "orchestration", "worker-launch.ts");
// Bundles live under node_modules so the externalized runtime deps still
// resolve from the file that requires them.
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-late-failure-test");

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
export class BrowserWindow { static getAllWindows() { return []; } }
export class Notification { static isSupported() { return false; } show() {} on() {} }
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const shell = { openPath: noop, openExternal: noop, showItemInFolder: noop };
export const dialog = { showOpenDialog: noop, showMessageBox: noop };
export const clipboard = { readText: () => "", writeText: noop, readImage: () => null };
export const nativeImage = { createFromPath: () => null, createFromBuffer: () => null };
export const nativeTheme = { on: noop };
export const safeStorage = { isEncryptionAvailable: () => false };
export const webContents = { getAllWebContents: () => [] };
export default { app };`;

const PTY_STUB = `export function spawn() { throw new Error("node-pty is stubbed in this harness"); }
export function exists() { return false; }
export default { spawn, exists };`;

const stubPlugin = {
  name: "electron-pty-stub",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "electron" ? ELECTRON_STUB : PTY_STUB,
      loader: "js",
    }));
  },
};

async function bundle(entry, name, opts = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    ...opts,
  });
  return require(outfile);
}

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === undefined ? "" : ` - ${detail}`}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-late-failure-"));
const WS = "ws-late-failure-test";
const NOW = "2026-07-24T12:00:00.000Z";

function step(id, status) {
  return {
    id,
    index: 0,
    title: `step ${id}`,
    status,
    acceptanceCriteria: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}
function task(id, status, extra = {}) {
  return {
    id,
    runId: "unused",
    stepId: "step-1",
    title: `task ${id}`,
    description: "do the thing",
    runtimePreference: "codex",
    status,
    allowedPaths: [],
    forbiddenPaths: [],
    expectedOutputs: [],
    verificationCommands: [],
    canRunParallel: true,
    conflictsWith: [],
    taskClass: "feature",
    createdBy: "spark",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
function attempt(id, status, workerTaskId, extra = {}) {
  return {
    id,
    runId: "unused",
    workerTaskId,
    attemptNumber: 1,
    runtime: "codex",
    cwd: HOME,
    status,
    engine: "pi",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
function directRun(id, overrides = {}) {
  return {
    id,
    title: "direct loom run",
    status: "running",
    executionMode: "direct",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: WS,
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    steps: [step("step-1", "running")],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [
      {
        id: "msg-1",
        author: "user",
        kind: "note",
        message: "run the loom",
        createdAt: NOW,
        deliveryState: "acknowledged",
        conversationEpoch: 0,
      },
    ],
    sparkCalls: [],
    plans: [],
    assumptions: [],
    ...overrides,
  };
}
function writeRun(run) {
  const dir = path.join(HOME, "runs", run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  return run.id;
}
function readRun(runId) {
  return JSON.parse(fs.readFileSync(path.join(HOME, "runs", runId, "run.json"), "utf8"));
}
function reportFile(name, body) {
  const p = path.join(HOME, "reports", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (body !== undefined) fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}
function completeReport(summary) {
  return {
    status: "complete",
    summary,
    filesChanged: [{ path: "src/app.ts", reason: "feature" }],
    commandsRun: [],
    tests: [{ command: "node scripts/test.cjs", result: "passed" }],
    proof: ["suite green"],
    risks: ["existing risk"],
    followups: [],
  };
}
const readReport = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  // ── 1. writeAutoFailureReport preserves a finished report ────────────────
  const workerLaunch = await bundle(WORKER_LAUNCH_TS, "worker-launch.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });
  const wtask = task("task-wl", "running");

  const pComplete = reportFile("complete.json", completeReport("Wrote the deliverable."));
  const resComplete = await workerLaunch.writeAutoFailureReport(
    { finalReportJson: pComplete },
    wtask,
    "servers overloaded",
  );
  const afterComplete = readReport(pComplete);
  check("late error on a complete report reports preservedExisting", resComplete.preservedExisting === true);
  check("complete report keeps its status", afterComplete.status === "complete", afterComplete.status);
  check("complete report keeps its summary", afterComplete.summary === "Wrote the deliverable.");
  check(
    "late error is recorded in the preserved report's risks",
    afterComplete.risks.includes("existing risk") &&
      afterComplete.risks.some((r) => r.includes("servers overloaded")),
    JSON.stringify(afterComplete.risks),
  );

  const pPartial = reportFile("partial.json", { ...completeReport("Half done."), status: "partial" });
  const resPartial = await workerLaunch.writeAutoFailureReport({ finalReportJson: pPartial }, wtask, "boom");
  check(
    "a partial report is preserved too",
    resPartial.preservedExisting === true && readReport(pPartial).status === "partial",
  );

  const pInterrupted = reportFile("interrupted.json", completeReport("Finished before the stop."));
  const resInterrupted = await workerLaunch.writeAutoFailureReport(
    { finalReportJson: pInterrupted },
    wtask,
    "Pi worker was interrupted.",
    { interrupted: true },
  );
  check(
    "an interrupt after the report is written preserves it",
    resInterrupted.preservedExisting === true && readReport(pInterrupted).status === "complete",
  );

  const pMissing = reportFile("missing.json");
  const resMissing = await workerLaunch.writeAutoFailureReport({ finalReportJson: pMissing }, wtask, "no TUI banner observed");
  const afterMissing = readReport(pMissing);
  check(
    "no prior report still writes the synthetic failure",
    resMissing.preservedExisting === false && afterMissing.status === "failed",
    JSON.stringify(afterMissing.status),
  );
  check(
    "synthetic failure carries the reason",
    afterMissing.summary.includes("no TUI banner observed"),
    afterMissing.summary,
  );

  const pFailed = reportFile("failed.json", { status: "failed", summary: "old failure" });
  const resFailed = await workerLaunch.writeAutoFailureReport({ finalReportJson: pFailed }, wtask, "fresh reason");
  check(
    "a prior failed report is replaced, not preserved",
    resFailed.preservedExisting === false && readReport(pFailed).summary.includes("fresh reason"),
  );

  const pCorrupt = reportFile("corrupt.json", "{not json");
  const resCorrupt = await workerLaunch.writeAutoFailureReport({ finalReportJson: pCorrupt }, wtask, "late boom");
  check(
    "a corrupt report file is replaced with the synthetic failure",
    resCorrupt.preservedExisting === false && readReport(pCorrupt).status === "failed",
  );

  // ── 2. end to end: preserved report settles the direct run complete ──────
  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  const lateReport = reportFile("late-run.json", completeReport("Node work landed."));
  writeRun(
    directRun("run-late-error", {
      workerTasks: [task("task-1", "running")],
      workerAttempts: [attempt("att-1", "running", "task-1", { finalReportPath: lateReport })],
    }),
  );
  // The observed sequence: the worker wrote its complete report, then the late
  // provider error drove the catch (which must preserve the report) and the
  // attempt was failed. The finalizer must still settle the run from the report.
  await workerLaunch.writeAutoFailureReport(
    { finalReportJson: lateReport },
    task("task-1", "running"),
    "Codex servers overloaded during shutdown",
  );
  await runStore.failWorkerAttempt("run-late-error", "att-1", "Pi provider turn failed.");
  const afterLate = readRun("run-late-error");
  check("late-error run settles complete from the preserved report", afterLate.status === "complete", afterLate.status);
  check(
    "late-error run's task is accepted",
    afterLate.workerTasks[0].status === "accepted",
    afterLate.workerTasks[0].status,
  );
  check("preserved report is still complete on disk", readReport(lateReport).status === "complete");

  // The pre-fix shape as a control: when the report really is the synthetic
  // failure (nothing to preserve), the same late failure fails the run.
  const clobberedReport = reportFile("clobbered-run.json", {
    status: "failed",
    summary: "Cora could not complete the codex CLI worker for this task: servers overloaded.",
  });
  writeRun(
    directRun("run-clobbered", {
      workerTasks: [task("task-1", "running")],
      workerAttempts: [attempt("att-1", "running", "task-1", { finalReportPath: clobberedReport })],
    }),
  );
  await runStore.failWorkerAttempt("run-clobbered", "att-1", "Pi provider turn failed.");
  check(
    "a genuinely failed report still fails the run",
    readRun("run-clobbered").status === "failed",
    readRun("run-clobbered").status,
  );

  // ── 3. newestAttemptForNode spans original + fallback tasks ──────────────
  const nodeRun = (fallbackExtra) => ({
    workerTasks: [
      task("task-orig", "cancelled", { loomNodeId: "w0" }),
      task("task-fb", "queued", { supersedesTaskId: "task-orig", createdBy: "system", ...fallbackExtra }),
    ],
    workerAttempts: [
      attempt("att-orig", "failed", "task-orig"),
      attempt("att-fb", "succeeded", "task-fb"),
    ],
  });
  const stamped = runStore.newestAttemptForNode(nodeRun({ loomNodeId: "w0" }), "w0");
  check("stamped fallback: node resolves to the newest (fallback) attempt", stamped?.id === "att-fb", stamped?.id);
  const unstamped = runStore.newestAttemptForNode(nodeRun({}), "w0");
  check(
    "pre-fix shape: an unstamped fallback leaves the node on the failed attempt",
    unstamped?.id === "att-orig",
    unstamped?.id,
  );
  const noFallbackAttempt = runStore.newestAttemptForNode(
    {
      workerTasks: [
        task("task-orig", "cancelled", { loomNodeId: "w0" }),
        task("task-fb", "queued", { loomNodeId: "w0" }),
      ],
      workerAttempts: [attempt("att-orig", "failed", "task-orig")],
    },
    "w0",
  );
  check(
    "a queued fallback with no attempt yet keeps the node on the original attempt",
    noFallbackAttempt?.id === "att-orig",
    noFallbackAttempt?.id,
  );

  // ── 4. end to end: the loom node settles from the fallback attempt ───────
  const loomPass = () => ({
    graphVersion: 1,
    layerCursor: 0,
    pendingNodeIds: ["w0"],
    nodeStates: { w0: { status: "running", attemptIds: ["att-f1", "att-f2"], layer: 0, activations: 2 } },
  });
  const fbReport = reportFile("fallback-node.json", completeReport("Fallback attempt landed the node."));
  const fbFailedReport = reportFile("fallback-node-failed.json", {
    status: "failed",
    summary: "codex CLI failed to launch.",
  });
  const loomTasks = (fallbackExtra) => [
    task("task-f1", "cancelled", { loomNodeId: "w0" }),
    task("task-f2", "needs_review", {
      supersedesTaskId: "task-f1",
      createdBy: "system",
      runtimePreference: "claude",
      ...fallbackExtra,
    }),
  ];
  const loomAttempts = () => [
    attempt("att-f1", "failed", "task-f1", { finalReportPath: fbFailedReport, error: "codex CLI failed to launch" }),
    attempt("att-f2", "succeeded", "task-f2", { runtime: "claude", finalReportPath: fbReport }),
  ];
  writeRun(
    directRun("run-fallback-node", {
      loomPass: loomPass(),
      workerTasks: loomTasks({ loomNodeId: "w0" }),
      workerAttempts: loomAttempts(),
    }),
  );
  // att-f1 is already terminal, so this call goes straight to finalizeDirectRun.
  await runStore.failWorkerAttempt("run-fallback-node", "att-f1", "codex CLI failed to launch");
  const afterFallback = readRun("run-fallback-node");
  check(
    "stamped fallback settles the loom run complete",
    afterFallback.status === "complete",
    afterFallback.status,
  );
  check(
    "node state records the fallback success",
    afterFallback.loomPass.nodeStates.w0.status === "succeeded",
    afterFallback.loomPass.nodeStates.w0.status,
  );
  check(
    "fallback task is accepted by the finalizer",
    afterFallback.workerTasks.find((t) => t.id === "task-f2").status === "accepted",
  );

  // The defect shape as a control: identical run, fallback without loomNodeId.
  writeRun(
    directRun("run-fallback-unstamped", {
      loomPass: loomPass(),
      workerTasks: loomTasks({}),
      workerAttempts: loomAttempts(),
    }),
  );
  await runStore.failWorkerAttempt("run-fallback-unstamped", "att-f1", "codex CLI failed to launch");
  check(
    "pre-fix shape: an unstamped fallback leaves the loom run failed",
    readRun("run-fallback-unstamped").status === "failed",
    readRun("run-fallback-unstamped").status,
  );

  // ── 5. source pins: the wiring the behavioral tests cannot reach ─────────
  const runStoreSrc = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "runtime fallback literal carries the loom node id",
    /const fallbackTask: WorkerTask = \{[\s\S]{0,3500}loomNodeId: task\.loomNodeId/.test(runStoreSrc),
  );
  check(
    "runtime fallback literal carries the node-derived fence hints",
    /loomNodeId: task\.loomNodeId,\s*\n\s*accessHint: task\.accessHint,\s*\n\s*blockedToolsHint: task\.blockedToolsHint,\s*\n\s*collabMailDirHint: task\.collabMailDirHint,/.test(
      runStoreSrc,
    ),
  );
  check(
    "the Pi session catch settles as succeeded when the report was preserved",
    runStoreSrc.includes("failureWrite?.preservedExisting") &&
      /preservedExisting[\s\S]{0,1200}return \{ exitCode: 0[,\s}]/.test(runStoreSrc),
  );
  const workerLaunchSrc = fs.readFileSync(WORKER_LAUNCH_TS, "utf8");
  check(
    "writeAutoFailureReport exposes the preservation verdict",
    workerLaunchSrc.includes("preservedExisting: true") &&
      workerLaunchSrc.includes("preservedExisting: false"),
  );

  fs.rmSync(HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} late-failure-preservation check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll late-failure-preservation checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
