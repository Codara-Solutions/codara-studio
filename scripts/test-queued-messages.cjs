// Regression harness for queued user messages (always-queue semantics).
//
// A user message sent while a Cora manager turn is in flight is NEVER
// delivered into the live turn. It stays deliveryState "queued" until the
// turn settles, then the steering-followup scheduler starts a fresh manager
// turn that drains it. While queued, the message can be pulled back out of
// the outbox with cancelQueuedMessage (the renderer's Unqueue control), whose
// race guard refuses a message a turn already claimed.
//
// Pinned here, against the REAL run-store.ts (manager backend stubbed at
// backend-registry, the one seam every provider goes through - the same
// esbuild/stub technique as scripts/test-force-pause-resume.cjs):
//
//   1. always-queue - a message sent while the manager is generating stays
//      queued for the live call (never claimed onto it), and the follow-up
//      scheduler delivers it in a fresh turn after settlement, exactly once.
//   2. unqueue - cancelQueuedMessage flips a still-queued message to
//      "cancelled", returns its text for the composer, and the cancelled
//      message never reaches any manager prompt.
//   3. race guard - cancelQueuedMessage refuses a message that a turn start
//      already claimed (backendTurnId set / deliveryState past "queued").
//   4. crash window - a queued message whose delivering turn dies before
//      settling is re-queued (releaseUnsubmittedManagerInput), never lost.
//   5. send now - deliverQueuedMessagesNow interrupts and flushes the queue
//      into a fresh turn exactly once, and refuses an empty queue.
//   6. source seams - the agent-socket wait handler carries NO mid-turn
//      delivery (no park/claim/user_messages), the composer labels the send
//      button Queue while a turn is active, and the conversation renders an
//      Unqueue control for queued rows.
//
//   node scripts/test-queued-messages.cjs
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
const CHAT_CONVERSATION_TSX = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "chat",
  "ChatConversation.tsx",
);
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-queued-messages-test");

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
  name: "cora-queued-messages-stubs",
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-queued-messages-"));
const WS = "ws-queued-messages-test";
const PAUSED_AT = "2026-08-11T09:00:00.000Z";

function pausedRun(id, overrides = {}) {
  return {
    id,
    title: "queued messages",
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

  // ── 1. always-queue: a message during a live turn stays queued ───────────
  const QUEUED_A = "Also add a lexer benchmark while you are at it";
  const runA = writeRun(pausedRun("run-queued-live-turn"));
  const turnAEntered = gate();
  const releaseTurnA = gate();
  managerBehavior.set(runA, async (calls) => {
    if (calls.length === 1) {
      turnAEntered.open();
      await releaseTurnA.opened;
    }
    return askUserResult();
  });
  const resumeA = runStore.resumeRun({ runId: runA });
  check("the live turn dispatched", await gateOpened(turnAEntered));
  const liveA = readRun(runA);
  const liveCallA = liveA.sparkCalls.find(
    (call) => call.status === "started" && !call.completedAt,
  );
  check("the manager call is live while gated", Boolean(liveCallA));
  await runStore.addRunMessage({
    runId: runA,
    author: "user",
    kind: "note",
    message: QUEUED_A,
  });
  const sentA = readRun(runA).humanMessages.find((message) => message.message === QUEUED_A);
  check(
    "the mid-turn message is recorded with intent steer",
    sentA?.intent === "steer",
    sentA?.intent,
  );
  check(
    "the mid-turn message stays queued and unowned while the turn runs",
    sentA?.deliveryState === "queued" && !sentA?.backendTurnId,
    JSON.stringify({ deliveryState: sentA?.deliveryState, backendTurnId: sentA?.backendTurnId }),
  );
  await sleep(400);
  const liveCallAfterSendA = readRun(runA).sparkCalls.find((call) => call.id === liveCallA?.id);
  check(
    "the live call's frozen input list never grows mid-turn",
    !(liveCallAfterSendA?.inputMessageIds ?? []).includes(sentA?.id),
    JSON.stringify(liveCallAfterSendA?.inputMessageIds),
  );
  check(
    "the live turn's prompt does not contain the queued text",
    !callsFor(runA)[0]?.prompt.includes(QUEUED_A),
  );
  releaseTurnA.open();
  await resumeA.catch(() => undefined);
  const followupArrivedA = await waitFor(() =>
    callsFor(runA).some((call) => call.prompt.includes(QUEUED_A)),
  );
  check(
    "the follow-up turn after settlement delivers the queued message",
    followupArrivedA,
    JSON.stringify(callsFor(runA).map((call) => call.prompt.slice(0, 60))),
  );
  const claimedByFollowupA = await waitFor(() => {
    const message = readRun(runA).humanMessages.find((entry) => entry.message === QUEUED_A);
    return Boolean(message?.backendTurnId) && message.backendTurnId !== liveCallA?.id;
  });
  check("the follow-up turn claimed the queued message for itself", claimedByFollowupA);
  const deliveredOnceA =
    callsFor(runA).filter((call) => call.prompt.includes(QUEUED_A)).length === 1;
  check("the queued message renders in exactly one manager prompt", deliveredOnceA);
  const settledA = await waitFor(() => {
    const message = readRun(runA).humanMessages.find((entry) => entry.message === QUEUED_A);
    return message?.deliveryState === "acknowledged";
  });
  check("settlement acknowledges the delivered message", settledA);

  // ── 2. unqueue: cancelQueuedMessage pulls a queued message back ──────────
  const QUEUED_B = "Wait, use the streaming tokenizer instead";
  const runB = writeRun(pausedRun("run-queued-unqueue"));
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
  check("the unqueue scenario's turn dispatched", await gateOpened(turnBEntered));
  await runStore.addRunMessage({
    runId: runB,
    author: "user",
    kind: "note",
    message: QUEUED_B,
  });
  const queuedB = readRun(runB).humanMessages.find((message) => message.message === QUEUED_B);
  check("the message queued behind the live turn", queuedB?.deliveryState === "queued");
  let cancelResultB = null;
  let cancelErrorB = null;
  try {
    cancelResultB = await runStore.cancelQueuedMessage({ runId: runB, messageId: queuedB.id });
  } catch (error) {
    cancelErrorB = error;
  }
  check("cancelQueuedMessage succeeds on a queued message", !cancelErrorB, cancelErrorB?.message);
  check(
    "the cancel returns the message text for the composer",
    cancelResultB?.restoredText === QUEUED_B,
    cancelResultB?.restoredText,
  );
  const cancelledB = readRun(runB).humanMessages.find((message) => message.message === QUEUED_B);
  check(
    "the unqueued message is removed from the conversation entirely",
    cancelledB === undefined,
    JSON.stringify(cancelledB),
  );
  releaseTurnB.open();
  await resumeB.catch(() => undefined);
  await sleep(500);
  check(
    "a cancelled message never reaches any manager prompt",
    !callsFor(runB).some((call) => call.prompt.includes(QUEUED_B)),
    JSON.stringify(callsFor(runB).map((call) => call.prompt.slice(0, 60))),
  );
  let cancelUnknownError = null;
  try {
    await runStore.cancelQueuedMessage({ runId: runB, messageId: "msg-nonexistent" });
  } catch (error) {
    cancelUnknownError = error;
  }
  check("cancelQueuedMessage throws for an unknown message", cancelUnknownError !== null);

  // ── 3. race guard: a claimed message refuses to unqueue ──────────────────
  const QUEUED_C = "Ship it to staging when green";
  const runC = writeRun(pausedRun("run-queued-claimed-guard"));
  const turnCEntered = gate();
  const releaseTurnC = gate();
  managerBehavior.set(runC, async (calls) => {
    if (calls.length === 1) {
      turnCEntered.open();
      await releaseTurnC.opened;
    }
    return askUserResult();
  });
  // Sending into the paused run auto-resumes it carrying the message, so the
  // turn that dispatches claims the message at turn start (submitted).
  await runStore.addRunMessage({
    runId: runC,
    author: "user",
    kind: "note",
    message: QUEUED_C,
  });
  check("the carried message dispatched its turn", await gateOpened(turnCEntered));
  const claimedC = readRun(runC).humanMessages.find((message) => message.message === QUEUED_C);
  // Ownership is the backendTurnId claim stamped at turn start; deliveryState
  // advances to "submitted" only once the provider accepts the prompt, which
  // the gated stub may not have reached yet.
  check(
    "the turn start claimed the message onto its call",
    Boolean(claimedC?.backendTurnId),
    JSON.stringify({ deliveryState: claimedC?.deliveryState, backendTurnId: claimedC?.backendTurnId }),
  );
  let cancelClaimedError = null;
  try {
    await runStore.cancelQueuedMessage({ runId: runC, messageId: claimedC.id });
  } catch (error) {
    cancelClaimedError = error;
  }
  check(
    "cancelQueuedMessage refuses a message a turn already claimed",
    cancelClaimedError !== null,
  );
  const stillClaimedC = readRun(runC).humanMessages.find((message) => message.message === QUEUED_C);
  check(
    "the refused cancel leaves the claimed message owned and uncancelled",
    stillClaimedC?.deliveryState !== "cancelled" && Boolean(stillClaimedC?.backendTurnId),
    JSON.stringify({ deliveryState: stillClaimedC?.deliveryState, backendTurnId: stillClaimedC?.backendTurnId }),
  );
  releaseTurnC.open();
  await sleep(200);

  // ── 4. crash window: a claimed message whose turn dies is re-queued ──────
  const QUEUED_D = "Actually target the legacy branch instead";
  const runD = writeRun(pausedRun("run-queued-crash-window"));
  managerBehavior.set(runD, async (calls) => {
    if (calls.length === 1) {
      throw new Error("stub provider died before applying the turn");
    }
    return askUserResult();
  });
  await runStore
    .addRunMessage({
      runId: runD,
      author: "user",
      kind: "note",
      message: QUEUED_D,
    })
    .catch(() => undefined);
  const requeuedD = await waitFor(() => {
    const message = readRun(runD).humanMessages.find((entry) => entry.message === QUEUED_D);
    return Boolean(message) && message.deliveryState === "queued" && !message.backendTurnId;
  });
  check(
    "a claimed message whose turn dies before settling is re-queued, never lost",
    requeuedD,
    JSON.stringify(readRun(runD).humanMessages.find((entry) => entry.message === QUEUED_D)),
  );

  // ── 5. send now: deliverQueuedMessagesNow flushes after the turn settles ──
  const QUEUED_E = "Change of plans, target the beta branch";
  const runE = writeRun(pausedRun("run-queued-send-now"));
  const turnEEntered = gate();
  const releaseTurnE = gate();
  managerBehavior.set(runE, async (calls) => {
    if (calls.length === 1) {
      turnEEntered.open();
      await releaseTurnE.opened;
    }
    return askUserResult();
  });
  const resumeE = runStore.resumeRun({ runId: runE });
  check("the send-now scenario's turn dispatched", await gateOpened(turnEEntered));
  await runStore.addRunMessage({
    runId: runE,
    author: "user",
    kind: "note",
    message: QUEUED_E,
  });
  let sendNowError = null;
  try {
    await runStore.deliverQueuedMessagesNow(runE);
  } catch (error) {
    sendNowError = error;
  }
  check("deliverQueuedMessagesNow accepts a populated queue", !sendNowError, sendNowError?.message);
  releaseTurnE.open();
  await resumeE.catch(() => undefined);
  const deliveredE = await waitFor(() =>
    callsFor(runE).some((call) => call.prompt.includes(QUEUED_E)),
  );
  check("send-now delivers the queue in a fresh turn after settlement", deliveredE);
  await sleep(400);
  check(
    "send-now never double-delivers the queue",
    callsFor(runE).filter((call) => call.prompt.includes(QUEUED_E)).length === 1,
    JSON.stringify(callsFor(runE).map((call) => call.prompt.slice(0, 60))),
  );
  let sendNowEmptyError = null;
  try {
    await runStore.deliverQueuedMessagesNow(runE);
  } catch (error) {
    sendNowEmptyError = error;
  }
  check("deliverQueuedMessagesNow refuses an empty queue", sendNowEmptyError !== null);

  // ── 6. source seams ──────────────────────────────────────────────────────
  const socketSource = fs.readFileSync(AGENT_SOCKET_TS, "utf8");
  const waitStart = socketSource.indexOf("async function handleOrchestratorWaitForWorkers(");
  const waitBody = socketSource.slice(
    waitStart,
    socketSource.indexOf("async function peekManagerInbox(", waitStart),
  );
  check("handleOrchestratorWaitForWorkers exists", waitStart !== -1 && waitBody.length > 0);
  check(
    "the wait handler carries no mid-turn delivery machinery",
    !waitBody.includes("enterManagerWaitPark") &&
      !waitBody.includes("claimQueuedInputForParkedManagerWait") &&
      !waitBody.includes("user_messages"),
  );

  const storeSource = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "run-store no longer owns a parked-wait registry",
    !storeSource.includes("parkedManagerWaits") &&
      !storeSource.includes("enterManagerWaitPark"),
  );
  check(
    "addRunMessage arms the steering follow-up unconditionally for live work",
    /recordedIntent === "steer" &&\s*\n\s*\(Boolean\(activeManagerCall\(updated\)\)/.test(storeSource),
  );
  check(
    "cancelQueuedMessage re-checks the queue state inside the commit mutate",
    /export async function cancelQueuedMessage/.test(storeSource) &&
      /\(target\.deliveryState \?\? "queued"\) !== "queued" \|\|\s*\n\s*target\.backendTurnId/.test(storeSource),
  );

  const composerSource = fs.readFileSync(CHAT_COMPOSER_TSX, "utf8");
  check(
    "the composer no longer reads the parked SparkCall flag",
    !composerSource.includes("parkedInWaitForWorkers") &&
      !composerSource.includes("steeringDeliversNow"),
  );
  check(
    "the send button says Queue while a turn is active",
    composerSource.includes('label={isActive ? "Queue" : "Send"}'),
  );

  const conversationSource = fs.readFileSync(CHAT_CONVERSATION_TSX, "utf8");
  check(
    "queued rows render the Unqueue control wired to cancelQueuedMessage",
    conversationSource.includes("function UnqueueControl") &&
      conversationSource.includes("cancelQueuedMessage") &&
      /\{queued && <UnqueueControl runId=\{runId\} messageId=\{item\.id\} \/>\}/.test(conversationSource),
  );

  completed = true;
  console.log(failures === 0 ? "\nAll queued-message checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
