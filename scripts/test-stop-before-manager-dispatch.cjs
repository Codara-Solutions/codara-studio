// A Stop that lands after a Cora manager call is committed but before the
// backend has it must end that call: the backend is never asked and the call
// stays settled. Three cases:
//   1. a chat turn preparing its prompt, Stop finished before it goes on;
//   2. the same, with the Stop still tearing down when the turn rechecks
//      (the turn must wait for the Stop's commit, not read the state before);
//   3. the auto-compaction summary call, committed while a Stop tears down;
//   4. a Stop that starts in the tick between a recheck's look at the Stop
//      window and its read of the run, for the chat turn, for `/compact`
//      and for the automatic compaction after a turn (swept over every
//      microtask offset: no request may reach the backend once the Stop
//      began disposing);
//   5. `/compact` that a Stop overtook reports that nothing was compacted.
// Against the REAL run-store.ts, with the manager backend stubbed at
// backend-registry, the prompt preparation held open at subscription-headroom
// and the Stop's session disposal held open at disposeManagerSessions. The
// event journal and the Cora memory read are the real modules, wrapped so
// the test can start a Stop right after them.
//
//   node scripts/test-stop-before-manager-dispatch.cjs

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
// Inside the repository so the bundle resolves node_modules (packages stay external).
const CACHE = path.join(ROOT, "node_modules", ".cache", "stop-before-manager-dispatch-test");
fs.mkdirSync(CACHE, { recursive: true });

const ACCOUNTS = { anthropic: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10" };

const STUBS = {
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
  "node-pty": `export function spawn() { throw new Error("node-pty is stubbed"); }
export function exists() { return false; }
export default { spawn, exists };`,
  "./backend-registry": `const backend = (kind) => ({
  kind,
  displayName: "stub backend",
  async requestManagerDecision(input, onStream) { return globalThis.__stopManagerStub(input, onStream); },
  async disposeChat() {},
  interruptChat() {},
});
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions(runId) { globalThis.__disposing.add(runId); await globalThis.__disposeGate?.(); }`,
  "./pi-runtime-electron": `const ACCOUNTS = ${JSON.stringify(ACCOUNTS)};
export async function resolveCodaraPiExecutionAccount(input) {
  return {
    accountProfileId: input?.preferredAccountProfileId ?? ACCOUNTS[input?.provider] ?? ACCOUNTS.anthropic,
    provider: input?.provider ?? "anthropic",
    configDir: "/tmp/cora-route-stub-pi",
  };
}
export async function resolveCodaraPiRuntime() { throw new Error("pi runtime is stubbed"); }
export async function resolveCodaraPiLibrary() { throw new Error("pi runtime is stubbed"); }
export async function resolveUserPiRuntime() { throw new Error("pi runtime is stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/cora-route-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() { throw new Error("pi worker launch is stubbed"); }
`,
  // Held open by the test: the prompt is being prepared after the turn's
  // SparkCall was committed.
  "./subscription-headroom": `export function describeHeadroomForPrompt() { return null; }
export async function readCachedSubscriptionHeadroomSummary() { await globalThis.__headroomGate?.(); return null; }`,
};

// The real modules, with a hook right after the call that precedes each
// recheck: the journal entry of a started call, and the turn's memory read.
const ORCH = path.join(ROOT, "src", "main", "orchestration");
const WRAPPERS = {
  "./event-log": `export * from ${JSON.stringify(path.join(ORCH, "event-log.ts"))};
import { appendEvent as realAppendEvent, appendEvents as realAppendEvents } from ${JSON.stringify(path.join(ORCH, "event-log.ts"))};
export async function appendEvent(...args) {
  const result = await realAppendEvent(...args);
  globalThis.__afterAppend?.(args[0]);
  return result;
}
export async function appendEvents(events, ...rest) {
  const result = await realAppendEvents(events, ...rest);
  for (const event of events) globalThis.__afterAppend?.(event);
  return result;
}`,
  "./cora-memory": `export * from ${JSON.stringify(path.join(ORCH, "cora-memory.ts"))};
import { formatCoraMemoryForTurn as realFormat } from ${JSON.stringify(path.join(ORCH, "cora-memory.ts"))};
export async function formatCoraMemoryForTurn(workspaceId, runId, options) {
  const result = await realFormat(workspaceId, runId, options);
  globalThis.__afterMemory?.(runId);
  return result;
}`,
};

const stubPlugin = {
  name: "stop-before-dispatch-stubs",
  setup(build) {
    build.onResolve({ filter: /^\.\/(event-log|cora-memory)$/ }, (args) =>
      args.importer === RUN_STORE_TS ? { path: args.path, namespace: "wrap" } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "wrap" }, (args) => ({
      contents: WRAPPERS[args.path], loader: "ts", resolveDir: ORCH,
    }));
    build.onResolve(
      { filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron|\.\/subscription-headroom)$/ },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === undefined ? "" : ` - ${detail}`}`);
}
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-stop-before-dispatch-"));
const AT = "2026-11-19T09:00:00.000Z";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(20);
  }
  return Boolean(condition());
}

const backendCalls = new Map();
// Requests that reached the backend after a Stop of their run began
// disposing its sessions: each one is a session the Stop never ends.
const afterStopCalls = new Map();
globalThis.__disposing = new Set();
let backendResult = null;
globalThis.__stopManagerStub = async (input) => {
  backendCalls.set(input.run.id, (backendCalls.get(input.run.id) ?? 0) + 1);
  if (globalThis.__disposing.has(input.run.id)) {
    afterStopCalls.set(input.run.id, (afterStopCalls.get(input.run.id) ?? 0) + 1);
  }
  return backendResult?.(input) ?? {
    decision: { status: "complete", summary: "stub", chatReply: "Done.", steps: [], tasks: [] },
    durationMs: 1,
    model: "stub-model",
  };
};

/** Start a Stop of `runId` after `hops` microtasks. */
function stopAfterMicrotasks(runStore, runId, hops) {
  let left = hops;
  const step = () => {
    if (left-- > 0) queueMicrotask(step);
    else void runStore.forcePauseRun(runId).catch(() => undefined);
  };
  step();
}
const SWEEP = Number(process.env.STOP_TICK_SWEEP ?? 40);

/** A gate a stub waits on until the test opens it. */
function gate() {
  let entered = false;
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return {
    wait: async () => { entered = true; await opened; },
    entered: () => entered,
    open: () => open(),
  };
}

function writeRun(runId, overrides) {
  const dir = path.join(HOME, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
    id: runId, title: runId, status: "paused", executionMode: "managed",
    chatBackend: "pi", chatMode: "auto", chatModel: "claude-opus-5", workspaceId: "ws-stop", cwd: HOME,
    artifactDir: path.join(dir, "artifacts"), settingsSnapshot: { workspaceCwd: HOME },
    createdAt: AT, updatedAt: AT, conversationEpoch: 1,
    autopilot: { status: "paused", lastAction: "force_paused", pausedAt: AT, updatedAt: AT },
    steps: [], workerTasks: [], workerAttempts: [], sparkCalls: [], plans: [], assumptions: [],
    humanMessages: [{
      id: "msg-1", runId, author: "user", kind: "note", message: "build the parser", attachments: [],
      createdAt: AT, deliveryState: "queued", intent: "turn", conversationEpoch: 1,
    }],
    ...overrides,
  }, null, 2));
  return () => JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
}

function compactableRun(runId) {
  return {
    status: "running",
    chatSessionUuid: "4b7e9a2c-1d3f-4e5a-8b6c-7d8e9f0a1b2c",
    autopilot: { status: "running", updatedAt: AT },
    humanMessages: [
      { id: "msg-0", runId, author: "user", kind: "note", message: "earlier", attachments: [], createdAt: AT, deliveryState: "delivered", intent: "turn", conversationEpoch: 1 },
    ],
  };
}

function checkStoppedTurn(label, runId, after, liveId) {
  check(`${label}: the backend never receives the stopped turn`, !backendCalls.get(runId), `calls=${backendCalls.get(runId) ?? 0}`);
  check(`${label}: the run stays paused`, after.status === "paused", after.status);
  const call = after.sparkCalls.find((entry) => entry.id === liveId);
  check(`${label}: the call stays settled by the Stop`, call?.status === "failed" && /force pause/.test(call?.error ?? ""), JSON.stringify(call));
  const message = after.humanMessages.find((entry) => entry.id === "msg-1");
  check(
    `${label}: the message waits in the queue for Resume`,
    message?.deliveryState === "queued" && !message.backendTurnId,
    JSON.stringify(message),
  );
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  const entry = path.join(CACHE, "entry.ts");
  fs.writeFileSync(entry, `export * from ${JSON.stringify(RUN_STORE_TS)};\n`);
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"), plugins: [stubPlugin], packages: "external",
  });
  const runStore = require(outfile);
  const liveCall = (run) => run.sparkCalls.find((call) => call.status === "started" && !call.completedAt);

  // ── 1. Stop finished before the turn goes on ────────────────────────────
  {
    const runId = "run-stop-while-preparing";
    const readRun = writeRun(runId, {});
    const headroom = gate();
    globalThis.__headroomGate = headroom.wait;
    await runStore.resumeRun({ runId });
    check("the turn reached prompt preparation", await waitFor(headroom.entered));
    const live = liveCall(readRun());
    check("its SparkCall is committed and live", Boolean(live));
    await runStore.forcePauseRun(runId);
    headroom.open();
    await runStore.settleScheduledManagerWork(runId);
    checkStoppedTurn("Stop done first", runId, readRun(), live?.id);
    globalThis.__headroomGate = undefined;
  }

  // ── 2. Stop still tearing down when the turn rechecks ───────────────────
  {
    const runId = "run-stop-in-progress";
    const readRun = writeRun(runId, {});
    const headroom = gate();
    const dispose = gate();
    globalThis.__headroomGate = headroom.wait;
    await runStore.resumeRun({ runId });
    check("the turn reached prompt preparation", await waitFor(headroom.entered));
    const live = liveCall(readRun());
    globalThis.__disposeGate = dispose.wait;
    const stopped = runStore.forcePauseRun(runId);
    check("the Stop is tearing down", await waitFor(dispose.entered));
    // The turn goes on while the Stop has disposed nothing and committed
    // nothing yet: it must wait for the Stop, not dispatch.
    headroom.open();
    await sleep(50);
    check("Stop in progress: nothing was dispatched while it tore down", !backendCalls.get(runId), `calls=${backendCalls.get(runId) ?? 0}`);
    dispose.open();
    await stopped;
    await runStore.settleScheduledManagerWork(runId);
    checkStoppedTurn("Stop in progress", runId, readRun(), live?.id);
    globalThis.__headroomGate = undefined;
    globalThis.__disposeGate = undefined;
  }

  // ── 3. the compaction summary, committed while a Stop tears down ─────────
  {
    const runId = "run-stop-during-compaction";
    const readRun = writeRun(runId, {
      status: "running",
      chatSessionUuid: "4b7e9a2c-1d3f-4e5a-8b6c-7d8e9f0a1b2c",
      autopilot: { status: "running", updatedAt: AT },
      humanMessages: [
        { id: "msg-0", runId, author: "user", kind: "note", message: "earlier", attachments: [], createdAt: AT, deliveryState: "delivered", intent: "turn", conversationEpoch: 1 },
      ],
    });
    const dispose = gate();
    globalThis.__disposeGate = dispose.wait;
    const stopped = runStore.forcePauseRun(runId);
    check("compaction: the Stop is tearing down", await waitFor(dispose.entered));
    const compacting = runStore.compactConversation(runId).catch((error) => error);
    check(
      "compaction: its summary call is committed",
      await waitFor(() => readRun().sparkCalls.some((call) => call.purpose === "compaction")),
    );
    await sleep(50);
    const sentDuringStop = backendCalls.get(runId) ?? 0;
    dispose.open();
    await stopped;
    await compacting;
    const after = readRun();
    check("compaction: no summary is sent while the Stop tears down", sentDuringStop === 0 && !backendCalls.get(runId), `calls=${backendCalls.get(runId) ?? 0}`);
    check("compaction: the run stays paused", after.status === "paused", after.status);
    const call = after.sparkCalls.find((entry) => entry.purpose === "compaction");
    check("compaction: the summary call is settled", call?.status === "failed", JSON.stringify(call));
    globalThis.__disposeGate = undefined;
  }

  // ── 4. a Stop in the tick between the window check and the run read ─────
  {
    // The chat turn: the Stop starts right after the memory read, the last
    // await before the dispatch recheck.
    const leaked = [];
    let stops = 0;
    for (let hops = 0; hops <= SWEEP; hops += 1) {
      const runId = `run-stop-tick-turn-${hops}`;
      writeRun(runId, {});
      globalThis.__afterMemory = (id) => {
        if (id !== runId) return;
        globalThis.__afterMemory = undefined;
        stopAfterMicrotasks(runStore, runId, hops);
      };
      await runStore.resumeRun({ runId });
      await runStore.settleScheduledManagerWork(runId);
      await sleep(5);
      if (afterStopCalls.get(runId)) leaked.push(hops);
      if (globalThis.__disposing.has(runId)) stops += 1;
    }
    globalThis.__afterMemory = undefined;
    check(`tick race, chat turn: a Stop began in every swept run`, stops === SWEEP + 1, `stops=${stops}`);
    check("tick race, chat turn: nothing reaches the backend once a Stop began", leaked.length === 0, `at microtask offsets ${leaked.join(",")}`);
  }
  {
    // `/compact`: the Stop starts right after the summary call's journal entry.
    const leaked = [];
    let stops = 0;
    for (let hops = 0; hops <= SWEEP; hops += 1) {
      const runId = `run-stop-tick-compact-${hops}`;
      writeRun(runId, compactableRun(runId));
      globalThis.__afterAppend = (event) => {
        if (event?.runId !== runId || event.type !== "spark_call.started" || event.payload?.purpose !== "compaction") return;
        globalThis.__afterAppend = undefined;
        stopAfterMicrotasks(runStore, runId, hops);
      };
      await runStore.compactConversation(runId).catch(() => undefined);
      await sleep(5);
      if (afterStopCalls.get(runId)) leaked.push(hops);
      if (globalThis.__disposing.has(runId)) stops += 1;
    }
    globalThis.__afterAppend = undefined;
    check(`tick race, /compact: a Stop began in every swept run`, stops === SWEEP + 1, `stops=${stops}`);
    check("tick race, /compact: no summary reaches the backend once a Stop began", leaked.length === 0, `at microtask offsets ${leaked.join(",")}`);
  }
  {
    // The automatic compaction after a turn whose prompt filled the window.
    const leaked = [];
    let stops = 0;
    let compactionsStarted = 0;
    backendResult = (input) => /dense handoff/.test(String(input.prompt ?? ""))
      ? null
      : {
          decision: { status: "complete", summary: "stub", chatReply: "Done.", steps: [], tasks: [] },
          durationMs: 1,
          model: "stub-model",
          promptTokens: 990_000,
          contextTokens: 990_000,
          contextWindowTokens: 1_000_000,
        };
    for (let hops = 0; hops <= SWEEP; hops += 1) {
      const runId = `run-stop-tick-auto-${hops}`;
      writeRun(runId, { chatSessionUuid: "4b7e9a2c-1d3f-4e5a-8b6c-7d8e9f0a1b2c" });
      globalThis.__afterAppend = (event) => {
        if (event?.runId !== runId || event.type !== "spark_call.started" || event.payload?.purpose !== "compaction") return;
        globalThis.__afterAppend = undefined;
        compactionsStarted += 1;
        stopAfterMicrotasks(runStore, runId, hops);
      };
      await runStore.resumeRun({ runId });
      await runStore.settleScheduledManagerWork(runId);
      await sleep(5);
      if (afterStopCalls.get(runId)) leaked.push(hops);
      if (globalThis.__disposing.has(runId)) stops += 1;
    }
    globalThis.__afterAppend = undefined;
    backendResult = null;
    check("tick race, automatic compaction: the turn's high context started a compaction", compactionsStarted > 0, `started=${compactionsStarted}`);
    check(`tick race, automatic compaction: a Stop began in every swept run`, stops === SWEEP + 1, `stops=${stops}`);
    check("tick race, automatic compaction: no summary reaches the backend once a Stop began", leaked.length === 0, `at microtask offsets ${leaked.join(",")}`);
  }

  // ── 5. `/compact` overtaken by a Stop says it did not compact ────────────
  {
    const runId = "run-stop-overtakes-compact";
    const readRun = writeRun(runId, compactableRun(runId));
    const dispose = gate();
    globalThis.__disposeGate = dispose.wait;
    globalThis.__afterAppend = (event) => {
      if (event?.runId !== runId || event.type !== "spark_call.started") return;
      globalThis.__afterAppend = undefined;
      void runStore.forcePauseRun(runId);
    };
    const compacting = runStore.compactConversation(runId).then(() => null, (error) => error);
    check("/compact overtaken: the Stop is tearing down", await waitFor(dispose.entered));
    dispose.open();
    const outcome = await compacting;
    const after = readRun();
    check("/compact overtaken: the run is paused", after.status === "paused", after.status);
    check(
      "/compact overtaken: the command reports that nothing was compacted",
      outcome instanceof Error && /not compacted/i.test(outcome.message),
      outcome instanceof Error ? outcome.message : "resolved as compacted",
    );
    check(
      "/compact overtaken: no compaction call completed",
      !after.sparkCalls.some((call) => call.purpose === "compaction" && call.status === "completed"),
    );
    globalThis.__disposeGate = undefined;
    globalThis.__afterAppend = undefined;
  }

  completed = true;
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CACHE, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("stop before manager dispatch: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
