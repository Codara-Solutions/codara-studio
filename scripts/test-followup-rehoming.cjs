#!/usr/bin/env node
"use strict";

// Regression harness for follow-up re-homing (run-msojtvqk-qjklvo).
//
//   node scripts/test-followup-rehoming.cjs
//
// Shape of the bug: step 1 finished with both its workers accepted, then the
// step-2 verifier returned FEEDBACK on one of them. maybeQueueVerifierFeedbackRetry
// re-queued that finished task IN PLACE and reopened its completed step, so 80 ms
// after the verifier exited the graph showed step 1 as "1/2 workers, 1 running,
// attempt 2" beside a running step 3. Product rule: Cora may follow up with a
// finished agent, but a completed step never shows running workers again - the
// follow-up attempt belongs to the CURRENT step.
//
// Six layers are pinned here:
//   1. placement - the real rehomeSettledStepFeedbackRetry (bundled from
//      step-lifecycle.ts) mints a follow-up copy in the current step, appends a
//      worker_batch step when every step has settled, and returns null (i.e.
//      "retry in place, unchanged behaviour") while the target's step is live;
//   2. the brake rule - a brake step is a no-op checkpoint that
//      resolveActiveBrakeAndReplan completes without running anything, so a
//      copy homed inside one either vanishes or defeats the brake. Both drivers
//      are asserted against the REAL run-store picker;
//   3. the picker - pickAutopilotTasks (the real one, bundled from run-store)
//      actually selects the copy in its destination. This is the invariant a
//      wrong destination silently breaks: a queued task nobody picks;
//   4. immutability - the settled step's status, workerTaskIds and every task
//      and attempt under it are byte-identical after the re-homing;
//   5. warm sessions + budget - the copy carries resumeSessionId so the REAL
//      evaluateWorkerSessionReuse still resumes it, and the attempt cap counts
//      the whole followUpOfTaskId lineage (cycle-safe);
//   6. the manager-decision path - the REAL applySparkManagerDecision homes a
//      worker_result_review verifier follow-up in a fresh step instead of
//      reopening the complete one, driven over a run.json under a throwaway
//      CODARA_HOME_DIR.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");
// JSON round-trip so `undefined`-valued keys compare equal on both sides.
const snapshot = (value) => JSON.parse(JSON.stringify(value));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-followup-rehoming-home-"));
process.env.CODARA_HOME_DIR = HOME;

const SHARED_ALIAS = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

// run-store reaches electron, node-pty and the provider fleet at module load;
// the same four seams scripts/test-force-pause-resume.cjs stubs are enough to
// bundle it and call its pure selectors plus applySparkManagerDecision.
const RUN_STORE_STUBS = {
  electron: `const noop = () => {};
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
export default { app };`,
  "node-pty": `export function spawn() { throw new Error("node-pty is stubbed in this harness"); }
export function exists() { return false; }
export default { spawn, exists };`,
  "./backend-registry": `const backend = (kind) => ({ kind, displayName: "stub", async requestManagerDecision() { throw new Error("no manager turn in this harness"); }, async disposeChat() {}, interruptChat() {} });
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions() {}`,
  "./pi-runtime-electron": `export async function resolveCodaraPiExecutionAccount() { return { accountProfileId: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10", provider: "anthropic", configDir: "/tmp/cora-stub-pi" }; }
export async function resolveCodaraPiRuntime() { throw new Error("pi runtime is stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/cora-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() { throw new Error("pi worker launch is stubbed"); }`,
};

const RUN_STORE_STUB_PLUGIN = {
  name: "run-store-stubs",
  setup(build) {
    build.onResolve(
      { filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron)$/ },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: RUN_STORE_STUBS[args.path],
      loader: "js",
    }));
  },
};

// Bundles live under node_modules so the externalized runtime deps (ssh2 and
// its native .node addons) still resolve from the file that requires them.
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-followup-rehoming-test");

async function bundle(relativeEntry, outName, opts = {}) {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, outName);
  const { extraPlugins = [], ...rest } = opts;
  await esbuild.build({
    entryPoints: [path.join(ROOT, ...relativeEntry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [SHARED_ALIAS, ...extraPlugins],
    ...rest,
  });
  return require(outfile);
}

const T0 = "2026-08-11T11:04:00.000Z";
const NOW = "2026-08-11T11:11:00.568Z";
const SESSION = "run-msojtvqk-qjklvo-attempt-msojysx5-76rumq";

// The reference run at the instant the verifier's FEEDBACK verdict landed:
// step 1 complete with both its workers accepted, step 2 the verifier's own
// step. `liveTail` adds the later step the manager was already running.
function referenceRun(options = {}) {
  const steps = [
    {
      id: "step-1",
      runId: "run-ref",
      index: 1,
      title: "Cora workers (2)",
      goal: "OpenAI primary source news; OpenAI independent coverage",
      kind: "worker_batch",
      plannedAgents: [],
      status: "complete",
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: ["task-primary", "task-coverage"],
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "step-2",
      runId: "run-ref",
      index: 2,
      title: "Verify OpenAI news brief",
      goal: "Verify OpenAI news brief",
      kind: "worker_batch",
      plannedAgents: [],
      status: options.verifierStepStatus ?? "complete",
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: ["task-verify"],
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  if (options.liveTail) {
    steps.push({
      id: "step-3",
      runId: "run-ref",
      index: 3,
      title: "Correct OpenAI coverage brief",
      goal: "Correct OpenAI coverage brief",
      kind: "worker_batch",
      plannedAgents: [],
      status: options.liveTail,
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: [],
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const workerTasks = [
    {
      id: "task-primary",
      runId: "run-ref",
      stepId: "step-1",
      title: "OpenAI primary source news",
      description: "Research OpenAI news from first party sources only.",
      runtimePreference: "claude",
      modelHint: "claude-sonnet-5",
      effortHint: "medium",
      status: "accepted",
      allowedPaths: ["research/openai-primary.md"],
      forbiddenPaths: ["src/"],
      expectedOutputs: ["research/openai-primary.md"],
      verificationCommands: ["npm run lint"],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "leaf",
      writeScopeSource: "derived",
      parallelTrust: "manager_batch",
      peers: true,
      peerComms: true,
      accessHint: "edits",
      blockedToolsHint: ["Bash"],
      collabMailDirHint: "/runs/run-ref/mail",
      loomNodeId: "w0",
      resumeSessionId: options.warmSession ? SESSION : undefined,
      followUpOfTaskId: options.warmSession ? "task-warm-source" : undefined,
      verifierFeedbackRounds: options.priorRounds,
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "task-coverage",
      runId: "run-ref",
      stepId: "step-1",
      title: "OpenAI independent coverage",
      description: "Independent coverage brief.",
      runtimePreference: "codex",
      status: "accepted",
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "leaf",
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "task-verify",
      runId: "run-ref",
      stepId: "step-2",
      title: "Verify OpenAI news brief",
      description: "Read-only re-derivation.",
      runtimePreference: "codex",
      status: "accepted",
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: false,
      conflictsWith: [],
      taskClass: "verifier",
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  const workerAttempts = [
    {
      id: "attempt-primary",
      runId: "run-ref",
      workerTaskId: "task-primary",
      attemptNumber: 1,
      runtime: "claude",
      model: "claude-sonnet-5",
      cwd: "/repo",
      status: "succeeded",
      piSessionId: SESSION,
      contextTokens: 30_000,
      startedAt: T0,
      finishedAt: "2026-08-11T11:05:52.518Z",
    },
    {
      id: "attempt-verify",
      runId: "run-ref",
      workerTaskId: "task-verify",
      attemptNumber: 1,
      runtime: "codex",
      cwd: "/repo",
      status: "succeeded",
      startedAt: T0,
      finishedAt: "2026-08-11T11:11:00.488Z",
    },
  ];
  return {
    id: "run-ref",
    status: "running",
    updatedAt: T0,
    currentStepId: undefined,
    steps,
    workerTasks,
    workerAttempts,
  };
}

const FEEDBACK_DESCRIPTION =
  "Research OpenAI news from first party sources only.\n\n## VERIFIER FEEDBACK\n\nFix the stale section header.";

const rehomeInput = (overrides = {}) => ({
  targetTaskId: "task-primary",
  description: FEEDBACK_DESCRIPTION,
  followUpTaskId: "task-followup",
  followUpStepId: "step-followup",
  timestamp: NOW,
  ...overrides,
});

// A brake step: kind "brake", no planned agents. resolveActiveBrakeAndReplan
// completes it without running anything the instant it becomes active.
function brakeStep(id, index) {
  return {
    id,
    runId: "run-ref",
    index,
    title: "Checkpoint before implementation",
    goal: "Replan with the recon evidence.",
    kind: "brake",
    plannedAgents: [],
    status: "queued",
    acceptanceCriteria: [],
    verificationCommands: [],
    workerTaskIds: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

async function main() {
  const lifecycle = await bundle(
    ["src", "main", "orchestration", "step-lifecycle.ts"],
    "step-lifecycle.cjs",
  );
  const {
    rehomeSettledStepFeedbackRetry,
    resolveFollowUpDestinationStep,
    countFollowUpLineageAttempts,
    isSettledStepStatus,
  } = lifecycle;
  const { evaluateWorkerSessionReuse } = await bundle(
    ["src", "main", "orchestration", "worker-session-reuse.ts"],
    "worker-session-reuse.cjs",
  );
  const runStore = await bundle(
    ["src", "main", "orchestration", "run-store.ts"],
    "run-store.cjs",
    { extraPlugins: [RUN_STORE_STUB_PLUGIN], packages: "external" },
  );
  const { pickAutopilotTasks, applySparkManagerDecision } = runStore;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  // ── 1. the settled-step definition the caller and the helper share ──
  for (const settled of ["complete", "completed_unverified", "failed", "skipped"]) {
    assert.equal(isSettledStepStatus(settled), true, `${settled} is settled`);
  }
  for (const live of ["queued", "ready", "running", "reviewing"]) {
    assert.equal(isSettledStepStatus(live), false, `${live} is not settled`);
  }
  console.log("PASS settled-step statuses match run-store's terminal set");

  // ── 2. re-home into the step that is already current ──
  {
    const run = referenceRun({ liveTail: "running", warmSession: true });
    const completedBefore = snapshot(run.steps[0]);
    const attemptsBefore = snapshot(run.workerAttempts);

    const rehomed = rehomeSettledStepFeedbackRetry(run, rehomeInput());
    assert.ok(rehomed, "a target in a complete step re-homes");
    assert.equal(rehomed.stepId, "step-3", "the copy lands in the current step");
    assert.equal(rehomed.createdStep, false, "an existing current step is reused");
    assert.equal(rehomed.taskId, "task-followup");

    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.ok(copy, "the follow-up task exists");
    assert.equal(copy.stepId, "step-3", "task.stepId points at the current step");
    assert.deepEqual(
      run.steps[2].workerTaskIds,
      ["task-followup"],
      "the current step's workerTaskIds carry the copy - what the desktop graph groups by",
    );

    // The completed step is untouched history.
    assert.deepEqual(snapshot(run.steps[0]), completedBefore, "the completed step is byte-identical");
    assert.equal(run.steps[0].status, "complete", "the completed step is never reopened");
    assert.deepEqual(
      run.steps[0].workerTaskIds,
      ["task-primary", "task-coverage"],
      "the completed step's counters are unchanged",
    );
    assert.deepEqual(snapshot(run.workerAttempts), attemptsBefore, "no attempt is added under the completed step");
    const original = run.workerTasks.find((task) => task.id === "task-primary");
    assert.equal(original.status, "accepted", "the original task keeps its accepted status");
    assert.equal(
      original.description,
      "Research OpenAI news from first party sources only.",
      "the original task's brief is not rewritten",
    );

    // Linkage + copied fields.
    assert.equal(copy.followUpOfTaskId, "task-primary", "the copy links back to the original");
    assert.equal(copy.title, original.title, "title is copied verbatim (runtime-fallback idiom)");
    assert.equal(copy.description, FEEDBACK_DESCRIPTION, "the copy carries the corrective brief");
    assert.equal(copy.status, "queued", "the copy is queueable");
    assert.equal(copy.createdBy, "system", "the copy is marked machine-minted");
    assert.equal(copy.taskClass, "leaf");
    assert.equal(copy.runtimePreference, "claude");
    assert.equal(copy.modelHint, "claude-sonnet-5");
    assert.equal(copy.effortHint, "medium");
    assert.deepEqual(copy.allowedPaths, ["research/openai-primary.md"]);
    assert.deepEqual(copy.forbiddenPaths, ["src/"]);
    assert.deepEqual(copy.expectedOutputs, ["research/openai-primary.md"]);
    assert.deepEqual(copy.verificationCommands, ["npm run lint"]);
    assert.equal(copy.canRunParallel, true);
    assert.equal(copy.parallelTrust, "manager_batch");
    assert.equal(copy.writeScopeSource, "derived");
    assert.equal(copy.loomNodeId, "w0", "loom identity survives the re-homing");
    assert.equal(copy.accessHint, "edits", "the node-derived tool fence travels with the copy");
    assert.deepEqual(copy.blockedToolsHint, ["Bash"]);
    assert.equal(copy.collabMailDirHint, "/runs/run-ref/mail");
    assert.equal(copy.verifierFeedbackRounds, 1, "the rework round counter advances on the copy");

    // Peer semantics: the INTENT flag travels, the outcome flag does not -
    // prepareWorkerTask re-derives group membership against the new step.
    assert.equal(copy.peers, true, "the peers opt-in travels with the copy");
    assert.equal(copy.peerComms, undefined, "the outcome flag is re-derived, never copied");
    console.log("PASS follow-up on a completed step's task lands in the current step");
  }

  // ── 3. isolated beats everything, and rounds accumulate ──
  {
    const run = referenceRun({ liveTail: "queued", priorRounds: 1 });
    const target = run.workerTasks.find((task) => task.id === "task-primary");
    target.isolated = true;
    rehomeSettledStepFeedbackRetry(run, rehomeInput());
    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.equal(copy.isolated, true, "an independent worker cannot rejoin peer traffic by re-homing");
    assert.equal(copy.verifierFeedbackRounds, 2, "feedback rounds are cumulative across the lineage");
    console.log("PASS isolated and the rework round counter carry across the re-homing");
  }

  // ── 4. no current step: append one, never reopen a settled one ──
  {
    const run = referenceRun();
    const rehomed = rehomeSettledStepFeedbackRetry(run, rehomeInput());
    assert.ok(rehomed);
    assert.equal(rehomed.createdStep, true, "a step is appended when every step has settled");
    assert.equal(rehomed.stepId, "step-followup");
    const created = run.steps.at(-1);
    assert.equal(created.id, "step-followup");
    assert.equal(created.index, 3, "the appended step continues the plan's numbering");
    assert.equal(created.status, "queued");
    assert.equal(created.kind, "worker_batch", "manager-spawn shape: work of its own gets a worker_batch step");
    assert.deepEqual(created.workerTaskIds, ["task-followup"]);
    assert.match(created.title, /Corrective rework: OpenAI primary source news/);
    assert.equal(run.steps[0].status, "complete", "the completed step stays complete");
    assert.equal(run.steps[1].status, "complete", "the verifier's settled step stays complete");
    assert.equal(
      run.steps.filter((step) => step.status !== "complete").length,
      1,
      "exactly one live step exists afterwards - the picker's active step",
    );
    console.log("PASS a run with no current step gets a fresh worker_batch step");
  }

  // ── 5. the target's step is still live: unchanged in-place behaviour ──
  {
    for (const status of ["queued", "ready", "running", "reviewing"]) {
      const run = referenceRun();
      run.steps[0].status = status;
      const before = snapshot(run);
      assert.equal(
        rehomeSettledStepFeedbackRetry(run, rehomeInput()),
        null,
        `a ${status} step retries in place`,
      );
      assert.deepEqual(snapshot(run), before, `a ${status} step's run state is untouched`);
    }
    // A target with no step at all cannot be re-homed either.
    const orphan = referenceRun();
    orphan.workerTasks.find((task) => task.id === "task-primary").stepId = undefined;
    assert.equal(rehomeSettledStepFeedbackRetry(orphan, rehomeInput()), null, "a step-less task retries in place");
    // An unknown target id is a no-op rather than a throw.
    assert.equal(
      rehomeSettledStepFeedbackRetry(referenceRun(), rehomeInput({ targetTaskId: "task-gone" })),
      null,
      "an unknown target id is a no-op",
    );
    console.log("PASS a live step keeps the existing in-place retry");
  }

  // ── 5b. the copy is picked up by the REAL autopilot picker ──
  // The invariant a wrong destination breaks silently: a queued task nobody
  // launches. Driving run-store's own selector is what makes "the CURRENT step"
  // mean something.
  {
    const run = referenceRun({ liveTail: "queued" });
    assert.deepEqual(
      pickAutopilotTasks(run).map((task) => task.id),
      [],
      "before the re-homing there is nothing queued to launch",
    );
    rehomeSettledStepFeedbackRetry(run, rehomeInput());
    assert.deepEqual(
      pickAutopilotTasks(run).map((task) => task.id),
      ["task-followup"],
      "the picker selects the re-homed copy",
    );

    // And when a step had to be appended.
    const settledRun = referenceRun();
    rehomeSettledStepFeedbackRetry(settledRun, rehomeInput());
    assert.deepEqual(
      pickAutopilotTasks(settledRun).map((task) => task.id),
      ["task-followup"],
      "the picker selects the copy in the appended step",
    );

    // Negative control for the removed reopen: no task of the completed step is
    // ever selected, so no attempt can land under it.
    const completedStepTaskIds = new Set(settledRun.steps[0].workerTaskIds);
    assert.equal(
      pickAutopilotTasks(settledRun).some((task) => completedStepTaskIds.has(task.id)),
      false,
      "no task of the completed step is launchable after the re-homing",
    );
    console.log("PASS the real autopilot picker launches the re-homed copy");
  }

  // ── 5c. brakes are never used as the destination ──
  // A brake is a no-op checkpoint. Two drivers, both fatal:
  //   (a) resolveActiveBrakeAndReplan marks the brake complete WITHOUT running
  //       anything, so a copy parked inside it is silently swallowed - queued,
  //       not failed, so the loud capped-task branch never fires either;
  //   (b) if the picker gets there first the copy runs INSIDE the brake, which
  //       then completes as an ordinary step and the replan never happens.
  {
    // Only step left is a brake -> append instead of homing inside it.
    const braked = referenceRun();
    braked.steps.push(brakeStep("step-brake", 3));
    const rehomed = rehomeSettledStepFeedbackRetry(braked, rehomeInput());
    assert.ok(rehomed);
    assert.notEqual(rehomed.stepId, "step-brake", "a brake step is never the destination");
    assert.equal(rehomed.createdStep, true, "a brake-only tail still appends a worker_batch step");
    assert.deepEqual(braked.steps.find((s) => s.id === "step-brake").workerTaskIds, [],
      "(a) the brake stays empty, so resolving it cannot swallow the copy");
    assert.equal(braked.steps.find((s) => s.id === "step-brake").status, "queued",
      "the brake is left untouched");
    // (b) the brake is still the first non-terminal step, so the picker gates
    // the copy behind it rather than running it inside it. That is the brake
    // doing its job: it resolves, replans, and the copy runs after.
    assert.deepEqual(
      pickAutopilotTasks(braked).map((task) => task.id),
      [],
      "(b) the copy waits for the brake to resolve instead of running inside it",
    );

    // A brake ahead of a real worker_batch step: skip the brake, use the step.
    const mixed = referenceRun();
    mixed.steps.push(brakeStep("step-brake", 3));
    mixed.steps.push({
      ...brakeStep("step-work", 4),
      kind: "worker_batch",
      title: "Implement the fix",
    });
    const mixedRehomed = rehomeSettledStepFeedbackRetry(mixed, rehomeInput());
    assert.equal(mixedRehomed.stepId, "step-work", "the first non-brake live step wins");
    assert.equal(mixedRehomed.createdStep, false, "no step is appended when a usable one exists");
    assert.deepEqual(mixed.steps.find((s) => s.id === "step-brake").workerTaskIds, []);

    // The shared resolver behaves identically for the manager-decision path.
    const decisionRun = referenceRun();
    decisionRun.steps.push(brakeStep("step-brake", 3));
    const destination = resolveFollowUpDestinationStep(decisionRun, {
      newStepId: "step-new",
      title: "Verify the fix",
      goal: "Re-derive ground truth.",
      timestamp: NOW,
    });
    assert.equal(destination.created, true);
    assert.equal(destination.step.id, "step-new");
    assert.equal(destination.step.kind, "worker_batch");
    console.log("PASS a brake step is never used to host follow-up work");
  }

  // ── 5d. the attempt budget spans the follow-up lineage, cycle-safe ──
  {
    const chain = {
      id: "run-chain",
      steps: [],
      workerTasks: [
        { id: "t1", followUpOfTaskId: undefined },
        { id: "t2", followUpOfTaskId: "t1" },
        { id: "t3", followUpOfTaskId: "t2" },
      ],
      workerAttempts: [
        { id: "a1", workerTaskId: "t1" },
        { id: "a2", workerTaskId: "t2" },
        { id: "a3", workerTaskId: "t3" },
      ],
    };
    const byId = (id) => chain.workerTasks.find((task) => task.id === id);
    assert.equal(countFollowUpLineageAttempts(chain, byId("t1")), 1, "the head counts only itself");
    assert.equal(countFollowUpLineageAttempts(chain, byId("t2")), 2);
    assert.equal(
      countFollowUpLineageAttempts(chain, byId("t3")),
      3,
      "three rounds of re-homing exhaust the 3-attempt cap",
    );
    // A corrupted run whose links form a cycle must terminate and count each
    // task exactly once rather than spin.
    byId("t1").followUpOfTaskId = "t3";
    assert.equal(
      countFollowUpLineageAttempts(chain, byId("t3")),
      3,
      "a followUpOfTaskId cycle terminates without double counting",
    );
    console.log("PASS the attempt cap counts the whole lineage and survives a cycle");
  }

  // ── 6. warm session reuse still engages for the re-homed task ──
  {
    const run = referenceRun({ liveTail: "running", warmSession: true });
    rehomeSettledStepFeedbackRetry(run, rehomeInput());
    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.equal(copy.resumeSessionId, SESSION, "the copy continues the same runtime session");

    // While the copy is the live writer, the gate refuses a second claim on
    // that session - the one-live-writer rule, unchanged by the re-homing.
    const contested = evaluateWorkerSessionReuse({
      run,
      followUpOfTaskId: "task-primary",
      requestedRuntime: "claude",
    });
    assert.equal(contested.kind, "cold", "a second claim on the live session spawns cold");
    assert.match(contested.reason, /task-followup already continues that session/);

    // Once the copy settles, the gate resumes it from its new step exactly as
    // it would have from the old one: the gate is run-scoped, never step-scoped.
    copy.status = "accepted";
    run.workerAttempts.push({
      id: "attempt-followup",
      runId: "run-ref",
      workerTaskId: "task-followup",
      attemptNumber: 1,
      runtime: "claude",
      model: "claude-sonnet-5",
      cwd: "/repo",
      status: "succeeded",
      piSessionId: SESSION,
      contextTokens: 32_000,
      startedAt: NOW,
      finishedAt: "2026-08-11T11:11:53.408Z",
    });
    const resumed = evaluateWorkerSessionReuse({
      run,
      followUpOfTaskId: "task-followup",
      requestedRuntime: "claude",
    });
    assert.equal(resumed.kind, "resume", "the re-homed task is itself resumable");
    assert.equal(resumed.sessionId, SESSION);
    assert.equal(resumed.contextTokens, 32_000, "the gauge reads the session's newest attempt");
    console.log("PASS warm session reuse survives the re-homing");
  }

  // ── 6b. the manager-decision follow-up path, driven for real ──
  // A trivial run marks its impl step complete before the verifier is queued,
  // so the manager's worker_result_review verifier follow-up names a step that
  // has already finished. It used to be hosted by flipping that step back to
  // "reviewing". Now it gets a step of its own and the complete step is history.
  {
    const runId = "run-trivial-followup";
    const dir = path.join(HOME, "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const before = {
      id: runId,
      title: "trivial run",
      status: "reviewing",
      executionMode: "managed",
      chatBackend: "pi",
      chatMode: "auto",
      taskComplexity: "trivial",
      workspaceId: "ws-followup-rehoming",
      cwd: HOME,
      artifactDir: path.join(dir, "artifacts"),
      createdAt: T0,
      updatedAt: T0,
      conversationEpoch: 1,
      steps: [
        {
          id: "step-impl",
          runId,
          index: 1,
          title: "Fix the parser",
          goal: "Fix the parser",
          kind: "worker_batch",
          plannedAgents: [],
          status: "complete",
          acceptanceCriteria: [],
          verificationCommands: [],
          workerTaskIds: ["task-impl"],
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      workerTasks: [
        {
          id: "task-impl",
          runId,
          stepId: "step-impl",
          title: "Fix the parser",
          description: "Fix the parser",
          runtimePreference: "claude",
          status: "accepted",
          allowedPaths: ["src/parser.ts"],
          forbiddenPaths: [],
          expectedOutputs: [],
          verificationCommands: [],
          canRunParallel: false,
          conflictsWith: [],
          taskClass: "leaf",
          createdBy: "spark",
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      workerAttempts: [
        {
          id: "attempt-impl",
          runId,
          workerTaskId: "task-impl",
          attemptNumber: 1,
          runtime: "claude",
          cwd: HOME,
          status: "succeeded",
          startedAt: T0,
          finishedAt: T0,
        },
      ],
      humanMessages: [],
      sparkCalls: [],
      plans: [],
      assumptions: [],
    };
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(before, null, 2));

    const after = await applySparkManagerDecision(
      before,
      {
        status: "run_workers",
        summary: "queue the verifier",
        steps: [],
        tasks: [
          {
            // The manager names the step that just completed.
            stepIndex: 1,
            title: "Verify the parser fix",
            description: "Re-derive ground truth over src/parser.ts.",
            runtimePreference: "codex",
            allowedPaths: [],
            forbiddenPaths: [],
            expectedOutputs: [],
            verificationCommands: [],
            canRunParallel: false,
            conflictsWith: [],
            taskClass: "verifier",
          },
        ],
      },
      "worker_result_review",
      HOME,
    );

    const implStep = after.steps.find((step) => step.id === "step-impl");
    assert.equal(implStep.status, "complete", "the completed step is NOT reopened to reviewing");
    assert.deepEqual(
      implStep.workerTaskIds,
      ["task-impl"],
      "the completed step's workerTaskIds are unchanged",
    );
    assert.equal(after.steps.length, 2, "the follow-up got a step of its own");
    const followUpStep = after.steps[1];
    assert.equal(followUpStep.kind, "worker_batch");
    assert.equal(followUpStep.index, 2, "the appended step continues the plan's numbering");
    assert.equal(followUpStep.title, "Verify the parser fix");
    assert.equal(after.currentStepId, followUpStep.id, "the run's current step is the new one");
    const verifier = after.workerTasks.find((task) => task.id !== "task-impl");
    assert.ok(verifier, "the verifier task was created rather than dropped");
    assert.equal(verifier.stepId, followUpStep.id, "task.stepId points at the new step");
    assert.deepEqual(
      followUpStep.workerTaskIds,
      [verifier.id],
      "the new step's workerTaskIds carry the verifier",
    );
    assert.deepEqual(
      pickAutopilotTasks(after).map((task) => task.id),
      [verifier.id],
      "the picker will launch the verifier from its new step",
    );

    const events = fs
      .readFileSync(path.join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.type === "spark_manager.followup_homed_in_current_step"),
      "the re-homing is journaled",
    );
    assert.equal(
      events.some((event) => event.type === "spark_manager.completed_step_reopened_for_followup"),
      false,
      "the old reopen event is gone",
    );
    assert.equal(
      events.some((event) => event.type === "spark_manager.task_without_active_step_dropped"),
      false,
      "the follow-up is not dropped",
    );
    console.log("PASS a manager verifier follow-up on a completed step gets its own step");
  }

  // ── 7. run-store wiring ──
  {
    const runStore = read("src", "main", "orchestration", "run-store.ts");
    const retry = runStore.slice(
      runStore.indexOf("async function maybeQueueVerifierFeedbackRetry"),
      runStore.indexOf("async function recordGreenClaims"),
    );
    assert.ok(retry.length > 0, "the verifier feedback retry still exists");
    assert.match(
      retry,
      /rehomeSettledStepFeedbackRetry\(draft, \{/,
      "the retry routes a settled-step target through the re-homing helper",
    );
    assert.ok(
      retry.indexOf("reconcileAcceptedVerifierOnlySteps(draft, timestamp)") <
        retry.indexOf("rehomeSettledStepFeedbackRetry(draft, {"),
      "verifier-only steps settle BEFORE the destination step is picked",
    );
    assert.doesNotMatch(
      retry,
      /isTerminalStepStatus\(step\.status\) \|\| step\.status === "reviewing"/,
      "a settled step is never reopened to queued any more",
    );
    assert.match(
      retry,
      /countFollowUpLineageAttempts\(run, target\)/,
      "the attempt cap counts the whole follow-up lineage when re-homing",
    );
    // The cap decline is journaled, so an unacted verifier verdict is
    // explicable from events.jsonl instead of looking like a dropped verdict.
    assert.match(
      retry,
      /type: "autopilot\.verifier_feedback_retry_capped"/,
      "hitting the attempt cap emits an event",
    );
    assert.ok(
      retry.indexOf('type: "autopilot.verifier_feedback_retry_capped"') <
        retry.indexOf("return null;\n  }"),
      "the capped event is emitted on the decline path",
    );
    // The commit event follows the work: filing it under the settled step would
    // put a "worker re-queued" row in a step that is not running it.
    assert.match(
      retry,
      /change\.stepId = rehomed\.stepId;\s*\n\s*change\.workerTaskId = rehomed\.taskId;/,
      "the re-homed retry event is filed under the destination step and task",
    );

    // The manager-decision follow-up path no longer mutates a complete step.
    const homed = runStore.slice(
      runStore.indexOf("async function maybeHomeFollowUpTaskInCurrentStep"),
      runStore.indexOf("function resolveRequestedStepIncludingTerminal"),
    );
    assert.ok(homed.length > 0, "the manager follow-up homing exists");
    assert.match(
      homed,
      /resolveFollowUpDestinationStep\(draft, \{/,
      "it shares the destination resolver with the corrective re-homing",
    );
    assert.doesNotMatch(
      homed,
      /status = "reviewing"/,
      "it never flips the completed step back to reviewing",
    );
    assert.equal(
      runStore.includes("maybeReopenCompletedStepForFollowUpTask"),
      false,
      "the reopen-the-completed-step helper is gone entirely",
    );
    console.log("PASS run-store routes both follow-up paths through the helpers");
  }

  // ── 7b. the brake rule lives in the shared resolver ──
  {
    const lifecycleSource = read("src", "main", "orchestration", "step-lifecycle.ts");
    assert.match(
      lifecycleSource,
      /!isSettledStepStatus\(step\.status\) && \(step\.kind \?\? "worker_batch"\) !== "brake"/,
      "the destination resolver skips settled steps AND brakes",
    );
    // The brake semantics this depends on: run-store completes a brake without
    // running anything, which is why a task parked inside one disappears.
    const runStore = read("src", "main", "orchestration", "run-store.ts");
    assert.match(
      runStore,
      /if \(!next \|\| \(next\.kind \?\? "worker_batch"\) !== "brake"\) return run;/,
      "resolveActiveBrakeAndReplan still settles the active brake with no workers",
    );
    console.log("PASS the brake exclusion is pinned against run-store's brake resolver");
  }

  // ── 8. grouping pins: no renderer change is needed ──
  {
    const runFormat = read("src", "renderer", "src", "components", "runs", "run-format.ts");
    assert.match(
      runFormat,
      /const tasks = step\.workerTaskIds/,
      "the desktop graph groups workers by step.workerTaskIds",
    );
    const production = read("src", "main", "remote-access", "production.ts");
    assert.match(
      production,
      /isRemoteCoraIdentity\(task\.stepId\)\s*\n?\s*\?\s*\{ stepId: task\.stepId \}/,
      "the phone roster groups workers by task.stepId",
    );
    console.log("PASS both graphs group by fields the re-homing already sets");
  }

  console.log("\nfollow-up re-homing: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
