// Regression harness for mid-turn steering delivery (round-2 R3).
//
// Cora parks inside orchestrator.wait_for_workers for up to ~20 minutes, and a
// user message typed during that window used to queue until the NEXT manager
// turn start (prepareManagerTurn). run-store now owns a parked-wait registry
// (enterManagerWaitPark / sleepForParkedManagerWait /
// claimQueuedInputForParkedManagerWait / exitManagerWaitPark) that the
// agent-socket wait handler drives, so a parked wait wakes when a user message
// lands and returns it inside the wait response, claimed onto the ACTIVE
// manager call.
//
// Pinned here, against the REAL run-store.ts (manager backend stubbed at
// backend-registry, the one seam every provider goes through - the same
// esbuild/stub technique as scripts/test-force-pause-resume.cjs):
//
//   1. lifecycle - entering the park stamps parkedInWaitForWorkers on the
//      active SparkCall, the sleep primitive wakes EARLY when a user message
//      arrives, the claim delivers the text with the turn-start section shape,
//      marks the message "submitted" onto the active call, and a second claim
//      re-delivers nothing; exit clears the flag; turn settlement acknowledges
//      the mid-turn message together with the turn-start input.
//   2. no double render - the NEXT manager turn's prompt never re-renders a
//      message that was delivered mid-turn (claimed input is invisible to
//      queuedManagerInputMessages and canonical replay is consumed).
//   3. no follow-up race - a steering message sent while a wait is parked does
//      NOT arm a second concurrent manager turn (the mid-turn claim owns it).
//   4. generating-turn control - a message sent while the manager is actively
//      generating (no parked wait) stays queued for the live call, is never
//      claimed onto it, and the existing steering-followup scheduler still
//      delivers it in a later turn.
//   5. force-pause mid-wait - a message already delivered mid-turn
//      ("submitted") is re-queued into the bumped epoch by forcePauseRun, the
//      stale claim no-ops, and exit clears the flag off the failed call.
//   6. the crash window choice - a mid-turn-delivered message whose turn dies
//      before settling is RE-QUEUED (releaseUnsubmittedManagerInput), never
//      stranded as acknowledged-but-unseen. This is why the claim marks
//      "submitted" and not "acknowledged".
//   7. source seams - the agent-socket wait handler actually drives the
//      registry (enter before the loop, claim before success responses, early
//      return reason "user_message", exit in finally), addRunMessage's
//      follow-up arming is guarded by runHasParkedManagerWait, and the
//      composer flips its labels on the SparkCall flag.
//
//   node scripts/test-mid-turn-steering.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const AGENT_SOCKET_TS = path.join(ROOT, "src", "main", "agent-socket.ts");
const CHAT_COMPOSER_TSX = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "chat",
  "ChatComposer.tsx",
);
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-mid-turn-steering-test");

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

const PI_RUNTIME_STUB = `export async function resolveCodaraPiExecutionAccount() {
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
  name: "cora-mid-turn-steering-stubs",
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

// A harness that stops early must never look like a pass (see
// test-force-pause-resume.cjs for the pattern's rationale).
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-mid-turn-steering-"));
const WS = "ws-mid-turn-steering-test";
const PAUSED_AT = "2026-08-11T09:00:00.000Z";

function pausedRun(id, overrides = {}) {
  return {
    id,
    title: "mid-turn steering",
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
    steps: [],
    workerTasks: [],
    workerAttempts: [],
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

async function waitFor(condition, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(25);
  }
  return Boolean(condition());
}

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

const managerCalls = new Map();
const managerBehavior = new Map();
const callsFor = (runId) => managerCalls.get(runId) ?? [];

globalThis.__coraManagerStub = async (input) => {
  const runId = input.run.id;
  const calls = callsFor(runId);
  calls.push({ mode: input.mode, prompt: input.prompt });
  managerCalls.set(runId, calls);
  const behavior = managerBehavior.get(runId);
  return behavior ? behavior(calls, input) : askUserResult();
};

function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

function gateOpened(g, ms = 4000) {
  return Promise.race([g.opened.then(() => true), sleep(ms).then(() => false)]);
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  // ── 1. lifecycle: park → wake → claim → deliver → settle ─────────────────
  const STEER_A = "Focus on the tokenizer edge cases before anything else";
  const runA = writeRun(pausedRun("run-mid-turn-lifecycle"));
  const scenarioA = {};
  managerBehavior.set(runA, async (calls) => {
    if (calls.length === 1) {
      try {
        // The turn is live: this run's active manager call is the one this
        // stub is executing. Enter the park exactly as the wait handler does.
        const token = await runStore.enterManagerWaitPark(runA);
        scenarioA.token = token;
        scenarioA.flaggedWhileParked = Boolean(
          readRun(runA).sparkCalls.find((call) => call.id === token?.callId)
            ?.parkedInWaitForWorkers,
        );
        // Early wake: start a long sleep FIRST, then let the user message
        // land. The sleep must resolve on the wake, not the timer.
        const sleepStarted = Date.now();
        const parkedSleep = runStore.sleepForParkedManagerWait(token, 8000);
        await runStore.addRunMessage({
          runId: runA,
          author: "user",
          kind: "note",
          message: STEER_A,
        });
        scenarioA.messageAfterSend = readRun(runA).humanMessages.find(
          (message) => message.message === STEER_A,
        );
        await parkedSleep;
        scenarioA.sleepElapsedMs = Date.now() - sleepStarted;
        scenarioA.firstClaim = await runStore.claimQueuedInputForParkedManagerWait(token);
        scenarioA.stateAfterClaim = readRun(runA);
        scenarioA.secondClaim = await runStore.claimQueuedInputForParkedManagerWait(token);
        await runStore.exitManagerWaitPark(token);
        scenarioA.stateAfterExit = readRun(runA);
      } catch (error) {
        scenarioA.error = error;
      }
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runA });
  check("the parked-wait lifecycle ran without throwing", !scenarioA.error, scenarioA.error?.message);
  check("enterManagerWaitPark returns a token for the live manager call", Boolean(scenarioA.token));
  check(
    "the active SparkCall is flagged parkedInWaitForWorkers while parked",
    scenarioA.flaggedWhileParked === true,
  );
  check(
    "a message sent while parked skips deliveryState submitted at send time",
    scenarioA.messageAfterSend?.deliveryState === "queued" &&
      !scenarioA.messageAfterSend?.backendTurnId,
    JSON.stringify({
      deliveryState: scenarioA.messageAfterSend?.deliveryState,
      backendTurnId: scenarioA.messageAfterSend?.backendTurnId,
    }),
  );
  check(
    "the parked sleep wakes early when the user message lands",
    typeof scenarioA.sleepElapsedMs === "number" && scenarioA.sleepElapsedMs < 4000,
    `elapsed=${scenarioA.sleepElapsedMs}ms (timer was 8000ms)`,
  );
  check(
    "the claim delivers the user's text",
    Boolean(scenarioA.firstClaim?.text?.includes(STEER_A)),
    scenarioA.firstClaim?.text?.slice(0, 200),
  );
  const claimedMessage = scenarioA.stateAfterClaim?.humanMessages.find(
    (message) => message.message === STEER_A,
  );
  check(
    "the claimed message is submitted onto the ACTIVE call",
    claimedMessage?.deliveryState === "submitted" &&
      claimedMessage?.backendTurnId === scenarioA.token?.callId,
    JSON.stringify({
      deliveryState: claimedMessage?.deliveryState,
      backendTurnId: claimedMessage?.backendTurnId,
      callId: scenarioA.token?.callId,
    }),
  );
  check(
    "the claim appends the message onto the call's frozen input list",
    Boolean(
      scenarioA.stateAfterClaim?.sparkCalls
        .find((call) => call.id === scenarioA.token?.callId)
        ?.inputMessageIds?.includes(claimedMessage?.id),
    ),
  );
  check(
    "a second claim re-delivers nothing",
    scenarioA.secondClaim === null,
    JSON.stringify(scenarioA.secondClaim),
  );
  check(
    "exitManagerWaitPark clears the SparkCall flag",
    scenarioA.stateAfterExit?.sparkCalls.every(
      (call) => call.parkedInWaitForWorkers === undefined,
    ),
  );
  const settledA = readRun(runA);
  const settledMessageA = settledA.humanMessages.find((message) => message.message === STEER_A);
  check(
    "turn settlement acknowledges the mid-turn message with the turn-start input",
    settledMessageA?.deliveryState === "acknowledged",
    settledMessageA?.deliveryState,
  );
  const eventTypesA = readEvents(runA).map((event) => event.type);
  check(
    "the park, delivery, and unpark are journalled",
    eventTypesA.includes("run.manager_wait_parked") &&
      eventTypesA.includes("run.manager_input_delivered_mid_turn") &&
      eventTypesA.includes("run.manager_wait_unparked"),
    JSON.stringify(eventTypesA.filter((type) => type.includes("wait") || type.includes("mid_turn"))),
  );

  // ── 3. no follow-up race while parked ────────────────────────────────────
  await sleep(400);
  check(
    "a steering message consumed mid-turn never arms a second manager turn",
    callsFor(runA).length === 1,
    `calls=${callsFor(runA).length}`,
  );

  // ── 2. the NEXT turn never re-renders the delivered message ──────────────
  const questionA = readRun(runA).humanMessages.find(
    (message) => message.author === "spark" && message.kind === "question",
  );
  check("the stub turn parked the run on its question", Boolean(questionA));
  if (questionA) {
    await runStore.answerRunQuestion({
      runId: runA,
      questionMessageId: questionA.id,
      message: "Continue however you see fit.",
    });
    const answerTurnArrived = await waitFor(() => callsFor(runA).length >= 2);
    check("the answer dispatches the next manager turn", answerTurnArrived, `calls=${callsFor(runA).length}`);
    const nextPrompt = callsFor(runA)[1]?.prompt ?? "";
    check(
      "the next turn's prompt does NOT re-render the mid-turn message",
      answerTurnArrived && !nextPrompt.includes(STEER_A),
      nextPrompt.slice(0, 300),
    );
  }

  // ── 4. a message while the manager is actively GENERATING stays queued ───
  const STEER_B = "Also add a lexer benchmark while you are at it";
  const runB = writeRun(pausedRun("run-mid-turn-generating"));
  const turnBEntered = gate();
  const releaseTurnB = gate();
  managerBehavior.set(runB, async (calls) => {
    if (calls.length === 1) {
      turnBEntered.open();
      await releaseTurnB.opened;
    }
    return askUserResult();
  });
  const resumeB = runStore.resumeRun({ runId: runB });
  check("the generating turn dispatched", await gateOpened(turnBEntered));
  const liveB = readRun(runB);
  const liveCallB = liveB.sparkCalls.find(
    (call) => call.status === "started" && !call.completedAt,
  );
  check("the generating turn is live and NOT flagged parked", Boolean(liveCallB) && !liveCallB.parkedInWaitForWorkers);
  await runStore.addRunMessage({
    runId: runB,
    author: "user",
    kind: "note",
    message: STEER_B,
  });
  const sentB = readRun(runB).humanMessages.find((message) => message.message === STEER_B);
  check(
    "the message is recorded as steering for a run with a live turn",
    sentB?.intent === "steer",
    sentB?.intent,
  );
  check(
    "with no parked wait, the message is never claimed onto the LIVE call",
    sentB?.backendTurnId !== liveCallB?.id,
    JSON.stringify({ backendTurnId: sentB?.backendTurnId, liveCall: liveCallB?.id }),
  );
  // The steering-followup scheduler still owns it: a later manager turn must
  // consume the text (this is the negative control proving mid-turn delivery
  // did not replace the existing queue-then-follow-up path).
  const followupArrived = await waitFor(() =>
    callsFor(runB).some((call) => call.prompt.includes(STEER_B)),
  );
  releaseTurnB.open();
  await resumeB.catch(() => undefined);
  check(
    "the steering follow-up path still delivers the queued message",
    followupArrived,
    JSON.stringify(callsFor(runB).map((call) => call.prompt.slice(0, 60))),
  );
  const settledMessageB = await waitFor(() => {
    const message = readRun(runB).humanMessages.find((entry) => entry.message === STEER_B);
    return Boolean(message?.backendTurnId) && message.backendTurnId !== liveCallB?.id;
  });
  check("the follow-up turn claimed the queued message for itself", settledMessageB);

  // ── 5. force-pause mid-wait re-queues a delivered message (epoch bump) ───
  const STEER_C = "Stop the refactor and ship the fix alone";
  const runC = writeRun(pausedRun("run-mid-turn-force-pause"));
  const scenarioC = {};
  const claimedC = gate();
  const releaseC = gate();
  managerBehavior.set(runC, async (calls) => {
    if (calls.length === 1) {
      try {
        const token = await runStore.enterManagerWaitPark(runC);
        scenarioC.token = token;
        await runStore.addRunMessage({
          runId: runC,
          author: "user",
          kind: "note",
          message: STEER_C,
        });
        scenarioC.claim = await runStore.claimQueuedInputForParkedManagerWait(token);
        claimedC.open();
        await releaseC.opened;
        // The harness force-paused the run while we were parked. The claim
        // token is now stale and must no-op; the exit must still clear the
        // flag off the failed call.
        scenarioC.staleClaim = await runStore.claimQueuedInputForParkedManagerWait(token);
        await runStore.exitManagerWaitPark(token);
      } catch (error) {
        scenarioC.error = error;
      }
    }
    return askUserResult();
  });
  const resumeC = runStore.resumeRun({ runId: runC });
  check("the force-pause scenario reached its claim", await gateOpened(claimedC));
  check(
    "the message was delivered mid-turn before the pause",
    Boolean(scenarioC.claim?.text?.includes(STEER_C)),
  );
  await runStore.forcePauseRun(runC);
  const pausedC = readRun(runC);
  const messageC = pausedC.humanMessages.find((message) => message.message === STEER_C);
  check(
    "force-pause re-queues the mid-turn-delivered message into the bumped epoch",
    messageC?.deliveryState === "queued" &&
      !messageC?.backendTurnId &&
      (messageC?.conversationEpoch ?? 0) === (pausedC.conversationEpoch ?? 0),
    JSON.stringify({
      deliveryState: messageC?.deliveryState,
      backendTurnId: messageC?.backendTurnId,
      messageEpoch: messageC?.conversationEpoch,
      runEpoch: pausedC.conversationEpoch,
    }),
  );
  releaseC.open();
  await resumeC.catch(() => undefined);
  check("the stale claim after the epoch bump re-delivers nothing", scenarioC.staleClaim === null);
  check("the force-pause scenario ran without throwing", !scenarioC.error, scenarioC.error?.message);
  const afterExitC = readRun(runC);
  check(
    "exit clears the parked flag off the failed call after a force pause",
    afterExitC.sparkCalls.every((call) => call.parkedInWaitForWorkers === undefined),
    JSON.stringify(afterExitC.sparkCalls.map((call) => `${call.id}:${call.status}:${call.parkedInWaitForWorkers}`)),
  );

  // ── 6. crash window: a delivered message whose turn dies is RE-QUEUED ────
  const STEER_D = "Actually target the legacy branch instead";
  const runD = writeRun(pausedRun("run-mid-turn-crash-window"));
  const scenarioD = {};
  managerBehavior.set(runD, async (calls) => {
    if (calls.length === 1) {
      const token = await runStore.enterManagerWaitPark(runD);
      await runStore.addRunMessage({
        runId: runD,
        author: "user",
        kind: "note",
        message: STEER_D,
      });
      scenarioD.claim = await runStore.claimQueuedInputForParkedManagerWait(token);
      await runStore.exitManagerWaitPark(token);
      throw new Error("stub provider died after mid-turn delivery");
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runD }).catch(() => undefined);
  check(
    "the message was delivered mid-turn before the crash",
    Boolean(scenarioD.claim?.text?.includes(STEER_D)),
  );
  const requeuedD = await waitFor(() => {
    const message = readRun(runD).humanMessages.find((entry) => entry.message === STEER_D);
    return (
      message?.deliveryState === "queued" &&
      !message.backendTurnId
    );
  });
  check(
    "a delivered message whose turn dies before settling is re-queued, never lost",
    requeuedD,
    JSON.stringify(
      readRun(runD).humanMessages.find((entry) => entry.message === STEER_D),
    ),
  );

  // ── 8. NO SPIN: queued input against a DEAD same-epoch call must sleep ───
  // The reported hazard: the turn dies in the SAME epoch while the wait's MCP
  // socket stays open (turn timeout, provider error). The claim then returns
  // null forever, and a sleep fast-path keyed only on "queued input exists"
  // would return immediately every iteration - a CPU-speed loop of
  // snapshotWorkers + run reads until the wait deadline. Reproduced through
  // the REAL death path (the stub turn throws, askManagerBackend fails the
  // call in place without an epoch bump) and then executing the wait
  // handler's exact per-iteration primitive sequence (claim, then sleep).
  const STEER_E = "Drop the migration step, the schema is already live";
  const runE = writeRun(pausedRun("run-mid-turn-dead-call-spin"));
  const scenarioE = {};
  const driverEEntered = gate();
  const releaseDriverE = gate();
  managerBehavior.set(runE, async (calls) => {
    if (calls.length === 1) {
      // Park, then die without claiming and WITHOUT exiting: the wait's poll
      // loop is still running when a real turn dies under it.
      scenarioE.token = await runStore.enterManagerWaitPark(runE);
      throw new Error("stub provider died while the wait stayed parked");
    }
    if (calls.length === 2) {
      driverEEntered.open();
      await releaseDriverE.opened;
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runE }).catch(() => undefined);
  check("the spin scenario parked before its turn died", Boolean(scenarioE.token));
  check(
    "the fallback driver turn dispatched and is gated",
    await gateOpened(driverEEntered),
  );
  const deadStateE = readRun(runE);
  const deadCallE = deadStateE.sparkCalls.find((call) => call.id === scenarioE.token?.callId);
  check(
    "the parked token's call is dead in the SAME epoch (the spin precondition)",
    deadCallE?.status === "failed" &&
      (deadStateE.conversationEpoch ?? 0) === scenarioE.token?.conversationEpoch,
    JSON.stringify({ status: deadCallE?.status, epoch: deadStateE.conversationEpoch }),
  );
  await runStore.addRunMessage({
    runId: runE,
    author: "user",
    kind: "note",
    message: STEER_E,
  });
  const queuedE = readRun(runE).humanMessages.find((message) => message.message === STEER_E);
  check(
    "the message stays queued (arm guard active, driver turn already started)",
    queuedE?.deliveryState === "queued" && !queuedE?.backendTurnId,
    JSON.stringify({ deliveryState: queuedE?.deliveryState, backendTurnId: queuedE?.backendTurnId }),
  );
  check("the registry still reports the parked wait", runStore.runHasParkedManagerWait(runE));
  const deadSleepStart = Date.now();
  await runStore.sleepForParkedManagerWait(scenarioE.token, 350);
  const deadSleepElapsed = Date.now() - deadSleepStart;
  check(
    "queued input against a dead call does NOT fast-path the sleep",
    deadSleepElapsed >= 300,
    `elapsed=${deadSleepElapsed}ms (timer was 350ms)`,
  );
  // The wait handler's real per-iteration sequence, bounded: with the fix the
  // sleep throttles every iteration to its full timer, so a 1200ms window
  // holds at most a handful of iterations. Under the reverted fix this counts
  // hundreds (the sleep returns immediately) and the check fails.
  let spinIterations = 0;
  let spinClaimed = null;
  const spinWindowStart = Date.now();
  while (Date.now() - spinWindowStart < 1200) {
    spinIterations += 1;
    spinClaimed = await runStore.claimQueuedInputForParkedManagerWait(scenarioE.token);
    if (spinClaimed) break;
    await runStore.sleepForParkedManagerWait(scenarioE.token, 300);
  }
  check(
    "the poll loop over a dead call is throttled to its sleep interval",
    spinIterations <= 6 && spinClaimed === null,
    `iterations=${spinIterations} in 1200ms, claimed=${JSON.stringify(spinClaimed)}`,
  );
  await runStore.exitManagerWaitPark(scenarioE.token);
  check("the spin scenario exits its park cleanly", runStore.runHasParkedManagerWait(runE) === false);
  releaseDriverE.open();
  // The queued message is still owed to the manager: answering the driver
  // turn's question must drain it into the next turn (never lost).
  const questionArrivedE = await waitFor(() =>
    readRun(runE).humanMessages.some(
      (message) => message.author === "spark" && message.kind === "question" && !message.answersMessageId,
    ),
  );
  check("the gated driver settles on its question", questionArrivedE);
  const questionE = [...readRun(runE).humanMessages]
    .reverse()
    .find((message) => message.author === "spark" && message.kind === "question");
  if (questionE) {
    await runStore
      .answerRunQuestion({
        runId: runE,
        questionMessageId: questionE.id,
        message: "Understood, continue.",
      })
      .catch(() => undefined);
    const drainedE = await waitFor(() =>
      callsFor(runE).some((call) => call.prompt.includes(STEER_E)),
    );
    check("the survivor message drains into the next real turn", drainedE);
  }

  // ── 9. exit re-arms the follow-up for steering the wait never claimed ────
  // The clientGone return path: the wait exits without claiming (claimUserInput
  // refuses once the client is gone) while a steering message sits queued and
  // the arm guard already skipped its follow-up. exitManagerWaitPark must
  // re-arm the scheduler or the message strands until the user acts.
  const STEER_F = "Rename the flag before anyone depends on it";
  const runF = writeRun(
    pausedRun("run-mid-turn-exit-nudge", {
      status: "running",
      autopilot: { status: "running", lastAction: "resumed_by_user", updatedAt: PAUSED_AT },
      sparkCalls: [
        {
          id: "spark-live-nudge",
          runId: "run-mid-turn-exit-nudge",
          mode: "chat",
          model: "stub-model",
          status: "started",
          inputMessageIds: [],
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
    }),
  );
  const tokenF = await runStore.enterManagerWaitPark(runF);
  check("the nudge scenario parks on the live fabricated call", tokenF?.callId === "spark-live-nudge");
  await runStore.addRunMessage({
    runId: runF,
    author: "user",
    kind: "note",
    message: STEER_F,
  });
  await sleep(300);
  check(
    "while parked, the queued steering arms no follow-up turn",
    callsFor(runF).length === 0,
    `calls=${callsFor(runF).length}`,
  );
  await runStore.exitManagerWaitPark(tokenF);
  const nudgedF = await waitFor(() =>
    callsFor(runF).some((call) => call.prompt.includes(STEER_F)),
  );
  check(
    "exiting the park without claiming re-arms the steering follow-up",
    nudgedF,
    JSON.stringify(callsFor(runF).map((call) => call.prompt.slice(0, 60))),
  );

  // ── 10. a failed park commit never leaks its registry entry ──────────────
  // enterManagerWaitPark inserts the map entry BEFORE its awaited commit; the
  // wait handler swallows the throw into parked=null, so its finally never
  // exits the park. A leaked entry would keep runHasParkedManagerWait true for
  // the process lifetime and permanently disable steering follow-ups for the
  // run. Forced here with a real commit failure: the run directory is made
  // read-only so saveRun throws.
  const runG = writeRun(
    pausedRun("run-mid-turn-enter-rollback", {
      status: "running",
      autopilot: { status: "running", lastAction: "resumed_by_user", updatedAt: PAUSED_AT },
      sparkCalls: [
        {
          id: "spark-live-rollback",
          runId: "run-mid-turn-enter-rollback",
          mode: "chat",
          model: "stub-model",
          status: "started",
          inputMessageIds: [],
          conversationEpoch: 1,
          createdAt: PAUSED_AT,
        },
      ],
    }),
  );
  // Prime the cache while the directory is still writable.
  await runStore.getRun(runG);
  const runGDir = path.join(HOME, "runs", runG);
  fs.chmodSync(runGDir, 0o555);
  let enterFailed = null;
  try {
    await runStore.enterManagerWaitPark(runG);
  } catch (error) {
    enterFailed = error;
  } finally {
    fs.chmodSync(runGDir, 0o755);
  }
  check(
    "a failed park commit rethrows to the caller (the wait degrades to unparked)",
    enterFailed !== null,
    "enterManagerWaitPark resolved despite the failed commit",
  );
  check(
    "a failed park commit rolls the registry entry back (no leak)",
    runStore.runHasParkedManagerWait(runG) === false,
  );
  // The registry stays healthy: the same run parks fine once the disk works.
  const retryTokenG = await runStore.enterManagerWaitPark(runG);
  check("the run parks normally after the failed attempt", Boolean(retryTokenG));
  if (retryTokenG) await runStore.exitManagerWaitPark(retryTokenG);

  // ── negative controls on the primitives ──────────────────────────────────
  const idleId = writeRun(pausedRun("run-mid-turn-idle"));
  check(
    "enterManagerWaitPark returns null when no manager call is live",
    (await runStore.enterManagerWaitPark(idleId)) === null,
  );
  check("runHasParkedManagerWait is false with nothing parked", runStore.runHasParkedManagerWait(idleId) === false);
  const timerStart = Date.now();
  await runStore.sleepForParkedManagerWait(
    { runId: idleId, callId: "spark-nonexistent", conversationEpoch: 1 },
    350,
  );
  check(
    "the parked sleep without a wake runs its full timer",
    Date.now() - timerStart >= 300,
    `elapsed=${Date.now() - timerStart}ms`,
  );

  // ── 7. source seams ──────────────────────────────────────────────────────
  const socketSource = fs.readFileSync(AGENT_SOCKET_TS, "utf8");
  const waitStart = socketSource.indexOf("async function handleOrchestratorWaitForWorkers(");
  const waitBody = socketSource.slice(
    waitStart,
    socketSource.indexOf("async function peekManagerInbox(", waitStart),
  );
  check("handleOrchestratorWaitForWorkers exists", waitStart !== -1 && waitBody.length > 0);
  check(
    "the wait handler enters the park before its poll loop",
    /const parked = await runStore\.enterManagerWaitPark\(runId\)/.test(waitBody),
  );
  check(
    "the wait handler exits the park in a finally",
    /\} finally \{\s*\n\s*if \(parked\) \{\s*\n\s*await runStore\.exitManagerWaitPark\(parked\)/.test(waitBody),
  );
  check(
    "the poll sleeps through the wake-capable primitive while parked",
    waitBody.includes("await runStore.sleepForParkedManagerWait(parked, WAIT_FOR_WORKERS_POLL_MS)"),
  );
  check(
    "queued input is claimed for the response, not peeked destructively elsewhere",
    waitBody.includes("claimQueuedInputForParkedManagerWait(parked)"),
  );
  check(
    "a mid-wait user message returns early with reason user_message",
    waitBody.includes('"user_message"') && waitBody.includes("user_messages"),
  );
  check(
    "the claim is skipped once the client is gone (no claim for a lost response)",
    /if \(!parked \|\| clientGone\(res\)\) return null;/.test(waitBody),
  );

  const storeSource = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "addRunMessage's follow-up arming is guarded by the parked-wait registry",
    /recordedIntent === "steer" &&\s*\n\s*!runHasParkedManagerWait\(updated\.id\) &&/.test(storeSource),
  );
  check(
    "the sleep fast-path requires the token's call to be live (the anti-spin pin)",
    /parkedWaitCallIsLive\(run, token\) &&\s*\n\s*queuedManagerInputMessages\(run\)\.length > 0/.test(storeSource),
  );
  check(
    "orphan recovery clears the parked flag off crashed calls",
    /if \(call\.parkedInWaitForWorkers !== undefined\) \{\s*\n\s*delete call\.parkedInWaitForWorkers;/.test(
      storeSource,
    ),
  );
  check(
    "addRunMessage wakes parked waits for every recorded user message",
    /if \(input\.author === "user"\) \{\s*\n\s*wakeParkedManagerWaits\(updated\.id\);/.test(storeSource),
  );
  check(
    "the claim marks submitted (the pinned crash-window choice), never acknowledged",
    /message\.deliveryState = "submitted";/.test(
      storeSource.slice(
        storeSource.indexOf("export async function claimQueuedInputForParkedManagerWait"),
        storeSource.indexOf("function normalizeManagerMode"),
      ),
    ),
  );

  const composerSource = fs.readFileSync(CHAT_COMPOSER_TSX, "utf8");
  check(
    "the composer derives the parked state from the SparkCall flag",
    composerSource.includes("parkedInWaitForWorkers") &&
      composerSource.includes("steeringDeliversNow"),
  );
  check(
    "the send button says Send (not Queue steering) while Cora is parked",
    composerSource.includes('label={isActive && !steeringDeliversNow ? "Queue steering" : "Send"}'),
  );

  completed = true;
  console.log(failures === 0 ? "\nAll mid-turn steering checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
