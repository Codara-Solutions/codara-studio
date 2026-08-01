#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-pi-backend-lifecycle-"),
);
const HARNESS_KEY = "__codaraPiBackendLifecycleHarness";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const harness = {
    activeCapabilities: new Map(),
    clients: [],
    cleanups: [],
    events: [],
    launches: 0,
    nextStart: null,
    // Stands in for AppSettings.openAiFastMode, which the composer's flash
    // button writes. Anthropic never sees it.
    fastMode: false,
    fastModeFor(provider) {
      return provider !== "anthropic" && harness.fastMode;
    },
    resolveAccount: async () => ({
      accountProfileId: "11111111-1111-4111-8111-111111111111",
      configDir: "/tmp/codara-pi-profile",
    }),
    createPlan(options) {
      const sequence = ++harness.launches;
      const capabilityId = `capability-${sequence}`;
      const expiresAt = Date.now() + 60_000;
      harness.activeCapabilities.set(capabilityId, { expiresAt, active: true });
      return {
        command: "/fake/electron",
        args: [],
        cwd: options.cwd,
        env: {},
        provider: options.provider,
        accountProfileId: options.accountProfileId,
        model: options.model,
        thinking: options.thinking,
        sessionId: options.sessionId,
        openAiFastMode: options.openAiFastMode,
        executionPolicy: options.executionPolicy,
        projectPolicyMode: options.projectPolicyMode,
        frontierManifestPath: null,
        frontierManifestSha256: null,
        frontierAdmissionArtifactSha256: null,
        mcpConfigPath: null,
        agentSocketCapabilityId: capabilityId,
        agentSocketCapabilityExpiresAt: expiresAt,
      };
    },
    isCapabilityActive(id, now) {
      const claim = harness.activeCapabilities.get(id);
      return Boolean(claim?.active && claim.expiresAt > now);
    },
    revokeCapability(id) {
      if (!id) return;
      harness.events.push(`revoke:${id}`);
      const claim = harness.activeCapabilities.get(id);
      if (claim) claim.active = false;
    },
    cleanupPlan(plan) {
      harness.events.push(`cleanup:${plan.agentSocketCapabilityId}`);
      harness.cleanups.push(plan.agentSocketCapabilityId);
    },
    takeStart(client) {
      harness.events.push(`start:${client.id}`);
      const next = harness.nextStart;
      harness.nextStart = null;
      return next ? next.promise : Promise.resolve();
    },
  };
  return harness;
}

async function loadBackend() {
  const outfile = path.join(TMP, "pi-backend.cjs");
  const stubs = {
    "./claude-backend": `
      module.exports = {
        buildExecuteDecisionFromToolCalls: (_calls, reply) => ({ status: "reply", reply }),
        executeDecisionWasAppliedDuringTurn: () => false,
      };`,
    "./pi-runtime-electron": `
      const h = () => globalThis.${HARNESS_KEY};
      module.exports = {
        archiveCodaraPiFrontierRevision: async () => null,
        cleanupPiMcpBridgeConfig: async (plan) => h().cleanupPlan(plan),
        createCodaraPiLaunchPlan: async (options) => h().createPlan(options),
        promoteCodaraPiFrontierAdmission: async () => ({ promoted: false, reason: "test" }),
        resolveCodaraPiExecutionAccount: async (request) => h().resolveAccount(request),
        resolveCodaraPiFastMode: async (provider) => h().fastModeFor(provider),
      };`,
    "./pi-rpc-client": `
      const h = () => globalThis.${HARNESS_KEY};
      module.exports = {
        PiRpcClient: class {
          constructor(plan) {
            this.plan = plan;
            this.id = "client-" + (h().clients.length + 1);
            this.phase = "idle";
            this.listeners = new Set();
            this.prompts = [];
            this.stopCalls = 0;
            this.abortCalls = 0;
            h().clients.push(this);
          }
          state() { return { phase: this.phase }; }
          async start() {
            this.phase = "starting";
            await h().takeStart(this);
            if (this.phase !== "stopped") this.phase = "running";
            return { sessionId: this.plan.sessionId };
          }
          async stop() {
            this.stopCalls += 1;
            this.phase = "stopped";
            h().events.push("stop:" + this.id);
          }
          async abort() {
            this.abortCalls += 1;
            h().events.push("abort:" + this.id);
          }
          onEvent(listener) {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          }
          async prompt(prompt) {
            this.prompts.push(prompt);
            h().events.push("prompt:" + this.id);
            for (const listener of [...this.listeners]) {
              listener({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                },
              });
              listener({ type: "agent_settled" });
            }
          }
          async request() { return { text: "ok" }; }
          diagnostics() { return { stderr: "" }; }
        },
      };`,
    "./pi-session-identity": `
      module.exports = {
        piBackendSessionIdentityMatches: (session, expected) =>
          Object.entries(expected).every(([key, value]) => session[key] === value),
      };`,
    "./pi-turn": `
      module.exports = {
        frontierTurnHasRequiredCompletion: () => true,
        PiTurnAccumulator: class {
          constructor() { this.finalText = ""; }
          consume(event) {
            if (event.type === "message_end") {
              this.finalText = event.message?.content?.[0]?.text ?? "";
            }
          }
          result() {
            return {
              finalText: this.finalText,
              toolCalls: [],
              successfulToolCalls: [],
              providerResponseIds: [],
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
              contextTokens: 0,
              contextWindowTokens: null,
              failure: null,
              settled: true,
            };
          }
        },
      };`,
    "./spark-agent-backend": `
      module.exports = {
        buildTalkReplyDecision: (reply) => ({ status: "reply", reply }),
      };`,
    "./project-constitution": `
      module.exports = { renderProjectConstitution: () => "" };`,
    "./project-policy": `
      module.exports = {
        renderRunProjectPolicy: () => "",
        runProjectPolicyMode: (run) => run.projectPolicyMode ?? "trusted",
      };`,
    "../agent-socket-capabilities": `
      const h = () => globalThis.${HARNESS_KEY};
      module.exports = {
        isAgentSocketCapabilityActive: (id, now) => h().isCapabilityActive(id, now),
        revokeAgentSocketCapability: (id) => h().revokeCapability(id),
      };`,
  };
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src/main/orchestration/pi-backend.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "pi-backend-lifecycle-stubs",
      setup(build) {
        const names = Object.keys(stubs)
          .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        build.onResolve(
          { filter: new RegExp(`^(?:${names})$`) },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
        }));
      },
    }],
  });
  return require(outfile).piBackend;
}

function requestInput(runId, model = "gpt-5.6-sol") {
  return {
    run: {
      id: runId,
      title: "Lifecycle test",
      humanMessages: [],
      sparkCalls: [],
      projectPolicyMode: "untrusted-pull-request",
    },
    chat: {
      model,
      effort: "high",
      mode: "auto",
      executionPolicy: "fast",
    },
    conversationEpoch: 0,
    cwd: "/workspace",
    prompt: "do work",
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function testDisposalCannotRevivePendingStartup(backend, harness) {
  const gate = deferred();
  harness.nextStart = gate;
  const staleOutcome = backend
    .requestManagerDecision(requestInput("run-dispose-race"))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waitFor(
    () => harness.clients.length === 1 && harness.clients[0].phase === "starting",
    "first process should enter pending startup",
  );
  const stale = harness.clients[0];
  const staleCapability = stale.plan.agentSocketCapabilityId;

  await backend.disposeChat("run-dispose-race");
  assert.equal(
    harness.isCapabilityActive(staleCapability, Date.now()),
    false,
    "dispose must synchronously revoke a pending process claim",
  );
  assert.deepEqual(
    harness.events.slice(1, 3),
    [`revoke:${staleCapability}`, `stop:${stale.id}`],
    "revocation must precede shutdown",
  );

  const freshResult = await backend.requestManagerDecision(
    requestInput("run-dispose-race"),
  );
  const fresh = harness.clients[1];
  assert.equal(freshResult.turnFailed, undefined);
  assert.equal(fresh.prompts.length, 1);

  gate.resolve();
  const staleResult = await staleOutcome;
  assert.match(
    staleResult.error?.message ?? "",
    /startup was superseded/,
  );
  assert.equal(stale.prompts.length, 0, "late startup must never receive a prompt");
  assert.equal(
    harness.isCapabilityActive(fresh.plan.agentSocketCapabilityId, Date.now()),
    true,
    "late stale completion must not revoke the replacement owner",
  );
  await backend.disposeChat("run-dispose-race");
}

async function testRevokedAndExpiredOwnersAreNeverReused(backend, harness) {
  const input = requestInput("run-reuse");
  await backend.requestManagerDecision(input);
  const first = harness.clients.at(-1);
  await backend.requestManagerDecision(input);
  assert.equal(
    harness.clients.at(-1),
    first,
    "an active leased process should be reused",
  );
  assert.equal(first.prompts.length, 2);

  harness.revokeCapability(first.plan.agentSocketCapabilityId);
  await backend.requestManagerDecision(input);
  const afterRevocation = harness.clients.at(-1);
  assert.notEqual(
    afterRevocation,
    first,
    "a revoked claim must force process rotation",
  );
  assert.equal(first.stopCalls, 1);

  afterRevocation.plan.agentSocketCapabilityExpiresAt = Date.now() - 1;
  await backend.requestManagerDecision(input);
  const afterExpiry = harness.clients.at(-1);
  assert.notEqual(
    afterExpiry,
    afterRevocation,
    "an expired claim must force process rotation",
  );
  assert.equal(afterRevocation.stopCalls, 1);
  await backend.disposeChat("run-reuse");
}

async function testFailedStartupReleasesItsClaim(backend, harness) {
  const gate = deferred();
  harness.nextStart = gate;
  const outcome = backend
    .requestManagerDecision(requestInput("run-start-failure"))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waitFor(
    () => harness.clients.at(-1)?.phase === "starting",
    "failed process should first become the explicit pending owner",
  );
  const failed = harness.clients.at(-1);
  gate.reject(new Error("synthetic startup failure"));
  const result = await outcome;
  assert.match(result.error?.message ?? "", /synthetic startup failure/);
  assert.equal(failed.stopCalls, 1);
  assert.equal(
    harness.isCapabilityActive(failed.plan.agentSocketCapabilityId, Date.now()),
    false,
    "failed startup must release its process claim",
  );
  assert.equal(
    harness.cleanups.includes(failed.plan.agentSocketCapabilityId),
    true,
    "failed startup must clean its process-scoped launch resources",
  );

  const recovered = await backend.requestManagerDecision(
    requestInput("run-start-failure"),
  );
  assert.equal(recovered.turnFailed, undefined);
  assert.notEqual(harness.clients.at(-1), failed);
  await backend.disposeChat("run-start-failure");
}

async function testSupersedingRequestReclaimsPendingOwner(backend, harness) {
  const gate = deferred();
  harness.nextStart = gate;
  const firstOutcome = backend
    .requestManagerDecision(requestInput("run-pending-replace"))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await waitFor(
    () => harness.clients.at(-1)?.phase === "starting",
    "first request should own pending startup",
  );
  const pending = harness.clients.at(-1);

  const replacement = await backend.requestManagerDecision(
    requestInput("run-pending-replace"),
  );
  assert.equal(replacement.turnFailed, undefined);
  assert.equal(pending.stopCalls, 1, "replacement must stop prior pending owner");
  assert.equal(
    harness.isCapabilityActive(pending.plan.agentSocketCapabilityId, Date.now()),
    false,
    "replacement must revoke prior pending owner",
  );

  gate.resolve();
  const firstResult = await firstOutcome;
  assert.match(firstResult.error?.message ?? "", /startup was superseded/);
  assert.equal(pending.prompts.length, 0);
  await backend.disposeChat("run-pending-replace");
}

// Fast mode reaches the runtime only as launch-time env (CODARA_PI_FAST_MODE),
// so it has to sit in the session's reuse key: flipping the composer's flash
// button must rotate the process on the next turn instead of silently doing
// nothing. Anthropic is exempt in the only way that matters — it never carries
// fast mode at all, so no flip can ever rotate an Anthropic session.
async function testFastModeIsPartOfSessionIdentity(backend, harness) {
  harness.fastMode = false;
  const input = requestInput("run-fast-mode");
  await backend.requestManagerDecision(input);
  const off = harness.clients.at(-1);
  assert.equal(
    off.plan.openAiFastMode,
    false,
    "the launch plan must carry the fast mode the identity check compared",
  );
  await backend.requestManagerDecision(input);
  assert.equal(
    harness.clients.at(-1),
    off,
    "an unchanged fast mode must reuse the running process",
  );

  harness.fastMode = true;
  await backend.requestManagerDecision(input);
  const on = harness.clients.at(-1);
  assert.notEqual(on, off, "flipping fast mode on must relaunch the session");
  assert.equal(on.plan.openAiFastMode, true);
  assert.equal(off.stopCalls, 1);

  harness.fastMode = false;
  await backend.requestManagerDecision(input);
  const backOff = harness.clients.at(-1);
  assert.notEqual(backOff, on, "flipping fast mode off must relaunch the session");
  assert.equal(backOff.plan.openAiFastMode, false);
  await backend.disposeChat("run-fast-mode");

  const anthropic = requestInput("run-fast-mode-anthropic", "claude-opus-5");
  harness.fastMode = false;
  await backend.requestManagerDecision(anthropic);
  const claude = harness.clients.at(-1);
  assert.equal(
    claude.plan.openAiFastMode,
    false,
    "an anthropic session must never be launched with fast mode",
  );
  harness.fastMode = true;
  await backend.requestManagerDecision(anthropic);
  assert.equal(
    harness.clients.at(-1),
    claude,
    "fast mode cannot rotate an anthropic session: it never applies to one",
  );
  assert.equal(harness.clients.at(-1).plan.openAiFastMode, false);
  harness.fastMode = false;
  await backend.disposeChat("run-fast-mode-anthropic");
}

async function main() {
  const harness = createHarness();
  globalThis[HARNESS_KEY] = harness;
  const backend = await loadBackend();
  await testDisposalCannotRevivePendingStartup(backend, harness);
  await testRevokedAndExpiredOwnersAreNeverReused(backend, harness);
  await testFailedStartupReleasesItsClaim(backend, harness);
  await testSupersedingRequestReclaimsPendingOwner(backend, harness);
  await testFastModeIsPartOfSessionIdentity(backend, harness);
  console.log(
    "PASS Pi pending ownership, revoke-before-stop, stale-start rejection, lease rotation, and fast-mode identity",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis[HARNESS_KEY];
    fs.rmSync(TMP, { recursive: true, force: true });
  });
