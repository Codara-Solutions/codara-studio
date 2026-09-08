"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const root = path.resolve(__dirname, "..");
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src/main/orchestration/direct-conversation.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { "@shared": path.join(root, "src/shared") },
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
  const { buildDirectTurnPrompt, directConversationMessages, directCompactionInput, directConversationNeedsCompaction, directCompactionSnapshotStillCurrent, DIRECT_REPLAY_COMPACT_CHARS } = mod.exports;
  const message = (id, author, text, extra = {}) => ({ id, author, message: text, kind: "note", createdAt: "2026-09-08T00:00:00Z", deliveryState: "acknowledged", ...extra });
  const first = message("first", "user", "jobId=job-abc, region=us-west-2, owner=team-xyz");
  const corrected = message("corrected", "user", "Correction: region=eu-west-3");
  const latest = message("latest", "user", "Write the settings we agreed on.");
  const run = { id: "run-test", updatedAt: first.createdAt, conversationEpoch: 0, workerAttempts: [], humanMessages: [first, message("reply", "spark", "Noted."), corrected, latest] };
  const prompt = buildDirectTurnPrompt(run, [latest]);
  assert.ok(prompt.includes(first.message));
  assert.ok(prompt.includes(corrected.message));
  assert.ok(prompt.indexOf(first.message) < prompt.indexOf(corrected.message));
  assert.equal(prompt.split(latest.message).length, 2, "the newest request is included once");
  assert.ok(prompt.endsWith(latest.message));
  const noisy = { ...run, humanMessages: [...run.humanMessages,
    message("queued", "user", "future queued input", { deliveryState: "queued" }),
    message("cancelled", "user", "cancelled input", { deliveryState: "cancelled" }),
    message("stream", "spark", "partial stream", { kind: "assistant_stream" }),
    message("board", "user", "board noise", { boardNote: true }),
  ] };
  assert.deepEqual(directConversationMessages(noisy, [latest]).map((m) => m.id), ["first", "reply", "corrected"]);
  const summary = message("summary", "spark", "jobId=job-abc, region=eu-west-3, owner=team-xyz", { compaction: true, conversationEpoch: 1 });
  const after = message("after", "user", "Owner is now team-new", { conversationEpoch: 1 });
  const compacted = { ...run, conversationEpoch: 1, compactionEpoch: 1, compactionSummaryMessageId: "summary", humanMessages: [first, corrected, summary, after, latest] };
  const replay = buildDirectTurnPrompt(compacted, [latest]);
  assert.ok(replay.includes(summary.message));
  assert.ok(replay.includes(after.message), "later cold turns retain post-compaction corrections");
  assert.ok(!replay.includes("us-west-2"), "superseded pre-summary history is not replayed");
  assert.ok(directCompactionInput(compacted, "Summarize now").includes(after.message));
  assert.equal(directConversationNeedsCompaction(run, [latest]), false);
  assert.equal(directConversationNeedsCompaction({ ...run, humanMessages: [message("long", "user", "x".repeat(DIRECT_REPLAY_COMPACT_CHARS)), latest] }, [latest]), true);
  assert.equal(directCompactionSnapshotStillCurrent(run, run), true);
  assert.equal(directCompactionSnapshotStillCurrent(run, { ...run, humanMessages: [...run.humanMessages, after] }), false, "a newer user message prevents cutover");
  assert.equal(directCompactionSnapshotStillCurrent(run, { ...run, workerAttempts: [{ status: "running" }] }), false, "a live direct worker prevents cutover");
  console.log("direct conversation replay and compaction contracts passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
