// A manager turn that THROWS before streaming (no connected account, a
// credential Pi refused at launch) must park the run like a streamed turn
// failure does: paused, with a managerTurnRecovery token naming the failed
// call, so the composer offers Retry. It must not park on a "check the run
// log" question that asks the user to answer an error.
//
// Runs the REAL run-store.ts with the manager backend stubbed at
// backend-registry (the technique of scripts/test-queued-messages.cjs).
//
//   node scripts/test-manager-turn-thrown-park.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-thrown-park-test");

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
  name: "cora-thrown-park-stubs",
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-thrown-park-"));
const WS = "ws-thrown-park-test";
const PAUSED_AT = "2026-08-11T09:00:00.000Z";

function pausedRun(id, overrides = {}) {
  return {
    id,
    title: "thrown park",
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

const managerBehavior = new Map();
globalThis.__coraManagerStub = async (input) => {
  const behavior = managerBehavior.get(input.run.id);
  if (!behavior) throw new Error("no stub behavior for this run");
  return behavior(input);
};

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  // 1. An auth failure thrown at launch parks with a Retry-able recovery.
  const authRun = writeRun(pausedRun("run-thrown-auth"));
  managerBehavior.set(authRun, async () => {
    throw new Error("Pi provider openai-codex is not authenticated with OAuth");
  });
  await runStore.resumeRun({ runId: authRun }).catch(() => undefined);
  const parkedOk = await waitFor(() => readRun(authRun).managerTurnRecovery?.state === "parked");
  const parked = readRun(authRun);
  check("the thrown auth failure parks the run", parkedOk && parked.status === "paused", parked.status);
  check(
    "the park is stamped as a parked chat turn so the composer shows Retry",
    parked.autopilot?.lastAction === "chat_turn_parked",
    parked.autopilot?.lastAction,
  );
  check(
    "the park reason points at Settings > Agents",
    /Settings > Agents/.test(parked.autopilot?.stopReason ?? ""),
    parked.autopilot?.stopReason,
  );
  const failedCall = parked.sparkCalls.find(
    (call) => call.status === "failed" && call.id !== "spark-interrupted",
  );
  check(
    "the recovery token names the call that threw",
    Boolean(failedCall) && parked.managerTurnRecovery?.failedSparkCallId === failedCall.id,
    JSON.stringify(parked.managerTurnRecovery),
  );
  check("the recovery is classified as auth", parked.managerTurnRecovery?.failureKind === "auth");
  check(
    "no question asks the user to answer the error",
    !parked.humanMessages.some((message) => message.kind === "question"),
    JSON.stringify(parked.humanMessages.map((message) => message.kind)),
  );

  // 2. An unclassified throw keeps the caller's fallback: no recovery token.
  const oddRun = writeRun(pausedRun("run-thrown-unclassified"));
  managerBehavior.set(oddRun, async () => {
    throw new Error("something inexplicable");
  });
  await runStore.resumeRun({ runId: oddRun }).catch(() => undefined);
  await sleep(300);
  check(
    "an unclassified launch failure creates no recovery token",
    readRun(oddRun).managerTurnRecovery === undefined,
    JSON.stringify(readRun(oddRun).managerTurnRecovery),
  );

  completed = true;
  console.log(failures === 0 ? "\nAll thrown-park checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
