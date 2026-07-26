// Pins the detached post-completion bookkeeping seam.
//
//   node scripts/test-completion-tail.cjs
//
// Completing a run used to drag its whole bookkeeping tail (result manifest,
// completion-summary message, memory + lessons ledgers) into the caller's
// await: two git subprocesses, one report read per worker attempt, and three
// extra full run serializations, all inside the live codara_complete MCP call
// and therefore inside the manager's own turn. None of it is needed for the
// answer the user already has, so it now runs detached.
//
// Two properties matter and both are checked here:
//   1. the completing call returns with the run already `complete` and the tail
//      not yet done, so a manager turn never pays for it;
//   2. flushRunCompletionTails still lands every artifact, so nothing was
//      dropped, only moved.
//
// Bundles the REAL run-store.ts against an electron/node-pty stub and drives it
// over a fabricated run.json under a throwaway CODARA_HOME_DIR, same trick as
// scripts/test-wedged-run-recovery.cjs.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-completion-tail-test");

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

const stubPlugin = {
  name: "electron-pty-stub",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "electron" ? ELECTRON_STUB : PTY_STUB,
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-completion-tail-"));
const WS = "ws-completion-tail";
const NOW = "2026-07-24T12:00:00.000Z";

function settledRun(id) {
  const tasks = [1, 2].map((n) => ({
    id: `task-${n}`,
    runId: id,
    stepId: "step-1",
    title: `task ${n}`,
    status: "accepted",
    taskClass: "feature",
    createdAt: NOW,
    updatedAt: NOW,
  }));
  return {
    id,
    title: "settled run",
    status: "running",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "auto",
    workspaceId: WS,
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    steps: [
      {
        id: "step-1",
        index: 0,
        title: "step 1",
        status: "complete",
        acceptanceCriteria: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workerTasks: tasks,
    workerAttempts: tasks.map((task, i) => ({
      id: `att-${i + 1}`,
      workerTaskId: task.id,
      status: "succeeded",
      engine: "pi",
      createdAt: NOW,
      updatedAt: NOW,
    })),
    humanMessages: [
      {
        id: "msg-1",
        author: "user",
        kind: "note",
        message: "do the thing",
        createdAt: NOW,
        deliveryState: "acknowledged",
        conversationEpoch: 0,
      },
    ],
    sparkCalls: [
      {
        id: "spark-1",
        mode: "chat",
        status: "succeeded",
        conversationEpoch: 0,
        startedAt: NOW,
        completedAt: NOW,
      },
    ],
    plans: [],
    assumptions: [],
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

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });

  const runStore = await bundle(RUN_STORE_TS, "run-store.cjs", {
    plugins: [stubPlugin],
    packages: "external",
  });

  check(
    "run-store exposes the completion-tail flush",
    typeof runStore.flushRunCompletionTails === "function",
  );

  const runId = writeRun(settledRun("run-tail"));
  const manifestPath = path.join(HOME, "runs", runId, "artifacts", "result-manifest.json");

  await runStore.completeRunFromOrchestrator(runId);

  // (1) The user-visible outcome is already durable here. The bookkeeping is
  // not: the tail has to reach the filesystem and (in a Git workspace) two git
  // subprocesses, neither of which can finish inside the microtask drain that
  // resumed this line. If the tail were still awaited inline, the manager turn
  // that called codara_complete would have paid for all of it.
  const onReturn = readRun(runId);
  check("completion returns with the run already complete", onReturn.status === "complete", onReturn.status);
  check("completion returns with completedAt stamped", typeof onReturn.completedAt === "string");
  check(
    "bookkeeping is not on the completing call's critical path",
    !fs.existsSync(manifestPath) && onReturn.resultManifest === undefined,
  );

  // (2) Nothing was dropped, only moved off the turn.
  await runStore.flushRunCompletionTails(runId);
  const afterFlush = readRun(runId);
  check("the flush lands result-manifest.json", fs.existsSync(manifestPath));
  check(
    "the flush stamps the manifest onto the run",
    afterFlush.resultManifest && typeof afterFlush.resultManifest.workspace === "object",
    JSON.stringify(afterFlush.resultManifest ?? null).slice(0, 120),
  );
  check(
    "the flush appends the completion summary for a run with worker history",
    (afterFlush.humanMessages || []).some(
      (message) => message.author === "spark" && message.kind === "decision",
    ),
  );
  check(
    "the flush writes the workspace memory ledger",
    fs.existsSync(path.join(HOME, "memory", `${WS}.json`)),
    fs.existsSync(path.join(HOME, "memory")) ? fs.readdirSync(path.join(HOME, "memory")).join(",") : "no memory dir",
  );

  // Flushing an already-drained run is a no-op, not a hang or a second write.
  const beforeIdleFlush = fs.readFileSync(manifestPath, "utf8");
  await runStore.flushRunCompletionTails(runId);
  await runStore.flushRunCompletionTails();
  check(
    "flushing a drained run is a no-op",
    fs.readFileSync(manifestPath, "utf8") === beforeIdleFlush,
  );

  console.log(
    failures === 0
      ? "\nAll completion-tail checks passed."
      : `\n${failures} completion-tail check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
