// A Stop that lands while a Cora manager turn is preparing its prompt (after
// the turn's SparkCall is committed, before the backend has it) must end that
// turn: the backend is never asked, the call stays settled by the Stop, and
// the user's message waits in the queue for Resume. Against the REAL
// run-store.ts, with the manager backend stubbed at backend-registry and the
// prompt preparation held open at subscription-headroom.
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
export async function disposeManagerSessions() {}`,
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

const stubPlugin = {
  name: "stop-before-dispatch-stubs",
  setup(build) {
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

let backendCalls = 0;
globalThis.__stopManagerStub = async () => {
  backendCalls += 1;
  return {
    decision: { status: "complete", summary: "stub", chatReply: "Done.", steps: [], tasks: [] },
    durationMs: 1,
    model: "stub-model",
  };
};

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  const runId = "run-stop-while-preparing";
  const dir = path.join(HOME, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
    id: runId, title: "stop while preparing", status: "paused", executionMode: "managed",
    chatBackend: "pi", chatMode: "auto", chatModel: "claude-opus-5", workspaceId: "ws-stop", cwd: HOME,
    artifactDir: path.join(dir, "artifacts"), settingsSnapshot: { workspaceCwd: HOME },
    createdAt: AT, updatedAt: AT, conversationEpoch: 1,
    autopilot: { status: "paused", lastAction: "force_paused", pausedAt: AT, updatedAt: AT },
    steps: [], workerTasks: [], workerAttempts: [], sparkCalls: [], plans: [], assumptions: [],
    humanMessages: [{
      id: "msg-1", runId, author: "user", kind: "note", message: "build the parser", attachments: [],
      createdAt: AT, deliveryState: "queued", intent: "turn", conversationEpoch: 1,
    }],
  }, null, 2));
  const readRun = () => JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));

  const entry = path.join(CACHE, "entry.ts");
  fs.writeFileSync(entry, `export * from ${JSON.stringify(RUN_STORE_TS)};\n`);
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"), plugins: [stubPlugin], packages: "external",
  });
  const runStore = require(outfile);

  let entered = false;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.__headroomGate = async () => {
    entered = true;
    await held;
  };
  await runStore.resumeRun({ runId });
  check("the turn reached prompt preparation", await waitFor(() => entered));
  const live = readRun().sparkCalls.find((call) => call.status === "started" && !call.completedAt);
  check("its SparkCall is committed and live", Boolean(live));

  await runStore.forcePauseRun(runId);
  release();
  await runStore.settleScheduledManagerWork(runId);
  await sleep(200);

  const after = readRun();
  check("the backend never receives the stopped turn", backendCalls === 0, `calls=${backendCalls}`);
  check("the run stays paused", after.status === "paused", after.status);
  const call = after.sparkCalls.find((entry) => entry.id === live?.id);
  check("the call stays settled by the Stop", call?.status === "failed" && /force pause/.test(call?.error ?? ""), JSON.stringify(call));
  const message = after.humanMessages.find((entry) => entry.id === "msg-1");
  check(
    "the message waits in the queue for Resume",
    message?.deliveryState === "queued" && !message.backendTurnId,
    JSON.stringify(message),
  );

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
