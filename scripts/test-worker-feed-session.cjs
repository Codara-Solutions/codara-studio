// test-runner: heavy (bundles the whole run-store)
// A Pi worker's session writes its feed: the REAL run-store.ts launches a Pi
// worker against a scripted Pi client, and the chat's readers see its tool
// call, its reply and a message sent to it, live from memory and afterwards
// from feed.jsonl. Stubs as in scripts/test-force-pause-resume.cjs.
//
//   node scripts/test-worker-feed-session.cjs

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", `cora-worker-feed-session-${process.pid}`);

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getAppPath: () => process.cwd(), getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => (globalThis.__feedSends ??= []).push({ channel, payload }) } };
export class BrowserWindow { static getAllWindows() { return [win]; } }
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

const STUBS = {
  electron: ELECTRON_STUB,
  "node-pty": `export function spawn() { throw new Error("stubbed"); } export default { spawn };`,
  "./backend-registry": `const backend = (kind) => ({ kind, displayName: "stub", async requestManagerDecision() {
    return { decision: { status: "ask_user", summary: "stub", question: "Stub?", questionCategory: "irreducible_product_scope", questionReason: "stub", steps: [], tasks: [] }, durationMs: 1, model: "stub" };
  }, async disposeChat() {}, interruptChat() {} });
export function getBackend(kind) { return backend(kind); }
export function listBackends() { return []; }
export async function disposeManagerSessions() {}`,
  "./pi-runtime-electron": `export async function resolveCodaraPiExecutionAccount() {
  return { accountProfileId: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10", provider: "anthropic", configDir: "/tmp/cora-stub-pi" };
}
export async function resolveCodaraPiRuntime() { throw new Error("stubbed"); } export async function resolveCodaraPiLibrary() { throw new Error("stubbed"); } export async function resolveUserPiRuntime() { throw new Error("stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/cora-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() {
  return { provider: "anthropic", model: "claude-opus-5", thinking: "high", sessionId: "stub-session", mcpConfigPath: null, accountProfileId: "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10", env: {} };
}`,
  "../pty-manager": `const noop = () => {};
export function exists() { return false; }
export async function spawn() {}
export function resize() {}
export async function waitForResize() {}
export async function waitForSpawn() { return false; }
export function publishOutput() {}
export function killImmediate() {}
export function dispose() {}
export function onExit() { return noop; }
export function readTail() { return ""; }
export function tap() { return noop; }
export function write() {}`,
  // The scripted session: one tool call, one reply streamed in two pieces,
  // then it waits for the harness before writing its report and settling.
  "./pi-rpc-client": `export class PiRpcClient {
  constructor() { this.listeners = new Set(); }
  async start() {}
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  state() { return { phase: "running" }; }
  async prompt(text, mode) {
    if (mode === "steer") { (globalThis.__feedSteers ??= []).push(text); return; }
    setTimeout(async () => {
      this.emit({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "src/parser.ts" } });
      this.emit({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", isError: false, result: { content: [{ type: "text", text: "export const parse = () => null;" }] } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "The parser returns null. " } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Fixing it." } });
      this.emit({ type: "message_end", message: { role: "assistant" } });
      await globalThis.__feedRelease;
      require("node:fs").writeFileSync(globalThis.__feedReportPath, JSON.stringify({ status: "complete", summary: "Fixed the parser.", files_changed: [], commands_run: [], tests: [], proof: [], risks: [], followups: [], handoff: [] }));
      this.emit({ type: "agent_settled" });
    }, 0);
  }
  async abort() {}
  async stop() {}
}`,
};

const stubPlugin = {
  name: "worker-feed-session-stubs",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron|\.\.\/pty-manager|\.\/pi-rpc-client)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || detail === undefined ? "" : ` - ${detail}`}`);
}
let completed = false;
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.log("FAIL the harness exited before finishing its checks");
    process.exitCode = 1;
  }
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, ok, ms = 20_000) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(25);
    value = await read();
  }
  return value;
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-worker-feed-session-"));
const NOW = "2026-11-17T10:00:00.000Z";

function writeRun(id, attempts) {
  const stepId = `step-${id}`;
  const taskId = `task-${id}`;
  const dir = path.join(HOME, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    id,
    title: "worker feed",
    status: "running",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: "ws-worker-feed",
    cwd: HOME,
    artifactDir: path.join(dir, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 1,
    autopilot: { status: "running", lastAction: "started", updatedAt: NOW },
    plans: [],
    humanMessages: [],
    sparkCalls: [],
    steps: [{
      id: stepId, runId: id, index: 1, title: "Fix", goal: "Fix the parser", kind: "worker_batch", status: "running",
      plannedAgents: [], acceptanceCriteria: [], verificationCommands: [], workerTaskIds: [taskId], createdAt: NOW, updatedAt: NOW,
    }],
    workerTasks: [{
      id: taskId, runId: id, stepId, title: "fix the parser", description: "Fix the parser.", status: "queued",
      runtimePreference: "claude", allowedPaths: [], forbiddenPaths: [], expectedOutputs: [], verificationCommands: [],
      canRunParallel: false, conflictsWith: [], taskClass: "verifier", createdBy: "spark", createdAt: NOW, updatedAt: NOW,
    }],
    workerAttempts: attempts(taskId),
  };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  return { id, stepId, taskId };
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
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

  const runId = "run-worker-feed";
  const attemptId = "attempt-worker-feed";
  const fixture = writeRun(runId, (taskId) => [{
    id: attemptId, runId, workerTaskId: taskId, attemptNumber: 1, runtime: "claude", cwd: HOME, status: "prompt_ready", createdAt: NOW,
  }]);
  const attemptDir = path.join(HOME, "runs", runId, "steps", fixture.stepId, "workers", fixture.taskId, "attempts", attemptId);
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, "prompt.md"), "Fix the parser.\n");
  globalThis.__feedReportPath = path.join(attemptDir, "final-report.json");
  let release;
  globalThis.__feedRelease = new Promise((resolve) => { release = resolve; });

  const launch = runStore.launchWorkerAttempt({ runId, attemptId }).catch((error) => error);
  const live = await until(
    () => runStore.readWorkerAttemptFeed(runId, attemptId),
    (feed) => feed.records.some((record) => record.k === "text"),
  );
  check("a running Pi worker's feed reads live from memory", live.available && live.live, JSON.stringify(live));
  check(
    "the feed holds the tool call, its result and the whole reply",
    JSON.stringify(live.records.map((record) => record.k)) === JSON.stringify(["tool", "result", "text"]) &&
      live.records[0].name === "read" &&
      live.records[0].input?.path === "src/parser.ts" &&
      live.records[1].output.includes("parse") &&
      live.records[2].text === "The parser returns null. Fixing it.",
    JSON.stringify(live.records),
  );

  const delivered = await runStore.messageWorkerAttempt(runId, attemptId, "  Keep the old export too.\n");
  check("a message reaches the running worker", delivered.delivered === true && globalThis.__feedSteers?.[0] === "Keep the old export too.", JSON.stringify({ delivered, steers: globalThis.__feedSteers }));
  const escaped = await runStore.messageWorkerAttempt(runId, attemptId, "\u001b");
  check("a message of only control characters is not sent (a lone Esc would abort it)", escaped.delivered === false && globalThis.__feedSteers.length === 1);
  const tooLong = await runStore.messageWorkerAttempt(runId, attemptId, "x".repeat(8_001)).then(() => null, (error) => error.message);
  check("a message past 8,000 characters is refused", /at most 8000/.test(tooLong ?? ""), tooLong);
  const steered = await runStore.readWorkerAttemptFeed(runId, attemptId);
  check("the message shows in the worker's feed as the user's", steered.records.at(-1)?.k === "steer" && steered.records.at(-1).from === "user");

  release();
  const launched = await launch;
  check("the scripted session finishes", !(launched instanceof Error), launched?.message);
  const after = await until(() => runStore.readWorkerAttemptFeed(runId, attemptId), (feed) => !feed.live);
  check("a finished worker's feed reads from disk", after.available && !after.live && fs.existsSync(path.join(attemptDir, "feed.jsonl")));
  check(
    "it keeps every record it had while running",
    JSON.stringify(after.records.slice(0, steered.records.length)) === JSON.stringify(steered.records),
    JSON.stringify(after.records.map((record) => record.k)),
  );
  const sends = (globalThis.__feedSends ?? []).filter((send) => send.channel === "orchestration:workerFeed");
  check(
    "each change reached the renderer on the feed channel",
    sends.some((send) => send.payload.records?.[0]?.k === "tool") &&
      sends.some((send) => send.payload.records?.[0]?.k === "text") &&
      sends.some((send) => send.payload.ended === true) &&
      sends.every((send) => send.payload.runId === runId && send.payload.attemptId === attemptId),
  );
  const gone = await runStore.messageWorkerAttempt(runId, attemptId, "Are you there?");
  check("a finished worker takes no more messages", gone.delivered === false);

  const many = runStore.steeringForContract(Array.from({ length: 10 }, (_, i) => `message ${i + 1} ${"s".repeat(3_000)}`));
  check(
    "steering re-sent after a compaction keeps the newest messages within its budget and says what it left out",
    many.length > 1 &&
      /earlier steering messages left out/.test(many[0]) &&
      many.at(-1).startsWith("Later steering 10:") &&
      many.slice(1).join("").length <= 16_000,
    JSON.stringify(many.map((section) => section.slice(0, 30))),
  );
  const oldId = "run-worker-feed-old";
  const oldAttempt = "attempt-old";
  writeRun(oldId, (taskId) => [{
    id: oldAttempt, runId: oldId, workerTaskId: taskId, attemptNumber: 1, runtime: "claude", cwd: HOME, status: "succeeded", createdAt: NOW,
    stdoutLogPath: path.join(HOME, "runs", oldId, "steps", `step-${oldId}`, "workers", `task-${oldId}`, "attempts", oldAttempt, "stdout.log"),
  }]);
  const oldFeed = await runStore.readWorkerAttemptFeed(oldId, oldAttempt);
  check("an attempt from before feeds reads as unavailable", oldFeed.available === false && oldFeed.records.length === 0, JSON.stringify(oldFeed));
  const missing = await runStore.readWorkerAttemptFeed(oldId, "attempt-nope").then(() => null, (error) => error.message);
  check("an unknown attempt is refused", /not found/.test(missing ?? ""), missing);

  completed = true;
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nworker feed session: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
