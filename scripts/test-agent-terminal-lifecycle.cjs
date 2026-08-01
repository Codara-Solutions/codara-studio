#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-terminal-lifecycle-"));

function runtimeStubs() {
  return {
    name: "agent-terminal-lifecycle-runtime-stubs",
    setup(build) {
      build.onResolve({ filter: /^\.\/pty-manager$/ }, () => ({
        path: "pty-manager",
        namespace: "terminal-lifecycle-stub",
      }));
      build.onResolve({ filter: /^\.\/terminal-bridge$/ }, () => ({
        path: "terminal-bridge",
        namespace: "terminal-lifecycle-stub",
      }));
      build.onLoad(
        { filter: /^pty-manager$/, namespace: "terminal-lifecycle-stub" },
        () => ({
          loader: "js",
          contents: `
            export function killImmediate(paneId) {
              globalThis.__codaraTerminalLifecycleStub.kills.push(paneId);
            }
          `,
        }),
      );
      build.onLoad(
        { filter: /^terminal-bridge$/, namespace: "terminal-lifecycle-stub" },
        () => ({
          loader: "js",
          contents: `
            export function requestTerminalOp(op, params, options) {
              return globalThis.__codaraTerminalLifecycleStub.request(op, params, options);
            }
          `,
        }),
      );
    },
  };
}

function result(runId, retention, failures = []) {
  return { runId, retention, closed: [], failures };
}

async function waitFor(label, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  globalThis.__codaraTerminalLifecycleStub = {
    kills: [],
    request: async () => ({ ok: true }),
  };

  const lifecycleOut = path.join(TMP, "lifecycle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/agent-terminal-lifecycle.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: lifecycleOut,
    plugins: [runtimeStubs()],
    logLevel: "silent",
  });

  const {
    AgentTerminalCleanupCoordinator,
    agentTerminals,
    canRegisterAgentTerminal,
    fenceAgentTerminalRunDeleting,
    markAgentTerminalRunActive,
    registerAgentTerminal,
    retryPendingAgentTerminalCleanups,
    settleAgentTerminalRun,
  } = require(lifecycleOut);

  // Equal callers join one pass; a concurrent deletion upgrades the queued
  // scope and cannot be downgraded by settlement.
  const calls = [];
  let releaseTemporary;
  const temporaryGate = new Promise((resolve) => {
    releaseTemporary = resolve;
  });
  const coordinator = new AgentTerminalCleanupCoordinator(
    async (runId, scope) => {
      calls.push(`${runId}:${scope}`);
      if (scope === "temporary") await temporaryGate;
      return result(runId, scope);
    },
    [60_000],
  );
  const firstTemporary = coordinator.request("run-upgrade", "temporary");
  const duplicateTemporary = coordinator.request("run-upgrade", "temporary");
  const deletion = coordinator.request("run-upgrade", "all");
  await Promise.resolve();
  assert.deepEqual(calls, ["run-upgrade:temporary"]);
  releaseTemporary();
  await Promise.all([firstTemporary, duplicateTemporary, deletion]);
  assert.deepEqual(
    calls,
    ["run-upgrade:temporary", "run-upgrade:all"],
    "delete must upgrade a joined settlement pass without duplicating the temporary pass",
  );

  // A terminal can finish spawning after an all-scope deletion pass already
  // captured its snapshot. A fresh request must force another enumeration,
  // rather than incorrectly joining the broader-but-stale in-flight pass.
  const freshCalls = [];
  let releaseAll;
  const allGate = new Promise((resolve) => {
    releaseAll = resolve;
  });
  const freshCoordinator = new AgentTerminalCleanupCoordinator(
    async (runId, scope) => {
      freshCalls.push(`${runId}:${scope}`);
      if (scope === "all") await allGate;
      return result(runId, scope);
    },
    [60_000],
  );
  const allPass = freshCoordinator.request("run-fresh", "all");
  await Promise.resolve();
  freshCoordinator.enqueueFresh("run-fresh", "temporary");
  releaseAll();
  await allPass;
  await waitFor("post-snapshot fresh pass", () => freshCalls.length === 2);
  assert.deepEqual(
    freshCalls,
    ["run-fresh:all", "run-fresh:temporary"],
    "late registration must force a pass after the stale in-flight snapshot",
  );

  // A failed renderer pass resolves its initiating caller (the PTY is already
  // stopped), stays pending, and renderer-ready forces an immediate retry.
  let retryAttempts = 0;
  const retryCoordinator = new AgentTerminalCleanupCoordinator(
    async (runId, scope) => {
      retryAttempts += 1;
      return result(
        runId,
        scope,
        retryAttempts === 1
          ? [{ terminal: { paneId: "p", tabId: "t", runId, retention: "temporary", state: "active" }, error: new Error("renderer reload") }]
          : [],
      );
    },
    [60_000],
  );
  const failedPass = await retryCoordinator.request("run-retry", "temporary");
  assert.equal(failedPass.failures.length, 1);
  assert.equal(retryCoordinator.hasPending("run-retry"), true);
  retryCoordinator.retryPendingNow();
  await waitFor("coordinator renderer-ready retry", () => retryAttempts === 2);
  assert.equal(retryCoordinator.hasPending("run-retry"), false);

  // The real lifecycle fence closes the create-vs-settle race. A failed
  // renderer destroy retains ownership, then the renderer-ready flush retries
  // it and removes the exact pane.
  let bridgeAttempts = 0;
  globalThis.__codaraTerminalLifecycleStub.request = async () => {
    bridgeAttempts += 1;
    if (bridgeAttempts === 1) throw new Error("renderer unavailable");
    return { ok: true };
  };
  assert.equal(
    registerAgentTerminal({
      paneId: "pane-fenced",
      tabId: "tab-fenced",
      runId: "run-fenced",
      retention: "temporary",
    }),
    true,
  );
  const fencedCleanup = await settleAgentTerminalRun("run-fenced");
  assert.equal(fencedCleanup.failures.length, 1);
  assert.deepEqual(globalThis.__codaraTerminalLifecycleStub.kills, ["pane-fenced"]);
  assert.equal(canRegisterAgentTerminal("run-fenced"), false);
  assert.equal(
    registerAgentTerminal({
      paneId: "pane-too-late",
      tabId: "tab-too-late",
      runId: "run-fenced",
    }),
    false,
    "a late terminal must not land after the settlement cleanup snapshot",
  );
  markAgentTerminalRunActive("run-fenced");
  assert.equal(
    canRegisterAgentTerminal("run-fenced"),
    false,
    "a resumed run must stay fenced until the old renderer cleanup is idle",
  );
  retryPendingAgentTerminalCleanups();
  await waitFor(
    "real renderer-ready retry",
    () => agentTerminals.listForRun("run-fenced").length === 0,
  );
  assert.equal(bridgeAttempts, 2);
  assert.equal(
    canRegisterAgentTerminal("run-fenced"),
    true,
    "successful retry must release a resumed run's settlement fence",
  );

  // Reopening releases a settled fence only after cleanup is idle. Deletion is
  // permanent for this process. Null ownership is never fenced.
  fenceAgentTerminalRunDeleting("run-deleting");
  assert.equal(canRegisterAgentTerminal("run-deleting"), false);
  assert.equal(
    registerAgentTerminal({
      paneId: "pane-manual",
      tabId: "tab-manual",
      runId: null,
    }),
    true,
    "manual/null-owned terminals must remain outside run lifecycle fences",
  );

  const registryOut = path.join(TMP, "terminal-registry.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src/renderer/src/components/Terminal/terminalRegistry.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: registryOut,
    logLevel: "silent",
  });
  const rendererRegistry = require(registryOut);
  assert.throws(
    () => rendererRegistry.closeAgentTerminal("tab-before-mount"),
    /not ready to close terminal tabs/i,
    "renderer must not acknowledge destroy while its App adapter is absent",
  );
  const closedTabs = [];
  rendererRegistry.setCloseAgentTerminalFn((tabId) => closedTabs.push(tabId));
  rendererRegistry.closeAgentTerminal("tab-mounted");
  assert.deepEqual(closedTabs, ["tab-mounted"]);
  rendererRegistry.setCloseAgentTerminalFn(null);
  assert.throws(
    () => rendererRegistry.closeAgentTerminal("tab-after-unmount"),
    /not ready to close terminal tabs/i,
  );

  console.log(
    "PASS agent terminal lifecycle coalesces, upgrades, retries on renderer-ready, fences late creates, and acknowledges renderer closes truthfully",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis.__codaraTerminalLifecycleStub;
    fs.rmSync(TMP, { recursive: true, force: true });
  });
