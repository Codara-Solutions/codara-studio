// Only text the user typed in a composer may run a skill. Against the REAL
// run-store.ts (manager backend stubbed at backend-registry, the loaded skills
// stubbed at pi-runtime-electron as {"ship"}), the paths where an agent's
// text could still reach skill routing or count as typed:
//
//   1. a first note nobody typed never looks the skills up;
//   2. an agent's "/ship" into a finished direct chat stays text for the
//      direct lane, while the same command typed moves the chat to Cora's
//      manager;
//   3. a skill the user typed while the direct worker ran reaches the manager
//      on Resume instead of being bundled into a direct pass;
//   4. a queued agent "/ship" never swallows the same command the user then
//      types as a "double send".
//
//   node scripts/test-skill-provenance-run-store.cjs

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
// Inside the repository so the bundle resolves node_modules (packages stay external).
const CACHE = path.join(ROOT, "node_modules", ".cache", "skill-provenance-run-store-test");
fs.mkdirSync(CACHE, { recursive: true });

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
  async requestManagerDecision(input) { return globalThis.__skillManagerStub(input); },
  async disposeChat() {},
  interruptChat() {},
});
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions() {}`,
  "./pi-runtime-electron": `export async function listCodaraPiSkillNames(cwd) {
  globalThis.__skillLookups = (globalThis.__skillLookups ?? 0) + 1;
  return new Set(["ship"]);
}
export async function resolveCodaraPiExecutionAccount() {
  return { accountProfileId: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10", provider: "anthropic", configDir: "/tmp/skill-stub-pi" };
}
export async function resolveCodaraPiRuntime() { throw new Error("pi runtime is stubbed"); }
export async function resolveCodaraPiLibrary() { throw new Error("pi runtime is stubbed"); }
export async function resolveUserPiRuntime() { throw new Error("pi runtime is stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/skill-stub-pi", configDir: "/tmp/skill-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() { throw new Error("pi worker launch is stubbed"); }`,
};

const stubPlugin = {
  name: "skill-provenance-stubs",
  setup(build) {
    build.onResolve(
      { filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron)$/ },
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "skill-provenance-run-store-"));
const WORKSPACE = path.join(HOME, "workspace");
const AT = "2026-11-19T09:00:00.000Z";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const managerCalls = [];
globalThis.__skillManagerStub = async (input) => {
  managerCalls.push(input.run.id);
  return {
    decision: { status: "complete", summary: "stub", chatReply: "Done.", steps: [], tasks: [] },
    durationMs: 1,
    model: "stub-model",
  };
};

function directRun(id, overrides = {}) {
  return {
    id,
    title: "direct chat",
    status: "complete",
    executionMode: "direct",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: "ws-skill",
    cwd: WORKSPACE,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    settingsSnapshot: { workspaceCwd: WORKSPACE },
    createdAt: AT,
    updatedAt: AT,
    completedAt: AT,
    conversationEpoch: 0,
    autopilot: { status: "complete", updatedAt: AT },
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [],
    sparkCalls: [],
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
const readRun = (id) => JSON.parse(fs.readFileSync(path.join(HOME, "runs", id, "run.json"), "utf8"));

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const entry = path.join(CACHE, "entry.ts");
  fs.writeFileSync(entry, `export * from ${JSON.stringify(RUN_STORE_TS)};\n`);
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"), plugins: [stubPlugin], packages: "external",
  });
  const runStore = require(outfile);

  // ── 1. a first note nobody typed never looks the skills up ──────────────
  globalThis.__skillLookups = 0;
  await runStore
    .startAutopilot({
      workspaceId: "ws-skill", workspaceName: "workspace", cwd: WORKSPACE,
      initialUserNote: "/ship it", initialUserNoteClientMessageId: "cli-agent-first",
    })
    .catch(() => undefined);
  check("an agent's first /ship never looks up the loaded skills", globalThis.__skillLookups === 0, `lookups=${globalThis.__skillLookups}`);
  globalThis.__skillLookups = 0;
  await runStore
    .startAutopilot({
      workspaceId: "ws-skill", workspaceName: "workspace", cwd: WORKSPACE,
      initialUserNote: "/ship it", initialUserNoteClientMessageId: "composer-first", initialNoteTypedByUser: true,
    })
    .catch(() => undefined);
  check("the same first /ship typed by the user does", globalThis.__skillLookups === 1, `lookups=${globalThis.__skillLookups}`);

  // ── 2. a follow-up into a finished direct chat ──────────────────────────
  const agentFollowUp = writeRun(directRun("run-direct-agent"));
  await runStore
    .addRunMessage({ runId: agentFollowUp, author: "user", kind: "note", message: "/ship", clientMessageId: "delivery-1" })
    .catch(() => undefined);
  check(
    "an agent's /ship into a finished direct chat keeps it direct",
    readRun(agentFollowUp).executionMode === "direct",
    readRun(agentFollowUp).executionMode,
  );
  const typedFollowUp = writeRun(directRun("run-direct-typed"));
  await runStore
    .addRunMessage({ runId: typedFollowUp, author: "user", kind: "note", message: "/ship", clientMessageId: "composer-1", typedByUser: true })
    .catch(() => undefined);
  check(
    "the same /ship typed by the user moves it to the manager",
    readRun(typedFollowUp).executionMode === "managed",
    readRun(typedFollowUp).executionMode,
  );

  // ── 3. a skill typed while the direct worker ran, then Resume ───────────
  const queued = (id, typed) => writeRun(directRun(id, {
    humanMessages: [{
      id: `${id}-msg`, runId: id, author: "user", kind: "note", message: "/ship", attachments: [],
      intent: "turn", deliveryState: "queued", conversationEpoch: 0, createdAt: AT,
      ...(typed ? { typedByUser: true } : {}),
    }],
  }));
  const typedQueued = queued("run-direct-queued-typed", true);
  managerCalls.length = 0;
  await runStore.resumeRun({ runId: typedQueued }).catch((error) => error);
  await runStore.settleScheduledManagerWork(typedQueued).catch(() => undefined);
  await sleep(100);
  const afterTyped = readRun(typedQueued);
  check(
    "Resume hands a typed queued /ship to the manager",
    afterTyped.executionMode === "managed" && managerCalls.includes(typedQueued),
    JSON.stringify({ mode: afterTyped.executionMode, managerCalls }),
  );
  const agentQueued = queued("run-direct-queued-agent", false);
  await runStore.resumeRun({ runId: agentQueued }).catch(() => undefined);
  check(
    "an agent's queued /ship stays on the direct lane",
    readRun(agentQueued).executionMode === "direct",
    readRun(agentQueued).executionMode,
  );

  // ── 4. a queued agent /ship never swallows the typed one ────────────────
  const busy = writeRun(directRun("run-managed-busy", {
    executionMode: "managed",
    status: "running",
    completedAt: undefined,
    autopilot: { status: "running", updatedAt: AT },
    sparkCalls: [{ id: "spark-live", runId: "run-managed-busy", mode: "chat", model: "claude-opus-5", status: "started", conversationEpoch: 0, createdAt: AT }],
  }));
  await runStore.addRunMessage({ runId: busy, author: "user", kind: "note", message: "/ship", clientMessageId: "delivery-2" });
  await runStore.addRunMessage({ runId: busy, author: "user", kind: "note", message: "/ship", clientMessageId: "composer-2", typedByUser: true });
  const busyMessages = (await runStore.getRun(busy)).humanMessages.filter((message) => message.message === "/ship");
  check(
    "the typed /ship is recorded beside a queued agent /ship",
    busyMessages.length === 2 && busyMessages.some((message) => message.typedByUser === true),
    JSON.stringify(busyMessages.map((message) => ({ id: message.clientMessageId, typed: message.typedByUser }))),
  );

  completed = true;
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CACHE, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("skill provenance run-store: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
