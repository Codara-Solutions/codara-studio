// deleteRun(runId, { refuseLive: true }), the session picker's cleanup delete:
// it refuses, and leaves untouched, a run that is working, one stopped with a
// worker still going, and one a Loom still holds as its current run (the Loom
// adds its next pass to that run, which reads as finished in between). A
// finished run nobody holds is deleted, and so is a held one by a plain
// deleteRun, which the chat list and Settings keep using. The IPC handler only
// takes ids of the run-store's own shape. A workflow run whose script is
// still going is refused before discard, which would wait on that script
// while the script waits on the run's queue the delete holds.
//
//   node scripts/test-run-delete-refuse-live.cjs
//
// Bundles the REAL run-store.ts against electron/node-pty stubs and drives it
// over run.json and scheduler.json files under a throwaway CODARA_HOME_DIR, the
// technique of scripts/test-run-resume-guard.cjs.

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const IPC_TS = path.join(ROOT, "src", "main", "ipc.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-run-delete-refuse-live-test");

const ELECTRON_STUB = `const noop = () => {};
export const app = { getPath: () => "/tmp", getAppPath: () => process.cwd(), getVersion: () => "0.0.0", getName: () => "codara", isPackaged: false, on: noop, whenReady: () => Promise.resolve(), setName: noop };
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
export function killImmediate() {}
export default { spawn, exists, killImmediate };`;

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

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === undefined ? "" : ` - ${detail}`}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-run-delete-refuse-live-"));
const WS = "ws-delete-refuse-live";
const NOW = "2026-08-04T12:00:00.000Z";

function writeRun(id, overrides = {}) {
  const dir = path.join(HOME, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    id,
    title: `Loom: digest - ${id}`,
    status: "complete",
    executionMode: "direct",
    automationId: "loom-1",
    workspaceId: WS,
    artifactDir: dir,
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [],
    sparkCalls: [],
    plans: [],
    assumptions: [],
    checkpoints: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  return id;
}

const exists = (id) => fs.existsSync(path.join(HOME, "runs", id, "run.json"));

async function refusal(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  process.env.SPARK_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });
  const held = writeRun("run-held");
  fs.writeFileSync(
    path.join(HOME, "scheduler.json"),
    JSON.stringify({
      jobs: [
        {
          id: "loom-1",
          name: "digest",
          trigger: { kind: "cron", expr: "0 9 * * *" },
          enabled: false,
          input: { workspaceId: WS, workspaceName: "w", cwd: HOME, initialUserNote: "", chatMode: "execute" },
          loop: { kind: "count", count: 3, stop: {} },
          prompt: { template: "digest" },
          worker: { model: "claude-opus-5", effort: "medium" },
          state: { status: "idle", iteration: 1, currentRunId: held },
          history: [{ iteration: 0, runId: held, startedAt: NOW, finishedAt: NOW, status: "complete" }],
          createdAt: NOW,
        },
      ],
    }),
  );
  const running = writeRun("run-running", { status: "running" });
  const pausedLive = writeRun("run-paused-live", {
    status: "paused",
    workerAttempts: [{ id: "attempt-1", taskId: "task-1", status: "running", createdAt: NOW, updatedAt: NOW }],
  });
  const finished = writeRun("run-finished");
  const workflow = writeRun("run-workflow", { automationId: undefined, status: "paused", workflow: { name: "w" } });

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

  const runningRefusal = await refusal(() => runStore.deleteRun(running, { refuseLive: true }));
  check("a running run is refused", /Working now/.test(runningRefusal ?? ""), runningRefusal);
  check("a refused running run is untouched", exists(running));

  const pausedRefusal = await refusal(() => runStore.deleteRun(pausedLive, { refuseLive: true }));
  check("a paused run with a worker still going is refused", /Working now/.test(pausedRefusal ?? ""), pausedRefusal);
  check("a refused paused run is untouched", exists(pausedLive));

  const heldRefusal = await refusal(() => runStore.deleteRun(held, { refuseLive: true }));
  check(
    "a finished run its Loom still holds is refused",
    heldRefusal === "Its Loom is still using this run. Stop the Loom first.",
    heldRefusal,
  );
  check("a refused held run is untouched", exists(held));

  const finishedRefusal = await refusal(() => runStore.deleteRun(finished, { refuseLive: true }));
  check("a finished run nobody holds is deleted", finishedRefusal === null && !exists(finished), finishedRefusal);

  const discarded = [];
  let scriptActive = true;
  runStore.setWorkflowRunControls({
    stop: async () => {},
    resume: async () => {},
    cancel: async () => {},
    discard: async (id) => {
      discarded.push(id);
    },
    isActive: (id) => id === workflow && scriptActive,
  });
  const workflowRefusal = await refusal(() => runStore.deleteRun(workflow, { refuseLive: true }));
  check("a workflow run whose script is going is refused", /Working now/.test(workflowRefusal ?? ""), workflowRefusal);
  check("a refused workflow run is untouched and never discarded", exists(workflow) && discarded.length === 0);
  scriptActive = false;
  const settledWorkflow = await refusal(() => runStore.deleteRun(workflow, { refuseLive: true }));
  check(
    "a workflow run whose script ended is deleted",
    settledWorkflow === null && !exists(workflow) && discarded.join() === workflow,
    settledWorkflow,
  );
  runStore.setWorkflowRunControls(null);

  const plainRefusal = await refusal(() => runStore.deleteRun(held));
  check("a plain delete keeps today's behaviour", plainRefusal === null && !exists(held), plainRefusal);
  const scheduler = JSON.parse(fs.readFileSync(path.join(HOME, "scheduler.json"), "utf8"));
  check("deleting never edits the Loom", scheduler.jobs.length === 1 && scheduler.jobs[0].history.length === 1);

  const ipc = fs.readFileSync(IPC_TS, "utf8");
  const handler = ipc.slice(ipc.indexOf('handle("orchestration:deleteRun"'), ipc.indexOf("// ── Cora Board"));
  check(
    "the IPC handler checks the id's shape before anything else",
    /if \(typeof runId !== "string" \|\| !RUN_ID_SHAPE\.test\(runId\)\) throw/.test(handler) &&
      handler.indexOf("RUN_ID_SHAPE") < handler.indexOf("getRunStore"),
  );
  check("the IPC handler passes refuseLive only when asked", /refuseLive: options\?\.refuseLive === true/.test(handler));

  console.log(failures === 0 ? "\nAll refuse-live delete checks passed." : `\n${failures} refuse-live delete check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  });
