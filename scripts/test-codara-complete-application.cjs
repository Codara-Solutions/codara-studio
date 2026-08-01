// Durable codara_complete application-outbox regression harness.
//
// Bundles the real run-store with only Electron/node-pty stubbed, then uses
// child-process exits as crash boundaries:
//   old snapshot -> effects_applied snapshot -> boot-local settlement.

// Run with: node scripts/test-codara-complete-application.cjs

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const NOW = "2026-07-31T10:00:00.000Z";
const SUMMARY = "Verified implementation complete.";

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

const PTY_STUB = `export function spawn() { throw new Error("node-pty is stubbed"); }
export function exists() { return false; }
export default { spawn, exists };`;

const stubPlugin = {
  name: "codara-complete-application-stubs",
  setup(build) {
    build.onResolve({ filter: /^(electron|node-pty)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "electron" ? ELECTRON_STUB : PTY_STUB,
      loader: "js",
    }));
  },
};

function runFixture(id, overrides = {}) {
  const callId = `spark-${id}`;
  const messageId = `msg-${id}`;
  return {
    id,
    workspaceId: "ws-complete-application",
    title: "Complete safely",
    status: "running",
    executionMode: "orchestrated",
    chatMode: "execute",
    artifactDir: path.join(process.env.TEST_HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [{
      id: callId,
      runId: id,
      mode: "chat",
      model: "gpt-5.6",
      status: "started",
      inputMessageIds: [messageId],
      conversationEpoch: 0,
      createdAt: NOW,
    }],
    humanMessages: [{
      id: messageId,
      runId: id,
      author: "user",
      kind: "note",
      message: "Finish this run.",
      attachments: [],
      intent: "turn",
      deliveryState: "submitted",
      backendTurnId: callId,
      conversationEpoch: 0,
      createdAt: NOW,
    }],
    atomicClaims: [],
    confidence: "VERIFIED",
    conversationEpoch: 0,
    autopilot: { status: "running", updatedAt: NOW },
    ...overrides,
  };
}

function writeRun(home, value) {
  const dir = path.join(home, "runs", value.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(value));
}

function readRun(home, id) {
  return JSON.parse(
    fs.readFileSync(path.join(home, "runs", id, "run.json"), "utf8"),
  );
}

async function childMain(mode) {
  process.env.CODARA_HOME_DIR = process.env.TEST_HOME;
  const store = require(process.env.TEST_RUN_STORE_BUNDLE);
  const runId = process.env.TEST_RUN_ID;
  const resultPath = path.join(process.env.TEST_HOME, `${mode}.json`);

  if (mode === "before-commit") {
    process.exit(86);
  }
  if (mode === "apply-then-crash") {
    await store.applyCodaraCompleteFromManagerCall({ runId, summary: SUMMARY });
    // Simulate losing the provider/caller immediately after the application
    // commit and before #062's ordinary manager-call settlement runs.
    process.exit(86);
  }
  if (mode === "retry") {
    const result = await store.applyCodaraCompleteFromManagerCall({
      runId,
      summary: `  ${SUMMARY}  `,
    });
    fs.writeFileSync(resultPath, JSON.stringify({
      callId: result.callId,
      replayed: result.replayed,
      result: result.result,
    }));
    return;
  }
  if (mode === "conflict") {
    try {
      await store.applyCodaraCompleteFromManagerCall({
        runId,
        summary: "A different completion payload.",
      });
      fs.writeFileSync(resultPath, JSON.stringify({ error: null }));
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (mode === "recover") {
    await store.recoverOrphanedManagerTurns();
    await store.recoverManagerTurnRecoveries();
    return;
  }
  throw new Error(`Unknown child mode: ${mode}`);
}

function runChild(home, bundle, runId, mode, expectedStatus = 0) {
  const child = spawnSync(process.execPath, [__filename, "child", mode], {
    cwd: ROOT,
    env: {
      ...process.env,
      TEST_HOME: home,
      TEST_RUN_ID: runId,
      TEST_RUN_STORE_BUNDLE: bundle,
      CODARA_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
    },
    encoding: "utf8",
  });
  assert.equal(
    child.status,
    expectedStatus,
    `${mode} exited ${child.status}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
  );
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-complete-application-"));
  process.env.TEST_HOME = home;
  const cacheRoot = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const cache = fs.mkdtempSync(
    path.join(cacheRoot, "codara-complete-application-test-"),
  );
  const bundle = path.join(cache, "run-store.cjs");
  await esbuild.build({
    entryPoints: [RUN_STORE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    packages: "external",
    plugins: [stubPlugin],
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });

  const runId = "run-complete-crash";
  writeRun(home, runFixture(runId));

  runChild(home, bundle, runId, "before-commit", 86);
  let snapshot = readRun(home, runId);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.sparkCalls[0].applicationReceipts, undefined);
  assert.equal(snapshot.humanMessages[0].deliveryState, "submitted");
  console.log("PASS crash before commit preserves the complete old snapshot");

  runChild(home, bundle, runId, "apply-then-crash", 86);
  snapshot = readRun(home, runId);
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.sparkCalls[0].status, "started");
  assert.equal(snapshot.humanMessages[0].deliveryState, "submitted");
  assert.equal(snapshot.sparkCalls[0].applicationReceipts.length, 1);
  assert.equal(
    snapshot.sparkCalls[0].applicationReceipts[0].key,
    `spark-${runId}:codara_complete`,
  );
  assert.deepEqual(snapshot.sparkCalls[0].applicationReceipts[0].result, { ok: true });
  assert.equal(
    snapshot.humanMessages.filter((message) => message.message === SUMMARY).length,
    1,
  );
  console.log("PASS crash after application exposes one atomic effects_applied snapshot");

  runChild(home, bundle, runId, "retry");
  const retry = JSON.parse(fs.readFileSync(path.join(home, "retry.json"), "utf8"));
  snapshot = readRun(home, runId);
  assert.deepEqual(retry, {
    callId: `spark-${runId}`,
    replayed: true,
    result: { ok: true },
  });
  assert.equal(snapshot.sparkCalls[0].applicationReceipts.length, 1);
  assert.equal(
    snapshot.humanMessages.filter((message) => message.message === SUMMARY).length,
    1,
  );
  console.log("PASS identical call retry returns the stored safe result without duplicates");

  runChild(home, bundle, runId, "conflict");
  const conflict = JSON.parse(fs.readFileSync(path.join(home, "conflict.json"), "utf8"));
  snapshot = readRun(home, runId);
  assert.match(conflict.error, /different payload/i);
  assert.equal(
    snapshot.humanMessages.some(
      (message) => message.message === "A different completion payload.",
    ),
    false,
  );
  assert.equal(snapshot.sparkCalls[0].applicationReceipts.length, 1);
  console.log("PASS changed call retry conflicts before domain mutation");

  runChild(home, bundle, runId, "recover");
  snapshot = readRun(home, runId);
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.sparkCalls[0].status, "completed");
  assert.ok(snapshot.sparkCalls[0].completedAt);
  assert.equal(snapshot.sparkCalls[0].error, undefined);
  assert.equal(snapshot.humanMessages[0].deliveryState, "acknowledged");
  assert.equal(snapshot.humanMessages[0].backendTurnId, `spark-${runId}`);
  assert.equal(snapshot.pendingManagerResume, undefined);
  assert.equal(snapshot.managerTurnRecovery, undefined);
  console.log("PASS boot settles the receipted call locally without requeue/provider replay");

  const corruptId = "run-complete-corrupt";
  const corrupt = runFixture(corruptId);
  corrupt.sparkCalls[0].applicationReceipts = [{
    key: `spark-${corruptId}:codara_complete`,
    method: "codara_complete",
    state: "effects_applied",
    payloadSchemaVersion: 1,
    payloadSha256: "not-a-sha256",
    result: { ok: true },
    appliedAt: NOW,
  }];
  writeRun(home, corrupt);
  runChild(home, bundle, corruptId, "recover");
  const corruptRecovered = readRun(home, corruptId);
  assert.equal(corruptRecovered.sparkCalls[0].status, "failed");
  assert.equal(corruptRecovered.sparkCalls[0].applicationReceiptIntegrity, "invalid");
  assert.match(corruptRecovered.sparkCalls[0].error, /provider replay was suppressed/i);
  assert.equal(corruptRecovered.humanMessages[0].deliveryState, "acknowledged");
  assert.equal(corruptRecovered.pendingManagerResume, undefined);
  console.log("PASS malformed persisted receipt fails closed and never requeues input");

  const remoteSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "production.ts"),
    "utf8",
  );
  const projection = remoteSource.slice(
    remoteSource.indexOf("function toRemoteRun("),
    remoteSource.indexOf("async function listWorkerSessionsForRemote"),
  );
  assert.doesNotMatch(projection, /sparkCalls|applicationReceipts|applicationReceiptIntegrity/);
  console.log("PASS remote run projection omits private application receipts");
}

if (process.argv[2] === "child") {
  childMain(process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
