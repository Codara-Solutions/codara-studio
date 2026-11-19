// A run read from disk while another caller changes the same run must not
// replace the newer copy in run-store's cache.
//
// getRun fills its cache after an awaited readFile. Two readers that miss at
// the same time (an agent's RPC and the renderer listing runs, say) each read
// the file. If one of them saves a change before the slower read finishes,
// that slow read used to put the run as it was on disk back in the cache.
// Every later read then saw the old run, and the next save wrote it back,
// dropping the change. On a loaded macOS runner, test-agent-socket saw this
// as codara_complete being accepted with a plan milestone still open: the
// plan written by codara_plan_update was gone from the cache.
//
// The slow read is made slow on purpose here: the first read of the run file
// waits until the test lets it finish.
//
//   node scripts/test-run-cache-race.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-run-cache-race-"));
// Inside the checkout, so the bundle's external packages resolve.
const OUT = path.join(ROOT, "node_modules", ".cache", "run-cache-race-test");
const AT = "2026-11-17T09:00:00.000Z";

const noop = "const noop = () => {};";
const STUBS = {
  electron: `${noop}
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
export default { spawn };`,
  "./backend-registry": `export function getBackend() { throw new Error("no manager backend in this test"); }
export function listBackends() { return []; }
export async function disposeManagerSessions() {}`,
  "./pi-runtime-electron": `export async function listCodaraPiSkillNames() { return new Set(); }
export async function resolveCodaraPiExecutionAccount() { throw new Error("stubbed"); }
export async function resolveCodaraPiRuntime() { throw new Error("stubbed"); }
export async function resolveCodaraPiLibrary() { throw new Error("stubbed"); }
export async function resolveUserPiRuntime() { throw new Error("stubbed"); }
export function codaraPiPaths() { return { home: "/tmp/codara-stub-pi" }; }
export async function cleanupPiMcpBridgeConfig() {}
export async function createCodaraPiWorkerLaunchPlan() { throw new Error("stubbed"); }`,
};

function runFixture(id) {
  return {
    id,
    title: "cache race",
    status: "running",
    executionMode: "managed",
    chatBackend: "pi",
    chatMode: "execute",
    workspaceId: "ws-cache-race",
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: AT,
    updatedAt: AT,
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [
      { id: "msg-1", runId: id, author: "user", kind: "note", message: "migrate every service", attachments: [], createdAt: AT },
    ],
    sparkCalls: [],
  };
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  const runId = "run-cache-race";
  const runFile = path.join(HOME, "runs", runId, "run.json");
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify(runFixture(runId), null, 2));

  fs.mkdirSync(OUT, { recursive: true });
  const outfile = path.join(OUT, "run-store.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "run-store.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [
      {
        name: "run-cache-race-stubs",
        setup(build) {
          build.onResolve({ filter: /^(electron|node-pty|\.\/backend-registry|\.\/pi-runtime-electron)$/ }, (args) => ({
            path: args.path,
            namespace: "stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
        },
      },
    ],
  });

  // The first read of this run's file finishes only when the test says so.
  const realReadFile = fs.promises.readFile;
  let releaseSlowRead;
  const slowReadMayFinish = new Promise((resolve) => (releaseSlowRead = resolve));
  let slowReadStarted = false;
  let markSlowReadHolding;
  const slowReadHolding = new Promise((resolve) => (markSlowReadHolding = resolve));
  fs.promises.readFile = async function readFile(file, ...rest) {
    const content = await realReadFile.call(this, file, ...rest);
    if (!slowReadStarted && String(file) === runFile) {
      slowReadStarted = true;
      markSlowReadHolding();
      await slowReadMayFinish;
    }
    return content;
  };

  const runStore = require(outfile);
  try {
    const slowRead = runStore.getRun(runId); // the renderer listing runs
    await slowReadHolding; // it has the file as it was before the plan

    await runStore.updateManagerPlan(runId, {
      goal: "Migrate every service",
      milestones: [{ id: "m2", title: "billing", status: "pending" }],
    });
    releaseSlowRead();
    const slowResult = await slowRead;

    const current = await runStore.getRun(runId);
    assert.equal(slowResult, current, "the slow read itself returns the cached, newer run");
    assert.equal(
      current.managerPlan?.milestones?.[0]?.status,
      "pending",
      "a read that started before the plan was saved must not put the run without it back in the cache",
    );
    const onDisk = JSON.parse(fs.readFileSync(runFile, "utf8"));
    assert.equal(onDisk.managerPlan?.goal, "Migrate every service");
    console.log("PASS a slow read does not replace a newer cached run");
  } finally {
    fs.promises.readFile = realReadFile;
  }
}

main()
  .then(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  })
  .catch((error) => {
    console.log("FAIL a slow read does not replace a newer cached run");
    console.error(error && error.stack ? error.stack : error);
    fs.rmSync(HOME, { recursive: true, force: true });
    process.exit(1);
  });
