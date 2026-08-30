#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-runtime-shutdown-"));

async function loadShutdownFactory() {
  const outfile = path.join(TMP, "run-runtime-shutdown.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src/main/orchestration/run-runtime-shutdown.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile).createRunRuntimeShutdown;
}

async function testNonPtyProviderDrain(createRunRuntimeShutdown) {
  const disposed = [];
  const killedPtys = [];
  const shutdown = createRunRuntimeShutdown({
    activeWorkers: () => [],
    activeRunIds: () => [],
    persistedRunIds: async () => ["persisted-pi-run"],
    disposeManagerSessions: async (runId) => disposed.push(runId),
    killPty: (attemptId) => killedPtys.push(attemptId),
    releaseWorker: () => undefined,
  });

  await shutdown();
  assert.deepEqual(disposed, ["persisted-pi-run"]);
  assert.deepEqual(killedPtys, []);
}

async function testEveryActiveWorkerIsStopped(createRunRuntimeShutdown) {
  const calls = [];
  const workers = [
    {
      runId: "worker-run-a",
      attemptId: "attempt-a",
      kill: () => {
        calls.push("kill:attempt-a");
        workers.pop(); // Simulate a synchronous process-exit map mutation.
        throw new Error("synthetic worker kill failure");
      },
    },
    {
      runId: "worker-run-b",
      attemptId: "attempt-b",
      kill: () => calls.push("kill:attempt-b"),
    },
  ];
  const shutdown = createRunRuntimeShutdown({
    activeWorkers: () => workers,
    activeRunIds: () => [],
    persistedRunIds: async () => [],
    disposeManagerSessions: async (runId) => calls.push(`dispose:${runId}`),
    killPty: (attemptId) => calls.push(`pty:${attemptId}`),
    releaseWorker: (attemptId) => calls.push(`release:${attemptId}`),
  });

  const result = shutdown();
  assert.deepEqual(calls.slice(0, 6), [
    "kill:attempt-a",
    "pty:attempt-a",
    "release:attempt-a",
    "kill:attempt-b",
    "pty:attempt-b",
    "release:attempt-b",
  ]);
  await result;
  assert(calls.includes("dispose:worker-run-a"));
  assert(calls.includes("dispose:worker-run-b"));
}

async function testAllResourcesDespiteFailures(createRunRuntimeShutdown) {
  const disposed = [];
  const shutdown = createRunRuntimeShutdown({
    activeWorkers: () => [],
    activeRunIds: () => ["active-broken", "active-healthy"],
    persistedRunIds: async () => ["active-healthy", "persisted-healthy"],
    disposeManagerSessions: async (runId) => {
      disposed.push(runId);
      if (runId === "active-broken") throw new Error("synthetic provider failure");
    },
    killPty: () => undefined,
    releaseWorker: () => undefined,
  });

  await shutdown();
  assert.deepEqual(new Set(disposed), new Set([
    "active-broken",
    "active-healthy",
    "persisted-healthy",
  ]));
  assert.equal(disposed.filter((id) => id === "active-healthy").length, 1);
}

async function testIdempotence(createRunRuntimeShutdown) {
  let workerKills = 0;
  let providerDisposals = 0;
  const shutdown = createRunRuntimeShutdown({
    activeWorkers: () => [{
      runId: "one-run",
      attemptId: "one-attempt",
      kill: () => { workerKills += 1; },
    }],
    activeRunIds: () => ["one-run"],
    persistedRunIds: async () => ["one-run"],
    disposeManagerSessions: async () => { providerDisposals += 1; },
    killPty: () => undefined,
    releaseWorker: () => undefined,
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second, "repeated shutdown calls must share one promise");
  await first;
  assert.equal(shutdown(), first, "completed shutdown remains single-flight");
  assert.equal(workerKills, 1);
  assert.equal(providerDisposals, 1);
}

async function testBoundedDrain(createRunRuntimeShutdown) {
  const keepAlive = setTimeout(() => undefined, 500);
  const shutdown = createRunRuntimeShutdown({
    activeWorkers: () => [],
    activeRunIds: () => ["hung-provider"],
    persistedRunIds: async () => [],
    disposeManagerSessions: async () => new Promise(() => undefined),
    killPty: () => undefined,
    releaseWorker: () => undefined,
  });

  const startedAt = Date.now();
  await shutdown(25);
  clearTimeout(keepAlive);
  assert(
    Date.now() - startedAt < 250,
    "shutdown must return within its bounded provider-drain window",
  );
}

function testRunStoreAndQuitWiring() {
  const runStore = fs.readFileSync(
    path.join(ROOT, "src/main/orchestration/run-store.ts"),
    "utf8",
  );
  assert.match(
    runStore,
    /export function shutdownRunRuntimeResources\(maxWaitMs\?: number\): Promise<void>/,
  );
  assert.match(runStore, /activeWorkers: \(\) => activeWorkerProcesses\.values\(\)/);
  assert.match(runStore, /activeRunIds: \(\) => runCache\.keys\(\)/);
  assert.match(runStore, /persistedRunIds: \(\) => fs\.readdir\(runsRoot\(\)\)/);

  const main = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8");
  const beforeQuitAt = main.indexOf('app.on("before-quit"');
  assert(beforeQuitAt >= 0, "before-quit handler must exist");
  const beforeQuit = main.slice(beforeQuitAt);
  const drainAt = beforeQuit.indexOf("shutdownRunRuntimeResources()");
  const ptyAt = beforeQuit.indexOf("await pty.disposeAllGraceful()");
  // The final quit is updater-aware: after cleanup, cleanQuit flips and the
  // handler either hands the process to Squirrel (an update was requested)
  // or calls app.quit(). Both paths sit after the PTY teardown.
  const finalQuitAt = beforeQuit.indexOf("cleanQuit = true;");
  const quitCallAt = beforeQuit.indexOf("app.quit()", finalQuitAt);
  assert(drainAt >= 0, "before-quit must await the runtime drain");
  assert(drainAt < ptyAt, "runtime drain must precede broad PTY teardown");
  assert(ptyAt < finalQuitAt, "PTY teardown must finish before the final quit");
  assert(quitCallAt > finalQuitAt, "a quit path must follow the cleanQuit flip");
}

async function main() {
  const createRunRuntimeShutdown = await loadShutdownFactory();
  await testNonPtyProviderDrain(createRunRuntimeShutdown);
  await testEveryActiveWorkerIsStopped(createRunRuntimeShutdown);
  await testAllResourcesDespiteFailures(createRunRuntimeShutdown);
  await testIdempotence(createRunRuntimeShutdown);
  await testBoundedDrain(createRunRuntimeShutdown);
  testRunStoreAndQuitWiring();

  console.log("PASS persisted non-PTY provider sessions are drained");
  console.log("PASS every active worker and backing PTY is stopped best-effort");
  console.log("PASS provider failures do not block other resource attempts");
  console.log("PASS quit drain is idempotent, single-flight, and time-bounded");
  console.log("PASS awaited before-quit wiring drains runtime before PTYs and app.quit");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
