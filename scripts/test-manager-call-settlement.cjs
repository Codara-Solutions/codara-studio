#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(
  ROOT,
  "src/main/orchestration/manager-call-settlement.ts",
);
const RUN_STORE = path.join(ROOT, "src/main/orchestration/run-store.ts");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-manager-call-settlement-"),
);
const NOW = "2026-07-31T12:00:00.000Z";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function clone(value) {
  return structuredClone(value);
}

function message(id, deliveryState, overrides = {}) {
  return {
    id,
    runId: "run-settlement",
    author: "user",
    kind: "note",
    message: id,
    createdAt: NOW,
    deliveryState,
    backendTurnId: "spark-current",
    conversationEpoch: 4,
    ...overrides,
  };
}

function baseRun(overrides = {}) {
  return {
    id: "run-settlement",
    workspaceId: "ws-settlement",
    title: "Atomic settlement",
    status: "running",
    executionMode: "orchestrated",
    artifactDir: "/tmp/run-settlement/artifacts",
    createdAt: NOW,
    updatedAt: NOW,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [{
      id: "spark-current",
      runId: "run-settlement",
      mode: "worker_result_review",
      model: "gpt-5.6-sol",
      accountProfileId: ACCOUNT,
      status: "started",
      inputMessageIds: [
        "message-queued",
        "message-submitted",
        "message-acknowledged",
        "message-cancelled",
      ],
      conversationEpoch: 4,
      managerResumeClaimId: "resume-claim-current",
      managerRecoveryClaimId: "recovery-claim-current",
      createdAt: NOW,
    }],
    humanMessages: [
      message("message-queued", "queued"),
      message("message-submitted", "submitted"),
      message("message-acknowledged", "acknowledged"),
      message("message-cancelled", "cancelled"),
      // Same backendTurnId is not sufficient: only the SparkCall's frozen ids
      // belong to this settlement.
      message("message-not-frozen", "submitted"),
      message("message-other-call", "submitted", {
        backendTurnId: "spark-other",
      }),
    ],
    atomicClaims: [],
    confidence: "PARTIAL",
    conversationEpoch: 4,
    pendingManagerResume: {
      questionMessageId: "message-question",
      managerMode: "worker_result_review",
      requestedAt: NOW,
      state: "launching",
      launchClaimId: "resume-claim-current",
      launchClaimedAt: NOW,
    },
    managerTurnRecovery: {
      id: "recovery-current",
      state: "resuming",
      failureKind: "provider",
      backend: "pi",
      managerMode: "worker_result_review",
      conversationEpoch: 4,
      failedSparkCallId: "spark-failed",
      parkedAt: NOW,
      resumeClaimId: "recovery-claim-current",
      resumeRequestedAt: NOW,
      resumeAccountProfileId: ACCOUNT,
      forceCanonicalReplay: true,
    },
    autopilot: { status: "running", updatedAt: NOW },
    ...overrides,
  };
}

function structuredInput(overrides = {}) {
  return {
    callId: "spark-current",
    conversationEpoch: 4,
    applicationProof: {
      kind: "structured-decision-applied",
      applicationReady: true,
    },
    managerResumeClaimId: "resume-claim-current",
    managerRecoveryClaimId: "recovery-claim-current",
    managerRecoveryClaimedAccountProfileId: ACCOUNT,
    ...overrides,
  };
}

function assertNoPartialSnapshot(snapshot) {
  const call = snapshot.sparkCalls[0];
  const linked = snapshot.humanMessages.filter((entry) =>
    call.inputMessageIds.includes(entry.id),
  );
  const inputSettled = linked.every((entry) =>
    entry.deliveryState === "acknowledged" ||
    entry.deliveryState === "cancelled",
  );
  const callSettled = call.status === "completed" && Boolean(call.completedAt);
  const claimsSettled =
    snapshot.pendingManagerResume === undefined &&
    snapshot.managerTurnRecovery === undefined;
  assert.equal(
    new Set([inputSettled, callSettled, claimsSettled]).size,
    1,
    "a durable snapshot must expose either none or all settlement fields",
  );
}

async function loadSettlement() {
  const outfile = path.join(TMP, "manager-call-settlement.cjs");
  await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return require(outfile).applyAtomicManagerCallSettlement;
}

function assertRejectedWithoutMutation(applySettlement, mutate, input) {
  const run = baseRun();
  mutate?.(run);
  const before = clone(run);
  assert.equal(applySettlement(run, input, NOW), false);
  assert.deepEqual(run, before);
}

async function main() {
  const applySettlement = await loadSettlement();

  // Crash before the one run-store commit leaves the old durable snapshot.
  const initial = baseRun();
  const durableSnapshots = [clone(initial)];
  assert.throws(() => {
    throw new Error("synthetic pre-commit crash");
  });
  assert.deepEqual(durableSnapshots, [initial]);
  assertNoPartialSnapshot(durableSnapshots[0]);

  // One successful commit publishes acknowledgement, call completion, and
  // exact claim cleanup together. No ack-only/completed-only image exists.
  const committed = clone(durableSnapshots.at(-1));
  assert.equal(
    applySettlement(committed, structuredInput(), NOW),
    true,
  );
  durableSnapshots.push(clone(committed));
  assert.equal(durableSnapshots.length, 2);
  for (const snapshot of durableSnapshots) assertNoPartialSnapshot(snapshot);
  assert.equal(committed.sparkCalls[0].status, "completed");
  assert.equal(committed.sparkCalls[0].completedAt, NOW);
  assert.equal(
    committed.humanMessages.find((entry) => entry.id === "message-queued")
      .deliveryState,
    "acknowledged",
  );
  assert.equal(
    committed.humanMessages.find((entry) => entry.id === "message-submitted")
      .deliveryState,
    "acknowledged",
  );
  assert.equal(
    committed.humanMessages.find((entry) => entry.id === "message-cancelled")
      .deliveryState,
    "cancelled",
    "settlement must not regress the monotonic cancelled state",
  );
  assert.equal(
    committed.humanMessages.find((entry) => entry.id === "message-not-frozen")
      .deliveryState,
    "submitted",
    "same-call messages omitted from inputMessageIds must not be acknowledged",
  );
  assert.equal(committed.pendingManagerResume, undefined);
  assert.equal(committed.managerTurnRecovery, undefined);

  const afterFirstCommit = clone(committed);
  assert.equal(
    applySettlement(committed, structuredInput(), "2026-07-31T12:01:00.000Z"),
    false,
    "repeating settlement is an idempotent no-op",
  );
  assert.deepEqual(committed, afterFirstCommit);

  assertRejectedWithoutMutation(
    applySettlement,
    undefined,
    structuredInput({ conversationEpoch: 3 }),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    undefined,
    structuredInput({
      applicationProof: {
        kind: "structured-decision-applied",
        applicationReady: false,
      },
    }),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    undefined,
    structuredInput({
      applicationProof: {
        kind: "decision-already-applied",
        decisionAlreadyApplied: false,
      },
    }),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    undefined,
    structuredInput({ managerResumeClaimId: "resume-claim-wrong" }),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    undefined,
    structuredInput({ managerRecoveryClaimId: "recovery-claim-wrong" }),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    (run) => {
      run.pendingManagerResume.launchClaimId = "resume-claim-stolen";
    },
    structuredInput(),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    (run) => {
      run.managerTurnRecovery.resumeClaimId = "recovery-claim-stolen";
    },
    structuredInput(),
  );
  assertRejectedWithoutMutation(
    applySettlement,
    (run) => {
      run.sparkCalls[0].accountProfileId =
        "22222222-2222-4222-8222-222222222222";
    },
    structuredInput(),
  );

  // Decision application may terminalize/block the run and normalization can
  // remove its claim records before settlement. The frozen claim/account proof
  // still authorizes call completion without reviving either record.
  const normalizedAfterApplication = baseRun();
  delete normalizedAfterApplication.pendingManagerResume;
  delete normalizedAfterApplication.managerTurnRecovery;
  assert.equal(
    applySettlement(
      normalizedAfterApplication,
      structuredInput(),
      NOW,
    ),
    true,
  );
  assert.equal(normalizedAfterApplication.sparkCalls[0].status, "completed");
  assertRejectedWithoutMutation(
    applySettlement,
    (run) => {
      run.humanMessages.find((entry) => entry.id === "message-submitted")
        .backendTurnId = "spark-stolen";
    },
    structuredInput(),
  );

  // Unrelated claims are not collateral cleanup for an ordinary call.
  const unrelated = baseRun();
  delete unrelated.sparkCalls[0].managerResumeClaimId;
  delete unrelated.sparkCalls[0].managerRecoveryClaimId;
  const unrelatedPending = clone(unrelated.pendingManagerResume);
  const unrelatedRecovery = clone(unrelated.managerTurnRecovery);
  assert.equal(
    applySettlement(
      unrelated,
      structuredInput({
        managerResumeClaimId: undefined,
        managerRecoveryClaimId: undefined,
      }),
      NOW,
    ),
    true,
  );
  assert.deepEqual(unrelated.pendingManagerResume, unrelatedPending);
  assert.deepEqual(unrelated.managerTurnRecovery, unrelatedRecovery);

  const source = fs.readFileSync(RUN_STORE, "utf8");
  const successStart = source.lastIndexOf(
    "    if (result.decisionAlreadyApplied) {",
  );
  const successEnd = source.indexOf("  } catch (err) {", successStart);
  assert(successStart >= 0 && successEnd > successStart);
  const successPath = source.slice(successStart, successEnd);
  assert.equal(
    (successPath.match(/settleAppliedManagerCall\(/g) ?? []).length,
    2,
    "both success branches must cross the same atomic settlement commit",
  );
  assert.doesNotMatch(
    successPath,
    /finalizeAppliedManagerCall|clearRegisteredManagerResume|clearRegisteredManagerTurnRecovery/,
  );
  assert.doesNotMatch(
    successPath,
    /updateManagerInputDelivery\([\s\S]*?"acknowledged"/,
  );
  assert.match(
    successPath,
    /decisionAlreadyApplied[\s\S]*?settleAppliedManagerCall[\s\S]*?kind: "decision-already-applied"/,
  );
  assert.match(
    successPath,
    /const applied = await applySparkManagerDecision[\s\S]*?settleAppliedManagerCall\(applied,[\s\S]*?kind: "structured-decision-applied"/,
  );

  const helperStart = source.indexOf("async function settleAppliedManagerCall(");
  const helperEnd = source.indexOf("async function runManagerStageAfterQuestion", helperStart);
  const helperSource = source.slice(helperStart, helperEnd);
  assert.equal(
    (helperSource.match(/commitRunChange\(/g) ?? []).length,
    1,
    "settlement must be represented by one run-store commit",
  );

  console.log(
    "PASS atomic manager settlement has only old-or-complete snapshots, exact monotonic input ack, idempotency, and claim/account CAS guards",
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
