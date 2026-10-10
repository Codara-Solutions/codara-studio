// Regression harness for user messages sent while Cora works.
//
// With AppSettings.coraMidTurnDelivery "steer" (the default) and a backend
// that has a steer channel, a message sent during a live manager turn is
// claimed by that turn and handed to the runtime, which injects it at Cora's
// next step. Anything the turn does not read returns to the queue when it
// ends. With "queue", or a backend without steerChat, the message stays
// deliveryState "queued" until the turn settles, then the steering-followup
// scheduler starts a fresh manager turn that drains it. While queued, the
// message can be pulled back out of the outbox with cancelQueuedMessage (the
// renderer's Unqueue control), whose race guard refuses a message a turn
// already claimed. Every path goes through the per-run turn lock, so a run
// never has two manager turns at once.
//
// Pinned here, against the REAL run-store.ts (manager backend stubbed at
// backend-registry, the one seam every provider goes through - the same
// esbuild/stub technique as scripts/test-force-pause-resume.cjs):
//
//   1. queue fallback - with no steer channel, a message sent while the
//      manager is generating stays queued for the live call (never claimed
//      onto it), and the follow-up scheduler delivers it in a fresh turn
//      after settlement, exactly once.
//   2. unqueue - cancelQueuedMessage flips a still-queued message to
//      "cancelled", returns its text for the composer, and the cancelled
//      message never reaches any manager prompt.
//   3. race guard - cancelQueuedMessage refuses a message that a turn start
//      already claimed (backendTurnId set / deliveryState past "queued").
//   4. crash window - a queued message whose delivering turn dies before
//      settling is re-queued (releaseUnsubmittedManagerInput), never lost.
//   5. send now - deliverQueuedMessagesNow interrupts and flushes the queue
//      into a fresh turn exactly once, returns the run for an empty queue,
//      and refuses a run waiting on an answer.
//   5b. steer - a mid-turn message reaches the live turn, is acknowledged
//      with it once read, returns to the queue when unread, and stays queued
//      under the "queue" setting or a refused steer.
//   5c. turn discipline - one manager turn per run at a time, a follow-up
//      that keeps failing stops re-arming, Stop keeps queued messages, and an
//      identical resend after delivery is a new message.
//   6. source seams - the agent-socket wait handler parks/claims nothing (it
//      only yields to an unread steer), the composer labels the send button
//      Queue while a turn is active, and the conversation renders an Unqueue
//      control for queued rows.
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
const SHARED_TYPES_TS = path.join(ROOT, "src", "shared", "types.ts");
const STORAGE_TS = path.join(ROOT, "src", "main", "storage.ts");
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
  ...(globalThis.__coraSteerStub
    ? { steerChat: (runId, steer) => globalThis.__coraSteerStub(runId, steer) }
    : {}),
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
export async function resolveCodaraPiRuntime() { throw new Error("pi runtime is stubbed"); } export async function resolveCodaraPiLibrary() { throw new Error("pi runtime is stubbed"); } export async function resolveUserPiRuntime() { throw new Error("pi runtime is stubbed"); }
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

function completeResult() {
  return {
    decision: {
      status: "complete",
      summary: "stub turn finished",
      chatReply: "Done.",
      steps: [],
      tasks: [],
    },
    durationMs: 1,
    model: "stub-model",
  };
}

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

  // One bundle for both, so the settings cache run-store reads is the one the
  // harness writes.
  const entry = path.join(CACHE, "queued-messages-entry.ts");
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(RUN_STORE_TS)};\nexport { loadSettings, saveSettings } from ${JSON.stringify(STORAGE_TS)};\n`,
  );
  const runStore = await bundle(entry, "run-store.cjs", {
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
      return completeResult();
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runA });
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
  await runStore.resumeRun({ runId: runB });
  check("the unqueue scenario's turn dispatched", await gateOpened(turnBEntered));
  const queuedImageSource = path.join(HOME, "queued-reference.png");
  fs.writeFileSync(queuedImageSource, "queued image fixture");
  await runStore.addRunMessage({
    runId: runB,
    author: "user",
    kind: "note",
    message: QUEUED_B,
    attachments: [{ sourcePath: queuedImageSource, name: "reference.png", kind: "image" }],
  });
  const queuedB = readRun(runB).humanMessages.find((message) => message.message === QUEUED_B);
  check("the message queued behind the live turn", queuedB?.deliveryState === "queued");
  const persistedQueuedImage = queuedB?.attachments?.[0]?.path;
  check(
    "the queued image is persisted with its message",
    queuedB?.attachments?.[0]?.kind === "image" &&
      typeof persistedQueuedImage === "string" &&
      fs.existsSync(persistedQueuedImage),
    JSON.stringify(queuedB?.attachments),
  );
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
  check(
    "the cancel returns a re-attachable image and keeps its persisted source alive",
    cancelResultB?.restoredAttachments?.[0]?.kind === "image" &&
      cancelResultB?.restoredAttachments?.[0]?.name === "reference.png" &&
      cancelResultB?.restoredAttachments?.[0]?.sourcePath === persistedQueuedImage &&
      fs.existsSync(cancelResultB.restoredAttachments[0].sourcePath),
    JSON.stringify(cancelResultB?.restoredAttachments),
  );
  const cancelledB = readRun(runB).humanMessages.find((message) => message.message === QUEUED_B);
  check(
    "the unqueued message is removed from the conversation entirely",
    cancelledB === undefined,
    JSON.stringify(cancelledB),
  );
  releaseTurnB.open();
  await runStore.settleScheduledManagerWork(runB);
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
      return completeResult();
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runE });
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
  await runStore.settleScheduledManagerWork(runE);
  let sendNowEmptyError = null;
  let sendNowEmptyResult = null;
  try {
    sendNowEmptyResult = await runStore.deliverQueuedMessagesNow(runE);
  } catch (error) {
    sendNowEmptyError = error;
  }
  // The row it would act on is already gone; the click that raced the turn
  // succeeded in effect, so it is not an error.
  check(
    "deliverQueuedMessagesNow returns the run for an empty queue",
    !sendNowEmptyError && sendNowEmptyResult?.id === runE,
    sendNowEmptyError?.message,
  );

  // A question is answered through answerRunQuestion, which carries the queue
  // with it; Send now on a blocked run would only race that answer.
  const runBlocked = writeRun(
    pausedRun("run-send-now-blocked", {
      status: "blocked",
      autopilot: { status: "blocked", lastAction: "asked_user", updatedAt: PAUSED_AT },
      humanMessages: [
        ...pausedRun("run-send-now-blocked").humanMessages,
        {
          id: "msg-blocked-queued",
          runId: "run-send-now-blocked",
          author: "user",
          kind: "note",
          message: "and keep the old API working",
          attachments: [],
          createdAt: PAUSED_AT,
          deliveryState: "queued",
          intent: "steer",
          conversationEpoch: 1,
        },
      ],
    }),
  );
  let sendNowBlockedError = null;
  try {
    await runStore.deliverQueuedMessagesNow(runBlocked);
  } catch (error) {
    sendNowBlockedError = error;
  }
  check(
    "deliverQueuedMessagesNow refuses a run waiting on an answer",
    /waiting for your answer/.test(sendNowBlockedError?.message ?? ""),
    sendNowBlockedError?.message,
  );

  // ── 5b. steer: a mid-turn message goes into the live turn ───────────────
  const steers = [];
  let steerAccepts = true;
  globalThis.__coraSteerStub = async (steerRunId, steer) => {
    steers.push({ runId: steerRunId, ...steer });
    return steerAccepts;
  };
  const steersFor = (steerRunId) => steers.filter((steer) => steer.runId === steerRunId);
  const messageText = (msgRunId, text) =>
    readRun(msgRunId).humanMessages.find((message) => message.message === text);

  async function gatedTurn(id, firstResult = completeResult) {
    const entered = gate();
    const release = gate();
    managerBehavior.set(id, async (calls) => {
      if (calls.length === 1) {
        entered.open();
        await release.opened;
        return firstResult();
      }
      return askUserResult();
    });
    await runStore.resumeRun({ runId: id });
    const dispatched = await gateOpened(entered);
    const liveCall = readRun(id).sparkCalls.find(
      (call) => call.status === "started" && !call.completedAt,
    );
    return { dispatched, liveCall, release };
  }

  const STEER_F = "Use a hash map for the symbol table";
  const runF = writeRun(pausedRun("run-steer-read"));
  const turnF = await gatedTurn(runF);
  check("the steer scenario's turn dispatched", turnF.dispatched && Boolean(turnF.liveCall));
  await runStore.addRunMessage({ runId: runF, author: "user", kind: "note", message: STEER_F });
  check("a mid-turn message is steered into the live turn", await waitFor(() => steersFor(runF).length === 1));
  const steerF = steersFor(runF)[0];
  check("the steer carries the user's text", Boolean(steerF?.text.includes(STEER_F)), steerF?.text);
  const claimedF = messageText(runF, STEER_F);
  check(
    "the steered message is claimed by the live call",
    claimedF?.backendTurnId === turnF.liveCall?.id &&
      claimedF?.deliveryState === "submitted" &&
      Boolean(claimedF?.steeredAt),
    JSON.stringify(claimedF),
  );
  check(
    "the live call's input list records the steer",
    (
      readRun(runF).sparkCalls.find((call) => call.id === turnF.liveCall?.id)?.inputMessageIds ?? []
    ).includes(claimedF?.id),
  );
  check("an unread steer makes the wait tool yield", runStore.hasUndeliveredSteer(readRun(runF)));
  steerF?.onDelivered();
  check(
    "the runtime's delivery notice is recorded",
    await waitFor(() => Boolean(messageText(runF, STEER_F)?.steerDeliveredAt)),
  );
  check("a read steer no longer makes the wait tool yield", !runStore.hasUndeliveredSteer(readRun(runF)));
  turnF.release.open();
  await runStore.settleScheduledManagerWork(runF);
  check(
    "the turn that read the steer acknowledges it",
    messageText(runF, STEER_F)?.deliveryState === "acknowledged",
    messageText(runF, STEER_F)?.deliveryState,
  );
  check(
    "a steer the live turn read never gets a turn of its own",
    callsFor(runF).length === 1,
    `calls=${callsFor(runF).length}`,
  );

  const STEER_G = "Skip the benchmark, it is flaky";
  const runG = writeRun(pausedRun("run-steer-unread"));
  const turnG = await gatedTurn(runG);
  await runStore.addRunMessage({ runId: runG, author: "user", kind: "note", message: STEER_G });
  await waitFor(() => steersFor(runG).length === 1);
  turnG.release.open();
  await runStore.settleScheduledManagerWork(runG);
  check(
    "a steer the turn never read is delivered by the next turn",
    callsFor(runG).filter((call) => call.prompt.includes(STEER_G)).length === 1,
    JSON.stringify(callsFor(runG).map((call) => call.prompt.slice(0, 60))),
  );
  const finalG = messageText(runG, STEER_G);
  check(
    "the unread steer was returned to the queue, not acknowledged by the turn that missed it",
    finalG?.backendTurnId !== turnG.liveCall?.id &&
      readEvents(runG).some((event) => event.type === "run.manager_input_steer_returned"),
    JSON.stringify(finalG),
  );

  const STEER_H = "Rename the module to lexer";
  const runH = writeRun(pausedRun("run-steer-refused"));
  steerAccepts = false;
  const turnH = await gatedTurn(runH);
  await runStore.addRunMessage({ runId: runH, author: "user", kind: "note", message: STEER_H });
  await waitFor(() => steersFor(runH).length === 1);
  await waitFor(() => messageText(runH, STEER_H)?.deliveryState === "queued");
  check(
    "a steer the runtime refuses goes back to the queue unowned",
    messageText(runH, STEER_H)?.deliveryState === "queued" && !messageText(runH, STEER_H)?.backendTurnId,
    JSON.stringify(messageText(runH, STEER_H)),
  );
  steerAccepts = true;
  turnH.release.open();
  await runStore.settleScheduledManagerWork(runH);
  check(
    "a refused steer is delivered once by the next turn",
    callsFor(runH).filter((call) => call.prompt.includes(STEER_H)).length === 1,
  );

  const settings = await runStore.loadSettings();
  await runStore.saveSettings({ ...settings, coraMidTurnDelivery: "queue" });
  const STEER_I = "Keep the error messages short";
  const runI = writeRun(pausedRun("run-steer-setting-queue"));
  const turnI = await gatedTurn(runI);
  await runStore.addRunMessage({ runId: runI, author: "user", kind: "note", message: STEER_I });
  await sleep(200);
  check(
    'coraMidTurnDelivery "queue" keeps the message out of the live turn',
    steersFor(runI).length === 0 && messageText(runI, STEER_I)?.deliveryState === "queued",
    JSON.stringify(messageText(runI, STEER_I)),
  );
  turnI.release.open();
  await runStore.settleScheduledManagerWork(runI);
  check(
    'with "queue" the next turn delivers the message once',
    callsFor(runI).filter((call) => call.prompt.includes(STEER_I)).length === 1,
  );
  await runStore.saveSettings({ ...settings, coraMidTurnDelivery: "steer" });
  globalThis.__coraSteerStub = undefined;

  // ── 5c. turn discipline ─────────────────────────────────────────────────
  // One manager turn per run: Resume, Send now and the follow-up scheduler
  // all route through the turn lock, so none starts on top of a live turn.
  const QUEUED_J = "Then document the parser";
  const runJ = writeRun(pausedRun("run-one-turn-at-a-time"));
  const enteredJ = gate();
  const releaseJ = gate();
  let inFlightJ = 0;
  let maxInFlightJ = 0;
  managerBehavior.set(runJ, async (calls) => {
    inFlightJ += 1;
    maxInFlightJ = Math.max(maxInFlightJ, inFlightJ);
    try {
      if (calls.length === 1) {
        enteredJ.open();
        await releaseJ.opened;
        return completeResult();
      }
      await sleep(20);
      return askUserResult();
    } finally {
      inFlightJ -= 1;
    }
  });
  await runStore.resumeRun({ runId: runJ });
  await gateOpened(enteredJ);
  await runStore.addRunMessage({ runId: runJ, author: "user", kind: "note", message: QUEUED_J });
  await runStore.resumeRun({ runId: runJ }).catch(() => undefined);
  await runStore.deliverQueuedMessagesNow(runJ).catch(() => undefined);
  await sleep(100);
  releaseJ.open();
  await waitFor(() => callsFor(runJ).some((call) => call.prompt.includes(QUEUED_J)));
  await runStore.settleScheduledManagerWork(runJ);
  check("a run never has two manager turns at once", maxInFlightJ === 1, `max=${maxInFlightJ}`);
  check(
    "the queued message reaches exactly one turn",
    callsFor(runJ).filter((call) => call.prompt.includes(QUEUED_J)).length === 1,
    JSON.stringify(callsFor(runJ).map((call) => call.prompt.slice(0, 60))),
  );

  // A follow-up that fails the same way every time must not re-arm itself
  // (the reference run made 1041 manager calls in 4 seconds).
  const QUEUED_K = "Retry with the cached tokens";
  const runK = writeRun(pausedRun("run-failing-followup"));
  const enteredK = gate();
  const releaseK = gate();
  managerBehavior.set(runK, async (calls) => {
    if (calls.length === 1) {
      enteredK.open();
      await releaseK.opened;
      return completeResult();
    }
    throw new Error("stub provider rejected the prompt");
  });
  await runStore.resumeRun({ runId: runK });
  await gateOpened(enteredK);
  await runStore.addRunMessage({ runId: runK, author: "user", kind: "note", message: QUEUED_K });
  releaseK.open();
  await runStore.settleScheduledManagerWork(runK, 10_000);
  const callsAfterSettleK = callsFor(runK).length;
  await sleep(600);
  check(
    "a follow-up that keeps failing stops re-arming",
    callsFor(runK).length === callsAfterSettleK && callsAfterSettleK <= 6,
    `calls=${callsFor(runK).length}`,
  );
  check(
    "the undelivered message stays visible as queued",
    messageText(runK, QUEUED_K)?.deliveryState === "queued",
    JSON.stringify(messageText(runK, QUEUED_K)),
  );

  // Stop moves the conversation epoch; a message queued behind the stopped
  // turn moves with it instead of being stranded in the old epoch.
  const QUEUED_L = "Use tabs, not spaces";
  const runL = writeRun(pausedRun("run-stop-keeps-queue"));
  const turnL = await gatedTurn(runL, askUserResult);
  await runStore.addRunMessage({ runId: runL, author: "user", kind: "note", message: QUEUED_L });
  await runStore.forcePauseRun(runL);
  turnL.release.open();
  await runStore.settleScheduledManagerWork(runL);
  const afterStopL = readRun(runL);
  const keptL = messageText(runL, QUEUED_L);
  check(
    "a message queued behind a stopped turn survives Stop",
    keptL?.deliveryState === "queued" &&
      (keptL?.conversationEpoch ?? 0) === (afterStopL.conversationEpoch ?? 0),
    JSON.stringify({ message: keptL, epoch: afterStopL.conversationEpoch }),
  );
  await runStore.resumeRun({ runId: runL });
  await runStore.settleScheduledManagerWork(runL);
  check(
    "Resume after Stop delivers the kept message once",
    callsFor(runL).filter((call) => call.prompt.includes(QUEUED_L)).length === 1,
    JSON.stringify(callsFor(runL).map((call) => call.prompt.slice(0, 60))),
  );

  // Only a copy still waiting to be delivered is a double send. Retyping a
  // message Cora already read is a new request.
  const RESENT_M = "continue";
  const runM = writeRun(
    pausedRun("run-identical-resend", {
      humanMessages: [
        {
          id: "msg-first-continue",
          runId: "run-identical-resend",
          author: "user",
          kind: "note",
          message: RESENT_M,
          attachments: [],
          createdAt: new Date().toISOString(),
          deliveryState: "acknowledged",
          intent: "turn",
          conversationEpoch: 1,
        },
      ],
    }),
  );
  await runStore.addRunMessage({ runId: runM, author: "user", kind: "note", message: RESENT_M });
  await runStore.settleScheduledManagerWork(runM);
  check(
    "an identical resend after delivery is recorded as a new message",
    readRun(runM).humanMessages.filter((message) => message.message === RESENT_M).length === 2,
  );

  // /compact summarizes on the run's one manager session. A message sent while
  // it runs starts a turn that must queue behind it, not run on top of it.
  const QUEUED_S = "Now wire the parser into the CLI";
  const runS = writeRun(
    pausedRun("run-compact-holds-turn-lock", {
      status: "complete",
      chatSessionUuid: "00000000-0000-4000-8000-0000000000c1",
      settingsSnapshot: { workspaceCwd: HOME },
      autopilot: { status: "complete", lastAction: "completed", updatedAt: PAUSED_AT },
    }),
  );
  const enteredS = gate();
  const releaseS = gate();
  let inFlightS = 0;
  let maxInFlightS = 0;
  managerBehavior.set(runS, async (calls) => {
    inFlightS += 1;
    maxInFlightS = Math.max(maxInFlightS, inFlightS);
    try {
      if (calls.length === 1) {
        enteredS.open();
        await releaseS.opened;
        return {
          decision: {
            status: "complete",
            summary: "compaction",
            chatReply: "Summary of the parser work so far. ".repeat(12),
            steps: [],
            tasks: [],
          },
          durationMs: 1,
          model: "stub-model",
        };
      }
      return completeResult();
    } finally {
      inFlightS -= 1;
    }
  });
  const compactingS = runStore.compactConversation(runS).then(
    () => null,
    (error) => error,
  );
  check("the compaction summary call started", await gateOpened(enteredS));
  await runStore.addRunMessage({ runId: runS, author: "user", kind: "note", message: QUEUED_S });
  await sleep(300);
  check(
    "a turn started during compaction waits for it",
    callsFor(runS).length === 1,
    `calls=${callsFor(runS).length}`,
  );
  releaseS.open();
  const compactErrorS = await compactingS;
  await runStore.settleScheduledManagerWork(runS);
  check("compaction and a turn never overlap", maxInFlightS === 1, `max=${maxInFlightS}`);
  check(
    "compaction yields to the message that arrived during it",
    /abandoned/i.test(compactErrorS?.message ?? ""),
    compactErrorS?.message,
  );
  check(
    "the message sent during compaction is delivered once",
    callsFor(runS).filter((call) => call.prompt.includes(QUEUED_S)).length === 1 &&
      messageText(runS, QUEUED_S)?.deliveryState === "acknowledged",
    JSON.stringify(messageText(runS, QUEUED_S)),
  );

  // A turn the session refused as busy was never stopped by anyone, so its
  // requeued input needs a turn of its own afterwards.
  const QUEUED_T = "Then add the benchmark";
  const runT = writeRun(
    pausedRun("run-session-busy-redrive", {
      status: "complete",
      autopilot: { status: "complete", lastAction: "completed", updatedAt: PAUSED_AT },
    }),
  );
  managerBehavior.set(runT, async (calls) => {
    if (calls.length === 1) {
      return {
        decision: {
          status: "complete",
          summary: "busy",
          chatReply: "Cora is already working on a turn in this chat.",
          steps: [],
          tasks: [],
        },
        durationMs: 1,
        model: "stub-model",
        notice: "Cora is already working on a turn in this chat; this message waits for it.",
        turnAborted: true,
        sessionBusy: true,
      };
    }
    return completeResult();
  });
  await runStore.addRunMessage({ runId: runT, author: "user", kind: "note", message: QUEUED_T });
  await runStore.settleScheduledManagerWork(runT);
  check(
    "input refused by a busy session gets its own turn afterwards",
    callsFor(runT).filter((call) => call.prompt.includes(QUEUED_T)).length === 2 &&
      messageText(runT, QUEUED_T)?.deliveryState === "acknowledged",
    JSON.stringify({ calls: callsFor(runT).length, message: messageText(runT, QUEUED_T) }),
  );

  // ── 5d. a runtime that fails to start ───────────────────────────────────
  // The backend throwing means no provider turn ran. The message is requeued;
  // a dead login parks for Retry, a slow start is retried once, and anything
  // else asks the user without calling for a resend of a saved message.
  const finishedRun = (id) =>
    pausedRun(id, {
      status: "complete",
      autopilot: { status: "complete", lastAction: "completed", updatedAt: PAUSED_AT },
    });

  const STARTUP_N = "Rename the parser module";
  const runN = writeRun(finishedRun("run-startup-auth"));
  managerBehavior.set(runN, async () => {
    throw new Error("Pi provider anthropic OAuth session expired and cannot refresh");
  });
  await runStore.addRunMessage({ runId: runN, author: "user", kind: "note", message: STARTUP_N });
  await runStore.settleScheduledManagerWork(runN);
  const parkedN = readRun(runN);
  check(
    "a runtime that cannot start on a dead login parks the run for Retry",
    parkedN.status === "paused" && parkedN.managerTurnRecovery?.failureKind === "auth",
    JSON.stringify({ status: parkedN.status, recovery: parkedN.managerTurnRecovery }),
  );
  check(
    "the parked turn's message stays queued for the retry",
    messageText(runN, STARTUP_N)?.deliveryState === "queued",
    JSON.stringify(messageText(runN, STARTUP_N)),
  );

  const STARTUP_O = "Add a changelog entry";
  const runO = writeRun(finishedRun("run-startup-timeout"));
  managerBehavior.set(runO, async (calls) => {
    if (calls.length === 1) {
      throw new Error("Pi RPC startup handshake failed: Pi RPC request codara-1 timed out");
    }
    return askUserResult();
  });
  await runStore.addRunMessage({ runId: runO, author: "user", kind: "note", message: STARTUP_O });
  await runStore.settleScheduledManagerWork(runO);
  check("a runtime that timed out starting is retried once", callsFor(runO).length === 2, `calls=${callsFor(runO).length}`);
  check(
    "the retried turn delivers the message once",
    callsFor(runO).filter((call) => call.prompt.includes(STARTUP_O)).length === 2 &&
      (callsFor(runO)[1].prompt.split(STARTUP_O).length - 1) === 1,
  );

  const STARTUP_P = "Ship the release notes";
  const runP = writeRun(finishedRun("run-startup-unclassified"));
  managerBehavior.set(runP, async (calls) => {
    if (calls.length === 1) throw new Error("stub runtime refused the session");
    return askUserResult();
  });
  await runStore.addRunMessage({ runId: runP, author: "user", kind: "note", message: STARTUP_P });
  await runStore.settleScheduledManagerWork(runP);
  const blockedP = readRun(runP);
  const failureQuestion = blockedP.humanMessages.find(
    (message) => message.kind === "question" && message.questionContext?.backendFailure,
  );
  check(
    "an unclassified startup failure asks instead of failing",
    blockedP.status === "blocked" && Boolean(failureQuestion),
    blockedP.status,
  );
  check(
    "the failure notice says the message is saved instead of asking for a resend",
    /Your message is saved/.test(failureQuestion?.message ?? "") &&
      !/send the message again/.test(failureQuestion?.message ?? ""),
    failureQuestion?.message,
  );
  if (failureQuestion) {
    await runStore.answerRunQuestion({
      runId: runP,
      questionMessageId: failureQuestion.id,
      message: STARTUP_P,
    });
    await runStore.settleScheduledManagerWork(runP);
  }
  const continuationP = callsFor(runP).at(-1)?.prompt ?? "";
  check(
    "retyping the failed message as the answer delivers it once",
    callsFor(runP).length === 2 && continuationP.split(STARTUP_P).length - 1 === 1,
    `calls=${callsFor(runP).length} occurrences=${continuationP.split(STARTUP_P).length - 1}`,
  );

  // A reply aimed at a question the run no longer waits on (a Stop or a park
  // landed first) fails with a code the composer turns into a normal send.
  const runQ = writeRun(
    pausedRun("run-answer-inactive", {
      humanMessages: [
        ...pausedRun("run-answer-inactive").humanMessages,
        {
          id: "msg-stale-question",
          runId: "run-answer-inactive",
          author: "spark",
          kind: "question",
          message: "Which branch should I target?",
          attachments: [],
          createdAt: PAUSED_AT,
          deliveryState: "acknowledged",
          conversationEpoch: 1,
        },
      ],
    }),
  );
  let inactiveError = null;
  try {
    await runStore.answerRunQuestion({
      runId: runQ,
      questionMessageId: "msg-stale-question",
      message: "main",
    });
  } catch (error) {
    inactiveError = error;
  }
  check(
    "answering a question the run no longer waits on fails with QUESTION_INACTIVE",
    /^QUESTION_INACTIVE:/.test(inactiveError?.message ?? ""),
    inactiveError?.message,
  );

  // A backend that throws after the provider accepted the prompt ran a real
  // turn, whose tools may already have acted. That is not a runtime that
  // failed to start, so it is never retried or parked for a replay.
  const runR = writeRun(finishedRun("run-throw-after-accept"));
  managerBehavior.set(runR, async (calls, input) => {
    if (calls.length === 1) {
      await input.onPromptAccepted?.();
      throw new Error("Pi RPC request codara-7 timed out");
    }
    return askUserResult();
  });
  await runStore.addRunMessage({ runId: runR, author: "user", kind: "note", message: "Tag the release" });
  await runStore.settleScheduledManagerWork(runR);
  check(
    "a turn that throws after its prompt was accepted is not replayed as a startup failure",
    callsFor(runR).length === 1 && !readRun(runR).managerTurnRecovery,
    JSON.stringify({ calls: callsFor(runR).length, recovery: readRun(runR).managerTurnRecovery }),
  );

  // ── 5e. Stop and cancel teardown ────────────────────────────────────────
  // Stop and cancel dispose the live session, then commit. A turn queued
  // behind the interrupted one must not start in between: it would launch a
  // fresh runtime that the paused or cancelled commit never stops.
  for (const action of ["stop", "cancel"]) {
    const QUEUED_S = `Queued before the ${action}`;
    const runS = writeRun(pausedRun(`run-teardown-${action}`));
    const enteredS = gate();
    const releaseS = gate();
    managerBehavior.set(runS, async (calls) => {
      if (calls.length === 1) {
        enteredS.open();
        await releaseS.opened;
        return { ...completeResult(), turnAborted: true };
      }
      return askUserResult();
    });
    await runStore.resumeRun({ runId: runS });
    await gateOpened(enteredS);
    await runStore.saveSettings({ ...settings, coraMidTurnDelivery: "queue" });
    await runStore.addRunMessage({ runId: runS, author: "user", kind: "note", message: QUEUED_S });
    await runStore.saveSettings({ ...settings, coraMidTurnDelivery: "steer" });
    // The interrupted turn returns while the session is still being torn
    // down, which is when the queued follow-up used to slip in.
    globalThis.__coraDisposeHook = async (id) => {
      if (id !== runS) return;
      releaseS.open();
      await sleep(400);
    };
    try {
      if (action === "stop") await runStore.forcePauseRun(runS);
      else await runStore.cancelRun({ runId: runS });
    } finally {
      globalThis.__coraDisposeHook = undefined;
    }
    await runStore.settleScheduledManagerWork(runS);
    const afterS = readRun(runS);
    check(
      `no manager turn starts while ${action} tears the run down`,
      callsFor(runS).length === 1 &&
        !afterS.sparkCalls.some((call) => call.status === "started" && !call.completedAt),
      JSON.stringify({ calls: callsFor(runS).length, status: afterS.status }),
    );
    check(
      `${action} leaves the run ${action === "stop" ? "paused" : "cancelled"}`,
      afterS.status === (action === "stop" ? "paused" : "cancelled"),
      afterS.status,
    );
  }

  // ── 5f. requeued input the provider already had ─────────────────────────
  // Stop and an app restart both hand a submitted message back to the queue.
  // The replay must label it as delivered before, or Cora redoes the work the
  // cut-off turn already started.
  const SUBMITTED_U = "Add auth to the API";
  const runU = writeRun(
    pausedRun("run-stop-submitted-input", {
      humanMessages: [
        {
          id: "msg-submitted-u",
          runId: "run-stop-submitted-input",
          author: "user",
          kind: "note",
          message: SUBMITTED_U,
          attachments: [],
          createdAt: PAUSED_AT,
          deliveryState: "queued",
          intent: "turn",
          conversationEpoch: 1,
        },
      ],
    }),
  );
  const enteredU = gate();
  const releaseU = gate();
  managerBehavior.set(runU, async (calls, input) => {
    if (calls.length === 1) {
      await input.onPromptAccepted?.();
      enteredU.open();
      await releaseU.opened;
      return { ...completeResult(), turnAborted: true };
    }
    return askUserResult();
  });
  await runStore.resumeRun({ runId: runU });
  await gateOpened(enteredU);
  await waitFor(() => messageText(runU, SUBMITTED_U)?.deliveryState === "submitted");
  await runStore.forcePauseRun(runU);
  releaseU.open();
  await runStore.settleScheduledManagerWork(runU);
  check(
    "Stop marks a submitted message as redelivered when it requeues it",
    messageText(runU, SUBMITTED_U)?.deliveryState === "queued" &&
      messageText(runU, SUBMITTED_U)?.redelivered === true,
    JSON.stringify(messageText(runU, SUBMITTED_U)),
  );

  const SUBMITTED_V = "Spawn the auth workers";
  const restartedAt = new Date().toISOString();
  writeRun(
    pausedRun("run-restart-submitted-input", {
      status: "running",
      autopilot: { status: "running", lastAction: "chat_turn", updatedAt: restartedAt },
      humanMessages: [
        {
          id: "msg-submitted-v",
          runId: "run-restart-submitted-input",
          author: "user",
          kind: "note",
          message: SUBMITTED_V,
          attachments: [],
          createdAt: restartedAt,
          deliveryState: "submitted",
          backendTurnId: "spark-cut-by-restart",
          targetTurnId: "spark-cut-by-restart",
          steeredAt: restartedAt,
          intent: "turn",
          conversationEpoch: 1,
        },
      ],
      sparkCalls: [
        {
          id: "spark-cut-by-restart",
          runId: "run-restart-submitted-input",
          mode: "chat",
          model: "stub-model",
          status: "started",
          inputMessageIds: ["msg-submitted-v"],
          conversationEpoch: 1,
          createdAt: restartedAt,
        },
      ],
    }),
  );
  await runStore.recoverOrphanedManagerTurns();
  const restartedV = messageText("run-restart-submitted-input", SUBMITTED_V);
  check(
    "restart recovery marks a submitted message as redelivered when it requeues it",
    restartedV?.deliveryState === "queued" &&
      restartedV?.redelivered === true &&
      !restartedV?.steeredAt,
    JSON.stringify(restartedV),
  );

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
  check(
    "the wait handler yields to a steer the live turn has not read",
    waitBody.includes("hasUndeliveredSteer(") && waitBody.includes('"user_message"'),
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
  const terminalDirectDispatch = storeSource.slice(
    storeSource.indexOf("export async function addRunMessage("),
    storeSource.indexOf("if (input.author === \"user\" && activeConversationRewinds", storeSource.indexOf("export async function addRunMessage(")),
  );
  check(
    "terminal direct-chat sends dispatch attachments through the same iteration path as text",
    terminalDirectDispatch.includes("attachments: input.attachments") &&
      !terminalDirectDispatch.includes("(input.attachments?.length ?? 0) === 0"),
  );
  check(
    "Resume drains a persisted queued direct-chat turn instead of duplicating it",
    /queuedDirectMessages = queuedManagerInputMessages\(run\)/.test(storeSource) &&
      /queuedMessageIds: queuedDirectMessages\.map/.test(storeSource) &&
      /renderBundledManagerInput\(directInputMessages\)/.test(storeSource),
  );
  const sharedTypesSource = fs.readFileSync(SHARED_TYPES_TS, "utf8");
  const directIterationInput = sharedTypesSource.slice(
    sharedTypesSource.indexOf("export interface AddDirectIterationInput"),
    sharedTypesSource.indexOf("// Live lifecycle", sharedTypesSource.indexOf("export interface AddDirectIterationInput")),
  );
  check(
    "the direct-iteration contract carries new attachments and persisted queue identity",
    directIterationInput.includes("attachments?: AddRunMessageAttachmentInput[]") &&
      directIterationInput.includes("queuedMessageIds?: string[]"),
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
  check(
    "the composer stays editable while a send or Resume is in flight",
    composerSource.includes("disabled={disabled}") && !composerSource.includes("disabled={disabled || busy}"),
  );
  // Editable means a paste can land mid-send: clearing every attachment once
  // the send returned silently dropped an image meant for the next message.
  check(
    "a finished send clears only the attachments it carried",
    composerSource.includes("current.filter((image) => !sentImages.includes(image))") &&
      composerSource.includes("!sentFileReferences.includes(reference)") &&
      !/setImages\(\[\]\);\s*setFileReferences\(\[\]\);\s*setMentionQuery\(null\);/.test(composerSource),
  );
  check(
    "a reply to a question that closed is sent as a message",
    /isQuestionInactiveError\([\s\S]{0,400}addRunMessage\(/.test(composerSource),
  );

  const conversationSource = fs.readFileSync(CHAT_CONVERSATION_TSX, "utf8");
  check(
    "queued rows render the Unqueue control wired to cancelQueuedMessage",
    conversationSource.includes("function UnqueueControl") &&
      conversationSource.includes("cancelQueuedMessage") &&
      /\{queued && <UnqueueControl runId=\{runId\} messageId=\{item\.id\} \/>\}/.test(conversationSource),
  );
  check(
    "a turn message handed back by a failed turn shows as queued",
    /item\.intent === "steer" \|\| \(item\.deliveryAttempts \?\? 0\) > 0/.test(conversationSource),
  );
  check(
    "Send now is hidden while the run waits on an answer",
    conversationSource.includes("{queued && !runBlocked && <SendNowControl runId={runId} />}") &&
      conversationSource.includes("Delivered with your answer"),
  );

  completed = true;
  console.log(failures === 0 ? "\nAll queued-message checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
