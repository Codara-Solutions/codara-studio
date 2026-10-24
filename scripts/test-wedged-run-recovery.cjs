// Regression harness for the wedged-run defect (run-ms0dijmk-54pw6g).
//
// Shape of the bug: an execute/auto CLI manager (claude/codex/pi) reviews its
// workers INSIDE its own turn via codara_wait_for_workers, so
// runAutopilotWorkerCycle deliberately skips scheduleAutopilotReview for it.
// When that turn then ends without codara_complete, nothing terminalizes the
// run: every step is complete, every worker task accepted, no worker alive, no
// timer armed, and the header pulses "Working" forever (the badge reads
// run.status, not autopilot.status).
//
// Two seams are pinned here:
//   1. the in-process hop , startAutopilot, re-entered after the manager turn,
//      must finish a run whose work is all settled instead of asking the user
//      about work that is already done;
//   2. boot recovery , completeSettledManagedRunsAfterRestart must close out a
//      persisted run left in that shape, BEFORE pauseManagedRunsAfterRestart
//      can park it as "press Resume".
//
//   node scripts/test-wedged-run-recovery.cjs
//
// Bundles the REAL run-settled.ts (dep-free) and the REAL run-store.ts against
// an electron/node-pty stub, then drives both entry points over fabricated
// run.json files under a throwaway CODARA_HOME_DIR (run-store reads any
// well-formed run.json on cache miss, same trick as scripts/test-agent-socket.cjs).
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const RUN_SETTLED_TS = path.join(ROOT, "src", "main", "orchestration", "run-settled.ts");
const INDEX_TS = path.join(ROOT, "src", "main", "index.ts");
// Bundles live under node_modules so the externalized runtime deps (ssh2 and
// friends) still resolve from the file that requires them.
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-wedged-run-test");

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getAppPath: () => process.cwd(), getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-wedged-run-"));
const WS = "ws-wedged-test";
const NOW = "2026-07-24T12:00:00.000Z";

function step(id, status, extra = {}) {
  return {
    id,
    index: 0,
    title: `step ${id}`,
    status,
    acceptanceCriteria: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
function task(id, status, stepId = "step-1") {
  return {
    id,
    runId: "unused",
    stepId,
    title: `task ${id}`,
    status,
    taskClass: "feature",
    createdAt: NOW,
    updatedAt: NOW,
  };
}
function attempt(id, status, workerTaskId) {
  return { id, workerTaskId, status, engine: "pi", createdAt: NOW, updatedAt: NOW };
}

// The observed wedge: one worker_batch step rolled to complete by the last
// local acceptance, five accepted tasks, five succeeded attempts, the manager's
// chat call already finalized, run.status still "running".
function wedgedRun(id, overrides = {}) {
  const tasks = [1, 2, 3, 4, 5].map((n) => task(`task-${n}`, "accepted"));
  return {
    id,
    title: "wedged run",
    status: "running",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: WS,
    cwd: HOME,
    // completion writes result-manifest.json here; without it the real store
    // logs a caught mkdir(undefined) and the harness output turns to noise.
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    steps: [step("step-1", "complete")],
    workerTasks: tasks,
    workerAttempts: tasks.map((t, i) => attempt(`att-${i + 1}`, "succeeded", t.id)),
    humanMessages: [
      {
        id: "msg-1",
        author: "user",
        kind: "note",
        message: "do the thing",
        createdAt: NOW,
        deliveryState: "acknowledged",
        conversationEpoch: 0,
      },
    ],
    sparkCalls: [
      {
        id: "spark-1",
        mode: "chat",
        status: "succeeded",
        conversationEpoch: 0,
        startedAt: NOW,
        completedAt: NOW,
      },
    ],
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

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  // ── 1. the shared predicate ──────────────────────────────────────────────
  const { describeRunSettlement, isRunSettled } = await bundle(RUN_SETTLED_TS, "run-settled.cjs");

  check("the wedged shape is settled", isRunSettled(wedgedRun("run-a")) === true);
  check(
    "settlement reports the settled reason",
    describeRunSettlement(wedgedRun("run-a")).reason === "settled",
  );

  const notSettled = (name, run, reason) => {
    const verdict = describeRunSettlement(run);
    check(name, verdict.settled === false && verdict.reason === reason, JSON.stringify(verdict));
  };
  notSettled(
    "a task still awaiting review is not settled",
    wedgedRun("run-b", {
      workerTasks: [task("task-1", "accepted"), task("task-2", "needs_review")],
      workerAttempts: [attempt("att-1", "succeeded", "task-1"), attempt("att-2", "succeeded", "task-2")],
    }),
    "worker_task_unfinished",
  );
  notSettled(
    "a step still in review is not settled",
    wedgedRun("run-c", { steps: [step("step-1", "reviewing")] }),
    "step_unfinished",
  );
  notSettled(
    "a live worker attempt is not settled",
    wedgedRun("run-d", {
      workerAttempts: [attempt("att-1", "running", "task-1")],
    }),
    "attempt_in_flight",
  );
  // A prepared-but-never-launched attempt is exactly what startAutopilot's own
  // attemptInFlight guard treats as live, so the predicate must agree.
  notSettled(
    "a prompt_ready attempt is not settled",
    wedgedRun("run-d2", { workerAttempts: [attempt("att-1", "prompt_ready", "task-1")] }),
    "attempt_in_flight",
  );
  // Failure shapes keep their existing questions: completing them silently
  // would hide a decision the user still owes.
  notSettled(
    "an all-failed plan is not settled",
    wedgedRun("run-e", {
      steps: [step("step-1", "failed")],
      workerTasks: [task("task-1", "failed")],
      workerAttempts: [attempt("att-1", "failed", "task-1")],
    }),
    "step_unfinished",
  );
  notSettled(
    "a failed worker task under a complete step is not settled",
    wedgedRun("run-f", {
      workerTasks: [task("task-1", "accepted"), task("task-2", "failed")],
      workerAttempts: [attempt("att-1", "succeeded", "task-1"), attempt("att-2", "failed", "task-2")],
    }),
    "worker_task_unfinished",
  );
  notSettled(
    "a cancelled worker task is not settled",
    wedgedRun("run-g", {
      workerTasks: [task("task-1", "cancelled")],
      workerAttempts: [attempt("att-1", "cancelled", "task-1")],
    }),
    "worker_task_unfinished",
  );
  notSettled("a run with no steps is not settled", wedgedRun("run-h", { steps: [] }), "no_steps");
  notSettled(
    "a direct loom run is never settled by this rule",
    wedgedRun("run-i", { executionMode: "direct" }),
    "direct_run",
  );
  notSettled(
    "an already-complete run is not re-settled",
    wedgedRun("run-j", { status: "complete" }),
    "terminal_run",
  );
  // Unverified success is not success: completed_unverified and forceAccepted
  // are the honest markers a force-accept path leaves when work landed without
  // a terminal verifier verdict. Completing those reports cap-broken work as a
  // clean green run.
  notSettled(
    "a completed_unverified step is not settled",
    wedgedRun("run-k", { steps: [step("step-1", "completed_unverified")] }),
    "step_unverified",
  );
  notSettled(
    "a force-accepted worker task is not settled",
    wedgedRun("run-k2", {
      workerTasks: [
        task("task-1", "accepted"),
        { ...task("task-2", "accepted"), forceAccepted: true, forceAcceptReason: "corrective_rounds_capped" },
      ],
      workerAttempts: [attempt("att-1", "succeeded", "task-1"), attempt("att-2", "succeeded", "task-2")],
    }),
    "worker_task_force_accepted",
  );
  // The worker cycle's honest auto review: a partial or blocked report parks
  // the task at "blocked" and its step at completed_unverified, a failed or
  // missing one fails both. Neither may ever settle the run on its own.
  notSettled(
    "a worker parked blocked by a partial report is not settled",
    wedgedRun("run-k3", {
      steps: [step("step-1", "completed_unverified")],
      workerTasks: [task("task-1", "blocked")],
      workerAttempts: [attempt("att-1", "succeeded", "task-1")],
    }),
    "step_unverified",
  );
  notSettled(
    "a blocked task under a complete step is not settled",
    wedgedRun("run-k4", {
      workerTasks: [task("task-1", "accepted"), task("task-2", "blocked")],
      workerAttempts: [attempt("att-1", "succeeded", "task-1"), attempt("att-2", "succeeded", "task-2")],
    }),
    "worker_task_unfinished",
  );
  // A partial worker that Cora continued with follow_up_of in a new step is
  // decided: the follow-up was accepted, so the earlier step holds nothing.
  const continuedRun = (id, followUp = {}) =>
    wedgedRun(id, {
      steps: [step("step-1", "completed_unverified"), step("step-2", "complete")],
      workerTasks: [
        task("task-1", "blocked", "step-1"),
        { ...task("task-2", "accepted", "step-2"), followUpOfTaskId: "task-1", ...followUp },
      ],
      workerAttempts: [attempt("att-1", "succeeded", "task-1"), attempt("att-2", "succeeded", "task-2")],
    });
  check(
    "a blocked task replaced by an accepted follow-up settles",
    isRunSettled(continuedRun("run-k5")) === true,
    JSON.stringify(describeRunSettlement(continuedRun("run-k5"))),
  );
  check(
    "a failed task superseded by an accepted retry settles",
    isRunSettled(
      wedgedRun("run-k6", {
        steps: [step("step-1", "failed"), step("step-2", "complete")],
        workerTasks: [
          task("task-1", "failed", "step-1"),
          { ...task("task-2", "accepted", "step-2"), supersedesTaskId: "task-1" },
        ],
        workerAttempts: [attempt("att-1", "failed", "task-1"), attempt("att-2", "succeeded", "task-2")],
      }),
    ) === true,
  );
  notSettled(
    "a blocked task with an unlinked later success is not settled",
    continuedRun("run-k7", { followUpOfTaskId: undefined }),
    "step_unverified",
  );
  notSettled(
    "a force-accepted follow-up does not replace the blocked task",
    continuedRun("run-k8", { forceAccepted: true }),
    "step_unverified",
  );
  check("a skipped step still counts as finished", isRunSettled(
    wedgedRun("run-l", { steps: [step("step-1", "skipped")] }),
  ) === true);

  // ── 2. the in-process hop: startAutopilot must finish, not ask ───────────
  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  const wedgedId = writeRun(wedgedRun("run-wedged-live"));
  await runStore.startAutopilot({
    workspaceId: WS,
    workspaceName: "wedged",
    cwd: HOME,
    runId: wedgedId,
  });
  const afterHop = readRun(wedgedId);
  check("post-turn hop completes the settled run", afterHop.status === "complete", afterHop.status);
  check(
    "post-turn hop stamps the manager-complete projection",
    afterHop.autopilot &&
      afterHop.autopilot.status === "complete" &&
      afterHop.autopilot.lastAction === "manager_marked_complete",
    JSON.stringify(afterHop.autopilot),
  );
  check("post-turn hop stamps completedAt", typeof afterHop.completedAt === "string");
  // The old behavior: a "Needs you" question about work that is already done.
  check(
    "post-turn hop asks the user nothing",
    !afterHop.blockedOn &&
      !(afterHop.humanMessages || []).some((m) => m.kind === "question"),
  );

  // The same hop on an unfinished run must NOT complete it. A live attempt is
  // the quiet case: startAutopilot returns at its attemptInFlight guard without
  // reaching any manager backend.
  const pendingId = writeRun(
    wedgedRun("run-still-working", {
      steps: [step("step-1", "running")],
      workerTasks: [task("task-1", "running")],
      workerAttempts: [attempt("att-1", "running", "task-1")],
    }),
  );
  await runStore.startAutopilot({
    workspaceId: WS,
    workspaceName: "pending",
    cwd: HOME,
    runId: pendingId,
  });
  const afterPending = readRun(pendingId);
  check(
    "post-turn hop leaves an unfinished run alone",
    afterPending.status !== "complete",
    afterPending.status,
  );

  // A partial worker nobody continued leaves only an unverified step. Nothing
  // remains to run, so the question names that worker instead of claiming the
  // remaining steps wait on a blocker.
  const partialReport = path.join(HOME, "runs", "run-partial-only", "final-report.json");
  const partialId = writeRun(
    wedgedRun("run-partial-only", {
      steps: [step("step-1", "completed_unverified")],
      workerTasks: [task("task-1", "blocked")],
      workerAttempts: [
        { ...attempt("att-1", "succeeded", "task-1"), finishedAt: NOW, finalReportPath: partialReport },
      ],
    }),
  );
  fs.mkdirSync(path.dirname(partialReport), { recursive: true });
  fs.writeFileSync(
    partialReport,
    JSON.stringify({ status: "partial", summary: "half the endpoints", filesChanged: [] }),
  );
  await runStore.startAutopilot({ workspaceId: WS, workspaceName: "partial", cwd: HOME, runId: partialId });
  const afterPartial = readRun(partialId);
  const partialQuestion = (afterPartial.humanMessages || []).filter((m) => m.kind === "question").at(-1);
  check(
    "an unverified-only run asks about the unfinished worker",
    afterPartial.status === "blocked" &&
      /only finished part of its task/.test(partialQuestion?.message ?? "") &&
      !/None of the remaining steps/.test(partialQuestion?.message ?? ""),
    partialQuestion?.message,
  );

  // A settled run whose recorded plan still has open milestones is not done:
  // the hop asks instead of completing after the first green slice.
  const openPlanId = writeRun(
    wedgedRun("run-open-plan-live", {
      managerPlan: {
        goal: "Ship auth, billing and docs",
        milestones: [
          { id: "m1", title: "Auth", status: "done", note: "tests pass" },
          { id: "m2", title: "Billing", status: "in_progress" },
          { id: "m3", title: "Docs", status: "pending" },
        ],
        updatedAt: NOW,
      },
    }),
  );
  await runStore.startAutopilot({ workspaceId: WS, workspaceName: "plan", cwd: HOME, runId: openPlanId });
  const afterOpenPlan = readRun(openPlanId);
  const planQuestion = (afterOpenPlan.humanMessages || []).filter((m) => m.kind === "question").at(-1);
  check(
    "post-turn hop does not complete a run with open plan milestones",
    afterOpenPlan.status !== "complete",
    afterOpenPlan.status,
  );
  check(
    "post-turn hop asks about the open milestones by name",
    afterOpenPlan.status === "blocked" &&
      /m2 "Billing"/.test(planQuestion?.message ?? "") &&
      /m3 "Docs"/.test(planQuestion?.message ?? ""),
    planQuestion?.message,
  );

  // ── 3. boot recovery ────────────────────────────────────────────────────
  const bootSettled = writeRun(wedgedRun("run-boot-settled"));
  const bootReviewing = writeRun(wedgedRun("run-boot-reviewing", { status: "reviewing" }));
  const bootUnfinished = writeRun(
    wedgedRun("run-boot-unfinished", {
      steps: [step("step-1", "running")],
      workerTasks: [task("task-1", "running")],
      workerAttempts: [attempt("att-1", "running", "task-1")],
    }),
  );
  const bootPaused = writeRun(wedgedRun("run-boot-paused", { status: "paused" }));
  const bootQueuedInput = writeRun(
    wedgedRun("run-boot-queued-input", {
      humanMessages: [
        {
          id: "msg-q",
          author: "user",
          kind: "note",
          message: "and now do this too",
          createdAt: NOW,
          deliveryState: "queued",
          conversationEpoch: 0,
        },
      ],
    }),
  );
  const bootLiveCall = writeRun(
    wedgedRun("run-boot-live-call", {
      sparkCalls: [
        { id: "spark-1", mode: "chat", status: "started", conversationEpoch: 0, startedAt: NOW },
      ],
    }),
  );
  const bootQuestion = writeRun(
    wedgedRun("run-boot-question", {
      humanMessages: [
        {
          id: "msg-question",
          author: "spark",
          kind: "question",
          message: "Which database should I use?",
          createdAt: NOW,
          conversationEpoch: 0,
          questionState: "open",
        },
      ],
    }),
  );
  const bootDirect = writeRun(wedgedRun("run-boot-direct", { executionMode: "direct" }));
  // The real boot ordering defeats a "started" check: recoverOrphanedManagerTurns
  // runs first and fails every live call, leaving only the marker behind.
  const bootRecoveredCall = writeRun(
    wedgedRun("run-boot-recovered-call", {
      sparkCalls: [
        {
          id: "spark-1",
          mode: "chat",
          status: "failed",
          error: "Manager turn interrupted by application restart.",
          conversationEpoch: 0,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    }),
  );
  // An answered codara_ask_user question: the live RPC carried the answer and
  // died with the process, so nothing durable says Cora ever acted on it.
  const bootAnsweredQuestion = writeRun(
    wedgedRun("run-boot-answered", {
      humanMessages: [
        {
          id: "msg-question",
          author: "spark",
          kind: "question",
          message: "Want me to run the test suite too?",
          createdAt: NOW,
          conversationEpoch: 0,
          questionState: "answered",
        },
        {
          id: "msg-answer",
          author: "user",
          kind: "answer",
          message: "yes",
          answersMessageId: "msg-question",
          deliveryState: "acknowledged",
          createdAt: NOW,
          conversationEpoch: 0,
        },
      ],
    }),
  );
  // A continuation recoverPendingManagerResumes repaired to "pending": Resume
  // owns it, completing the run would strand it.
  const bootPendingResume = writeRun(
    wedgedRun("run-boot-pending-resume", {
      pendingManagerResume: {
        questionMessageId: "msg-question",
        managerMode: "chat",
        requestedAt: NOW,
        state: "pending",
      },
    }),
  );
  // Work that changed files and never earned a passing verifier verdict. The
  // execute-mode auto-accept marks the task accepted on process exit without
  // reading the report, so settlement alone must not complete it.
  const unverifiedReport = path.join(HOME, "runs", "run-boot-unverified", "final-report.json");
  const bootUnverified = writeRun(
    wedgedRun("run-boot-unverified", {
      workerAttempts: [
        {
          ...attempt("att-1", "succeeded", "task-1"),
          finishedAt: NOW,
          finalReportPath: unverifiedReport,
        },
        ...[2, 3, 4, 5].map((n) => attempt(`att-${n}`, "succeeded", `task-${n}`)),
      ],
    }),
  );
  fs.writeFileSync(
    unverifiedReport,
    JSON.stringify({
      status: "complete",
      summary: "changed files, no verifier",
      filesChanged: [{ path: "src/app.ts", reason: "feature" }],
    }),
  );

  // Cora's own plan says more work remains. Every recorded task settled, but
  // the run is not done until the plan is.
  const bootOpenPlan = writeRun(
    wedgedRun("run-boot-open-plan", {
      managerPlan: {
        goal: "Ship auth, billing and docs",
        milestones: [
          { id: "m1", title: "Auth", status: "done" },
          { id: "m2", title: "Billing", status: "pending" },
        ],
        updatedAt: NOW,
      },
    }),
  );

  await runStore.completeSettledManagedRunsAfterRestart();

  check(
    "boot recovery never completes a run whose plan has open milestones",
    readRun(bootOpenPlan).status === "running",
    readRun(bootOpenPlan).status,
  );
  check("boot recovery completes a settled running run", readRun(bootSettled).status === "complete", readRun(bootSettled).status);
  check(
    "boot recovery completes a settled reviewing run",
    readRun(bootReviewing).status === "complete",
    readRun(bootReviewing).status,
  );
  check(
    "boot recovery leaves unfinished work alone",
    readRun(bootUnfinished).status === "running",
    readRun(bootUnfinished).status,
  );
  check("boot recovery leaves a paused run paused", readRun(bootPaused).status === "paused");
  check(
    "boot recovery leaves an undelivered user turn to Resume",
    readRun(bootQueuedInput).status === "running",
    readRun(bootQueuedInput).status,
  );
  check(
    "boot recovery leaves a cut-off manager call to Resume",
    readRun(bootLiveCall).status === "running",
    readRun(bootLiveCall).status,
  );
  check(
    "boot recovery never buries an open question",
    readRun(bootQuestion).status === "running",
    readRun(bootQuestion).status,
  );
  check("boot recovery ignores direct loom runs", readRun(bootDirect).status === "running");
  check(
    "boot recovery leaves a restart-failed manager call to Resume",
    readRun(bootRecoveredCall).status === "running",
    readRun(bootRecoveredCall).status,
  );
  check(
    "boot recovery never buries an answer the manager never acted on",
    readRun(bootAnsweredQuestion).status === "running",
    readRun(bootAnsweredQuestion).status,
  );
  check(
    "boot recovery leaves a pending manager continuation to Resume",
    readRun(bootPendingResume).status === "running",
    readRun(bootPendingResume).status,
  );
  check(
    "boot recovery never completes unverified file changes",
    readRun(bootUnverified).status === "running",
    readRun(bootUnverified).status,
  );

  // Ordering: the pause pass must find the settled run already terminal, so the
  // user is never asked to Resume finished work.
  await runStore.pauseManagedRunsAfterRestart();
  check(
    "the settled run survives the restart pause as complete",
    readRun(bootSettled).status === "complete",
    readRun(bootSettled).status,
  );
  check(
    "the unfinished run is still parked by the restart pause",
    readRun(bootUnfinished).status === "paused",
    readRun(bootUnfinished).status,
  );
  // Re-running recovery must not re-fire on an already terminal run.
  await runStore.completeSettledManagedRunsAfterRestart();
  check("boot recovery is idempotent", readRun(bootSettled).status === "complete");

  // ── 3b. the unverified question resolves on a click, no manager turn ────
  const askReport = path.join(HOME, "runs", "run-ask-unverified", "final-report.json");
  const askId = writeRun(
    wedgedRun("run-ask-unverified", {
      workerTasks: [task("task-1", "accepted")],
      workerAttempts: [
        { ...attempt("att-1", "succeeded", "task-1"), finishedAt: NOW, finalReportPath: askReport },
      ],
    }),
  );
  fs.writeFileSync(
    askReport,
    JSON.stringify({
      status: "complete",
      summary: "wrote the script",
      filesChanged: [{ path: "script.py", reason: "new" }],
    }),
  );
  await runStore.startAutopilot({ workspaceId: WS, workspaceName: "ask", cwd: HOME, runId: askId });
  const asked = readRun(askId);
  const question = (asked.humanMessages || []).filter((m) => m.kind === "question").at(-1);
  check("unverified work asks instead of completing", asked.status === "blocked" && Boolean(question), asked.status);
  const optionIds = (question?.questionOptions || []).map((option) => option.id);
  check(
    "the unverified question offers check and as-is choices",
    optionIds.includes("check_changes_now") && optionIds.includes("use_changes_as_is"),
    JSON.stringify(optionIds),
  );
  check(
    "the unverified question speaks plainly",
    question && !/verdict/i.test(question.message),
    question?.message,
  );
  const asIs = question?.questionOptions?.find((option) => option.id === "use_changes_as_is");
  await runStore.answerRunQuestion({ runId: askId, questionMessageId: question.id, message: asIs.answer });
  const acceptedAsIs = readRun(askId);
  check("'Use it as is' completes the run", acceptedAsIs.status === "complete", acceptedAsIs.status);
  check(
    "'Use it as is' records that nothing checked the work",
    acceptedAsIs.autopilot && acceptedAsIs.autopilot.lastAction === "user_accepted_unverified",
    JSON.stringify(acceptedAsIs.autopilot),
  );
  check(
    "'Use it as is' leaves no manager turn pending",
    !acceptedAsIs.pendingManagerResume &&
      (acceptedAsIs.humanMessages || []).every((m) => m.kind !== "answer" || m.deliveryState === "acknowledged"),
  );

  // "Check it now" launches one verifier over the final state on the other
  // provider, with no manager turn, and the run goes back to work.
  const checkReport = path.join(HOME, "runs", "run-ask-check", "final-report.json");
  const checkId = writeRun(
    wedgedRun("run-ask-check", {
      settingsSnapshot: { workspaceCwd: HOME },
      workerTasks: [{ ...task("task-1", "accepted"), runtimePreference: "claude" }],
      workerAttempts: [
        { ...attempt("att-1", "succeeded", "task-1"), finishedAt: NOW, finalReportPath: checkReport },
      ],
    }),
  );
  fs.writeFileSync(
    checkReport,
    JSON.stringify({
      status: "complete",
      summary: "wrote the script",
      filesChanged: [{ path: "script.py", reason: "new" }],
    }),
  );
  await runStore.startAutopilot({ workspaceId: WS, workspaceName: "ask", cwd: HOME, runId: checkId });
  const checkQuestion = (readRun(checkId).humanMessages || []).filter((m) => m.kind === "question").at(-1);
  const checkNow = checkQuestion?.questionOptions?.find((option) => option.id === "check_changes_now");
  const checking = await runStore
    .answerRunQuestion({ runId: checkId, questionMessageId: checkQuestion.id, message: checkNow.answer })
    .catch((error) => error);
  check("'Check it now' is applied without an error", !(checking instanceof Error), checking?.message);
  const verifiers = checking instanceof Error
    ? []
    : checking.workerTasks.filter((item) => item.taskClass === "verifier");
  check(
    "'Check it now' adds exactly one verifier, on the provider that did not write the changes",
    verifiers.length === 1 && verifiers[0].runtimePreference === "codex",
    JSON.stringify(verifiers.map((item) => item.runtimePreference)),
  );
  check(
    "'Check it now' puts the run back to work with no manager turn pending",
    !(checking instanceof Error) &&
      checking.autopilot?.lastAction === "user_requested_verification" &&
      !checking.pendingManagerResume,
    checking instanceof Error ? checking.message : JSON.stringify(checking.autopilot),
  );

  // ── 4. wiring the fixes cannot be silently unhooked ─────────────────────
  const runStoreSrc = fs.readFileSync(RUN_STORE_TS, "utf8");
  // Fix 1: re-feeding the initial note sends the post-turn hop back into
  // scheduleInitialChatDecision, whose activeAutopilotPlans guard sees this very
  // cycle in flight and returns , the hop then drives nothing at all.
  check(
    "the post-turn hop strips the initial-turn fields",
    /await startAutopilot\(\{\s*\.\.\.input,\s*initialUserNote: undefined,\s*initialUserNoteClientMessageId: undefined,\s*initialAttachments: undefined,\s*runId: run\.id,\s*\}\);/.test(
      runStoreSrc,
    ),
  );
  check(
    "startAutopilot finishes a settled run before asking the user anything",
    runStoreSrc.indexOf("if (isRunSettled(run)) {") <
      runStoreSrc.indexOf("No safe runnable task can be inferred"),
  );
  check(
    "boot recovery is exported from the run store",
    /export async function completeSettledManagedRunsAfterRestart\(\)/.test(runStoreSrc),
  );
  // The other way in: the manager turn ended BEFORE the last worker landed, so
  // no wait_for_workers RPC unblocks and no post-turn hop is coming either.
  const fallbackGuardAt = runStoreSrc.indexOf("if (activeManagerCall(settled)");
  const fallbackSettledAt = runStoreSrc.indexOf("if (isRunSettled(settled)) {");
  const fallbackCompleteAt = runStoreSrc.indexOf("await completeSettledRunOrAsk(settled);");
  check(
    "the worker cycle finishes a settled run when no manager turn is live",
    fallbackGuardAt > 0 &&
      fallbackGuardAt < fallbackSettledAt &&
      fallbackSettledAt < fallbackCompleteAt,
  );
  check(
    "the worker cycle reads the report before it auto-reviews a task",
    /autoReviewedTaskStatus\(finishedReport\?\.status\)/.test(runStoreSrc) &&
      !/taskInDraft\.status = "accepted";/.test(runStoreSrc),
  );
  check(
    "an unsettled run with an unfinished worker reaches the user",
    runStoreSrc.indexOf("await escalateUnfinishedWorkerOutcome(settled, finishedTaskId);") > fallbackSettledAt,
  );
  check(
    "that fallback stays behind the execute-mode skip, so a live turn is never re-prompted",
    runStoreSrc.indexOf("if (!isExecuteModeCliManager) {") < fallbackGuardAt,
  );
  // Completion invariants: every hop that can mark a run complete without the
  // manager's codara_complete must earn the same verifier freshness that tool
  // demands, and boot recovery must read the restart marker rather than
  // "started" (the orphan pass has already cleared every live call by then).
  // One gate (open plan milestones, then verifier freshness) serves every
  // hop: the post-turn hop, the worker cycle, the manual-review accept, and
  // boot recovery.
  check(
    "every terminal hop goes through the shared completion gate",
    /async function canAutoCompleteRun\(run: RunState\)[\s\S]*?openPlanMilestones\(run\.managerPlan\)[\s\S]*?await describeVerificationFreshness\(run\)/.test(runStoreSrc) &&
      (runStoreSrc.match(/completeSettledRunOrAsk\(/g) || []).length >= 4 &&
      /if \(!\(await canAutoCompleteRun\(run\)\)\.ok\) continue;/.test(runStoreSrc) &&
      (runStoreSrc.match(/return completeRunFromOrchestrator\(|await completeRunFromOrchestrator\(/g) || []).length === 2,
  );
  check(
    "boot recovery detects a manager turn the restart cut off",
    /if \(interruptedManagerCall\(run\)\) continue;/.test(runStoreSrc) &&
      /if \(run\.pendingManagerResume\) continue;/.test(runStoreSrc) &&
      /if \(unactedUserAnswer\(run\)\) continue;/.test(runStoreSrc),
  );
  const socketSrc = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
  check(
    "codara_complete shares the one freshness implementation",
    /await runStore\.describeVerificationFreshness\(run\)/.test(socketSrc),
  );

  const indexSrc = fs.readFileSync(INDEX_TS, "utf8");
  const orphanAt = indexSrc.indexOf("recoverOrphanedManagedWorkerAttempts()");
  const settleAt = indexSrc.indexOf("completeSettledManagedRunsAfterRestart()");
  const pauseAt = indexSrc.indexOf("pauseManagedRunsAfterRestart()");
  check("boot wires the settled-run sweep", settleAt > 0);
  check("the sweep runs after the orphaned-attempt recovery", orphanAt > 0 && orphanAt < settleAt);
  check("the sweep runs before the restart pause", pauseAt > settleAt);

  const settledSrc = fs.readFileSync(RUN_SETTLED_TS, "utf8");
  check("the predicate module stays dash-free", !/[\u2013\u2014]/.test(settledSrc));

  if (failures > 0) {
    console.error(`\n${failures} wedged-run check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll wedged-run recovery checks passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
