// A key the user pastes into a Cora chat never reaches the run's files:
// addRunMessage and answerRunQuestion scrub user text (scrubSecrets in
// src/shared/memory-items.ts) before it is written to run.json or
// events.jsonl. The model sees the key only in the live prompt of the turn
// that delivers it (src/main/orchestration/pasted-secrets.ts), so it can
// store it; later turns, and anything the run writes, even the model
// repeating the key, stay scrubbed. Runs against the REAL run-store.ts with
// the manager backend stubbed, the same esbuild/stub technique as
// scripts/test-queued-messages.cjs.
//
//   node scripts/test-run-message-scrub.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-run-message-scrub-test");

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
  name: "cora-run-message-scrub-stubs",
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

let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-run-message-scrub-"));
const AT = "2026-10-22T09:00:00.000Z";
const KEY = "sk-proj-Zq8Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0Ya";
const PASSWORD = "Hunter2Hunter2xyz";

function pausedRun(id) {
  return {
    id,
    title: "scrub",
    status: "paused",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: "ws-scrub",
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: AT,
    updatedAt: AT,
    conversationEpoch: 1,
    autopilot: { status: "paused", lastAction: "force_paused", stopReason: "Force-paused by user", pausedAt: AT, updatedAt: AT },
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [],
    sparkCalls: [],
    plans: [],
    assumptions: [],
  };
}

function runFiles(runId) {
  const dir = path.join(HOME, "runs", runId);
  return fs
    .readdirSync(dir, { recursive: true })
    .map((name) => path.join(dir, String(name)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
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

const prompts = [];
globalThis.__coraManagerStub = async (input) => {
  prompts.push(String(input.prompt ?? ""));
  // As a real backend does once the provider has the turn.
  await input.onPromptAccepted?.();
  return {
    decision: {
      status: "ask_user",
      // The model repeats what it was shown: the run must not write it.
      summary: `stub turn; I saw ${KEY} and ${PASSWORD}`,
      question: `Which account should the deploy with ${KEY} use?`,
      questionCategory: "irreducible_product_scope",
      questionReason: "The stub always asks so the run settles.",
      steps: [],
      tasks: [],
    },
    durationMs: 1,
    model: "stub-model",
  };
};

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  const runId = "run-scrub";
  fs.mkdirSync(path.join(HOME, "runs", runId), { recursive: true });
  fs.writeFileSync(path.join(HOME, "runs", runId, "run.json"), JSON.stringify(pausedRun(runId), null, 2));
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [RUN_STORE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [stubPlugin],
    packages: "external",
  });
  const runStore = require(outfile);
  const readRun = () => JSON.parse(fs.readFileSync(path.join(HOME, "runs", runId, "run.json"), "utf8"));

  await runStore.addRunMessage({ runId, author: "user", kind: "note", message: `deploy with this key ${KEY} please` });
  const stored = readRun().humanMessages.find((message) => message.author === "user");
  check("the user message is kept, with the key replaced", stored?.message === "deploy with this key [redacted] please", stored?.message);
  check("the manager turn ran and asked", await waitFor(() => Boolean(readRun().blockedOn)));
  const question = readRun().humanMessages.find((message) => message.kind === "question");
  check("the stub question was posted", Boolean(question));

  await runStore.answerRunQuestion({ runId, questionMessageId: question.id, message: `use prod, password: ${PASSWORD}` });
  const answer = readRun().humanMessages.find((message) => message.kind === "answer");
  check("the answer is kept, with the password replaced", answer?.message === "use prod, password: [redacted]", answer?.message);
  await waitFor(() => prompts.length >= 2);

  check("the turn that delivers the note sees the key", prompts[0]?.includes(KEY), prompts[0]?.slice(-400));
  check("the turn that delivers the answer sees the password", prompts[1]?.includes(PASSWORD), prompts[1]?.slice(-400));

  // A later turn: the earlier messages are history now, scrubbed.
  const answered = readRun();
  const nextQuestion = answered.humanMessages.filter((message) => message.kind === "question").at(-1);
  if (nextQuestion && answered.blockedOn) {
    await runStore.answerRunQuestion({ runId, questionMessageId: nextQuestion.id, message: "staging is fine" });
  } else {
    await runStore.addRunMessage({ runId, author: "user", kind: "note", message: "staging is fine" });
  }
  await waitFor(() => prompts.length >= 3);
  check("a third turn ran", prompts.length >= 3, prompts.length);
  check("later turns never see the key or the password", prompts.slice(2).every((prompt) => !prompt.includes(KEY) && !prompt.includes(PASSWORD)));

  const files = runFiles(runId);
  check("no run file holds the key, though the model repeated it", !files.includes(KEY));
  check("no run file holds the password, though the model repeated it", !files.includes(PASSWORD));
  check("the model's question was kept, with the key it repeated replaced", files.includes("Which account should the deploy with [redacted] use?"));
  check("run.json is still valid JSON", Boolean(readRun().id));

  // The first message of a new chat names it and, on the direct lane, is the
  // worker's task: both come from the scrubbed text. The stubbed worker
  // launch may refuse; only what reached disk matters here.
  const started = await runStore
    .startAutopilot({
      workspaceId: "ws-scrub",
      workspaceName: "scrub",
      cwd: HOME,
      executionStrategy: "direct",
      initialUserNote: `rotate ${KEY} now`,
    })
    .catch(() => null);
  const newRuns = fs.readdirSync(path.join(HOME, "runs")).filter((id) => id !== runId);
  check("the new chat was created", newRuns.length === 1, newRuns.join(","));
  const newFiles = newRuns.map(runFiles).join("\n");
  check("the new chat's files never hold the key", newFiles.length > 0 && !newFiles.includes(KEY));
  if (started) check("its title is scrubbed", started.title === "rotate [redacted] now", started.title);

  completed = true;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (failures) process.exit(1);
  console.log("run message scrub: all passed");
  // The new chat leaves background work (memory, recovery) that would write
  // into the home just removed.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
