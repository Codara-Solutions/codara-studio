// Cross-repository append-window contract between Studio's authenticated
// message cursor producer and mobile's strict delta materializer.
//
//   npm run test:cora-run-interop

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const STUDIO_ROOT = path.resolve(__dirname, "..");
const MOBILE_ROOT = path.resolve(STUDIO_ROOT, "..", "codara-mobile");
const CACHE_ROOT = path.join(STUDIO_ROOT, "node_modules", ".cache");

async function bundle(entry, name, external = []) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const outfile = path.join(CACHE_ROOT, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: {
      "@shared": path.join(STUDIO_ROOT, "src", "shared"),
    },
    external,
  });
  delete require.cache[outfile];
  return require(outfile);
}

function sourceMessage(index, body = `message ${index} ${"x".repeat(512)}`) {
  return {
    id: `message-${index}`,
    author: index % 7 === 0 ? "user" : "cora",
    kind: "note",
    message: body,
    createdAt: new Date(Date.UTC(2026, 6, 31, 12, 0, index)).toISOString(),
  };
}

function runBase(messageCount) {
  return {
    id: "run-interop",
    workspaceId: "workspace-interop",
    title: "Append interop",
    status: "running",
    createdAt: "2026-07-31T11:00:00.000Z",
    updatedAt: "2026-07-31T12:04:00.000Z",
    messageCount,
    activeWorkers: 1,
    messages: [],
  };
}

function throughWire(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  assert.ok(
    fs.existsSync(MOBILE_ROOT),
    `mobile sibling repository is required at ${MOBILE_ROOT}`,
  );
  const projector = await bundle(
    path.join(
      STUDIO_ROOT,
      "src",
      "main",
      "remote-access",
      "cora-run-projection.ts",
    ),
    "cora-run-studio-interop.cjs",
  );
  const rpc = await bundle(
    path.join(STUDIO_ROOT, "src", "main", "remote-access", "rpc.ts"),
    "cora-run-rpc-interop.cjs",
    ["sodium-native"],
  );
  const mobile = await bundle(
    path.join(MOBILE_ROOT, "src", "lib", "cora-run-message-delta.ts"),
    "cora-run-mobile-interop.cjs",
  );

  assert.equal(mobile.CORA_RUN_MESSAGE_WINDOW_LIMIT, 200);
  assert.equal(mobile.CORA_RUN_MESSAGE_BUDGET_BYTES, 384 * 1024);
  const projectMessage = (message) => ({ ...message });
  const previousSources = Array.from({ length: 200 }, (_, index) =>
    sourceMessage(index + 1),
  );
  const previous = projector.projectBoundedRemoteCoraRun({
    base: runBase(previousSources.length),
    runId: "run-interop",
    conversationEpoch: 3,
    sourceMessages: previousSources,
    projectMessage,
    maxMessageCount: mobile.CORA_RUN_MESSAGE_WINDOW_LIMIT,
    maxMessageBytes: mobile.CORA_RUN_MESSAGE_BUDGET_BYTES,
  });
  assert.equal(previous.run.messages.length, 200);
  assert.equal(previous.messageDelta, undefined);

  const currentSources = [
    ...previousSources,
    sourceMessage(201, "phone append one"),
    sourceMessage(202, "phone append two"),
  ];
  const current = projector.projectBoundedRemoteCoraRun({
    base: runBase(currentSources.length),
    runId: "run-interop",
    conversationEpoch: 3,
    sourceMessages: currentSources,
    projectMessage,
    afterCursor: previous.cursor,
    maxMessageCount: mobile.CORA_RUN_MESSAGE_WINDOW_LIMIT,
    maxMessageBytes: mobile.CORA_RUN_MESSAGE_BUDGET_BYTES,
  });
  assert.equal(current.messageDelta.messages.length, 2);
  assert.equal(current.messageDelta.windowStartId, "message-3");
  assert.equal(current.messageDelta.windowEndId, "message-202");
  assert.equal(current.messageDelta.windowCount, 200);

  const wire = throughWire(
    rpc.buildCoraRunWireResult(current, "revision-interop-2"),
  );
  assert.ok(wire.messageDelta, "the two-message append must use compact wire form");
  assert.deepEqual(
    wire.run.messages.map(({ id }) => id),
    ["message-201", "message-202"],
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(wire), "utf8") <
      Buffer.byteLength(
        JSON.stringify({
          run: current.run,
          revision: "revision-interop-2",
          cursor: current.cursor,
        }),
        "utf8",
      ),
    "Studio emits the append shape only when it is smaller than full",
  );

  const cached = {
    run: throughWire(previous.run),
    cursor: previous.cursor,
    revision: "revision-interop-1",
    updatedAt: 1,
  };
  const materialized = mobile.materializeCoraRunMessageDelta(
    cached,
    {
      workspaceId: "workspace-interop",
      runId: "run-interop",
      afterCursor: previous.cursor,
    },
    wire,
  );
  assert.equal(materialized.ok, true);
  assert.deepEqual(
    materialized.response.run,
    current.run,
    "mobile reconstructs Studio's exact bounded suffix and current metadata",
  );
  assert.equal(materialized.response.messageDelta, undefined);
  assert.equal(materialized.response.cursor, current.cursor);
  assert.deepEqual(
    cached.run,
    previous.run,
    "mobile cannot mutate the durable base while materializing",
  );

  // Any edit to the prior prefix invalidates the digest-bound cursor. Studio
  // must fall back to a full projection rather than emitting an unsafe append.
  const rewrittenSources = previousSources.map((message) => ({ ...message }));
  rewrittenSources[50].message = "rewritten historical content";
  rewrittenSources.push(sourceMessage(201, "new append after rewrite"));
  const rewritten = projector.projectBoundedRemoteCoraRun({
    base: runBase(rewrittenSources.length),
    runId: "run-interop",
    conversationEpoch: 3,
    sourceMessages: rewrittenSources,
    projectMessage,
    afterCursor: previous.cursor,
    maxMessageCount: mobile.CORA_RUN_MESSAGE_WINDOW_LIMIT,
    maxMessageBytes: mobile.CORA_RUN_MESSAGE_BUDGET_BYTES,
  });
  assert.equal(rewritten.messageDelta, undefined);
  const rewrittenWire = throughWire(
    rpc.buildCoraRunWireResult(rewritten, "revision-rewritten"),
  );
  assert.equal(rewrittenWire.messageDelta, undefined);
  assert.equal(rewrittenWire.run.messages.length, 200);

  // Epoch changes likewise reject an otherwise valid cursor without revealing
  // whether any historical content matched.
  const rewound = projector.projectBoundedRemoteCoraRun({
    base: runBase(1),
    runId: "run-interop",
    conversationEpoch: 4,
    sourceMessages: [sourceMessage(1, "new epoch")],
    projectMessage,
    afterCursor: previous.cursor,
    maxMessageCount: mobile.CORA_RUN_MESSAGE_WINDOW_LIMIT,
    maxMessageBytes: mobile.CORA_RUN_MESSAGE_BUDGET_BYTES,
  });
  assert.equal(rewound.messageDelta, undefined);

  console.log("Studio/mobile Cora run interoperability tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
