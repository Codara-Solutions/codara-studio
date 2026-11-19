// The route order (src/shared/cora-routes.ts) as the REAL run-store.ts applies
// it to Cora's manager, with the manager backend stubbed at backend-registry
// and the route choice stubbed at worker-model-availability (the routing
// itself is covered by test-cora-routes.cjs and
// test-worker-model-availability.cjs; this suite pins where it is applied):
//
//   1. a compaction summary runs on the same route and account as the chat
//      turns before it, both ways (picked native routed to OpenRouter, and
//      picked OpenRouter routed onto a sign-in);
//   2. resuming a parked turn on a subscription account the user picks is
//      checked against the route the failed turn took, and the chat keeps
//      that spelling once the user's pin stops routing.
//
//   node scripts/test-cora-route-run-store.cjs

"use strict";

const { completeStubExports } = require("./run-store-stub-exports.cjs");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const STORAGE_TS = path.join(ROOT, "src", "main", "storage.ts");
// Inside the repository so the bundle resolves node_modules (packages stay external).
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-route-run-store-test");
fs.mkdirSync(CACHE, { recursive: true });

const ACCOUNTS = {
  anthropic: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10",
  "openai-codex": "7c2d9e41-0b5a-4f3e-8d21-6a9b4c3e1f20",
};
const PICKED_ACCOUNT = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

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
  async requestManagerDecision(input, onStream) { return globalThis.__routeManagerStub(input, onStream); },
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
export async function listCodaraPiSkillNames() { return new Set(); }`,
  "./worker-model-availability": `export async function routeCoraModel(model) { return globalThis.__routes?.[model] ?? model; }
export async function coraWorkerModelAvailability() { return { connected: [], disconnected: [] }; }
export async function coraRouteAvailability() { return null; }
export function workerPlanningModels(connected) { return [...connected]; }`,
};

const stubPlugin = {
  name: "cora-route-run-store-stubs",
  setup(build) {
    build.onResolve(
      { filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron|\.\/worker-model-availability)$/ },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: completeStubExports(args.path, STUBS[args.path]), loader: "js" }));
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-route-run-store-"));
const AT = "2026-11-19T09:00:00.000Z";
const SUMMARY = "Summary of the parser work so far: the lexer is done and tested. ".repeat(8);

function baseRun(id, overrides = {}) {
  return {
    id,
    title: "routed chat",
    status: "paused",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: "ws-route",
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    settingsSnapshot: { workspaceCwd: HOME },
    createdAt: AT,
    updatedAt: AT,
    conversationEpoch: 1,
    autopilot: { status: "paused", lastAction: "force_paused", pausedAt: AT, updatedAt: AT },
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [
      {
        id: "msg-1", runId: id, author: "user", kind: "note", message: "build the parser", attachments: [],
        createdAt: AT, deliveryState: "acknowledged", intent: "turn", conversationEpoch: 1,
      },
    ],
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

const calls = new Map();
const callsFor = (runId) => calls.get(runId) ?? [];
globalThis.__routeManagerStub = async (input) => {
  const list = callsFor(input.run.id);
  list.push({ model: input.chat?.model, account: input.chat?.accountProfileId });
  calls.set(input.run.id, list);
  const compaction = typeof input.prompt === "string" && input.prompt.startsWith("Create a dense handoff");
  return {
    decision: { status: "complete", summary: "stub", chatReply: compaction ? SUMMARY : "Done.", steps: [], tasks: [] },
    durationMs: 1,
    model: input.chat?.model ?? "stub-model",
  };
};

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });
  const entry = path.join(CACHE, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(RUN_STORE_TS)};\nexport { loadSettings, saveSettings } from ${JSON.stringify(STORAGE_TS)};\n`,
  );
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"), plugins: [stubPlugin], packages: "external",
  });
  const runStore = require(outfile);
  await runStore.saveSettings({ ...(await runStore.loadSettings()), coraRouteOrder: ["subscription", "openrouter", "subcloud"] });

  // ── 1. compaction takes the chat's route and account ─────────────────────
  for (const [picked, routed, account] of [
    ["gpt-5.6-sol", "openai/gpt-5.6-sol", undefined],
    ["openai/gpt-5.6-sol", "gpt-5.6-sol", ACCOUNTS["openai-codex"]],
  ]) {
    globalThis.__routes = { [picked]: routed };
    const runId = writeRun(baseRun(`run-compact-${routed.replace(/[^a-z0-9]/gi, "-")}`, {
      chatModel: picked,
      chatSessionUuid: "00000000-0000-4000-8000-0000000000c1",
    }));
    await runStore.resumeRun({ runId });
    await runStore.settleScheduledManagerWork(runId);
    const turn = callsFor(runId)[0];
    check(`${picked}: the chat turn runs on ${routed}`, turn?.model === routed && turn?.account === account, JSON.stringify(turn));
    await runStore.compactConversation(runId).catch((error) => error);
    const summary = callsFor(runId)[1];
    check(
      `${picked}: the compaction summary runs on the same route and account as the turn`,
      summary?.model === turn?.model && summary?.account === turn?.account,
      JSON.stringify({ turn, summary }),
    );
    const recorded = readRun(runId).sparkCalls.find((call) => call.purpose === "compaction");
    check(`${picked}: the compaction call is recorded on that route`, recorded?.model === routed, recorded?.model);
  }

  // ── 2. resuming a parked turn checks the route the turn took ────────────
  globalThis.__routes = { "openai/gpt-5.6-sol": "gpt-5.6-sol" };
  const parkedId = "run-parked-routed";
  writeRun(baseRun(parkedId, {
    chatModel: "openai/gpt-5.6-sol",
    chatAccountProfileId: ACCOUNTS["openai-codex"],
    chatAccountProfileImplicit: true,
    sparkCalls: [{
      id: "spark-failed", runId: parkedId, mode: "chat", model: "gpt-5.6-sol",
      accountProfileId: ACCOUNTS["openai-codex"], status: "failed", error: "usage limit reached",
      conversationEpoch: 1, createdAt: AT, completedAt: AT,
    }],
    managerTurnRecovery: {
      id: "recovery-1", state: "parked", failureKind: "rate_limit", backend: "pi", managerMode: "chat",
      conversationEpoch: 1, failedSparkCallId: "spark-failed", failedAccountProfileId: ACCOUNTS["openai-codex"], parkedAt: AT,
    },
  }));
  const resumed = await runStore.resumeManagerTurnRecovery({
    runId: parkedId,
    recoveryId: "recovery-1",
    account: { kind: "subscription", profileId: PICKED_ACCOUNT },
  });
  check("a subscription account resumes a turn that ran on a sign-in", resumed.outcome === "accepted", JSON.stringify({ outcome: resumed.outcome, reason: resumed.reason }));
  await runStore.settleScheduledManagerWork(parkedId);
  const after = readRun(parkedId);
  check("the chat keeps the spelling that account serves", after.chatModel === "gpt-5.6-sol", after.chatModel);
  const retry = callsFor(parkedId).at(-1);
  check(
    "the resumed turn runs that model on the picked account",
    retry?.model === "gpt-5.6-sol" && retry?.account === PICKED_ACCOUNT,
    JSON.stringify(retry),
  );

  completed = true;
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CACHE, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("cora route run-store: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
