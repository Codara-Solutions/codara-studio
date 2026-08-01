// Focused regression harness for the stateless cora.get message cursor.
//
//   node scripts/test-cora-run-message-window.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, outName) {
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
  });
  delete require.cache[outfile];
  return require(outfile);
}

function source(id, message = `body ${id}`) {
  return {
    id,
    author: "spark",
    kind: "note",
    message,
    createdAt: `2026-07-31T00:00:${String(Number(id.replace(/\D/g, "")) || 0).padStart(2, "0")}.000Z`,
  };
}

function projectMessage(message) {
  return {
    id: message.id,
    author: message.author === "spark" ? "cora" : message.author,
    kind: message.kind,
    message: message.message,
    createdAt: message.createdAt,
  };
}

function project(api, messages, options = {}) {
  return api.projectCoraRunMessageWindow({
    runId: options.runId ?? "run-a",
    conversationEpoch: options.conversationEpoch ?? 0,
    sourceMessages: messages,
    projectMessage,
    afterCursor: options.afterCursor,
    maxCount: options.maxCount ?? 200,
    maxBytes: options.maxBytes ?? 384 * 1024,
  });
}

async function main() {
  const api = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "cora-run-message-window.ts",
    ),
    "cora-run-message-window-test.cjs",
  );
  const coalescerApi = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "cora-change-coalescer.ts",
    ),
    "cora-change-coalescer-test.cjs",
  );

  const scheduled = [];
  const flushed = [];
  const coalescer = coalescerApi.createCoraChangedCoalescer(
    (event) => flushed.push(event),
    {
      delayMs: 500,
      schedule: (callback, delayMs) => {
        const timer = {
          callback,
          delayMs,
          unrefCalled: false,
          cancelled: false,
          unref() {
            this.unrefCalled = true;
          },
        };
        scheduled.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.cancelled = true;
      },
    },
  );
  coalescer.push({ workspaceId: "workspace-a", runId: "run-a", sequence: 1 });
  coalescer.push({ workspaceId: "workspace-a", runId: "run-a", sequence: 3 });
  coalescer.push({ workspaceId: "workspace-a", runId: "run-a", sequence: 2 });
  coalescer.push({ workspaceId: "workspace-a", runId: "run-b", sequence: 4 });
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled.every((timer) => timer.delayMs === 500 && timer.unrefCalled));
  assert.deepEqual(flushed, []);
  scheduled[0].callback();
  assert.deepEqual(flushed, [
    { workspaceId: "workspace-a", runId: "run-a", sequence: 3 },
  ]);
  scheduled[1].callback();
  assert.deepEqual(flushed, [
    { workspaceId: "workspace-a", runId: "run-a", sequence: 3 },
    { workspaceId: "workspace-a", runId: "run-b", sequence: 4 },
  ]);
  coalescer.dispose();

  const initialMessages = [source("message-1"), source("message-2")];
  const initial = project(api, initialMessages);
  assert.deepEqual(
    initial.messages.map(({ id }) => id),
    ["message-1", "message-2"],
  );
  assert.equal(initial.delta, undefined);
  assert.ok(initial.cursor.length <= api.CORA_MESSAGE_CURSOR_MAX_LENGTH);

  const appended = project(api, [...initialMessages, source("message-3")], {
    afterCursor: initial.cursor,
  });
  assert.deepEqual(
    appended.delta?.messages.map(({ id }) => id),
    ["message-3"],
  );
  assert.deepEqual(
    {
      afterCursor: appended.delta?.afterCursor,
      windowStartId: appended.delta?.windowStartId,
      windowEndId: appended.delta?.windowEndId,
      windowCount: appended.delta?.windowCount,
    },
    {
      afterCursor: initial.cursor,
      windowStartId: "message-1",
      windowEndId: "message-3",
      windowCount: 3,
    },
  );

  const metadataOnly = project(api, initialMessages, { afterCursor: initial.cursor });
  assert.deepEqual(metadataOnly.delta?.messages, []);
  assert.equal(metadataOnly.delta?.windowCount, 2);

  const countBaseMessages = Array.from({ length: 200 }, (_, index) =>
    source(`message-${index + 1}`),
  );
  const countBase = project(api, countBaseMessages);
  const countShift = project(api, [...countBaseMessages, source("message-201")], {
    afterCursor: countBase.cursor,
  });
  assert.deepEqual(
    countShift.delta?.messages.map(({ id }) => id),
    ["message-201"],
  );
  assert.equal(countShift.delta?.windowStartId, "message-2");
  assert.equal(countShift.delta?.windowEndId, "message-201");
  assert.equal(countShift.delta?.windowCount, 200);

  const boundedSource = Array.from({ length: 10_000 }, (_, index) =>
    source(`message-${index + 1}`),
  );
  let projectionCalls = 0;
  const bounded = api.projectCoraRunMessageWindow({
    runId: "run-large",
    conversationEpoch: 0,
    sourceMessages: boundedSource,
    projectMessage: (message) => {
      projectionCalls += 1;
      return projectMessage(message);
    },
    maxCount: 200,
    maxBytes: 384 * 1024,
  });
  assert.ok(bounded.cursor);
  assert.ok(
    projectionCalls <= 400,
    `cursor work must stay window-bounded, got ${projectionCalls} projections`,
  );

  const outsideWindowBaseMessages = Array.from({ length: 201 }, (_, index) =>
    source(`message-${index + 1}`),
  );
  const outsideWindowBase = project(api, outsideWindowBaseMessages);
  const editedOutsideWindow = [...outsideWindowBaseMessages];
  editedOutsideWindow[0] = source("message-1", "edited outside retained window");
  const outsideWindowAppend = project(
    api,
    [...editedOutsideWindow, source("message-202")],
    { afterCursor: outsideWindowBase.cursor },
  );
  assert.deepEqual(
    outsideWindowAppend.delta?.messages.map(({ id }) => id),
    ["message-202"],
  );

  const byteMessages = [
    source("message-1", "a".repeat(48)),
    source("message-2", "b".repeat(48)),
  ];
  const oneMessageBytes =
    Buffer.byteLength(JSON.stringify(projectMessage(byteMessages[1])), "utf8") + 3;
  const byteBase = project(api, byteMessages, { maxBytes: oneMessageBytes * 2 });
  const byteShift = project(api, [...byteMessages, source("message-3", "c".repeat(48))], {
    afterCursor: byteBase.cursor,
    maxBytes: oneMessageBytes * 2,
  });
  assert.equal(byteShift.delta?.windowEndId, "message-3");
  assert.ok((byteShift.delta?.windowCount ?? 0) < 3);
  assert.deepEqual(
    byteShift.delta?.messages.map(({ id }) => id),
    ["message-3"],
  );

  const resetCases = [
    ["malformed", "not-a-cursor", initialMessages, {}],
    ["projection version", initial.cursor.replace(/^m1/, "m2"), initialMessages, {}],
    ["cross run", initial.cursor, initialMessages, { runId: "run-b" }],
    ["cross epoch", initial.cursor, initialMessages, { conversationEpoch: 1 }],
    [
      "edit",
      initial.cursor,
      [source("message-1", "edited"), source("message-2")],
      {},
    ],
    [
      "reorder",
      initial.cursor,
      [source("message-2"), source("message-1")],
      {},
    ],
    ["truncation", initial.cursor, [source("message-1")], {}],
  ];
  for (const [label, afterCursor, messages, options] of resetCases) {
    const reset = project(api, messages, { ...options, afterCursor });
    assert.equal(reset.delta, undefined, `${label} must fail closed to a full window`);
  }

  const empty = project(api, []);
  const fromEmpty = project(api, [source("message-1")], { afterCursor: empty.cursor });
  assert.deepEqual(
    fromEmpty.delta?.messages.map(({ id }) => id),
    ["message-1"],
  );
  assert.equal(fromEmpty.delta?.windowStartId, "message-1");

  console.log("all Cora run message-window checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
