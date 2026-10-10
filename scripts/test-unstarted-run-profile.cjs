// The composer offers a Cora profile for a chat the board minted but never
// started, and its first send reuses that run (OrchestrationSidebar.startChat
// passes runId plus the picked coraProfileId to startAutopilot). The pick has
// to land on the run before its first manager turn, while a run that already
// had a conversation keeps the profile it started with.
//
//   node scripts/test-unstarted-run-profile.cjs
//
// Bundles the REAL run-store.ts against an electron/node-pty stub and drives
// adoptCoraProfileForUnstartedRun over fabricated run.json files under a
// throwaway CODARA_HOME_DIR, the same harness shape as
// scripts/test-wedged-run-recovery.cjs.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const CACHE = path.join(ROOT, "node_modules", ".cache", "cora-unstarted-profile-test");

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

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === undefined ? "" : ` - ${detail}`}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-unstarted-profile-"));
const WS = "ws-unstarted-profile";
const NOW = "2026-10-10T12:00:00.000Z";

function idleRun(id, overrides = {}) {
  return {
    id,
    title: "board chat",
    status: "idle",
    executionMode: "managed",
    chatBackend: "pi",
    workspaceId: WS,
    cwd: HOME,
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    conversationEpoch: 0,
    coraProfileId: "default",
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
  return run;
}
function readRun(runId) {
  return JSON.parse(fs.readFileSync(path.join(HOME, "runs", runId, "run.json"), "utf8"));
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, "memory", "profiles.json"),
    JSON.stringify({
      version: 1,
      defaultProfileId: "default",
      profiles: [{ id: "reviewer", name: "Reviewer", description: "", createdAt: NOW }],
    }),
  );

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

  const fresh = writeRun(idleRun("run-board-fresh"));
  const adopted = await runStore.adoptCoraProfileForUnstartedRun(fresh, "reviewer");
  check("an unstarted run takes the picked profile", adopted.coraProfileId === "reviewer", adopted.coraProfileId);
  check(
    "the pick is persisted before the first turn reads it",
    readRun(fresh.id).coraProfileId === "reviewer",
    readRun(fresh.id).coraProfileId,
  );

  const byName = writeRun(idleRun("run-board-by-name"));
  const named = await runStore.adoptCoraProfileForUnstartedRun(byName, "Reviewer");
  check("a profile named instead of id'd resolves the same way", named.coraProfileId === "reviewer", named.coraProfileId);

  const untouched = writeRun(idleRun("run-board-no-pick", { coraProfileId: "reviewer" }));
  const kept = await runStore.adoptCoraProfileForUnstartedRun(untouched, undefined);
  check("no pick leaves the minted profile alone", kept.coraProfileId === "reviewer", kept.coraProfileId);

  const started = writeRun(
    idleRun("run-started", {
      humanMessages: [
        {
          id: "msg-1",
          author: "user",
          kind: "note",
          message: "hello",
          createdAt: NOW,
          deliveryState: "acknowledged",
          conversationEpoch: 0,
        },
      ],
    }),
  );
  const frozen = await runStore.adoptCoraProfileForUnstartedRun(started, "reviewer");
  check("a run that had a conversation keeps its profile", frozen.coraProfileId === "default", frozen.coraProfileId);
  check("and nothing is written for it", readRun(started.id).coraProfileId === "default");

  const running = writeRun(idleRun("run-running", { status: "running" }));
  const stillDefault = await runStore.adoptCoraProfileForUnstartedRun(running, "reviewer");
  check("a running run keeps its profile", stillDefault.coraProfileId === "default", stillDefault.coraProfileId);

  let unknownError = null;
  try {
    await runStore.adoptCoraProfileForUnstartedRun(writeRun(idleRun("run-unknown")), "ghost");
  } catch (err) {
    unknownError = err;
  }
  check(
    "an unknown profile is an error, not a silent fallback",
    unknownError instanceof Error && /Unknown Cora profile/.test(unknownError.message),
    unknownError && unknownError.message,
  );

  fs.rmSync(HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("PASS an unstarted chat takes the profile picked for its first send");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
