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
