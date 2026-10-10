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
    nextStop: null,
    nextPromptError: null,
    nextCompaction: null,
    promptReplies: [],
    turnOptions: [],
    holdNextTurn: false,
    stderr: "",
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
        cleanupPiMcpBridgeConfig: async (plan) => h().cleanupPlan(plan),
        createCodaraPiLaunchPlan: async (options) => h().createPlan(options),
        resolveCodaraOpenRouterApiKey: async () => "test-openrouter-key",
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
            const gate = h().nextStop;
            h().nextStop = null;
            if (gate) await gate.promise;
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
            const error = h().nextPromptError;
            h().nextPromptError = null;
            if (error) throw error;
            const reply = h().promptReplies.length > 0
              ? h().promptReplies.shift()
              : "ok";
            const finish = () => {
              for (const listener of [...this.listeners]) {
                listener({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    id: "assistant-" + this.prompts.length,
                    content: reply ? [{ type: "text", text: reply }] : [],
                  },
                });
                if (h().nextCompaction) listener({ type: "entry_appended", entry: { type: "custom", customType: "codara-context-pause", data: { reason: "threshold" } } });
                listener({ type: "agent_settled" });
              }
            };
            // A held turn is accepted but streams until the test finishes it.
            if (h().holdNextTurn) {
              h().holdNextTurn = false;
              this.finishTurn = finish;
              return;
            }
            finish();
          }
          emit(event) {
            for (const listener of [...this.listeners]) listener(event);
          }
          async request(command) {
            if (command.type !== "compact") {
              h().events.push("request:" + command.type + ":" + this.id);
              return { text: "ok" };
            }
            const gate = h().nextCompaction;
            h().nextCompaction = null;
            h().events.push("compact:" + this.id);
            const result = await gate.promise;
            for (const listener of [...this.listeners]) listener({ type: "compaction_end", result, aborted: false });
            return result;
          }
          diagnostics() { return { stderr: h().stderr }; }
        },
      };`,
    "./pi-session-identity": `
      module.exports = {
        piBackendSessionIdentityMatches: (session, expected) =>
          Object.entries(expected).every(([key, value]) => session[key] === value),
      };`,
    "./pi-turn": `
      const h = () => globalThis.${HARNESS_KEY};
      module.exports = {
        PiTurnAccumulator: class {
          constructor(_onStream, options) {
            h().turnOptions.push(options ?? {});
            this.finalText = "";
            this.assistantIds = new Set();
          }
          consume(event) {
            if (event.type === "message_end") {
              this.assistantIds.add(event.message?.id ?? "assistant-unknown");
              this.finalText = event.message?.content?.[0]?.text ?? "";
            }
          }
          result() {
            return {
              finalText: this.finalText,
              assistantMessageCount: this.assistantIds.size,
              toolCalls: [],
              successfulToolCalls: [],
              providerResponseIds: [],
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
              contextTokens: 0,
              contextWindowTokens: null,
              failure: null,
              settled: true,
            };
          }
        },
      };`,
    "./agent-backend": `
      module.exports = {
        buildTalkReplyDecision: (reply) => ({ status: "reply", reply }),
      };`,
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

async function testFailedTurnStopsItsWholeRuntime(backend, harness) {
  harness.nextPromptError = new Error("synthetic active-turn failure");
  const result = await backend.requestManagerDecision(
    requestInput("run-turn-failure"),
  );
  const failed = harness.clients.at(-1);
  assert.equal(result.turnFailed, true);
  assert.match(result.notice, /synthetic active-turn failure/);
  assert.equal(failed.stopCalls, 1, "a failed active turn must stop its runtime");
  assert.equal(
    harness.isCapabilityActive(failed.plan.agentSocketCapabilityId, Date.now()),
    false,
    "turn failure must revoke the failed runtime before it can be retried",
  );

  const recovered = await backend.requestManagerDecision(
    requestInput("run-turn-failure"),
  );
  assert.notEqual(harness.clients.at(-1), failed, "retry must launch a clean runtime");
  assert.equal(recovered.turnFailed, undefined);
  await backend.disposeChat("run-turn-failure");
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

async function testEmptyFinalGetsOneRecoveryPrompt(backend, harness) {
  harness.promptReplies.push("", "Recovered final response");
  const result = await backend.requestManagerDecision(
    requestInput("run-empty-final-recovery"),
  );
  const client = harness.clients.at(-1);
  assert.equal(client.prompts.length, 2, "an explicit empty final gets exactly one retry");
  assert.match(client.prompts[1], /final assistant message was empty/);
  assert.equal(result.turnFailed, undefined);
  assert.equal(result.decision.reply, "Recovered final response");
  await backend.disposeChat("run-empty-final-recovery");
}

async function testRepeatedEmptyFinalFailsClearly(backend, harness) {
  harness.promptReplies.push("", "");
  const result = await backend.requestManagerDecision(
    requestInput("run-empty-final-failure"),
  );
  const client = harness.clients.at(-1);
  assert.equal(client.prompts.length, 2, "empty-final recovery must not loop forever");
  assert.equal(result.turnFailed, true);
  assert.match(result.notice, /without a final response after one retry/);
  assert.match(result.decision.reply, /without a final response after one retry/);
  await backend.disposeChat("run-empty-final-failure");
}

async function testCostCaptureUsesProviderBoundary(backend, harness) {
  await backend.requestManagerDecision(
    requestInput("run-native-cost-boundary", "gpt-5.6-sol"),
  );
  assert.equal(
    harness.turnOptions.at(-1)?.captureCost,
    false,
    "a native subscription model must not capture catalog cost",
  );
  await backend.disposeChat("run-native-cost-boundary");

  await backend.requestManagerDecision(
    requestInput("run-openrouter-cost-boundary", "stealth/ox-alpha"),
  );
  assert.equal(
    harness.turnOptions.at(-1)?.captureCost,
    true,
    "an OpenRouter model must capture its provider-priced usage",
  );
  await backend.disposeChat("run-openrouter-cost-boundary");
}

async function testCompactionWaitsWithoutRepeatingAnswer(backend, harness) {
  const gate = deferred();
  harness.nextCompaction = gate;
  harness.promptReplies.push("Completed once.");
  let returned = false;
  const resultPromise = backend.requestManagerDecision(requestInput("run-manager-compaction")).then(result => { returned = true; return result; });
  await waitFor(() => harness.events.some(event => event.startsWith("compact:")), "manager should request compaction after settlement");
  const client = harness.clients.at(-1);
  assert.equal(returned, false, "manager result waits for summary telemetry");
  assert.equal(client.prompts.length, 1);
  gate.resolve({ estimatedTokensAfter: 20, usage: { input: 10, output: 2 } });
  const result = await resultPromise;
  assert.equal(result.decision.reply, "Completed once.");
  assert.equal(result.turnFailed, undefined);
  assert.equal(client.prompts.length, 1);
  await backend.disposeChat("run-manager-compaction");
}

async function testFailedCompactionPreservesAnswerAndStopsRuntime(backend, harness) {
  const gate = deferred();
  harness.nextCompaction = gate;
  harness.promptReplies.push("The completed answer survives.");
  const notes = [];
  const count = harness.events.filter(event => event.startsWith("compact:")).length;
  const resultPromise = backend.requestManagerDecision(requestInput("run-manager-compaction-failure"), event => notes.push(event));
  await waitFor(() => harness.events.filter(event => event.startsWith("compact:")).length > count, "summary should start");
  const client = harness.clients.at(-1);
  gate.reject(new Error("summary timed out"));
  const result = await resultPromise;
  assert.equal(result.decision.reply, "The completed answer survives.");
  assert.equal(result.turnFailed, undefined);
  assert.equal(client.stopCalls, 1, "unconfirmed compaction must not survive after its turn returns");
  assert.ok(notes.some(event => event.kind === "system_note" && /compaction failed/.test(event.message)));
  await backend.requestManagerDecision(requestInput("run-manager-compaction-failure"));
  assert.notEqual(harness.clients.at(-1), client, "next turn must use a fresh process");
  await backend.disposeChat("run-manager-compaction-failure");
}

async function testCompactionCleanupCannotReturnStaleAnswer(backend, harness) {
  const summary = deferred(), shutdown = deferred();
  harness.nextCompaction = summary;
  harness.nextStop = shutdown;
  harness.promptReplies.push("Stale answer.");
  const count = harness.events.filter(event => event.startsWith("compact:")).length;
  const stale = backend.requestManagerDecision(requestInput("run-manager-compaction-race"));
  await waitFor(() => harness.events.filter(event => event.startsWith("compact:")).length > count, "summary should start");
  const oldClient = harness.clients.at(-1);
  summary.reject(new Error("summary timeout"));
  await waitFor(() => oldClient.stopCalls === 1, "old runtime should begin shutdown");
  const fresh = await backend.requestManagerDecision(requestInput("run-manager-compaction-race"));
  assert.equal(fresh.turnAborted, undefined);
  shutdown.resolve();
  assert.equal((await stale).turnAborted, true, "a newer turn supersedes an answer still awaiting compaction cleanup");
  await backend.disposeChat("run-manager-compaction-race");
}

async function startHeldTurn(backend, harness, runId) {
  // A session first, so the held turn reuses it instead of racing startup.
  await backend.requestManagerDecision(requestInput(runId));
  const client = harness.clients.at(-1);
  harness.holdNextTurn = true;
  let accepted = false;
  const input = { ...requestInput(runId), onPromptAccepted: async () => { accepted = true; } };
  const outcome = backend.requestManagerDecision(input);
  await waitFor(() => accepted && typeof client.finishTurn === "function", "the held turn should be accepted");
  return { client, outcome };
}

// The bug: a second prompt on a streaming session failed, and that failure
// stopped the process the live turn was using, which then hung to the idle
// timeout. The second turn must back off without touching the live one.
async function testOverlappingTurnLeavesTheLiveTurnAlone(backend, harness) {
  const { client, outcome } = await startHeldTurn(backend, harness, "run-overlap");
  const promptsBefore = client.prompts.length;
  const second = await backend.requestManagerDecision(requestInput("run-overlap"));
  assert.equal(second.turnAborted, true, "an overlapping turn must report itself aborted");
  assert.equal(client.prompts.length, promptsBefore, "an overlapping turn must never prompt the live session");
  assert.equal(client.stopCalls, 0, "an overlapping turn must never stop the live session");
  client.finishTurn();
  const first = await outcome;
  assert.equal(first.turnFailed, undefined);
  assert.equal(first.turnAborted, undefined);
  await backend.disposeChat("run-overlap");
}

async function testSteerReachesTheLiveTurn(backend, harness) {
  assert.equal(
    await backend.steerChat("run-steer", { messageId: "m0", text: "too early" }),
    false,
    "a run without a live turn refuses a steer",
  );
  const { client, outcome } = await startHeldTurn(backend, harness, "run-steer");
  const delivered = [];
  const accepted = await backend.steerChat("run-steer", {
    messageId: "m1",
    text: "Use the faster parser",
    onDelivered: () => delivered.push("m1"),
  });
  assert.equal(accepted, true, "a live turn accepts a steer");
  assert.ok(harness.events.includes(`request:steer:${client.id}`), "the steer goes to Pi's steer command");
  await backend.steerChat("run-steer", {
    messageId: "m2",
    text: "And keep the old API",
    onDelivered: () => delivered.push("m2"),
  });
  client.emit({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "Use the faster parser" }] },
  });
  assert.deepEqual(delivered, ["m1"], "Pi injecting the steer reports its delivery");
  client.finishTurn();
  const result = await outcome;
  assert.equal(result.turnFailed, undefined);
  assert.deepEqual(delivered, ["m1"], "a steer Pi never injected is not reported delivered");
  assert.ok(
    harness.events.includes(`request:clear_queue:${client.id}`),
    "a steer left in Pi's queue is withdrawn so it cannot open a turn of its own",
  );
  assert.equal(
    await backend.steerChat("run-steer", { messageId: "m3", text: "late" }),
    false,
    "a settled turn refuses a steer",
  );
  await backend.disposeChat("run-steer");
}

async function testDeadProcessFailsTheTurnPromptly(backend, harness) {
  const { client, outcome } = await startHeldTurn(backend, harness, "run-dead-mid-turn");
  client.phase = "failed";
  const startedAt = Date.now();
  const result = await outcome;
  assert.equal(result.turnFailed, true, "a runtime that died mid-turn fails the turn");
  assert.ok(Date.now() - startedAt < 5000, "the turn fails within seconds, not at the idle timeout");
  assert.match(result.notice, /in the middle of the turn/);
  await backend.disposeChat("run-dead-mid-turn");
}

async function testStartupFailureCarriesStderr(backend, harness) {
  const gate = deferred();
  harness.nextStart = gate;
  harness.stderr = "Error: Cannot find module 'codara-extension'\n    at load (extension.js:12)";
  const outcome = backend
    .requestManagerDecision(requestInput("run-start-stderr"))
    .then((value) => ({ value }), (error) => ({ error }));
  await waitFor(() => harness.clients.at(-1)?.phase === "starting", "startup should begin");
  gate.reject(new Error("Pi RPC handshake timed out"));
  const result = await outcome;
  harness.stderr = "";
  assert.match(result.error?.message ?? "", /handshake timed out/);
  assert.match(result.error?.message ?? "", /Cannot find module 'codara-extension'/, "startup failures name Pi's own error");
}

async function main() {
  const harness = createHarness();
  globalThis[HARNESS_KEY] = harness;
  const backend = await loadBackend();
  await testDisposalCannotRevivePendingStartup(backend, harness);
  await testRevokedAndExpiredOwnersAreNeverReused(backend, harness);
  await testFailedStartupReleasesItsClaim(backend, harness);
  await testFailedTurnStopsItsWholeRuntime(backend, harness);
  await testSupersedingRequestReclaimsPendingOwner(backend, harness);
  await testFastModeIsPartOfSessionIdentity(backend, harness);
  await testEmptyFinalGetsOneRecoveryPrompt(backend, harness);
  await testRepeatedEmptyFinalFailsClearly(backend, harness);
  await testCostCaptureUsesProviderBoundary(backend, harness);
  await testCompactionWaitsWithoutRepeatingAnswer(backend, harness);
  await testFailedCompactionPreservesAnswerAndStopsRuntime(backend, harness);
  await testCompactionCleanupCannotReturnStaleAnswer(backend, harness);
  // The backend's turn timers are unref'd; hold the loop open while a held
  // turn waits on them.
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    await testOverlappingTurnLeavesTheLiveTurnAlone(backend, harness);
    await testSteerReachesTheLiveTurn(backend, harness);
    await testDeadProcessFailsTheTurnPromptly(backend, harness);
    await testStartupFailureCarriesStderr(backend, harness);
  } finally {
    clearInterval(keepAlive);
  }
  console.log(
    "PASS Pi ownership, lease rotation, fast-mode identity, empty-final recovery, one turn per session, and steering",
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
