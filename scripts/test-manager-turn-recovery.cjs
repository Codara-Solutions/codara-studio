// Durable parked-manager-turn recovery regression harness.
//
// Exercises the real run-store over throwaway run.json records. It focuses on
// the crash/idempotency seams that do not require launching a provider:
// stale tokens, already-resuming claims, incompatible account selectors,
// completed-claim cleanup, interrupted-claim reparking, and malformed record
// normalization.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "run-store.ts",
);
const CACHE = path.join(
  ROOT,
  "node_modules",
  ".cache",
  "manager-turn-recovery-test",
);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "manager-turn-recovery-"));
const NOW = "2026-07-31T10:00:00.000Z";

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
  name: "manager-turn-recovery-stubs",
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

function recovery(overrides = {}) {
  return {
    id: "recovery-ms7-test",
    state: "parked",
    failureKind: "provider",
    backend: "pi",
    managerMode: "worker_result_review",
    conversationEpoch: 0,
    failedSparkCallId: "spark-failed",
    failedAccountProfileId: "11111111-1111-4111-8111-111111111111",
    parkedAt: NOW,
    ...overrides,
  };
}

function run(id, overrides = {}) {
  return {
    id,
    workspaceId: "ws-recovery",
    title: "Recover me",
    status: "paused",
    chatBackend: "pi",
    executionMode: "orchestrated",
    artifactDir: path.join(HOME, "runs", id, "artifacts"),
    createdAt: NOW,
    updatedAt: NOW,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [
      {
        id: "spark-failed",
        runId: id,
        mode: "worker_result_review",
        model: "gpt-5.6",
        status: "failed",
        conversationEpoch: 0,
        createdAt: NOW,
        completedAt: NOW,
      },
    ],
    humanMessages: [],
    atomicClaims: [],
    confidence: "PARTIAL",
    conversationEpoch: 0,
    managerTurnRecovery: recovery(),
    autopilot: {
      status: "paused",
      lastAction: "manager_turn_parked",
      pausedAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

function writeRun(value) {
  const dir = path.join(HOME, "runs", value.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(value));
}

function readRun(id) {
  return JSON.parse(
    fs.readFileSync(path.join(HOME, "runs", id, "run.json"), "utf8"),
  );
}

async function main() {
  process.env.CODARA_HOME_DIR = HOME;
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, "run-store.cjs");
  await esbuild.build({
    entryPoints: [RUN_STORE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    packages: "external",
    plugins: [stubPlugin],
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  delete require.cache[outfile];
  const store = require(outfile);

  writeRun(run("run-stale"));
  const stale = await store.resumeManagerTurnRecovery({
    runId: "run-stale",
    recoveryId: "recovery-different",
  });
  assert.equal(stale.outcome, "stale");
  assert.equal(readRun("run-stale").status, "paused");
  console.log("PASS stale recovery token cannot launch or mutate");

  writeRun(
    run("run-resuming", {
      status: "running",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-live",
        resumeRequestedAt: NOW,
      }),
    }),
  );
  const replay = await store.resumeManagerTurnRecovery({
    runId: "run-resuming",
    recoveryId: "recovery-ms7-test",
  });
  assert.equal(replay.outcome, "already-resuming");
  assert.equal(
    readRun("run-resuming").managerTurnRecovery.resumeClaimId,
    "recovery-claim-ms7-live",
  );
  console.log("PASS lost-receipt replay observes the durable in-flight claim");

  writeRun(run("run-incompatible"));
  const incompatible = await store.resumeManagerTurnRecovery({
    runId: "run-incompatible",
    recoveryId: "recovery-ms7-test",
    account: {
      kind: "native-cli",
      backend: "codex",
      profileId: "personal",
    },
  });
  assert.equal(incompatible.outcome, "account-incompatible");
  assert.equal(readRun("run-incompatible").chatAccountProfileId, undefined);
  console.log("PASS incompatible account selectors fail before the CAS");

  writeRun(
    run("run-completed-claim", {
      status: "running",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-complete",
        resumeRequestedAt: NOW,
        resumeAccountProfileId: "11111111-1111-4111-8111-111111111111",
      }),
      sparkCalls: [
        {
          id: "spark-replacement",
          runId: "run-completed-claim",
          mode: "worker_result_review",
          model: "gpt-5.6",
          status: "completed",
          managerRecoveryClaimId: "recovery-claim-ms7-complete",
          accountProfileId: "11111111-1111-4111-8111-111111111111",
          conversationEpoch: 0,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    }),
  );
  await store.recoverManagerTurnRecoveries();
  assert.equal(readRun("run-completed-claim").managerTurnRecovery, undefined);
  console.log("PASS boot clears a recovery only after a linked completed call");

  writeRun(
    run("run-wrong-account-claim", {
      status: "running",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-wrong-account",
        resumeRequestedAt: NOW,
        resumeAccountProfileId: "11111111-1111-4111-8111-111111111111",
        forceCanonicalReplay: true,
      }),
      sparkCalls: [
        {
          id: "spark-wrong-account",
          runId: "run-wrong-account-claim",
          mode: "worker_result_review",
          model: "gpt-5.6",
          status: "completed",
          managerRecoveryClaimId: "recovery-claim-ms7-wrong-account",
          accountProfileId: "22222222-2222-4222-8222-222222222222",
          conversationEpoch: 0,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    }),
  );
  await store.recoverManagerTurnRecoveries();
  const wrongAccount = readRun("run-wrong-account-claim");
  assert.equal(wrongAccount.managerTurnRecovery.state, "parked");
  assert.equal(wrongAccount.managerTurnRecovery.forceCanonicalReplay, true);
  assert.equal(wrongAccount.status, "paused");
  console.log("PASS a mismatched completed call cannot clear the claimed account recovery");

  writeRun(
    run("run-interrupted-claim", {
      status: "running",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-interrupted",
        resumeRequestedAt: NOW,
      }),
      sparkCalls: [
        {
          id: "spark-replacement",
          runId: "run-interrupted-claim",
          mode: "worker_result_review",
          model: "gpt-5.6",
          status: "failed",
          managerRecoveryClaimId: "recovery-claim-ms7-interrupted",
          conversationEpoch: 0,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    }),
  );
  await store.recoverManagerTurnRecoveries();
  const interrupted = readRun("run-interrupted-claim");
  assert.equal(interrupted.status, "paused");
  assert.equal(interrupted.managerTurnRecovery.id, "recovery-ms7-test");
  assert.equal(interrupted.managerTurnRecovery.state, "parked");
  assert.equal(interrupted.managerTurnRecovery.resumeClaimId, undefined);
  assert.equal(interrupted.managerTurnRecovery.managerMode, "worker_result_review");
  console.log("PASS boot reparks an interrupted claim without losing exact mode");

  writeRun(
    run("run-blocked-claim", {
      status: "blocked",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-blocked",
        resumeRequestedAt: NOW,
      }),
      blockedOn: {
        questionMessageId: "message-question",
        category: "irreducible_product_scope",
        previousStatus: "running",
        resumeStatus: "running",
        source: "manager_decision",
        resumeStrategy: "schedule_manager",
        managerMode: "worker_result_review",
        blockedAt: NOW,
      },
    }),
  );
  await store.recoverManagerTurnRecoveries();
  const blocked = readRun("run-blocked-claim");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedOn.questionMessageId, "message-question");
  assert.equal(blocked.managerTurnRecovery, undefined);
  console.log("PASS boot recovery cannot overwrite a durable blocker");

  writeRun(
    run("run-frozen-config", {
      status: "running",
      managerTurnRecovery: recovery({
        state: "resuming",
        resumeClaimId: "recovery-claim-ms7-frozen",
        resumeRequestedAt: NOW,
      }),
    }),
  );
  await assert.rejects(
    store.updateChatBackend({
      runId: "run-frozen-config",
      chatModel: "different-model",
    }),
    /frozen provider configuration/,
  );
  assert.equal(readRun("run-frozen-config").chatModel, undefined);
  console.log("PASS an accepted recovery claim freezes provider configuration");

  writeRun(
    run("run-malformed", {
      managerTurnRecovery: {
        ...recovery(),
        failureKind: "authentication",
      },
    }),
  );
  const malformed = await store.getRun("run-malformed");
  assert.equal(malformed.managerTurnRecovery, undefined);
  console.log("PASS malformed persisted recovery metadata fails closed");

  const source = fs.readFileSync(RUN_STORE, "utf8");
  assert.match(source, /if \(run\.managerTurnRecovery\)/);
  assert.match(source, /resumeManagerTurnRecovery\(\{/);
  assert.doesNotMatch(
    source,
    /stopReason\s*\?\?\s*userUpdate/,
    "operational stop reasons must not become user prompts",
  );
  assert.match(
    source,
    /recoveryOwnsCall[\s\S]*recovery\?\.forceCanonicalReplay === true/,
    "account rotation must force canonical history replay for the claimed call",
  );
  assert.doesNotMatch(
    source,
    /const replyText = result\.decision\.chatReply\?\.trim\(\)/,
    "provider failure output must stay out of conversational history",
  );
  console.log("PASS ordinary Resume routes parked tokens through exact recovery");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
