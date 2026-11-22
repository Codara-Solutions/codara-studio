// Regression harness for user messages sent while Cora works.
//
// A message sent during a live manager turn is QUEUED: it stays deliveryState
// "queued" and unowned while the turn runs, the live turn never sees it, and
// the steering-followup scheduler starts the next manager turn with it once
// the turn settles. While queued, the message can be pulled back out with
// cancelQueuedMessage (the renderer's Unqueue control), whose race guard
// refuses a message a turn already claimed, or sent at once with
// deliverQueuedMessagesNow (Send now), which stops the live turn and starts
// the next one with every queued message. Every path goes through the per-run
// turn lock, so a run never has two manager turns at once.
//
// Pinned here, against the REAL run-store.ts (manager backend stubbed at
// backend-registry, the one seam every provider goes through - the same
// esbuild/stub technique as scripts/test-force-pause-resume.cjs):
//
//   1. queue - a message sent while the manager is generating stays queued
//      for the live call (never claimed onto it), and the follow-up scheduler
//      delivers it in a fresh turn after settlement, exactly once.
//   2. unqueue - cancelQueuedMessage removes a still-queued message, returns
//      its text for the composer, and it never reaches any manager prompt.
//   3. race guard - cancelQueuedMessage refuses a message that a turn start
//      already claimed (backendTurnId set / deliveryState past "queued").
//   4. crash window - a queued message whose delivering turn dies before
//      settling is re-queued (releaseUnsubmittedManagerInput), never lost.
//   5. send now - deliverQueuedMessagesNow stops the live turn once the
//      provider has its prompt, keeps that turn's input delivered (never sent
//      twice), and starts one new chat turn carrying every queued message in
//      order (a prose answer completes a plain chat instead of failing it as
//      an empty plan_analysis); a request only covers the messages queued
//      when it was made, so a retry that took them is not stopped for a later
//      message; Send now then Unqueue of everything leaves no busy run; with
//      no live turn it just starts the turn; it returns the run for an empty
//      queue and refuses a run waiting on an answer.
//   5c. turn discipline - one manager turn per run at a time, a follow-up
//      that keeps failing stops re-arming, Stop keeps queued messages, and an
//      identical resend after delivery is a new message.
//   6. source seams - the agent-socket wait handler parks, claims and yields
//      nothing for user messages, the mid-turn delivery setting is gone, the
//      composer labels the send button Queue while a turn is active, and the
//      conversation renders Send now and Unqueue controls for queued rows.
//
//   node scripts/test-queued-messages.cjs
//
// Exits non-zero on any failed assertion.

const { completeStubExports } = require("./run-store-stub-exports.cjs");
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
  interruptChat(runId) {
    globalThis.__coraInterruptStub?.(runId);
  },
});
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions(runId) {
  await globalThis.__coraDisposeHook?.(runId);
}`;

const PI_RUNTIME_STUB = `export async function listCodaraPiSkillNames(cwd) { await globalThis.__coraSkillNamesHook?.(cwd); return new Set(); }
export async function resolveCodaraPiExecutionAccount() {
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
      contents: completeStubExports(args.path, STUBS[args.path]),
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
    `export * from ${JSON.stringify(RUN_STORE_TS)};\nexport { loadSettings, normalizeSettings, saveSettings } from ${JSON.stringify(STORAGE_TS)};\n`,
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

  // ── 5. send now: stop the live turn, then one turn with the whole queue ──
  const interrupts = [];
  const interruptHandlers = new Map();
  globalThis.__coraInterruptStub = (id) => {
    interrupts.push(id);
    interruptHandlers.get(id)?.();
  };
  const interruptsFor = (id) => interrupts.filter((entry) => entry === id).length;
  const messageText = (msgRunId, text) =>
    readRun(msgRunId).humanMessages.find((message) => message.message === text);
  function abortedResult() {
    return {
      decision: { status: "talk", summary: "interrupted", chatReply: "Cora's Pi turn was interrupted.", steps: [], tasks: [] },
      durationMs: 1,
      model: "stub-model",
      turnAborted: true,
    };
  }
  // Turn 1 takes the user's message, reports the prompt accepted only once
  // `accept` opens (the provider's preflight), and then runs until Send now
  // interrupts it or `release` opens. Every later turn settles at once, with
  // `laterResult`.
  function sendNowTurn(id, laterResult = askUserResult) {
    const entered = gate();
    const accept = gate();
    const release = gate();
    let interrupted = false;
    managerBehavior.set(id, async (calls, input) => {
      if (calls.length === 1) {
        entered.open();
        await accept.opened;
        const aborted = new Promise((resolve) => interruptHandlers.set(id, resolve)).then(() => {
          interrupted = true;
        });
        await input.onPromptAccepted?.();
        await Promise.race([aborted, release.opened]);
        return interrupted ? abortedResult() : completeResult();
      }
      await input.onPromptAccepted?.();
      return laterResult();
    });
    return { entered, accept, release, wasInterrupted: () => interrupted };
  }

  const FIRST_E = "Build the tokenizer first";
  const QUEUED_E1 = "Change of plans, target the beta branch";
  const QUEUED_E2 = "and keep the public API stable";
  const runE = writeRun(pausedRun("run-queued-send-now"));
  const turnE = sendNowTurn(runE);
  turnE.accept.open();
  await runStore.addRunMessage({ runId: runE, author: "user", kind: "note", message: FIRST_E });
  check("the send-now scenario's turn dispatched", await gateOpened(turnE.entered));
  check(
    "the live turn owns the user's message once the provider has it",
    await waitFor(() => messageText(runE, FIRST_E)?.deliveryState === "submitted"),
    JSON.stringify(messageText(runE, FIRST_E)),
  );
  await runStore.addRunMessage({ runId: runE, author: "user", kind: "note", message: QUEUED_E1 });
  await runStore.addRunMessage({ runId: runE, author: "user", kind: "note", message: QUEUED_E2 });
  await sleep(150);
  check(
    "messages sent during the turn wait in the queue, unowned",
    [QUEUED_E1, QUEUED_E2].every((text) => {
      const message = messageText(runE, text);
      return message?.deliveryState === "queued" && !message.backendTurnId;
    }),
  );
  check("nothing interrupts the turn before Send now", interruptsFor(runE) === 0);
  let sendNowError = null;
  try {
    await runStore.deliverQueuedMessagesNow(runE);
  } catch (error) {
    sendNowError = error;
  }
  check("deliverQueuedMessagesNow accepts a populated queue", !sendNowError, sendNowError?.message);
  check("Send now stops the live turn", interruptsFor(runE) === 1 && turnE.wasInterrupted(), `interrupts=${interruptsFor(runE)}`);
  check(
    "the next turn starts with the queued messages",
    await waitFor(() => callsFor(runE).length === 2),
    `calls=${callsFor(runE).length}`,
  );
  await runStore.settleScheduledManagerWork(runE);
  const promptE = callsFor(runE)[1]?.prompt ?? "";
  check(
    "the queued messages go together, in the order they were sent",
    promptE.includes(QUEUED_E1) &&
      promptE.includes(QUEUED_E2) &&
      promptE.indexOf(QUEUED_E1) < promptE.indexOf(QUEUED_E2),
    promptE.slice(0, 400),
  );
  check(
    "the new turn is told the user stopped the previous reply",
    promptE.includes("stopped your previous reply to send this now"),
  );
  check(
    "the interrupted turn's own message is not sent again",
    !promptE.includes(FIRST_E) &&
      callsFor(runE).filter((call) => call.prompt.includes(FIRST_E)).length === 1,
  );
  const firstE = messageText(runE, FIRST_E);
  check(
    "the interrupted turn keeps its input delivered",
    firstE?.deliveryState === "acknowledged" && !firstE?.redelivered && !(firstE?.deliveryAttempts > 0),
    JSON.stringify(firstE),
  );
  check(
    "the queued messages are delivered by the new turn",
    [QUEUED_E1, QUEUED_E2].every((text) => messageText(runE, text)?.deliveryState === "acknowledged"),
  );
  check(
    "Send now leaves exactly two manager turns",
    callsFor(runE).length === 2,
    `calls=${callsFor(runE).length}`,
  );
  const interruptedCallE = readRun(runE).sparkCalls.find((call) => call.inputMessageIds?.includes(firstE?.id));
  check(
    "the interrupted turn settles as stopped, not failed, and the run carries on",
    interruptedCallE?.status === "completed" &&
      readRun(runE).status !== "failed" &&
      readRun(runE).status !== "paused",
    JSON.stringify({ call: interruptedCallE?.status, run: readRun(runE).status }),
  );
  check(
    "the interrupt is journaled",
    readEvents(runE).some((event) => event.type === "run.send_now_interrupted"),
  );
  check(
    "the turn Send now starts is a chat turn, like any queued follow-up",
    callsFor(runE)[1]?.mode === "chat",
    callsFor(runE)[1]?.mode,
  );

  // A plain conversation (no step, no worker): Cora answers the queued
  // messages in prose. In plan_analysis that answer is refused as an empty
  // execution and fails the run.
  const FIRST_PROSE = "What does the tokenizer do with tabs?";
  const QUEUED_PROSE = "And with carriage returns?";
  const runProse = writeRun(pausedRun("run-send-now-prose"));
  const turnProse = sendNowTurn(runProse, completeResult);
  turnProse.accept.open();
  await runStore.addRunMessage({ runId: runProse, author: "user", kind: "note", message: FIRST_PROSE });
  await gateOpened(turnProse.entered);
  await waitFor(() => messageText(runProse, FIRST_PROSE)?.deliveryState === "submitted");
  await runStore.addRunMessage({ runId: runProse, author: "user", kind: "note", message: QUEUED_PROSE });
  await runStore.deliverQueuedMessagesNow(runProse);
  await waitFor(() => callsFor(runProse).length === 2);
  await runStore.settleScheduledManagerWork(runProse);
  await sleep(100);
  const settledProse = readRun(runProse);
  check(
    "a prose answer to the messages Send now delivered completes the chat",
    settledProse.status === "complete" && callsFor(runProse).length === 2,
    JSON.stringify({
      status: settledProse.status,
      lastAction: settledProse.autopilot?.lastAction,
      modes: callsFor(runProse).map((call) => call.mode),
    }),
  );
  check(
    "the answer to the queued message is delivered once",
    callsFor(runProse).filter((call) => call.prompt.includes(QUEUED_PROSE)).length === 1 &&
      messageText(runProse, QUEUED_PROSE)?.deliveryState === "acknowledged",
  );

  // Send now while the provider has not taken the live turn's prompt yet
  // waits for it: stopped in its preflight, that prompt could still land after
  // the next turn sent it again.
  const FIRST_PRE = "Profile the hot loop";
  const QUEUED_PRE = "Use the release build for it";
  const runPre = writeRun(pausedRun("run-send-now-preflight"));
  const turnPre = sendNowTurn(runPre);
  await runStore.addRunMessage({ runId: runPre, author: "user", kind: "note", message: FIRST_PRE });
  await gateOpened(turnPre.entered);
  await runStore.addRunMessage({ runId: runPre, author: "user", kind: "note", message: QUEUED_PRE });
  await runStore.deliverQueuedMessagesNow(runPre);
  await sleep(150);
  check("Send now does not stop a turn still in its preflight", interruptsFor(runPre) === 0);
  turnPre.accept.open();
  check(
    "the turn is stopped as soon as the provider has its prompt",
    await waitFor(() => interruptsFor(runPre) === 1),
  );
  await runStore.settleScheduledManagerWork(runPre);
  check(
    "after a preflight Send now each message reaches exactly one turn",
    callsFor(runPre).length === 2 &&
      callsFor(runPre).filter((call) => call.prompt.includes(FIRST_PRE)).length === 1 &&
      callsFor(runPre).filter((call) => call.prompt.includes(QUEUED_PRE)).length === 1,
    JSON.stringify(callsFor(runPre).map((call) => call.prompt.slice(0, 80))),
  );

  // Send now covers the messages queued when it was pressed. A turn that
  // already carries them is not stopped later for a message sent afterwards:
  // here the live turn fails before its prompt lands and its in-lock retry
  // takes the queue, then the user sends one more message during the retry.
  const FIRST_RETRY = "Port the cache layer";
  const QUEUED_RETRY = "Keep the eviction policy as is";
  const LATER_RETRY = "Also log cache misses";
  const runRetry = writeRun(pausedRun("run-send-now-retry"));
  const retryFirstEntered = gate();
  const retryFirstFail = gate();
  const retrySecondEntered = gate();
  const retrySecondAccept = gate();
  const retrySecondRelease = gate();
  managerBehavior.set(runRetry, async (calls, input) => {
    if (calls.length === 1) {
      retryFirstEntered.open();
      await retryFirstFail.opened;
      return {
        decision: { status: "talk", summary: "failed", chatReply: "", steps: [], tasks: [] },
        durationMs: 1,
        model: "stub-model",
        notice: "fetch failed: ECONNRESET",
        replaySafe: true,
        turnFailed: true,
      };
    }
    if (calls.length === 2) {
      retrySecondEntered.open();
      await retrySecondAccept.opened;
      await input.onPromptAccepted?.();
      await Promise.race([
        new Promise((resolve) => interruptHandlers.set(runRetry, resolve)),
        retrySecondRelease.opened,
      ]);
      return completeResult();
    }
    await input.onPromptAccepted?.();
    return askUserResult();
  });
  await runStore.addRunMessage({ runId: runRetry, author: "user", kind: "note", message: FIRST_RETRY });
  await gateOpened(retryFirstEntered);
  await runStore.addRunMessage({ runId: runRetry, author: "user", kind: "note", message: QUEUED_RETRY });
  await runStore.deliverQueuedMessagesNow(runRetry);
  retryFirstFail.open();
  check("the failed turn's retry starts", await gateOpened(retrySecondEntered, 8000));
  check(
    "the retry carries the message Send now was pressed for",
    callsFor(runRetry)[1]?.prompt.includes(QUEUED_RETRY),
    callsFor(runRetry)[1]?.prompt.slice(0, 200),
  );
  await runStore.addRunMessage({ runId: runRetry, author: "user", kind: "note", message: LATER_RETRY });
  retrySecondAccept.open();
  await sleep(200);
  check(
    "a message sent after Send now does not stop the turn that delivers the earlier queue",
    interruptsFor(runRetry) === 0,
    `interrupts=${interruptsFor(runRetry)}`,
  );
  retrySecondRelease.open();
  check(
    "the later message still gets its own turn",
    await waitFor(() => callsFor(runRetry).some((call) => call.prompt.includes(LATER_RETRY))),
  );
  await runStore.settleScheduledManagerWork(runRetry);
  check(
    "each message of the retry scenario reaches exactly one turn",
    [QUEUED_RETRY, LATER_RETRY].every(
      (text) => callsFor(runRetry).filter((call) => call.prompt.includes(text)).length === 1,
    ),
    JSON.stringify(callsFor(runRetry).map((call) => call.prompt.slice(0, 80))),
  );

  // A turn that already carries the whole queue is left alone.
  const FIRST_FULL = "Write the changelog";
  const runFull = writeRun(pausedRun("run-send-now-nothing-left"));
  const turnFull = sendNowTurn(runFull);
  await runStore.addRunMessage({ runId: runFull, author: "user", kind: "note", message: FIRST_FULL });
  await gateOpened(turnFull.entered);
  const sendNowFull = await runStore.deliverQueuedMessagesNow(runFull);
  turnFull.accept.open();
  await sleep(150);
  check(
    "Send now with nothing queued behind the live turn interrupts nothing",
    sendNowFull?.id === runFull && interruptsFor(runFull) === 0,
  );
  turnFull.release.open();
  await runStore.settleScheduledManagerWork(runFull);

  // Send now, then Unqueue everything before the stopped turn settles: no
  // queued message is left to start the next turn, and the run must still not
  // be left looking busy with nothing driving it.
  const FIRST_UNQ = "Draft the release notes";
  const QUEUED_UNQ = "Actually, include the migration guide";
  const LATER_UNQ = "Go ahead with the notes";
  const runUnq = writeRun(pausedRun("run-send-now-then-unqueue"));
  const unqEntered = gate();
  const unqInterrupted = gate();
  const unqSettle = gate();
  managerBehavior.set(runUnq, async (calls, input) => {
    if (calls.length === 1) {
      unqEntered.open();
      const aborted = new Promise((resolve) => interruptHandlers.set(runUnq, resolve));
      await input.onPromptAccepted?.();
      await aborted;
      unqInterrupted.open();
      await unqSettle.opened;
      return abortedResult();
    }
    await input.onPromptAccepted?.();
    return completeResult();
  });
  await runStore.addRunMessage({ runId: runUnq, author: "user", kind: "note", message: FIRST_UNQ });
  await gateOpened(unqEntered);
  await waitFor(() => messageText(runUnq, FIRST_UNQ)?.deliveryState === "submitted");
  await runStore.addRunMessage({ runId: runUnq, author: "user", kind: "note", message: QUEUED_UNQ });
  await runStore.deliverQueuedMessagesNow(runUnq);
  check("Send now stops the turn before the unqueue", await gateOpened(unqInterrupted));
  await runStore.cancelQueuedMessage({ runId: runUnq, messageId: messageText(runUnq, QUEUED_UNQ).id });
  unqSettle.open();
  await runStore.settleScheduledManagerWork(runUnq);
  await sleep(100);
  const restedUnq = readRun(runUnq);
  check(
    "a stopped turn with nothing left to send leaves no turn running",
    !restedUnq.sparkCalls.some((call) => call.status === "started" && !call.completedAt),
    JSON.stringify(restedUnq.sparkCalls.map((call) => call.status)),
  );
  check(
    "a stopped turn with nothing left to send does not leave the run looking busy",
    !["planning", "running", "reviewing"].includes(restedUnq.status),
    restedUnq.status,
  );
  check(
    "the stopped turn's input is not sent again when nothing follows it",
    callsFor(runUnq).filter((call) => call.prompt.includes(FIRST_UNQ)).length === 1,
    JSON.stringify(callsFor(runUnq).map((call) => call.prompt.slice(0, 80))),
  );
  await runStore.addRunMessage({ runId: runUnq, author: "user", kind: "note", message: LATER_UNQ });
  check(
    "the next message after that starts a turn",
    await waitFor(() => callsFor(runUnq).some((call) => call.prompt.includes(LATER_UNQ))),
    JSON.stringify({ status: readRun(runUnq).status, calls: callsFor(runUnq).length }),
  );
  await runStore.settleScheduledManagerWork(runUnq);
  check(
    "a later turn is not told the user stopped a reply to send it",
    !(callsFor(runUnq).find((call) => call.prompt.includes(LATER_UNQ))?.prompt ?? "").includes(
      "stopped your previous reply",
    ),
  );

  // No live turn: Send now just starts one. The queued message has spent its
  // automatic delivery budget, so only the explicit action delivers it.
  const QUEUED_IDLE = "Pick the parser work back up";
  const runIdle = writeRun(
    pausedRun("run-send-now-idle", {
      status: "running",
      autopilot: { status: "running", lastAction: "workers_running", updatedAt: PAUSED_AT },
      humanMessages: [
        ...pausedRun("run-send-now-idle").humanMessages,
        {
          id: "msg-idle-queued",
          runId: "run-send-now-idle",
          author: "user",
          kind: "note",
          message: QUEUED_IDLE,
          attachments: [],
          createdAt: PAUSED_AT,
          deliveryState: "queued",
          deliveryAttempts: 2,
          intent: "steer",
          conversationEpoch: 1,
        },
      ],
    }),
  );
  managerBehavior.set(runIdle, async () => completeResult());
  await runStore.deliverQueuedMessagesNow(runIdle);
  check(
    "Send now with no live turn starts one with the queue",
    await waitFor(() => callsFor(runIdle).some((call) => call.prompt.includes(QUEUED_IDLE))),
  );
  await runStore.settleScheduledManagerWork(runIdle);
  check(
    "Send now with no live turn interrupts nothing and delivers once",
    interruptsFor(runIdle) === 0 && callsFor(runIdle).filter((call) => call.prompt.includes(QUEUED_IDLE)).length === 1,
    `interrupts=${interruptsFor(runIdle)} calls=${callsFor(runIdle).length}`,
  );
  check(
    "a turn started by Send now without an interrupt carries no interrupt note",
    !callsFor(runIdle)[0]?.prompt.includes("stopped your previous reply"),
  );

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
  globalThis.__coraInterruptStub = undefined;

  const settings = await runStore.loadSettings();
  check(
    "a settings file from before drops the mid-turn delivery key",
    !("coraMidTurnDelivery" in runStore.normalizeSettings({ ...settings, coraMidTurnDelivery: "queue" })),
  );

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
    await runStore.addRunMessage({ runId: runS, author: "user", kind: "note", message: QUEUED_S });
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
      restartedV?.redelivered === true,
    JSON.stringify(restartedV),
  );

  // ── 5g. the manager plan belongs to the request that recorded it ────────
  const openPlan = (requestMessageId) => ({
    goal: "Ship auth, billing and docs",
    milestones: [
      { id: "m1", title: "Auth", status: "done" },
      { id: "m2", title: "Billing", status: "pending" },
    ],
    updatedAt: PAUSED_AT,
    ...(requestMessageId ? { requestMessageId } : {}),
  });
  const runW = writeRun(pausedRun("run-plan-stamp"));
  await runStore.updateManagerPlan(runW, {
    goal: "Ship the parser",
    milestones: [{ id: "m1", title: "Lexer", status: "pending" }],
  });
  check(
    "a recorded plan is stamped with the request it serves",
    readRun(runW).managerPlan?.requestMessageId === "msg-1",
    JSON.stringify(readRun(runW).managerPlan),
  );

  const runX = writeRun(
    pausedRun("run-plan-new-request", {
      status: "complete",
      autopilot: { status: "complete", lastAction: "completed", updatedAt: PAUSED_AT },
      managerPlan: openPlan("msg-1"),
    }),
  );
  managerBehavior.set(runX, async () => completeResult());
  await runStore.addRunMessage({ runId: runX, author: "user", kind: "note", message: "Fix the typo in the README" });
  await runStore.settleScheduledManagerWork(runX);
  check(
    "a new request on a finished run drops the old plan",
    !readRun(runX).managerPlan,
    JSON.stringify(readRun(runX).managerPlan),
  );

  const runY = writeRun(pausedRun("run-plan-cancel", { managerPlan: openPlan("msg-1") }));
  await runStore.cancelRun({ runId: runY });
  check("cancel drops the plan", !readRun(runY).managerPlan, JSON.stringify(readRun(runY).managerPlan));

  const planRewind = (id, requestMessageId) =>
    writeRun(
      pausedRun(id, {
        humanMessages: [
          ...pausedRun(id).humanMessages,
          {
            id: "msg-plan-request",
            runId: id,
            author: "user",
            kind: "note",
            message: "Now add billing and docs",
            attachments: [],
            createdAt: new Date(Date.parse(PAUSED_AT) + 60_000).toISOString(),
            deliveryState: "queued",
            intent: "steer",
            conversationEpoch: 1,
          },
        ],
        managerPlan: openPlan(requestMessageId),
      }),
    );
  const runZ = planRewind("run-plan-rewound", "msg-plan-request");
  await runStore.stopAndUndoPending(runZ);
  await runStore.settleScheduledManagerWork(runZ);
  check(
    "undoing the message a plan was recorded for drops the plan",
    !readRun(runZ).managerPlan,
    JSON.stringify(readRun(runZ).managerPlan),
  );
  const runZ2 = planRewind("run-plan-kept", "msg-1");
  await runStore.stopAndUndoPending(runZ2);
  await runStore.settleScheduledManagerWork(runZ2);
  check(
    "undoing a later message keeps the plan of the request it belongs to",
    readRun(runZ2).managerPlan?.requestMessageId === "msg-1",
    JSON.stringify(readRun(runZ2).managerPlan),
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
      !waitBody.includes("user_message") &&
      !waitBody.includes("Steer"),
  );

  const storeSource = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "run-store no longer owns a parked-wait registry",
    !storeSource.includes("parkedManagerWaits") &&
      !storeSource.includes("enterManagerWaitPark"),
  );
  check(
    "nothing hands a queued message to the live turn",
    !storeSource.includes("steerChat") &&
      !storeSource.includes("steeredAt") &&
      !storeSource.includes("coraMidTurnDelivery"),
  );
  check(
    "the mid-turn delivery setting is gone from settings and types",
    !fs.readFileSync(STORAGE_TS, "utf8").includes("coraMidTurnDelivery") &&
      !fs.readFileSync(SHARED_TYPES_TS, "utf8").includes("coraMidTurnDelivery") &&
      !fs.readFileSync(SHARED_TYPES_TS, "utf8").includes("CoraMidTurnDelivery"),
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
      /startFinishedDirectChatQueue\(run, queuedDirectMessages\)/.test(storeSource) &&
      /queuedMessageIds: queued\.map/.test(storeSource) &&
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
    "the composer hint during a live turn says the message queues and how to send it now",
    /isActive\s*\?\s*"Message Cora\. It waits for her next turn, or press Send now on it to interrupt her\."/.test(composerSource) &&
      !composerSource.includes("useCoraMidTurnDelivery"),
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

  // ── 7. direct chat Send now ─────────────────────────────────────────────
  // A direct chat has no manager turn: one Pi worker does the pass. Send now
  // stops that worker (marked a Send now stop, never a failure), and the next
  // pass starts with every queued message, each delivered exactly once. A
  // message queued while a pass runs also goes on its own when the pass ends.
  // Driven by the scripted Pi worker (CODARA_FAKE_PI_WORKERS).
  process.env.CODARA_FAKE_PI_WORKERS = "1";
  const directCwd = fs.mkdtempSync(path.join(HOME, "direct-ws-"));
  const startDirect = (note) =>
    runStore.startAutopilot({
      workspaceId: WS,
      workspaceName: "direct",
      cwd: directCwd,
      initialUserNote: note,
      executionStrategy: "direct",
      chatModel: "gpt-5.6-sol",
      chatMode: "auto",
    });
  const liveAttempt = (runId) =>
    readRun(runId).workerAttempts.find((entry) => ["prompt_ready", "launching", "running", "finishing"].includes(entry.status));
  const direct = await startDirect("Rename the counter. FAKE_DELAY_MS=600000");
  check("a direct chat starts in direct mode", direct.executionMode === "direct", direct.executionMode);
  check("its first pass is running", await waitFor(() => liveAttempt(direct.id)?.status === "running", 8000),
    JSON.stringify(readRun(direct.id).workerAttempts.map((entry) => entry.status)));
  const DIRECT_Q = "Also cover the empty list. FAKE_DELAY_MS=200";
  await runStore.addRunMessage({ runId: direct.id, author: "user", kind: "note", message: DIRECT_Q });
  const queuedDirect = readRun(direct.id).humanMessages.find((entry) => entry.message === DIRECT_Q);
  check("a message sent mid-pass is queued", queuedDirect?.deliveryState === "queued", queuedDirect?.deliveryState);
  const firstAttemptId = liveAttempt(direct.id)?.id;
  let directSendNowError = null;
  await runStore.deliverQueuedMessagesNow(direct.id).catch((error) => {
    directSendNowError = error;
  });
  check("Send now on a direct chat does not throw", directSendNowError === null, String(directSendNowError));
  const secondPassDone = await waitFor(() => {
    const state = readRun(direct.id);
    return state.status === "complete" && state.workerAttempts.length === 2;
  }, 10000);
  const directAfter = readRun(direct.id);
  check("the next pass ran and the chat settled complete", secondPassDone,
    JSON.stringify({ status: directAfter.status, attempts: directAfter.workerAttempts.map((entry) => entry.status) }));
  const stopped = directAfter.workerAttempts.find((entry) => entry.id === firstAttemptId);
  check("the stopped pass is a Send now stop, not a failure",
    stopped?.status === "cancelled" && stopped?.interruptedBy === "send_now",
    JSON.stringify({ status: stopped?.status, interruptedBy: stopped?.interruptedBy }));
  const secondTask = directAfter.workerTasks.find((entry) => entry.id === directAfter.workerAttempts[1]?.workerTaskId);
  check("the queued message is in the next pass's prompt exactly once",
    (secondTask?.description.split(DIRECT_Q).length ?? 0) - 1 === 1,
    secondTask?.description.slice(-200));
  const deliveredDirect = directAfter.humanMessages.find((entry) => entry.id === queuedDirect?.id);
  check("the queued message is acknowledged", deliveredDirect?.deliveryState === "acknowledged", deliveredDirect?.deliveryState);
  check("the next pass is named after its message, not 'Cora follow-up N'",
    directAfter.steps.length === 2 && directAfter.steps[1].title.startsWith("Also cover the empty list"),
    JSON.stringify(directAfter.steps.map((entry) => entry.title)));
  check("no failure note was left for the stopped pass",
    !directAfter.humanMessages.some((entry) => entry.author !== "user" && /fail/i.test(entry.message ?? "")),
    JSON.stringify(directAfter.humanMessages.filter((entry) => entry.author !== "user").map((entry) => entry.message)));

  // Without Send now, a message queued during a pass goes once the pass ends.
  const handOff = await startDirect("Read the readme. FAKE_DELAY_MS=600");
  await waitFor(() => liveAttempt(handOff.id)?.status === "running", 8000);
  const HANDOFF_Q = "Then list the scripts. FAKE_DELAY_MS=100";
  await runStore.addRunMessage({ runId: handOff.id, author: "user", kind: "note", message: HANDOFF_Q });
  const handedOff = await waitFor(() => {
    const state = readRun(handOff.id);
    return state.status === "complete" && state.workerAttempts.length === 2;
  }, 10000);
  const handOffAfter = readRun(handOff.id);
  check("a message queued during a pass goes on its own when the pass ends", handedOff,
    JSON.stringify({ status: handOffAfter.status, attempts: handOffAfter.workerAttempts.map((entry) => entry.status) }));
  check("both passes succeeded", handOffAfter.workerAttempts.every((entry) => entry.status === "succeeded"));
  // A message the direct worker cannot serve, queued during a pass, goes to
  // the manager when the pass ends, as it would sent to a finished chat.
  const escalate = await startDirect("Read the readme again. FAKE_DELAY_MS=600");
  await waitFor(() => liveAttempt(escalate.id)?.status === "running", 8000);
  const ESCALATE_Q = "Spawn sub-agents to fix each failing file.";
  await runStore.addRunMessage({ runId: escalate.id, author: "user", kind: "note", message: ESCALATE_Q });
  const escalated = await waitFor(() => readRun(escalate.id).executionMode === "managed", 10000);
  const escalateAfter = readRun(escalate.id);
  check("a queued delegation request goes to the manager after the pass", escalated,
    JSON.stringify({ mode: escalateAfter.executionMode, status: escalateAfter.status }));
  check("no direct pass was given the delegation request",
    !escalateAfter.workerTasks.some((task) => task.description.includes(ESCALATE_Q)));
  check("the manager got the queued request",
    await waitFor(() => callsFor(escalate.id).some((call) => call.prompt.includes(ESCALATE_Q)), 8000));

  // "Always verify edits" sends every queued message to the manager too.
  const settingsBefore = runStore.loadSettings();
  const verifySettings = await settingsBefore;
  await runStore.saveSettings(runStore.normalizeSettings({ ...verifySettings, coraAlwaysVerifyEdits: true }));
  const verify = await startDirect("Read the readme once more. FAKE_DELAY_MS=600");
  await waitFor(() => liveAttempt(verify.id)?.status === "running", 8000);
  await runStore.addRunMessage({ runId: verify.id, author: "user", kind: "note", message: "Then rename the counter." });
  check("with always-verify on, a queued message goes to the manager after the pass",
    await waitFor(() => readRun(verify.id).executionMode === "managed", 10000),
    readRun(verify.id).executionMode);
  await runStore.saveSettings(runStore.normalizeSettings({ ...verifySettings, coraAlwaysVerifyEdits: false }));

  // Fixtures for the settle path (settleRecoveredDirectAttempt finalizes a
  // pass whose attempt is already terminal).
  const settledDirect = (id, attemptExtra, reportStatus, extra = {}) => {
    const reportPath = path.join(HOME, "runs", id, "report.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    if (reportStatus) {
      fs.writeFileSync(reportPath, JSON.stringify({
        status: reportStatus, summary: "Renamed the counter and the tests pass.",
        files_changed: [], commands_run: [], tests: [], proof: [], risks: [], followups: [], handoff: [],
      }));
    }
    return writeRun(pausedRun(id, {
      status: "running",
      executionMode: "direct",
      cwd: directCwd,
      settingsSnapshot: { workspaceCwd: directCwd },
      chatModel: "gpt-5.6-sol",
      autopilot: { status: "running", updatedAt: PAUSED_AT },
      sparkCalls: [],
      steps: [{
        id: `${id}-step`, runId: id, index: 1, title: "Rename", goal: "g", kind: "worker_batch", status: "running",
        plannedAgents: [], acceptanceCriteria: [], verificationCommands: [], workerTaskIds: [`${id}-task`],
        createdAt: PAUSED_AT, updatedAt: PAUSED_AT,
      }],
      workerTasks: [{
        id: `${id}-task`, runId: id, stepId: `${id}-step`, title: "Rename", description: "Rename the counter.",
        runtimePreference: "pi", status: "running", allowedPaths: [], forbiddenPaths: [], expectedOutputs: [],
        verificationCommands: [], canRunParallel: false, conflictsWith: [], createdBy: "spark",
        createdAt: PAUSED_AT, updatedAt: PAUSED_AT,
      }],
      workerAttempts: [{
        id: `${id}-attempt`, runId: id, workerTaskId: `${id}-task`, attemptNumber: 1, runtime: "pi",
        model: "gpt-5.6-sol", cwd: directCwd, startedAt: PAUSED_AT, finishedAt: PAUSED_AT,
        ...(reportStatus ? { finalReportPath: reportPath } : {}),
        ...attemptExtra,
      }],
      ...extra,
    }));
  };

  // Send now while the worker is finishing: it is not stopped, its answer
  // stands, and the hand-off sends the queue after it.
  const finishingId = settledDirect("run-direct-finishing", { status: "finishing", finishedAt: undefined }, null, {
    humanMessages: [{
      id: "msg-f", runId: "run-direct-finishing", author: "user", kind: "note", message: "And the docs.",
      attachments: [], createdAt: PAUSED_AT, deliveryState: "queued", intent: "steer", conversationEpoch: 1,
    }],
  });
  await runStore.deliverQueuedMessagesNow(finishingId);
  const finishingAttempt = readRun(finishingId).workerAttempts[0];
  check("Send now leaves a finishing worker alone",
    finishingAttempt.status === "finishing" && !finishingAttempt.interruptedBy,
    JSON.stringify({ status: finishingAttempt.status, interruptedBy: finishingAttempt.interruptedBy }));

  // A worker that exits 0 after Send now stopped it keeps its turn and reply.
  const lateId = settledDirect("run-direct-late-finish", { status: "succeeded", interruptedBy: "send_now", exitCode: 0 }, "complete");
  await runStore.settleRecoveredDirectAttempt(lateId, `${lateId}-attempt`);
  const late = readRun(lateId);
  check("a worker that finished after Send now keeps its turn",
    late.workerTasks[0].status === "accepted" && late.status === "complete",
    JSON.stringify({ task: late.workerTasks[0].status, status: late.status }));
  check("its reply is posted",
    late.humanMessages.some((message) => message.author === "spark" && message.message.includes("Renamed the counter")));

  // A message sent while the pass settles is read when the settle commits,
  // so it starts the next pass instead of waiting in a finished chat.
  // The settle reads the run, then its report; reading the report is held
  // until the message has landed, so it lands in that gap, before the settle
  // commits.
  const raceId = settledDirect("run-direct-settle-race", { status: "succeeded", exitCode: 0 }, "complete");
  const raceReport = readRun(raceId).workerAttempts[0].finalReportPath;
  const fsPromises = require("node:fs/promises");
  const realReadFile = fsPromises.readFile;
  const reportHeld = gate();
  let reportRead = false;
  fsPromises.readFile = async (file, ...rest) => {
    if (file === raceReport && !reportRead) {
      reportRead = true;
      await reportHeld.opened;
    }
    return realReadFile.call(fsPromises, file, ...rest);
  };
  const RACE_Q = "Also update the changelog. FAKE_DELAY_MS=100";
  const settling = runStore.settleRecoveredDirectAttempt(raceId, `${raceId}-attempt`);
  check("the settle is reading the report", await waitFor(() => reportRead, 4000));
  await runStore.addRunMessage({ runId: raceId, author: "user", kind: "note", message: RACE_Q });
  check("the message queued while the pass was settling",
    readRun(raceId).humanMessages.find((message) => message.message === RACE_Q)?.deliveryState === "queued");
  reportHeld.open();
  await settling;
  fsPromises.readFile = realReadFile;
  const raceDone = await waitFor(() => {
    const state = readRun(raceId);
    return state.workerTasks.some((task) => task.description.includes(RACE_Q));
  }, 10000);
  const raceAfter = readRun(raceId);
  check("the settle itself handed the queue on, so the chat never read as finished",
    readEvents(raceId).some((event) => event.type === "direct_run.queue_handoff"),
    JSON.stringify(readEvents(raceId).map((event) => event.type)));
  check("a message sent while a pass settles starts the next pass", raceDone,
    JSON.stringify({ status: raceAfter.status, queued: raceAfter.humanMessages.map((m) => m.deliveryState) }));
  if (!raceDone) console.log(JSON.stringify({ events: readEvents(raceId).map((e) => `${e.type}: ${e.message}`).slice(-12), stop: raceAfter.autopilot, tasks: raceAfter.workerTasks.map((t) => t.description.slice(-80)), msgs: raceAfter.humanMessages.map((m) => `${m.author}:${m.message.slice(0,60)}`) }, null, 1));
  check("that message is not left queued", await waitFor(() =>
    !readRun(raceId).humanMessages.some((message) => message.deliveryState === "queued"), 10000));

  // The other side of that race: the message is read while the pass still
  // runs but recorded after the settle committed "complete" with an empty
  // queue. Its attachment copy is held until the settle has committed.
  const lateMsgId = settledDirect("run-direct-late-message", { status: "succeeded", exitCode: 0 }, "complete");
  const lateSource = path.join(HOME, "late-note.txt");
  fs.writeFileSync(lateSource, "notes");
  const realStat = fsPromises.stat;
  const statHeld = gate();
  let statReached = false;
  fsPromises.stat = async (file, ...rest) => {
    if (file === lateSource && !statReached) {
      statReached = true;
      await statHeld.opened;
    }
    return realStat.call(fsPromises, file, ...rest);
  };
  const LATE_Q = "Also add a test for the empty list. FAKE_DELAY_MS=100";
  const lateSending = runStore.addRunMessage({
    runId: lateMsgId, author: "user", kind: "note", message: LATE_Q,
    attachments: [{ sourcePath: lateSource, kind: "file" }],
  });
  check("the message was read while the pass still ran", await waitFor(() => statReached, 4000));
  await runStore.settleRecoveredDirectAttempt(lateMsgId, `${lateMsgId}-attempt`);
  check("the settle committed first and found no queue", readRun(lateMsgId).status === "complete", readRun(lateMsgId).status);
  statHeld.open();
  await lateSending;
  fsPromises.stat = realStat;
  check("a message recorded after the chat finished starts the next pass", await waitFor(() =>
    readRun(lateMsgId).workerTasks.some((task) => task.description.includes(LATE_Q)), 10000),
  JSON.stringify({ status: readRun(lateMsgId).status, msgs: readRun(lateMsgId).humanMessages.map((m) => m.deliveryState) }));
  check("and is not left queued", await waitFor(() =>
    !readRun(lateMsgId).humanMessages.some((message) => message.deliveryState === "queued"), 10000));
  check("a long message names its turn up to a word, with one ellipsis character",
    readRun(lateMsgId).steps.at(-1)?.title === "Also add a test for the empty list.\u2026",
    readRun(lateMsgId).steps.at(-1)?.title);

  // Send now on a paused direct chat (its worker gone) resumes it, and the
  // queue reaches a pass.
  const PAUSED_Q = "Rename it back. FAKE_DELAY_MS=100";
  const pausedDirectId = settledDirect("run-direct-paused", { status: "cancelled", interruptedBy: "pause" }, null, {
    status: "paused",
    autopilot: { status: "paused", lastAction: "paused_by_user", stopReason: "Paused by user", updatedAt: PAUSED_AT },
    humanMessages: [{
      id: "msg-p", runId: "run-direct-paused", author: "user", kind: "note", message: PAUSED_Q,
      attachments: [], createdAt: PAUSED_AT, deliveryState: "queued", intent: "steer", conversationEpoch: 1,
    }],
  });
  let pausedSendNowError = null;
  await runStore.deliverQueuedMessagesNow(pausedDirectId).catch((error) => {
    pausedSendNowError = error;
  });
  check("Send now on a paused direct chat does not throw", pausedSendNowError === null, String(pausedSendNowError));
  check("Send now on a paused direct chat resumes it into a pass with the queue", await waitFor(() => {
    const state = readRun(pausedDirectId);
    return state.workerTasks.some((task) => task.description.includes(PAUSED_Q)) && state.status === "complete";
  }, 10000), JSON.stringify({ status: readRun(pausedDirectId).status, attempts: readRun(pausedDirectId).workerAttempts.map((a) => a.status) }));
  check("the paused chat's queued message is delivered",
    readRun(pausedDirectId).humanMessages.find((message) => message.id === "msg-p")?.deliveryState === "acknowledged");

  // Resume on a finished direct chat routes its queue like the hand-off: a
  // delegation request goes to the manager, not to another direct pass.
  const resumeEscalateId = settledDirect("run-direct-resume-escalate", { status: "succeeded", exitCode: 0 }, "complete", {
    status: "complete",
    autopilot: { status: "idle", lastAction: "direct_run_finalized", updatedAt: PAUSED_AT },
    humanMessages: [{
      id: "msg-r", runId: "run-direct-resume-escalate", author: "user", kind: "note",
      message: "Use sub-agents to fix each failing file", attachments: [], createdAt: PAUSED_AT,
      deliveryState: "queued", intent: "steer", conversationEpoch: 1,
    }],
  });
  await runStore.resumeRun({ runId: resumeEscalateId });
  check("Resume sends a finished direct chat's delegation request to the manager",
    readRun(resumeEscalateId).executionMode === "managed" && readRun(resumeEscalateId).workerTasks.length === 1,
    JSON.stringify({ mode: readRun(resumeEscalateId).executionMode, tasks: readRun(resumeEscalateId).workerTasks.length }));

  // A message taken back between the hand-off's read and its claim: nothing
  // is left to send, so the chat ends "complete", not "failed". The typed
  // slash command makes the hand-off look up skills, which is where it waits
  // while the message is unqueued.
  const takenBackId = settledDirect("run-direct-taken-back", { status: "succeeded", exitCode: 0 }, "complete", {
    humanMessages: [{
      id: "msg-t", runId: "run-direct-taken-back", author: "user", kind: "note", message: "/notaskill tidy the docs",
      typedByUser: true, attachments: [], createdAt: PAUSED_AT, deliveryState: "queued", intent: "steer", conversationEpoch: 1,
    }],
  });
  let unqueuedInGap = false;
  globalThis.__coraSkillNamesHook = async () => {
    if (unqueuedInGap) return;
    unqueuedInGap = true;
    await runStore.cancelQueuedMessage({ runId: takenBackId, messageId: "msg-t" });
  };
  await runStore.settleRecoveredDirectAttempt(takenBackId, `${takenBackId}-attempt`);
  delete globalThis.__coraSkillNamesHook;
  const takenBack = readRun(takenBackId);
  check("the message was unqueued between the read and the claim", unqueuedInGap && !takenBack.humanMessages.some((m) => m.id === "msg-t"));
  check("a hand-off whose message was taken back ends complete", takenBack.status === "complete",
    JSON.stringify({ status: takenBack.status, stop: takenBack.autopilot?.stopReason }));
  check("and posts no failure note",
    !takenBack.humanMessages.some((message) => message.author === "spark" && /could not start/i.test(message.message)));

  // A launch that throws after the claim: the chat fails and says so.
  const launchFailId = settledDirect("run-direct-launch-fails", { status: "succeeded", exitCode: 0 }, "complete", {
    humanMessages: [{
      id: "msg-l", runId: "run-direct-launch-fails", author: "user", kind: "note", message: "Then rename the file.",
      attachments: [], createdAt: PAUSED_AT, deliveryState: "queued", intent: "steer", conversationEpoch: 1,
    }],
  });
  // The launch breaks after the claim: writing the pass's new step fails.
  const launchFailDir = path.join(HOME, "runs", launchFailId);
  const realWriteFile = fsPromises.writeFile;
  let launchBroke = false;
  fsPromises.writeFile = async (file, data, ...rest) => {
    if (!launchBroke && String(file).startsWith(`${launchFailDir}${path.sep}run.json`) && typeof data === "string") {
      const draft = JSON.parse(data);
      const claimed = draft.humanMessages?.find((m) => m.id === "msg-l")?.deliveryState === "acknowledged";
      if (claimed && draft.steps?.length === 2) {
        launchBroke = true;
        throw new Error("disk full");
      }
    }
    return realWriteFile.call(fsPromises, file, data, ...rest);
  };
  await runStore.settleRecoveredDirectAttempt(launchFailId, `${launchFailId}-attempt`).catch(() => undefined);
  fsPromises.writeFile = realWriteFile;
  const launchFailed = readRun(launchFailId);
  check("the launch broke after the claim", launchBroke);
  check("a launch that throws after the claim leaves the chat failed", launchFailed.status === "failed",
    JSON.stringify({ status: launchFailed.status, stop: launchFailed.autopilot?.stopReason }));
  check("and says so in the chat",
    launchFailed.humanMessages.some((message) => message.author === "spark" && message.message.startsWith("I could not start on your next message")),
    JSON.stringify(launchFailed.humanMessages.map((m) => `${m.author}: ${m.message.slice(0, 80)}`)));
  delete process.env.CODARA_FAKE_PI_WORKERS;

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
    conversationSource.includes("{queued && !runBlocked && sendNowOffered && <SendNowControl runId={runId} />}") &&
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
