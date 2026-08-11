// Exact serialized-byte regressions for Studio's bounded Cora history/run DTOs.
//
//   node scripts/test-remote-cora-contract.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, outName, options = {}) {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native", ...(options.external ?? [])],
  });
  delete require.cache[outfile];
  return require(outfile);
}

function message(id, body = "\0".repeat(16 * 1024)) {
  return {
    id,
    author: "spark",
    kind: "note",
    message: body,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

function projectMessage(contract, source) {
  return {
    id: contract.requireRemoteCoraIdentity(source.id, "message.id"),
    author: source.author === "spark" ? "cora" : source.author,
    kind: source.kind,
    message: source.message,
    createdAt: contract.requireRemoteCoraTimestamp(
      source.createdAt,
      "message.createdAt",
    ),
  };
}

function hostileWorker(index) {
  return {
    id: `worker-${index}`,
    title: "\0".repeat(300),
    runtime: index % 2 === 0 ? "claude" : "codex",
    model: "\0".repeat(120),
    effort: "\0".repeat(40),
    status: index < 6 ? "running" : "succeeded",
    startedAt: "2026-07-31T00:00:00.000Z",
    finishedAt: "2026-07-31T00:01:00.000Z",
    runtimeState: "\0".repeat(200),
  };
}

function hostileBase() {
  return {
    id: "run-hostile",
    workspaceId: "workspace-hostile",
    title: "\0".repeat(512),
    status: "running",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:01:00.000Z",
    messageCount: 5,
    lastMessage: "\0".repeat(512),
    activeWorkers: 6,
    messages: [],
    workers: Array.from({ length: 12 }, (_, index) => hostileWorker(index)),
    steps: Array.from({ length: 12 }, () => ({
      title: "\0".repeat(300),
      status: "completed_unverified",
    })),
    stepsTotal: 12,
    stepsFinished: 12,
    blockedQuestion: {
      messageId: "message-5",
      message: "\0".repeat(16 * 1024),
    },
  };
}

async function main() {
  const contract = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "remote-cora-contract.ts"),
    "remote-cora-contract-test.cjs",
  );
  const projector = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "cora-run-projection.ts"),
    "remote-cora-run-projection-test.cjs",
  );
  const rpc = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "remote-cora-rpc-test.cjs",
  );

  assert.equal(contract.CORA_HISTORY_RUNS_JSON_MAX_BYTES, 72 * 1024);
  assert.equal(contract.CORA_RUN_JSON_MAX_BYTES, 400 * 1024);
  assert.equal(contract.CORA_RUN_RESULT_JSON_MAX_BYTES, 404 * 1024);
  assert.equal(contract.CORA_WIRE_ID_MAX_BYTES, 256);
  assert.equal(contract.CORA_WIRE_TIMESTAMP_MAX_BYTES, 64);
  assert.equal(contract.jsonUtf8Bytes("\0".repeat(512)), 3_074);

  const exactIdentity = "i".repeat(256);
  assert.equal(
    contract.requireRemoteCoraIdentity(exactIdentity, "id"),
    exactIdentity,
    "an exact-boundary identity is preserved, never truncated",
  );
  assert.throws(
    () => contract.requireRemoteCoraIdentity("i".repeat(257), "id"),
    /at most 256 UTF-8 bytes/,
  );
  assert.throws(
    () => contract.requireRemoteCoraIdentity("😀".repeat(65), "id"),
    /at most 256 UTF-8 bytes/,
  );
  assert.throws(
    () => contract.requireRemoteCoraTimestamp("t".repeat(65), "createdAt"),
    /timestamp/,
  );

  const summaries = Array.from({ length: 50 }, (_, index) => ({
    id: `run-${index}-${"i".repeat(240)}`,
    workspaceId: "workspace-hostile",
    title: "\0".repeat(512),
    status: "complete",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:01:00.000Z",
    messageCount: index,
    lastMessage: "\0".repeat(512),
    activeWorkers: 0,
    model: "\0".repeat(120),
  }));
  const history = contract.takeJsonArrayPrefixWithinBudget(
    summaries,
    contract.CORA_HISTORY_RUNS_JSON_MAX_BYTES,
  );
  assert.equal(history.length, 10);
  assert.equal(contract.jsonUtf8Bytes(history), 73_261);
  assert.ok(history.length > 0 && history.length < summaries.length);
  assert.ok(
    contract.jsonUtf8Bytes(history) <=
      contract.CORA_HISTORY_RUNS_JSON_MAX_BYTES,
  );
  assert.ok(
    contract.jsonUtf8Bytes([...history, summaries[history.length]]) >
      contract.CORA_HISTORY_RUNS_JSON_MAX_BYTES,
    "the history prefix stops on the exact complete-array byte boundary",
  );

  const sources = Array.from({ length: 5 }, (_, index) =>
    message(`message-${index + 1}`),
  );
  const projection = projector.projectBoundedRemoteCoraRun({
    base: hostileBase(),
    runId: "run-hostile",
    conversationEpoch: 0,
    sourceMessages: sources,
    projectMessage: (source) => projectMessage(contract, source),
    maxMessageCount: 200,
    maxMessageBytes: 384 * 1024,
  });
  const runBytes = contract.jsonUtf8Bytes(projection.run);
  assert.equal(runBytes, 370_483);
  assert.equal(projection.run.messages.length, 2);
  assert.ok(runBytes <= contract.CORA_RUN_JSON_MAX_BYTES, { runBytes });
  assert.equal(projection.run.lastMessage, undefined);
  assert.equal(projection.run.truncation.lastMessageOmitted, true);
  assert.equal(
    projection.run.truncation.messagesOmitted,
    sources.length - projection.run.messages.length,
  );
  assert.equal(
    projection.run.messages.at(-1).id,
    sources.at(-1).id,
    "whole-run pressure preserves the newest message suffix",
  );
  assert.equal(projection.run.workers.length, 12);
  assert.equal(projection.run.steps.length, 12);

  const oversizedBase = hostileBase();
  oversizedBase.blockedQuestion.message = "\0".repeat(100 * 1024);
  const prunedBase = projector.pruneRemoteCoraRunBase(oversizedBase);
  assert.ok(
    contract.jsonUtf8Bytes(prunedBase) <= contract.CORA_RUN_JSON_MAX_BYTES,
  );
  assert.equal(prunedBase.workers.length, 6);
  assert.ok(prunedBase.workers.every((worker) => worker.status === "running"));
  assert.equal(prunedBase.truncation.workersOmitted, 6);
  assert.equal(prunedBase.truncation.workerDetailsOmitted, true);
  assert.equal(prunedBase.steps, undefined);
  assert.equal(prunedBase.truncation.stepsOmitted, 12);
  assert.equal(prunedBase.truncation.blockedQuestionBodyTruncated, true);
  const pressureProjection = projector.projectBoundedRemoteCoraRun({
    base: oversizedBase,
    runId: "run-hostile",
    conversationEpoch: 0,
    sourceMessages: sources,
    projectMessage: (source) => projectMessage(contract, source),
    maxMessageCount: 200,
    maxMessageBytes: 384 * 1024,
  });
  assert.equal(pressureProjection.run.messages.at(-1).id, "message-5");
  assert.ok(
    contract.jsonUtf8Bytes(pressureProjection.run) <=
      contract.CORA_RUN_JSON_MAX_BYTES,
  );

  // Live activity is the most volatile worker detail and the least useful once
  // it is stale, so byte pressure has to spend it before the agent's lifecycle
  // state. Every worker here is running, which keeps the settled-worker sweep
  // out of the way and isolates the optional-field drop order.
  const activityBase = {
    ...hostileBase(),
    workers: Array.from({ length: 4 }, (_, index) => ({
      ...hostileWorker(index),
      status: "running",
      title: "worker",
      model: "m",
      effort: "high",
      runtimeState: "s".repeat(200),
      runtimeActivity: "a".repeat(120),
    })),
  };
  delete activityBase.lastMessage;
  delete activityBase.blockedQuestion;
  delete activityBase.steps;
  const activityFullBytes = contract.jsonUtf8Bytes(activityBase);
  assert.equal(activityFullBytes, 5_484);
  const activityCount = (run) =>
    run.workers.filter((worker) => worker.runtimeActivity !== undefined).length;
  const stateCount = (run) =>
    run.workers.filter((worker) => worker.runtimeState !== undefined).length;

  // Light pressure: the newest activity lines go and every agent still reports
  // the lifecycle state the phone renders its status pill from.
  const lightlyPruned = projector.pruneRemoteCoraRunBase(
    activityBase,
    activityFullBytes - 200,
  );
  assert.equal(lightlyPruned.workers.length, 4);
  assert.equal(activityCount(lightlyPruned), 2);
  assert.equal(stateCount(lightlyPruned), 4);

  // Enough pressure to spend every activity line, and not one byte of
  // runtimeState is touched until they are all gone.
  const activityPruned = projector.pruneRemoteCoraRunBase(
    activityBase,
    activityFullBytes - 400,
  );
  assert.equal(activityPruned.workers.length, 4);
  assert.equal(activityCount(activityPruned), 0);
  assert.equal(stateCount(activityPruned), 4);
  assert.equal(activityPruned.truncation.workerDetailsOmitted, true);
  assert.ok(
    contract.jsonUtf8Bytes(activityPruned) <= activityFullBytes - 400,
  );

  // The run-level context gauge has no drop entry: two numbers that never grow
  // with the run, against worker details and steps that do. It has to survive
  // every stage of the prune ladder — from the first dropped activity line all
  // the way down to a run stripped of its steps and blocked question — or the
  // phone's meter would blank out exactly when the run got interesting.
  const gaugeBase = {
    ...activityBase,
    steps: Array.from({ length: 12 }, () => ({
      title: "\0".repeat(300),
      status: "running",
    })),
    stepsTotal: 12,
    stepsFinished: 0,
    blockedQuestion: {
      messageId: "message-5",
      message: "q".repeat(4_096),
    },
    context: { usedTokens: 141_312, budgetTokens: 256_000 },
  };
  const gaugeFullBytes = contract.jsonUtf8Bytes(gaugeBase);
  const gaugeBytes = gaugeFullBytes - contract.jsonUtf8Bytes({
    ...gaugeBase,
    context: undefined,
  });
  assert.equal(gaugeBytes, 54, "the gauge is ~60 bytes on the wire, not a page");
  let deepestGaugePrune = gaugeBase;
  for (const spend of [200, 400, 2_000, 8_000, 24_000]) {
    deepestGaugePrune = projector.pruneRemoteCoraRunBase(
      gaugeBase,
      gaugeFullBytes - spend,
    );
    assert.deepEqual(
      deepestGaugePrune.context,
      { usedTokens: 141_312, budgetTokens: 256_000 },
      `the context gauge survives ${spend} bytes of pressure`,
    );
    assert.ok(contract.jsonUtf8Bytes(deepestGaugePrune) <= gaugeFullBytes - spend);
  }
  // The deepest of those budgets spends the whole ladder — every worker detail,
  // the entire plan, and part of the blocked question — and the gauge is still
  // there, which is the whole point of leaving it off the drop order.
  assert.equal(deepestGaugePrune.steps, undefined);
  assert.equal(deepestGaugePrune.truncation.stepsOmitted, 12);
  assert.equal(deepestGaugePrune.truncation.workerDetailsOmitted, true);
  assert.equal(deepestGaugePrune.truncation.blockedQuestionBodyTruncated, true);
  assert.ok(
    deepestGaugePrune.blockedQuestion.message.length < 4_096,
  );

  // A maximally-full run whose only prunable detail is the activity readout:
  // no lastMessage, no steps, no blockedQuestion, every worker still active.
  // The `workerDetailsOmitted` marker costs bytes of its own, so the drop loop
  // has to spend them from its own budget. When it did not, the loop stopped
  // just under budget, the truthful marker pushed the run back over, and the
  // final guard threw instead of serving the pruned run the phone can render.
  const markerBoundaryBase = () => ({
    id: "run-marker-boundary",
    workspaceId: "workspace-hostile",
    title: "t",
    status: "running",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:01:00.000Z",
    messageCount: 1,
    activeWorkers: 900,
    messages: [],
    workers: Array.from({ length: 900 }, (_, index) => ({
      id: `worker-${index}`,
      title: "w".repeat(300),
      runtime: "claude",
      status: "running",
      runtimeActivity: "a".repeat(120),
    })),
  });
  const markerBoundary = projector.projectBoundedRemoteCoraRun({
    base: markerBoundaryBase(),
    runId: "run-marker-boundary",
    conversationEpoch: 0,
    // Sized so the run lands inside the window where the drop loop stops
    // under budget and the marker alone would push it back over.
    sourceMessages: [message("message-1", "b".repeat(74))],
    projectMessage: (source) => projectMessage(contract, source),
    maxMessageCount: 10,
    maxMessageBytes: 384 * 1024,
  });
  assert.equal(markerBoundary.run.truncation.workerDetailsOmitted, true);
  assert.equal(markerBoundary.run.workers.length, 900);
  assert.ok(
    contract.jsonUtf8Bytes(markerBoundary.run) <=
      contract.CORA_RUN_JSON_MAX_BYTES,
    "the marker-boundary run is served pruned, inside its exact budget",
  );

  // Every budget between "nothing to drop" and "everything dropped" has to
  // land on a pruned run, never a throw: the marker's bytes must never be the
  // difference between success and failure.
  const sweepBase = () => ({
    ...markerBoundaryBase(),
    activeWorkers: 4,
    workers: Array.from({ length: 4 }, (_, index) => ({
      id: `worker-${index}`,
      title: "w",
      runtime: "claude",
      status: "running",
      runtimeActivity: "a".repeat(120),
    })),
  });
  const sweepFull = contract.jsonUtf8Bytes(sweepBase());
  const sweepStripped = sweepBase();
  for (const worker of sweepStripped.workers) delete worker.runtimeActivity;
  // Below this floor even a fully stripped run cannot fit, and throwing is the
  // correct answer; the reserve for `messagesOmitted` accounts for the rest.
  const sweepFloor = contract.jsonUtf8Bytes(sweepStripped) + 80;
  for (let budget = sweepFloor; budget <= sweepFull; budget += 1) {
    const pruned = projector.pruneRemoteCoraRunBase(sweepBase(), budget);
    assert.ok(
      contract.jsonUtf8Bytes(pruned) <= budget,
      `pruned run exceeded its budget of ${budget} bytes`,
    );
    const droppedActivity = pruned.workers.some(
      (worker) => worker.runtimeActivity === undefined,
    );
    assert.equal(
      pruned.truncation?.workerDetailsOmitted ?? false,
      droppedActivity,
      `the omission marker disagrees with the drops at ${budget} bytes`,
    );
  }

  // Defense in depth at the final RPC result boundary. A hostile injected
  // service can duplicate one enormous message id into both delta boundaries;
  // the result builder must choose the smaller bounded full projection.
  const hugeId = "m".repeat(390_000);
  const injectedRun = {
    id: "run-injected",
    workspaceId: "workspace-injected",
    title: "Injected",
    status: "running",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:01:00.000Z",
    messageCount: 1,
    activeWorkers: 0,
    messages: [
      {
        id: hugeId,
        author: "cora",
        kind: "note",
        message: "ok",
        createdAt: "2026-07-31T00:01:00.000Z",
      },
    ],
  };
  const fullResultBytes = contract.jsonUtf8Bytes({
    run: injectedRun,
    revision: "r".repeat(43),
    cursor: "c".repeat(66),
  });
  const injectedMessageDelta = {
    afterCursor: "c".repeat(66),
    windowStartId: hugeId,
    windowEndId: hugeId,
    windowCount: 1,
  };
  const injectedDeltaResultBytes = contract.jsonUtf8Bytes({
    run: injectedRun,
    revision: "r".repeat(43),
    cursor: "c".repeat(66),
    messageDelta: injectedMessageDelta,
  });
  assert.equal(fullResultBytes, 390_457);
  assert.equal(injectedDeltaResultBytes, 1_170_609);
  assert.ok(fullResultBytes < contract.CORA_RUN_RESULT_JSON_MAX_BYTES);
  const selected = rpc.buildCoraRunWireResult(
    {
      run: injectedRun,
      cursor: "c".repeat(66),
      messageDelta: {
        ...injectedMessageDelta,
        messages: injectedRun.messages,
      },
    },
    "r".repeat(43),
  );
  assert.equal(selected.messageDelta, undefined);
  assert.equal(selected.run.messages.length, 1);
  assert.ok(
    contract.jsonUtf8Bytes(selected) <= contract.CORA_RUN_RESULT_JSON_MAX_BYTES,
  );

  console.log("remote Cora byte-contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
