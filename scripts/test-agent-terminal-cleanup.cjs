#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-terminal-cleanup-"));

async function rejectsOwnership(promise, OwnershipError) {
  await assert.rejects(
    promise,
    (error) => error instanceof OwnershipError,
  );
}

async function main() {
  const outfile = path.join(TMP, "registry.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/agent-terminal-registry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const {
    AgentTerminalOwnershipError,
    AgentTerminalRegistry,
  } = require(outfile);

  const registry = new AgentTerminalRegistry(2);
  let callbacks = 0;
  await rejectsOwnership(
    registry.close({
      paneId: "unknown",
      runId: "run-a",
      stop: () => { callbacks += 1; },
      destroyTab: () => { callbacks += 1; },
    }),
    AgentTerminalOwnershipError,
  );
  assert.equal(callbacks, 0, "an unknown pane must not invoke cleanup callbacks");

  registry.register({ paneId: "pane-a", tabId: "tab-a", runId: "run-a" });
  await rejectsOwnership(
    registry.close({
      paneId: "pane-a",
      runId: "run-b",
      stop: () => { callbacks += 1; },
      destroyTab: () => { callbacks += 1; },
    }),
    AgentTerminalOwnershipError,
  );
  assert.equal(callbacks, 0, "another run must not invoke cleanup callbacks");
  assert.equal(registry.isActiveOwnedBy("pane-a", "run-a"), true);
  assert.equal(
    registry.isActiveOwnedBy("pane-a", "run-b"),
    false,
    "terminal writes must not cross run ownership",
  );

  const order = [];
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const closeInput = {
    paneId: "pane-a",
    runId: "run-a",
    stop: async () => {
      order.push("stop");
      await stopGate;
    },
    destroyTab: (registration) => {
      order.push(`destroy:${registration.tabId}`);
    },
  };
  const first = registry.close(closeInput);
  const concurrent = registry.close(closeInput);
  await Promise.resolve();
  assert.deepEqual(order, ["stop"], "concurrent cleanup must be single-flight");
  releaseStop();
  assert.deepEqual(await Promise.all([first, concurrent]), [
    { paneId: "pane-a", alreadyClosed: false },
    { paneId: "pane-a", alreadyClosed: false },
  ]);
  assert.deepEqual(order, ["stop", "destroy:tab-a"]);
  assert.equal(registry.isActiveOwnedBy("pane-a", "run-a"), false);

  const retry = await registry.close({
    paneId: "pane-a",
    runId: "run-a",
    stop: () => { callbacks += 1; },
    destroyTab: () => { callbacks += 1; },
  });
  assert.deepEqual(retry, { paneId: "pane-a", alreadyClosed: true });
  assert.equal(callbacks, 0, "a successful retry must not repeat cleanup callbacks");
  await rejectsOwnership(
    registry.close({
      paneId: "pane-a",
      runId: "run-b",
      stop: () => undefined,
      destroyTab: () => undefined,
    }),
    AgentTerminalOwnershipError,
  );

  registry.register({ paneId: "pane-retry", tabId: "tab-retry", runId: "run-a" });
  let destroyAttempts = 0;
  const retryInput = {
    paneId: "pane-retry",
    runId: "run-a",
    stop: () => undefined,
    destroyTab: () => {
      destroyAttempts += 1;
      if (destroyAttempts === 1) throw new Error("renderer reload");
    },
  };
  await assert.rejects(registry.close(retryInput), /renderer reload/);
  assert.equal(registry.isActiveOwnedBy("pane-retry", "run-a"), true);
  assert.deepEqual(
    await registry.close(retryInput),
    { paneId: "pane-retry", alreadyClosed: false },
  );
  assert.equal(destroyAttempts, 2, "failed renderer cleanup must be retryable");

  registry.register({ paneId: "pane-natural", tabId: "tab-natural", runId: "run-a" });
  assert.equal(
    registry.markExited({ paneId: "pane-natural", tabId: "tab-stale" }),
    false,
    "a stale exit callback must not unregister a reused pane id",
  );
  assert.equal(
    registry.markExited({ paneId: "pane-natural", tabId: "tab-natural" }),
    true,
  );
  assert.equal(registry.isActiveOwnedBy("pane-natural", "run-a"), false);
  let naturalStops = 0;
  let naturalDestroys = 0;
  assert.deepEqual(
    await registry.close({
      paneId: "pane-natural",
      runId: "run-a",
      stop: () => { naturalStops += 1; },
      destroyTab: () => { naturalDestroys += 1; },
    }),
    { paneId: "pane-natural", alreadyClosed: false },
  );
  assert.equal(naturalStops, 0, "a naturally exited PTY must not be killed again");
  assert.equal(naturalDestroys, 1, "close must still remove a naturally exited terminal tab");

  for (const suffix of ["one", "two", "three"]) {
    registry.register({
      paneId: `pane-exited-${suffix}`,
      tabId: `tab-exited-${suffix}`,
      runId: "run-a",
    });
    registry.markExited({
      paneId: `pane-exited-${suffix}`,
      tabId: `tab-exited-${suffix}`,
    });
  }
  await rejectsOwnership(
    registry.close({
      paneId: "pane-exited-one",
      runId: "run-a",
      stop: () => undefined,
      destroyTab: () => undefined,
    }),
    AgentTerminalOwnershipError,
  );

  registry.register({ paneId: "pane-retry", tabId: "tab-reused", runId: "run-b" });
  let reusedCallbacks = 0;
  assert.deepEqual(
    await registry.close({
      paneId: "pane-retry",
      runId: "run-b",
      stop: () => { reusedCallbacks += 1; },
      destroyTab: () => { reusedCallbacks += 1; },
    }),
    { paneId: "pane-retry", alreadyClosed: false },
  );
  assert.equal(reusedCallbacks, 2, "registering a reused pane id must clear its tombstone");

  const bulkRegistry = new AgentTerminalRegistry();
  bulkRegistry.register({ paneId: "pane-bulk-active", tabId: "tab-bulk-active", runId: "run-bulk" });
  bulkRegistry.register({
    paneId: "pane-bulk-service",
    tabId: "tab-bulk-service",
    runId: "run-bulk",
    retention: "service",
  });
  bulkRegistry.register({ paneId: "pane-bulk-exited", tabId: "tab-bulk-exited", runId: "run-bulk" });
  bulkRegistry.markExited({ paneId: "pane-bulk-exited", tabId: "tab-bulk-exited" });
  bulkRegistry.register({ paneId: "pane-other", tabId: "tab-other", runId: "run-other" });
  bulkRegistry.register({ paneId: "pane-null", tabId: "tab-null", runId: null });

  const allBulkSnapshots = bulkRegistry.listForRun("run-bulk");
  assert.deepEqual(
    allBulkSnapshots,
    [
      {
        paneId: "pane-bulk-active",
        tabId: "tab-bulk-active",
        runId: "run-bulk",
        retention: "temporary",
        state: "active",
      },
      {
        paneId: "pane-bulk-service",
        tabId: "tab-bulk-service",
        runId: "run-bulk",
        retention: "service",
        state: "active",
      },
      {
        paneId: "pane-bulk-exited",
        tabId: "tab-bulk-exited",
        runId: "run-bulk",
        retention: "temporary",
        state: "exited",
      },
    ],
    "listing must return exact active/exited run ownership with a temporary legacy default",
  );
  assert.equal(Object.isFrozen(allBulkSnapshots), true, "the listing container must be immutable");
  assert.equal(
    allBulkSnapshots.every(Object.isFrozen),
    true,
    "listing entries must not expose mutable registry state",
  );
  assert.deepEqual(
    bulkRegistry.listForRun("run-bulk", "temporary").map((terminal) => terminal.paneId),
    ["pane-bulk-active", "pane-bulk-exited"],
    "temporary filtering must preserve service panes",
  );

  let releaseBulk;
  const bulkGate = new Promise((resolve) => {
    releaseBulk = resolve;
  });
  const firstBulkCalls = [];
  const secondBulkCalls = [];
  const firstBulk = bulkRegistry.closeForRun({
    runId: "run-bulk",
    retention: "temporary",
    stop: async (terminal) => {
      firstBulkCalls.push(`stop:${terminal.paneId}`);
      await bulkGate;
    },
    destroyTab: async (terminal) => {
      firstBulkCalls.push(`destroy:${terminal.paneId}`);
      await bulkGate;
    },
  });
  const concurrentBulk = bulkRegistry.closeForRun({
    runId: "run-bulk",
    retention: "temporary",
    stop: () => {
      secondBulkCalls.push("stop");
    },
    destroyTab: () => {
      secondBulkCalls.push("destroy");
    },
  });
  await Promise.resolve();
  assert.deepEqual(
    firstBulkCalls.sort(),
    ["destroy:pane-bulk-exited", "stop:pane-bulk-active"],
    "bulk close must cover active and naturally exited panes",
  );
  assert.deepEqual(secondBulkCalls, [], "concurrent bulk close must share each pane's in-flight cleanup");
  releaseBulk();
  const [firstBulkResult, concurrentBulkResult] = await Promise.all([
    firstBulk,
    concurrentBulk,
  ]);
  for (const result of [firstBulkResult, concurrentBulkResult]) {
    assert.equal(result.runId, "run-bulk");
    assert.equal(result.retention, "temporary");
    assert.deepEqual(
      result.closed.map((entry) => entry.terminal.paneId),
      ["pane-bulk-active", "pane-bulk-exited"],
    );
    assert.deepEqual(result.failures, []);
  }
  assert.equal(
    firstBulkCalls.filter((call) => call === "destroy:pane-bulk-active").length,
    1,
    "an active pane must be stopped and destroyed once",
  );
  assert.equal(
    firstBulkCalls.filter((call) => call === "destroy:pane-bulk-exited").length,
    1,
    "an exited pane must only have its tab destroyed once",
  );
  assert.equal(
    firstBulkCalls.some((call) => call === "stop:pane-bulk-exited"),
    false,
    "an exited pane must not be stopped again",
  );
  assert.equal(
    bulkRegistry.isActiveOwnedBy("pane-bulk-service", "run-bulk"),
    true,
    "temporary settlement cleanup must preserve an explicit service pane",
  );
  assert.equal(
    bulkRegistry.isActiveOwnedBy("pane-other", "run-other"),
    true,
    "bulk cleanup must preserve another run's pane",
  );
  assert.equal(
    bulkRegistry.isActiveOwnedBy("pane-null", null),
    true,
    "bulk cleanup must preserve a null-owned user pane",
  );

  const serviceResult = await bulkRegistry.closeForRun({
    runId: "run-bulk",
    stop: () => undefined,
    destroyTab: () => undefined,
  });
  assert.deepEqual(
    serviceResult.closed.map((entry) => entry.terminal.paneId),
    ["pane-bulk-service"],
    "unfiltered run deletion cleanup must include retained services",
  );
  assert.deepEqual(serviceResult.failures, []);
  assert.equal(bulkRegistry.isActiveOwnedBy("pane-other", "run-other"), true);
  assert.equal(bulkRegistry.isActiveOwnedBy("pane-null", null), true);

  const retryRegistry = new AgentTerminalRegistry();
  retryRegistry.register({ paneId: "pane-fails-once", tabId: "tab-fails-once", runId: "run-retry" });
  retryRegistry.register({ paneId: "pane-still-closes", tabId: "tab-still-closes", runId: "run-retry" });
  let failedDestroyAttempts = 0;
  const firstRetryResult = await retryRegistry.closeForRun({
    runId: "run-retry",
    stop: () => undefined,
    destroyTab: (terminal) => {
      if (terminal.paneId === "pane-fails-once") {
        failedDestroyAttempts += 1;
        if (failedDestroyAttempts === 1) throw new Error("transient renderer failure");
      }
    },
  });
  assert.deepEqual(
    firstRetryResult.closed.map((entry) => entry.terminal.paneId),
    ["pane-still-closes"],
    "one failure must not skip another owned pane",
  );
  assert.deepEqual(
    firstRetryResult.failures.map((entry) => entry.terminal.paneId),
    ["pane-fails-once"],
    "bulk cleanup must aggregate exact failures",
  );
  assert.match(
    String(firstRetryResult.failures[0].error),
    /transient renderer failure/,
  );
  assert.deepEqual(
    retryRegistry.listForRun("run-retry").map((terminal) => terminal.paneId),
    ["pane-fails-once"],
    "only the failed pane must remain registered for retry",
  );

  const retried = await retryRegistry.closeForRun({
    runId: "run-retry",
    stop: () => undefined,
    destroyTab: () => {
      failedDestroyAttempts += 1;
    },
  });
  assert.deepEqual(
    retried.closed.map((entry) => entry.terminal.paneId),
    ["pane-fails-once"],
    "a failed bulk cleanup must be retryable",
  );
  assert.deepEqual(retried.failures, []);
  assert.equal(failedDestroyAttempts, 2);

  const idempotentBulk = await retryRegistry.closeForRun({
    runId: "run-retry",
    stop: () => {
      throw new Error("idempotent cleanup must not stop again");
    },
    destroyTab: () => {
      throw new Error("idempotent cleanup must not destroy again");
    },
  });
  assert.deepEqual(idempotentBulk.closed, []);
  assert.deepEqual(idempotentBulk.failures, []);

  const settingsSource = fs.readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "SettingsDialog.tsx"),
    "utf8",
  );
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const surface of [settingsSource, readme]) {
    assert.match(surface, /Temporary worker panes close/);
    assert.match(surface, /Service panes\s+remain until (?:the|their) run is deleted/);
    assert.match(surface, /failed closes retry automatically/i);
  }

  console.log(
    "PASS: agent terminal cleanup is exact, retention-aware, exhaustive, single-flight, retryable, and idempotent",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
