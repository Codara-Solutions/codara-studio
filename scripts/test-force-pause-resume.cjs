// Regression harness for Resume-after-force-pause (run-msojtvqk-qjklvo).
//
// Shape of the bug: Stop force-pauses a run — every worker PTY is killed and
// its attempts are committed as cancelled — and the following Resume did
// nothing. resumeRun only routed to a fresh manager chat turn for a parked
// chat turn or a file-mention message; a force-paused run fell through to
// sendResumeSignals, which writes ESC/continue into worker handles that no
// longer exist, then committed status "running". With a pi/auto manager
// runHasMcpManager() exempts the run from the driver scheduler, so nothing at
// all was scheduled: run.json ended at status "running", last spark call
// failed, no active worker, no autopilot cycle. Wedged on the Stop button.
//
// Secondary: forcePauseRun kills PTYs and then commits the attempts as
// "cancelled", but the killed session's own exit also lands in
// launchWorkerAttempt's finish path. Whichever side of the commit that write
// landed on, one of the two orderings recorded a phantom failure (the
// reference run: attempt-msok8193 failed/exit 1 "Pi worker runtime stopped."
// during the pause), so Resume and the report surfaces showed a step that
// "failed" when it had merely been interrupted.
//
// Four layers are pinned here:
//   1. the chat route — the REAL run-store.ts, driven over a fabricated
//      run.json with the manager backend stubbed at backend-registry (the one
//      seam every provider goes through), asserting a force-paused resume with
//      zero live workers dispatches a mode="chat" manager turn whose prompt
//      names the interrupted attempts (id, task title, step) so the manager
//      can relaunch them;
//   2. the driver invariant — after resumeRun returns on a paused run, the run
//      is never left "running" with no driver: no in-flight spark call, no
//      scheduled manager turn, no live worker. Asserted for a chat turn that
//      settles the run AND for one whose provider call dies;
//   3. the kill race — workerExitInterruptedByForcePause reports "interrupted"
//      for both orderings of the race (pause window still open; pause commit
//      already landed on the attempt) and only for those, plus a source pin
//      that launchWorkerAttempt's finish path routes attempt status, task
//      status and the report review through it;
//   4. attribution — the note is authored "user" only so the manager turn
//      consumes it, so it carries resumeNote:true (the boardNote house
//      pattern): the timeline renders it as a system row instead of the user's
//      own bubble, and isHeuristicUserMessage never reads it as user intent.
//
//   node scripts/test-force-pause-resume.cjs
//
// Bundles the REAL run-store.ts against electron/node-pty/provider stubs and
// drives it over run.json files under a throwaway CODARA_HOME_DIR — the same
// technique as scripts/test-run-resume-guard.cjs.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const USER_INTENT_TS = path.join(ROOT, "src", "main", "orchestration", "user-intent.ts");
// Bundles live under node_modules so the externalized runtime deps (ssh2 and
// friends) still resolve from the file that requires them.
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-force-pause-resume-test");

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

// The whole provider fleet behind one seam: run-store reaches every manager
// backend through getBackend, so a stub here means no real CLI, no network,
// and a place to observe the mode + prompt of every manager turn the store
// dispatches. disposeManagerSessions runs INSIDE forcePauseRun's kill window,
// which is exactly where the kill-race assertions need to look.
const BACKEND_REGISTRY_STUB = `const backend = (kind) => ({
  kind,
  displayName: "stub backend",
  async requestManagerDecision(input, onStream) {
    return globalThis.__coraManagerStub(input, onStream);
  },
  async disposeChat() {},
  interruptChat() {},
});
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions(runId) {
  await globalThis.__coraDisposeHook?.(runId);
}`;

// Account resolution is the only other thing a manager turn touches before the
// backend call, and a throwaway CODARA_HOME_DIR has no connected accounts.
const PI_RUNTIME_STUB = `export async function resolveCodaraPiExecutionAccount() {
  // Account resolution is the last thing a manager turn does BEFORE it owns a
  // SparkCall, so a throw here escapes askManagerBackend's whole failure policy
  // — the shape the resume path has to survive. The harness arms it per case.
  if ((globalThis.__coraAccountFailures ?? 0) > 0) {
    globalThis.__coraAccountFailures -= 1;
    throw new Error("stub: no connected Pi account for this provider");
  }
  // Shape-checked downstream: the frozen profile id must be a lowercase UUIDv4.
  return {
    accountProfileId: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10",
    provider: "anthropic",
    configDir: "/tmp/cora-stub-pi",
  };
}
export async function resolveCodaraPiRuntime() { throw new Error("pi runtime is stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/cora-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() { throw new Error("pi worker launch is stubbed"); }`;

const STUBS = {
  electron: ELECTRON_STUB,
  "node-pty": PTY_STUB,
  "./backend-registry": BACKEND_REGISTRY_STUB,
  "./pi-runtime-electron": PI_RUNTIME_STUB,
};

const stubPlugin = {
  name: "cora-force-pause-stubs",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: STUBS[args.path],
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

// A harness that stops early must never look like a pass. If main() drops a
// promise that nothing ever resolves, node drains its loop and exits 0 with no
// output at all; this turns that into a loud failure.
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-force-pause-resume-"));
const WS = "ws-force-pause-test";
const PAUSED_AT = "2026-08-11T09:00:00.000Z";
const NOW = "2026-08-11T09:00:05.000Z";

// The reported configuration: pi + auto, i.e. runHasMcpManager() true, which is
// what made the old fallback schedule nothing at all.
function forcePausedRun(id, overrides = {}) {
  return {
    id,
    title: "force pause resume",
    status: "paused",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: WS,
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: PAUSED_AT,
    updatedAt: PAUSED_AT,
    conversationEpoch: 1,
    autopilot: {
      status: "paused",
      lastAction: "force_paused",
      stopReason: "Force-paused by user",
      pausedAt: PAUSED_AT,
      updatedAt: PAUSED_AT,
    },
    steps: [
      {
        id: "step-3",
        runId: id,
        index: 3,
        title: "Wire the parser",
        status: "running",
        acceptanceCriteria: [],
        createdAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
      },
    ],
    workerTasks: [
      {
        id: "task-parser",
        runId: id,
        stepId: "step-3",
        title: "Implement the tokenizer",
        status: "cancelled",
        taskClass: "feature",
        createdBy: "spark",
        createdAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
      },
    ],
    workerAttempts: [
      {
        id: "attempt-msok8193",
        runId: id,
        workerTaskId: "task-parser",
        attemptNumber: 1,
        runtime: "claude",
        cwd: HOME,
        status: "cancelled",
        startedAt: PAUSED_AT,
        finishedAt: PAUSED_AT,
      },
    ],
    humanMessages: [
      {
        id: "msg-1",
        runId: id,
        author: "user",
        kind: "note",
        message: "build the parser",
        attachments: [],
        createdAt: PAUSED_AT,
        deliveryState: "acknowledged",
        intent: "turn",
        conversationEpoch: 1,
      },
    ],
    sparkCalls: [
      {
        id: "spark-interrupted",
        runId: id,
        mode: "chat",
        model: "stub-model",
        status: "failed",
        error: "Manager turn interrupted by force pause.",
        conversationEpoch: 1,
        createdAt: PAUSED_AT,
        completedAt: PAUSED_AT,
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

function readEvents(runId) {
  const file = path.join(HOME, "runs", runId, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until a condition holds (scheduled drivers hand off through
// setTimeout(0) and a commit or two). Returns the final verdict rather than
// throwing, so a regression surfaces as a FAIL instead of a hung harness.
async function waitFor(condition, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(25);
  }
  return Boolean(condition());
}

const RESUME_NOTE_HEADER = "[Cora resume — worker attempts interrupted by the pause]";
const isResumeNote = (message) => message.message.startsWith(RESUME_NOTE_HEADER);
const findResumeNote = (run) => run.humanMessages.find(isResumeNote);
const resumeNotes = (run) => run.humanMessages.filter(isResumeNote);

// A manager turn that blocks on a human question: it settles the run without
// spawning a worker (nothing here can spawn a real PTY) and without cascading
// into another turn.
function askUserResult() {
  return {
    decision: {
      status: "ask_user",
      summary: "stub turn",
      question: "Stub harness: which way should the parser go?",
      questionCategory: "irreducible_product_scope",
      questionReason: "The stub backend always blocks so the harness settles.",
      steps: [],
      tasks: [],
    },
    durationMs: 1,
    model: "stub-model",
  };
}

// Every manager turn any run dispatches, keyed by run: a scheduled driver from
// one scenario lands while the next one is running, so a single shared log
// would mix them up.
const managerCalls = new Map();
const managerBehavior = new Map();
const callsFor = (runId) => managerCalls.get(runId) ?? [];

globalThis.__coraManagerStub = async (input) => {
  const runId = input.run.id;
  const calls = callsFor(runId);
  calls.push({ mode: input.mode, prompt: input.prompt });
  managerCalls.set(runId, calls);
  const behavior = managerBehavior.get(runId);
  return behavior ? behavior(calls) : askUserResult();
};

// A promise the harness can open by hand, so a scenario can park a manager turn
// mid-flight and inspect the run while it is genuinely "running".
function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

// Never await a gate bare: if the regression under test is "no manager turn is
// dispatched", the gate is never opened, node's event loop drains and the
// process exits 0 having printed NOTHING — a silent pass. Every wait is bounded
// and reports its verdict so the missing turn surfaces as a FAIL.
function gateOpened(g, ms = 3000) {
  return Promise.race([g.opened.then(() => true), sleep(ms).then(() => false)]);
}

/**
 * The post-condition from the design doc: after a resume, a run that says
 * "running" must have SOMETHING driving it — an in-flight manager call, a
 * scheduled manager turn (observed here as a backend call arriving AFTER
 * resumeRun returned), or a live worker (impossible in this harness: node-pty
 * is stubbed, so the run may never be left depending on one).
 *
 * A run that settled (blocked/paused/complete/failed) satisfies it trivially,
 * which is why `runningInvariantChecks` counts the evaluations that actually
 * observed a "running" run — the harness asserts at the end that the invariant
 * was exercised on a live run and not merely on settled ones.
 */
let runningInvariantChecks = 0;
function driverInvariant(run, callsAfterResumeReturned) {
  if (run.status !== "running") return { ok: true, why: `settled as ${run.status}` };
  runningInvariantChecks += 1;
  const inFlightCall = run.sparkCalls.some((call) => call.status === "started" && !call.completedAt);
  if (inFlightCall) return { ok: true, why: "running, manager call in flight" };
  if (callsAfterResumeReturned > 0) return { ok: true, why: "running, manager turn scheduled" };
  return { ok: false, why: "running with no spark call, no scheduled manager turn, no worker" };
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });
  // The plan rewriters' view of "what the user said": the synthetic resume note
  // must be invisible to it, exactly like the board note (see user-intent.ts).
  const userIntent = await bundle(USER_INTENT_TS, "user-intent.cjs", {
    packages: "external",
  });

  // ── 1. a force-paused resume drives the run through a chat turn ──────────
  // The turn is parked mid-flight so the invariant can be observed on a run
  // that is genuinely "running" — a settled run satisfies it for free.
  const runId = writeRun(forcePausedRun("run-force-pause-chat"));
  const chatTurnEntered = gate();
  const releaseChatTurn = gate();
  managerBehavior.set(runId, async (calls) => {
    if (calls.length === 1) {
      chatTurnEntered.open();
      await releaseChatTurn.opened;
    }
    return askUserResult();
  });
  const resumePromise = runStore.resumeRun({ runId }).catch((error) => {
    check("resumeRun does not throw on a force-paused run", false, error?.message);
    return readRun(runId);
  });
  const chatTurnDispatched = await gateOpened(chatTurnEntered);
  const midFlight = chatTurnDispatched ? readRun(runId) : null;
  check(
    "the resumed run is running with its chat turn in flight",
    Boolean(midFlight) &&
      midFlight.status === "running" &&
      midFlight.sparkCalls.some(
        (call) => call.mode === "chat" && call.status === "started" && !call.completedAt,
      ),
    midFlight
      ? `${midFlight.status} / ${JSON.stringify(midFlight.sparkCalls.map((c) => `${c.mode}:${c.status}`))}`
      : "no chat turn was dispatched",
  );
  const midInvariant = midFlight
    ? driverInvariant(midFlight, 0)
    : { ok: false, why: "no chat turn was dispatched" };
  check(`the driver invariant holds on the live run (${midInvariant.why})`, midInvariant.ok);
  releaseChatTurn.open();
  const resumed = await resumePromise;
  const chatCalls = callsFor(runId);

  check(
    "a force-paused resume dispatches a manager turn",
    chatCalls.length >= 1,
    `calls=${chatCalls.length}`,
  );
  check(
    "the resume routes through the CHAT turn, not the signal fallback",
    chatCalls[0]?.mode === "chat",
    chatCalls[0]?.mode,
  );
  const persisted = readRun(runId);
  check(
    "the chat turn is recorded on the run",
    persisted.sparkCalls.some((call) => call.mode === "chat" && call.id !== "spark-interrupted"),
    JSON.stringify(persisted.sparkCalls.map((call) => `${call.id}:${call.mode}:${call.status}`)),
  );
  const resumeEvent = readEvents(runId).find(
    (event) => event.type === "run.resumed" && event.payload?.route === "chat",
  );
  check("the resume is journalled as the chat route", Boolean(resumeEvent), "no run.resumed route=chat event");
  check(
    "the resume event names the interrupted attempts",
    (resumeEvent?.payload?.interruptedAttemptIds ?? []).includes("attempt-msok8193"),
    JSON.stringify(resumeEvent?.payload?.interruptedAttemptIds),
  );

  // The manager owns retry bookkeeping, so the turn has to be TOLD what the
  // pause killed. Anything less and "Resume" resumes nothing.
  const chatPrompt = chatCalls[0]?.prompt ?? "";
  check(
    "the chat turn's prompt names the interrupted attempt id",
    chatPrompt.includes("attempt-msok8193"),
    chatPrompt.slice(0, 400),
  );
  check(
    "the chat turn's prompt names the interrupted task",
    chatPrompt.includes("Implement the tokenizer") && chatPrompt.includes("task-parser"),
  );
  check("the chat turn's prompt names the step", chatPrompt.includes('Step 3 "Wire the parser"'));
  check(
    "the chat turn's prompt asks for the interrupted work to be re-issued",
    /re-issue the work/i.test(chatPrompt),
  );

  // The context rides the house pattern for synthetic manager input: one
  // queued user note, claimed by the turn that consumed it. Every assertion
  // below is guarded on the note EXISTING: without the guard a regression that
  // stops minting it crashes the harness here and the sections after this one
  // (the kill race, the source pins) never run at all.
  const resumeNote = findResumeNote(persisted);
  check("the resume note is persisted as manager input", Boolean(resumeNote), "no resume note found");
  check(
    "the resume note was claimed by the chat turn",
    Boolean(resumeNote?.backendTurnId) &&
      persisted.sparkCalls.some(
        (call) => call.id === resumeNote.backendTurnId && call.mode === "chat",
      ),
    resumeNote?.backendTurnId,
  );
  check(
    "the resume note is no longer queued once delivered",
    Boolean(resumeNote) && resumeNote.deliveryState !== "queued",
    resumeNote ? resumeNote.deliveryState : "no resume note found",
  );

  // It is authored "user" for delivery only. Everything that reads the
  // conversation as the user's own words must be able to tell it apart, the
  // same way it tells a board note apart.
  check(
    "the resume note is flagged resumeNote so no surface reads it as the user",
    resumeNote?.resumeNote === true,
    JSON.stringify({ author: resumeNote?.author, resumeNote: resumeNote?.resumeNote }),
  );
  check(
    "resume notes are not heuristic user messages",
    Boolean(resumeNote) && userIntent.isHeuristicUserMessage(resumeNote) === false,
    resumeNote ? undefined : "no resume note found",
  );
  check(
    "latestUserRunMessageText skips the resume note",
    userIntent.latestUserRunMessageText(persisted) === "build the parser",
    userIntent.latestUserRunMessageText(persisted),
  );
  check(
    "a real user note is still heuristic user text",
    userIntent.isHeuristicUserMessage(
      persisted.humanMessages.find((message) => message.id === "msg-1"),
    ) === true,
  );

  check(
    "the settled run reports the state its chat turn reached",
    resumed.status === "blocked" && persisted.status === "blocked",
    `${resumed.status}/${persisted.status}`,
  );
  const chatCallsAtReturn = chatCalls.length;
  await sleep(200);
  const invariant = driverInvariant(readRun(runId), callsFor(runId).length - chatCallsAtReturn);
  check(`post-resume driver invariant holds (${invariant.why})`, invariant.ok);

  // ── 2. the invariant survives a chat turn whose provider call dies ───────
  // This is the exact wedge from the reference run: status "running", last
  // spark call failed, no worker, nothing scheduled. The resume must still
  // leave a driver behind.
  const deadId = "run-force-pause-dead-turn";
  const deadDriverEntered = gate();
  const releaseDeadDriver = gate();
  managerBehavior.set(deadId, async (calls) => {
    if (calls.length === 1) throw new Error("stub provider died mid-turn");
    // Park the scheduled driver so the invariant is observed while the run is
    // still "running" and that turn is genuinely in flight.
    if (calls.length === 2) {
      deadDriverEntered.open();
      await releaseDeadDriver.opened;
    }
    return askUserResult();
  });
  writeRun(forcePausedRun(deadId));
  const afterDead = await runStore.resumeRun({ runId: deadId });
  const deadTurnCalls = callsFor(deadId);
  check(
    "a dead chat turn still took the chat route first",
    deadTurnCalls[0]?.mode === "chat",
    deadTurnCalls[0]?.mode,
  );
  check(
    "a resume whose chat turn died leaves the run running (the old wedge state)",
    afterDead.status === "running",
    afterDead.status,
  );
  const deadCallsAtReturn = deadTurnCalls.length;
  // The scheduler hands off through setTimeout(0); give it a moment to land.
  const deadDriverArrived = await waitFor(() => callsFor(deadId).length > deadCallsAtReturn);
  check(
    "a resume whose chat turn died still schedules a driver",
    deadDriverArrived,
    `calls=${callsFor(deadId).length}, status=${afterDead.status}`,
  );
  const deadMidFlight = readRun(deadId);
  const deadInvariant = driverInvariant(
    deadMidFlight,
    callsFor(deadId).length - deadCallsAtReturn,
  );
  check(`post-resume driver invariant holds after a dead turn (${deadInvariant.why})`, deadInvariant.ok);
  releaseDeadDriver.open();
  await waitFor(() => readRun(deadId).status !== "running");

  // ── 3. a paused run with no interrupted attempt still resumes cleanly ────
  const bareId = writeRun(
    forcePausedRun("run-force-pause-bare", {
      steps: [],
      workerTasks: [],
      workerAttempts: [],
      autopilot: {
        status: "paused",
        lastAction: "paused_by_user",
        stopReason: "Paused by user",
        pausedAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
      },
    }),
  );
  await runStore.resumeRun({ runId: bareId });
  const bareCalls = callsFor(bareId);
  check("a paused run with no workers routes to chat too", bareCalls[0]?.mode === "chat", bareCalls[0]?.mode);
  const barePersisted = readRun(bareId);
  check("no interrupted attempts means no resume note", resumeNotes(barePersisted).length === 0);
  const bareCallsAtReturn = bareCalls.length;
  await sleep(200);
  const bareInvariant = driverInvariant(
    readRun(bareId),
    callsFor(bareId).length - bareCallsAtReturn,
  );
  check(`post-resume driver invariant holds with no prior work (${bareInvariant.why})`, bareInvariant.ok);

  // Sending a message is also Resume, but the genuine queued turn is already
  // all the manager input it needs. A generic synthetic resume note would
  // duplicate that request in the same prompt.
  const messageResumeId = writeRun(
    forcePausedRun("run-message-resume", {
      steps: [],
      workerTasks: [],
      workerAttempts: [],
      humanMessages: [
        {
          id: "msg-message-resume",
          runId: "run-message-resume",
          author: "user",
          kind: "note",
          message: "continue with the browser",
          attachments: [],
          intent: "turn",
          deliveryState: "queued",
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
    }),
  );
  await runStore.resumeRun({
    runId: messageResumeId,
    triggerMessageId: "msg-message-resume",
  });
  const messageResumePersisted = readRun(messageResumeId);
  const messageResumePrompt = callsFor(messageResumeId)[0]?.prompt ?? "";
  check(
    "message-triggered Resume does not add a synthetic duplicate turn",
    resumeNotes(messageResumePersisted).length === 0,
    JSON.stringify(resumeNotes(messageResumePersisted)),
  );
  check(
    "message-triggered Resume delivers the genuine user request once",
    (messageResumePrompt.match(/continue with the browser/g) ?? []).length === 1 &&
      !messageResumePrompt.includes("The user resumed this run"),
    messageResumePrompt.slice(0, 500),
  );

  // ── 3b. a run paused with its manager turn still in flight keeps that turn ──
  // The soft pauseRun path never kills the turn, so the run already has a
  // driver; a second concurrent chat turn would race the first one's decision.
  const liveTurnId = writeRun(
    forcePausedRun("run-paused-live-turn", {
      workerTasks: [],
      workerAttempts: [],
      autopilot: {
        status: "paused",
        lastAction: "paused_by_user",
        stopReason: "Paused by user",
        pausedAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
      },
      sparkCalls: [
        {
          id: "spark-live",
          runId: "run-paused-live-turn",
          mode: "chat",
          model: "stub-model",
          status: "started",
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
    }),
  );
  const afterLiveTurn = await runStore.resumeRun({ runId: liveTurnId });
  await sleep(200);
  check(
    "a resume never opens a second turn against a live manager call",
    callsFor(liveTurnId).length === 0,
    `calls=${callsFor(liveTurnId).length}`,
  );
  const liveInvariant = driverInvariant(readRun(liveTurnId), callsFor(liveTurnId).length);
  check(
    `post-resume driver invariant holds with a live turn (${liveInvariant.why})`,
    liveInvariant.ok,
    afterLiveTurn.status,
  );

  // ── 3c. a turn that throws BEFORE it owns a SparkCall still leaves a driver ──
  // askManagerBackend's park/retry/fail policy only covers failures inside a
  // turn: an unresolvable account (or the untrusted-PR refusal) throws straight
  // out of it. Unguarded, that escapes resumeRun with "running" already
  // committed — no driver, and no Resume button left to try again.
  const throwId = "run-resume-turn-throws";
  const throwDriverEntered = gate();
  const releaseThrowDriver = gate();
  managerBehavior.set(throwId, async (calls) => {
    if (calls.length === 1) {
      throwDriverEntered.open();
      await releaseThrowDriver.opened;
    }
    return askUserResult();
  });
  writeRun(forcePausedRun(throwId));
  globalThis.__coraAccountFailures = 1; // exactly the resume's own chat turn
  let throwEscaped = null;
  let afterThrow = null;
  try {
    afterThrow = await runStore.resumeRun({ runId: throwId });
  } catch (error) {
    throwEscaped = error;
  }
  globalThis.__coraAccountFailures = 0;
  check(
    "a manager turn that throws before its SparkCall does not escape resumeRun",
    throwEscaped === null,
    throwEscaped?.message,
  );
  check(
    "the failed resume turn is journalled",
    readEvents(throwId).some((event) => event.type === "run.resume_chat_turn_failed"),
    JSON.stringify(readEvents(throwId).map((event) => event.type)),
  );
  const throwDriverArrived = await waitFor(() => callsFor(throwId).length > 0);
  check(
    "a resume whose turn threw still schedules a driver",
    throwDriverArrived,
    `calls=${callsFor(throwId).length}, status=${afterThrow?.status}`,
  );
  const throwMidFlight = readRun(throwId);
  const throwInvariant = driverInvariant(throwMidFlight, callsFor(throwId).length);
  check(
    `post-resume driver invariant holds after a thrown turn (${throwInvariant.why})`,
    throwInvariant.ok,
  );
  // The note the throwing turn never claimed is still queued, so the scheduled
  // driver picks it up instead of the interrupted work being forgotten.
  check(
    "the interrupted-attempt context survives to the scheduled driver",
    (callsFor(throwId)[0]?.prompt ?? "").includes("attempt-msok8193"),
    (callsFor(throwId)[0]?.prompt ?? "").slice(0, 200),
  );
  releaseThrowDriver.open();
  await waitFor(() => readRun(throwId).status !== "running");

  // ── 3d. Stop → Resume → Stop must not put the note in the user's composer ──
  const undoId = writeRun(forcePausedRun("run-resume-then-stop"));
  await runStore.resumeRun({ runId: undoId });
  const undoPersisted = readRun(undoId);
  check(
    "the resume note is on the run before the second Stop",
    Boolean(findResumeNote(undoPersisted)),
    "no resume note found",
  );
  const undone = await runStore.stopAndUndoPending(undoId);
  check(
    "Stop after a resume never restores the synthetic note into the composer",
    !(undone.restoredText ?? "").includes(RESUME_NOTE_HEADER),
    JSON.stringify(undone.restoredText),
  );
  // Rewinding PAST the note is correct — it is undelivered manager input like
  // any other pending turn — so the note leaves the transcript with it; only
  // the composer restore had to learn to skip it.
  check("Stop after a resume rewinds past the synthetic note", resumeNotes(readRun(undoId)).length === 0);
  check(
    "Stop after a resume lands the undo",
    readRun(undoId).autopilot?.lastAction === "undo",
    JSON.stringify(readRun(undoId).autopilot),
  );

  // ── 3e. automation runs keep the signal path (nudgeBoardManager's rule) ────
  const automationId = writeRun(
    forcePausedRun("run-automation-paused", {
      automationId: "automation-1",
      autopilot: {
        status: "paused",
        lastAction: "paused_by_user",
        stopReason: "Paused by user",
        pausedAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
      },
    }),
  );
  await runStore.resumeRun({ runId: automationId });
  await sleep(200);
  // The automation loop owns an automation's drive, and it has no
  // conversational manager to hand a synthetic note to — so no chat turn and no
  // note, exactly like nudgeBoardManager refuses to nudge one.
  check(
    "an automation run never takes the chat route",
    callsFor(automationId).length === 0,
    `calls=${callsFor(automationId).length}`,
  );
  check(
    "an automation run gets no synthetic resume note",
    resumeNotes(readRun(automationId)).length === 0,
  );

  // ── 3f. a resume note stranded by a second Stop is superseded, not stacked ──
  // forcePauseRun re-homes input a live call OWNED; a note that was queued and
  // never claimed keeps its old epoch, where queuedManagerInputMessages can
  // never see it again.
  const strandedId = writeRun(
    forcePausedRun("run-stranded-resume-note", {
      conversationEpoch: 2,
      humanMessages: [
        {
          id: "msg-1",
          runId: "run-stranded-resume-note",
          author: "user",
          kind: "note",
          message: "build the parser",
          attachments: [],
          createdAt: PAUSED_AT,
          deliveryState: "acknowledged",
          intent: "turn",
          conversationEpoch: 1,
        },
        {
          id: "msg-stranded-note",
          runId: "run-stranded-resume-note",
          author: "user",
          kind: "note",
          resumeNote: true,
          message: `${RESUME_NOTE_HEADER}\nstale list from the previous resume`,
          intent: "turn",
          deliveryState: "queued",
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
      sparkCalls: [
        {
          id: "spark-interrupted",
          runId: "run-stranded-resume-note",
          mode: "chat",
          model: "stub-model",
          status: "failed",
          error: "Manager turn interrupted by force pause.",
          conversationEpoch: 2,
          createdAt: PAUSED_AT,
          completedAt: PAUSED_AT,
        },
      ],
    }),
  );
  await runStore.resumeRun({ runId: strandedId });
  const strandedPersisted = readRun(strandedId);
  const strandedNotes = resumeNotes(strandedPersisted);
  check(
    "the stranded note is superseded rather than left queued forever",
    strandedNotes.find((note) => note.id === "msg-stranded-note")?.deliveryState === "cancelled",
    strandedNotes.find((note) => note.id === "msg-stranded-note")?.deliveryState,
  );
  const freshNote = strandedNotes.find((note) => note.id !== "msg-stranded-note");
  check(
    "a fresh, deliverable note is written in the current epoch",
    Boolean(freshNote) && (freshNote.conversationEpoch ?? 0) === 2,
    JSON.stringify({ found: Boolean(freshNote), epoch: freshNote?.conversationEpoch }),
  );
  check(
    "the fresh note carries the CURRENT interrupted attempt, not the stale text",
    Boolean(freshNote?.message.includes("attempt-msok8193")),
  );
  check("exactly one resume note is ever live", strandedNotes.length === 2, `notes=${strandedNotes.length}`);

  // ...but a note still queued in the CURRENT epoch is live input: a second
  // resume must not stack another one on top of it.
  const liveNoteId = writeRun(
    forcePausedRun("run-live-resume-note", {
      humanMessages: [
        {
          id: "msg-live-note",
          runId: "run-live-resume-note",
          author: "user",
          kind: "note",
          resumeNote: true,
          message: `${RESUME_NOTE_HEADER}\nalready queued for the next turn`,
          intent: "turn",
          deliveryState: "queued",
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
    }),
  );
  await runStore.resumeRun({ runId: liveNoteId });
  check(
    "a resume note still queued in this conversation is not duplicated",
    resumeNotes(readRun(liveNoteId)).length === 1,
    `notes=${resumeNotes(readRun(liveNoteId)).length}`,
  );

  // ── 4. the kill race: a worker that dies inside a force pause is cancelled ──
  const raceId = writeRun(
    forcePausedRun("run-force-pause-race", {
      status: "running",
      autopilot: { status: "running", lastAction: "resumed_by_user", updatedAt: NOW },
      workerTasks: [
        {
          id: "task-parser",
          runId: "run-force-pause-race",
          stepId: "step-3",
          title: "Implement the tokenizer",
          status: "running",
          taskClass: "feature",
          createdBy: "spark",
          createdAt: PAUSED_AT,
          updatedAt: PAUSED_AT,
        },
      ],
      workerAttempts: [
        {
          id: "attempt-msok8193",
          runId: "run-force-pause-race",
          workerTaskId: "task-parser",
          attemptNumber: 1,
          runtime: "claude",
          cwd: HOME,
          status: "running",
          startedAt: PAUSED_AT,
        },
      ],
      sparkCalls: [],
    }),
  );

  const insidePauseWindow = [];
  globalThis.__coraDisposeHook = (disposingRunId) => {
    // disposeManagerSessions is forcePauseRun's FIRST teardown step, so this
    // fires before any PTY is killed — the earliest an exit can race the pause.
    insidePauseWindow.push({
      runId: disposingRunId,
      liveWorkerExit: runStore.workerExitInterruptedByForcePause({
        runId: disposingRunId,
        exitCode: 1,
        attemptStatus: "running",
      }),
      cleanExit: runStore.workerExitInterruptedByForcePause({
        runId: disposingRunId,
        exitCode: 0,
        attemptStatus: "running",
      }),
      otherRun: runStore.workerExitInterruptedByForcePause({
        runId: "run-some-other-run",
        exitCode: 1,
        attemptStatus: "running",
      }),
    });
  };
  const paused = await runStore.forcePauseRun(raceId);
  globalThis.__coraDisposeHook = undefined;

  check("force pause commits the run as paused", paused.status === "paused", paused.status);
  check("the force pause opened its window", insidePauseWindow.length === 1);
  check(
    "an attempt that dies inside the pause window records as interrupted",
    insidePauseWindow[0]?.liveWorkerExit === true,
  );
  check(
    "a clean exit inside the pause window is never rewritten",
    insidePauseWindow[0]?.cleanExit === false,
  );
  check(
    "the pause window is scoped to its own run",
    insidePauseWindow[0]?.otherRun === false,
  );
  check(
    "the window closes once the pause is committed",
    runStore.workerExitInterruptedByForcePause({
      runId: raceId,
      exitCode: 1,
      attemptStatus: "running",
    }) === false,
  );
  // The other ordering of the same race: the pause commit already cancelled the
  // attempt and the killed session's exit lands afterwards. It must not
  // overwrite "cancelled" with "failed".
  check(
    "an exit landing after the pause commit keeps the cancelled verdict",
    runStore.workerExitInterruptedByForcePause({
      runId: raceId,
      exitCode: 1,
      attemptStatus: "cancelled",
    }) === true,
  );
  // ...and a genuine failure outside any pause is still a failure.
  check(
    "a failure outside a pause window still records failed",
    runStore.workerExitInterruptedByForcePause({
      runId: raceId,
      exitCode: 1,
      attemptStatus: "finishing",
    }) === false,
  );

  // Two overlapping Stops on one run (double click, Stop + stopAndUndoPending):
  // the first to finish must not close the window under the second.
  const overlapId = writeRun(
    forcePausedRun("run-force-pause-overlap", {
      status: "running",
      autopilot: { status: "running", lastAction: "resumed_by_user", updatedAt: NOW },
      sparkCalls: [],
    }),
  );
  let overlapEntries = 0;
  const overlapWindowSeen = [];
  globalThis.__coraDisposeHook = async (disposingRunId) => {
    overlapEntries += 1;
    if (overlapEntries === 1) await sleep(60);
    overlapWindowSeen.push(
      runStore.workerExitInterruptedByForcePause({
        runId: disposingRunId,
        exitCode: 1,
        attemptStatus: "running",
      }),
    );
  };
  await Promise.all([runStore.forcePauseRun(overlapId), runStore.forcePauseRun(overlapId)]);
  globalThis.__coraDisposeHook = undefined;
  check(
    "overlapping force pauses each see an open window",
    overlapWindowSeen.length === 2 && overlapWindowSeen.every(Boolean),
    JSON.stringify(overlapWindowSeen),
  );
  check(
    "overlapping force pauses close the window exactly once",
    runStore.workerExitInterruptedByForcePause({
      runId: overlapId,
      exitCode: 1,
      attemptStatus: "running",
    }) === false,
  );

  // ── 5. source seams ─────────────────────────────────────────────────────
  const storeSource = fs.readFileSync(RUN_STORE_TS, "utf8");
  const launchStart = storeSource.indexOf("export async function launchWorkerAttempt(");
  const launchBody = storeSource.slice(
    launchStart,
    storeSource.indexOf("\nexport async function deleteRun(", launchStart),
  );
  check("launchWorkerAttempt exists", launchStart !== -1 && launchBody.length > 0);
  check(
    "the finish path asks whether the exit belonged to a force pause",
    /const pauseInterrupted = workerExitInterruptedByForcePause\(\{/.test(launchBody),
  );
  check(
    "an interrupted attempt records cancelled, not failed",
    /finishedAttempt\.status =\s*\n?\s*result\.exitCode === 0 \? "succeeded" : pauseInterrupted \? "cancelled" : "failed";/.test(
      launchBody,
    ),
  );
  check(
    "an interrupted attempt's task records cancelled, not failed",
    /finishedTask\.status =\s*\n?\s*result\.exitCode === 0 \? "needs_review" : pauseInterrupted \? "cancelled" : "failed";/.test(
      launchBody,
    ),
  );
  check(
    "an interrupted attempt never fails its step",
    /finishedStep &&\s*\n\s*!pauseInterrupted &&/.test(launchBody),
  );
  check(
    "an interrupted attempt is not carried into the report review",
    /if \(pauseInterrupted\) return run;/.test(launchBody),
  );
  const forcePauseStart = storeSource.indexOf("export async function forcePauseRun(");
  const forcePauseBody = storeSource.slice(
    forcePauseStart,
    storeSource.indexOf("\nasync function forcePauseRunInner(", forcePauseStart),
  );
  check(
    "forcePauseRun opens the window before any teardown and always closes it",
    /openForcePauseWindow\(run\.id\);\n\s*try \{/.test(forcePauseBody) &&
      /\} finally \{\n\s*closeForcePauseWindow\(run\.id\);/.test(forcePauseBody),
  );

  // A settled run satisfies the driver invariant for free, so the invariant is
  // only worth anything if some of its evaluations saw a LIVE run. Pin that the
  // harness exercised it that way (chat turn in flight, scheduled driver in
  // flight, thrown turn's driver in flight).
  check(
    "the driver invariant was exercised on running runs, not only settled ones",
    runningInvariantChecks >= 3,
    `running evaluations=${runningInvariantChecks}`,
  );

  completed = true;
  console.log(failures === 0 ? "\nAll force-pause resume checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
