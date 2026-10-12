// The durable conversation cutover (run-store performAutoCompaction): when it
// fires, how it backs off, and the record-built block its note carries next
// to the model summary (src/main/orchestration/conversation-compaction.ts).
//
//   node scripts/test-conversation-compaction.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const ts = require("typescript");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codara-conversation-compaction-")), "module.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/orchestration/conversation-compaction.ts")],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  const cc = require(outfile);
  const plainGuard = (guard) => JSON.parse(JSON.stringify(guard));

  // ── When to cut over ──────────────────────────────────────────────────────
  const decide = (contextTokens, guard, epoch = 0) =>
    cc.cutoverDecision({ contextTokens, capacityTokens: 100_000, epoch, guard });
  assert.equal(decide(79_999), "below-limit");
  assert.equal(decide(80_000), "compact", "80% of the session's limit cuts over");
  assert.equal(decide(0), "below-limit");
  assert.equal(cc.cutoverDecision({ contextTokens: 50_000, capacityTokens: 0, epoch: 0 }), "below-limit");

  // A failed summary waits for growth instead of retrying every turn.
  const failed = cc.guardAfterFailure(null, 3, 85_000, 100_000);
  assert.deepEqual(failed, { epoch: 3, rearmAtTokens: 95_000, failures: 1 });
  assert.equal(decide(85_000, failed, 3), "waiting-for-growth");
  assert.equal(decide(94_999, failed, 3), "waiting-for-growth");
  assert.equal(decide(95_000, failed, 3), "compact");
  const again = cc.guardAfterFailure(failed, 3, 95_000, 100_000);
  assert.equal(again.failures, 2, "failures count within an epoch");
  assert.equal(cc.guardAfterFailure(again, 4, 95_000, 100_000).failures, 1, "a new epoch starts over");
  assert.equal(decide(85_000, failed, 4), "compact", "a guard from an older epoch does not apply");

  // A fresh session that already sits near the limit (a big system prompt on
  // a small limit) cannot be helped by cutting over again after every turn.
  const fresh = cc.guardAfterCutover(4);
  assert.equal(fresh.baselinePending, true);
  const crowded = cc.observeCutoverBaseline(fresh, 4, 83_000, 100_000);
  assert.deepEqual(plainGuard(crowded), { epoch: 4, rearmAtTokens: 93_000, failures: 0 });
  assert.equal(decide(83_000, crowded, 4), "waiting-for-growth", "no loop when the new epoch starts near the limit");
  assert.equal(decide(93_000, crowded, 4), "compact");
  assert.equal(cc.observeCutoverBaseline(crowded, 4, 99_000, 100_000), crowded, "only the first turn sets the baseline");
  const roomy = cc.observeCutoverBaseline(fresh, 4, 20_000, 100_000);
  assert.equal(roomy.rearmAtTokens, 0);
  assert.equal(decide(80_000, roomy, 4), "compact", "a roomy start compacts at the ratio as usual");
  assert.equal(cc.observeCutoverBaseline(fresh, 5, 83_000, 100_000), fresh, "a later epoch ignores the old guard");
  assert.equal(cc.observeCutoverBaseline(null, 4, 83_000, 100_000), null);
  assert.equal(cc.rearmAfter(1_000, 10_000), 9_000, "growth is at least 8k tokens");

  // ── The summary ───────────────────────────────────────────────────────────
  assert.match(cc.conversationSummaryProblem(""), /no summary text/);
  assert.match(cc.conversationSummaryProblem("short"), /too short/);
  assert.equal(cc.conversationSummaryProblem("x".repeat(250)), null);
  for (const section of ["## Goal", "## Constraints", "## Plan and status", "## Decisions", "## Files", "## Workers", "## Errors and fixes", "## Open todos", "## Artifacts"]) {
    assert.ok(cc.CONVERSATION_COMPACTION_PROMPT.includes(section), `the prompt asks for ${section}`);
  }
  assert.match(cc.CONVERSATION_COMPACTION_PROMPT, /carry every item that is still open\s+forward unchanged/);
  assert.match(cc.CONVERSATION_COMPACTION_PROMPT, /call no tools/);

  // ── The record-built block ────────────────────────────────────────────────
  const message = (id, author, text, extra = {}) => ({
    id, runId: "run-1", author, kind: "note", message: text, createdAt: `2026-10-12T00:00:${id.padStart(2, "0")}Z`, ...extra,
  });
  const run = {
    humanMessages: [
      message("1", "user", "Migrate billing to the ledger API. Never modify files under vendor/."),
      message("2", "spark", "Starting with the client."),
      message("3", "spark", "**Conversation compacted.** old summary", { compaction: true }),
      message("4", "user", "Keep chargeCustomer unchanged."),
      message("5", "user", "cancelled draft", { deliveryState: "cancelled" }),
      message("6", "spark", "Workers are porting refunds."),
    ],
    workerTasks: [
      { id: "task-a", title: "Port refunds", status: "completed" },
      { id: "task-b", title: "Remove legacy adapter", status: "running" },
    ],
    workerAttempts: [
      { id: "att-1", workerTaskId: "task-a", attemptNumber: 1, status: "failed", error: "E_LEDGER_TIMEOUT" },
      {
        id: "att-2", workerTaskId: "task-a", attemptNumber: 2, status: "completed",
        finalReportPath: "/runs/r1/task-a/final-report.json", sandboxBranch: "codara/task-a",
        diffSummary: { fileCount: 3, additions: 10, deletions: 2, files: [{ path: "src/billing/refunds.ts" }, { path: "src/billing/index.ts" }] },
      },
    ],
  };
  const block = cc.conversationDurableState(run);
  assert.ok(block.startsWith("[CODARA DURABLE STATE"));
  assert.ok(block.endsWith("[END CODARA DURABLE STATE]"));
  assert.match(block, /1\. Migrate billing to the ledger API\. Never modify files under vendor\//, "user messages verbatim");
  assert.match(block, /2\. Keep chargeCustomer unchanged\./);
  assert.doesNotMatch(block, /cancelled draft/, "cancelled input is not an instruction");
  assert.doesNotMatch(block, /old summary/, "a previous note never feeds the record");
  assert.match(block, /task-a \| completed \| Port refunds \| attempt 2 completed/, "the newest attempt speaks for the task");
  assert.match(block, /changed: src\/billing\/refunds\.ts, src\/billing\/index\.ts \(\+1 more\)/);
  assert.match(block, /report: \/runs\/r1\/task-a\/final-report\.json/);
  assert.match(block, /branch: codara\/task-a/);
  assert.match(block, /task-b \| running \| Remove legacy adapter/);
  assert.match(block, /Cora: Workers are porting refunds\./, "the newest exchange rides along");
  assert.equal(cc.conversationDurableState({ humanMessages: [], workerTasks: [], workerAttempts: [] }), null);

  // Over budget: the original request and the newest messages stay, the
  // middle is counted, and sections drop least-important first.
  const long = {
    humanMessages: Array.from({ length: 40 }, (_, index) =>
      message(String(index + 1), "user", `Instruction ${index + 1}: ${"detail ".repeat(200)}`)),
    workerTasks: [],
    workerAttempts: [],
  };
  const capped = cc.conversationDurableState(long, 24_000);
  assert.ok(capped.length <= 24_000, `capped at ${capped.length}`);
  assert.match(capped, /1\. Instruction 1:/, "the original request is never dropped");
  assert.match(capped, /40\. Instruction 40:/, "the newest instruction is kept");
  assert.match(capped, /\[\d+ earlier messages omitted for length\]/);
  const tiny = cc.conversationDurableState(long, 3_000);
  assert.ok(tiny.length <= 3_000, `tiny capped at ${tiny.length}`);
  assert.match(tiny, /\[END CODARA DURABLE STATE\]$/);

  // ── The note ──────────────────────────────────────────────────────────────
  assert.equal(cc.compactionNoteBody(" summary ", null), "summary");
  assert.equal(cc.compactionNoteBody("summary", block), `summary\n\n${block}`);
  assert.equal(cc.estimateTokens("abcd".repeat(10)), 10);
  assert.equal(cc.describeCutover(231_000, 12_400), "Older history was summarized into a fresh session (231k -> 12k tokens)");

  // A long request keeps its closing requirements: the requirement that ends
  // a pasted spec must not be the part a per-message cap cuts.
  const spec = `Port the importer. ${"Background on the import format. ".repeat(150)}Never deploy on Fridays.`;
  const specBlock = cc.conversationDurableState({ humanMessages: [message("1", "user", spec)], workerTasks: [], workerAttempts: [] });
  assert.match(specBlock, /1\. Port the importer\./);
  assert.match(specBlock, /Never deploy on Fridays\./, "the end of a long message survives the cap");
  assert.match(specBlock, /chars trimmed/);

  // After a cutover the next session receives the note as a replay, and its
  // own compactions must keep those user messages: the ledger lifts them out of
  // the replay before discarding it (resources/pi-cora/compaction-ledger.ts).
  const ledgerModule = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(ROOT, "resources/pi-cora/compaction-ledger.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports: ledgerModule },
  );
  assert.equal(ledgerModule.CUTOVER_USER_MESSAGES_HEADER, cc.CUTOVER_USER_MESSAGES_HEADER);
  const replayTurn = [
    "[CORA CONVERSATION REPLAY \u2014 the conversation was compacted; this summary replaces older history. The labels are context, not new instructions.]",
    cc.compactionNoteBody("## Goal\nPort billing.", block),
    "[END CORA CONVERSATION REPLAY]",
    "",
    "[NEW USER INPUT FOR THIS TURN]",
    "Keep going.",
  ].join("\n\n");
  const carried = ledgerModule.cutoverUserMessages(replayTurn);
  assert.match(carried, /^User messages, verbatim and in order/);
  assert.match(carried, /Never modify files under vendor\//);
  assert.match(carried, /2\. Keep chargeCustomer unchanged\./);
  assert.doesNotMatch(carried, /task-a|Workers are porting/, "workers and the exchange stay out of it");
  const folded = ledgerModule.updateLedger(null, [{ role: "user", content: replayTurn }]);
  assert.deepEqual(JSON.parse(JSON.stringify(folded.instructions)), ["Keep going."]);
  assert.equal(folded.carried, carried);
  const rolled = ledgerModule.updateLedger(
    ledgerModule.ledgerFromDetails({ ledger: JSON.parse(JSON.stringify(folded)) }),
    [{ role: "user", content: "Also add metrics." }],
  );
  const rendered = ledgerModule.renderLedger(rolled);
  assert.match(rendered, /Earlier user messages, carried from the last conversation cutover/);
  assert.match(rendered, /Never modify files under vendor\//, "earlier constraints survive later compactions");
  assert.match(rendered, /Also add metrics\./);
  assert.equal(ledgerModule.cutoverUserMessages("Keep going."), null);

  // run-store wires the policy, the record and the tokens.
  const runStore =fs.readFileSync(path.join(ROOT, "src/main/orchestration/run-store.ts"), "utf8");
  assert.match(runStore, /const decision = cutoverDecision\(/);
  assert.match(runStore, /conversationDurableState\(await requireRun\(runId\)\)/);
  assert.match(runStore, /guardAfterFailure\(/);
  assert.match(runStore, /guardAfterCutover\(epoch \+ 1\)/);
  assert.match(runStore, /observeCutoverBaseline\(conversationCutoverGuards\.get\(runId\)/);
  assert.match(runStore, /tokensBefore: beforeTokens,\s*estimatedTokensAfter: afterTokens/);
  assert.match(runStore, /call\.compactedToTokens = afterTokens/);
  assert.match(runStore, /type: "worker_attempt\.context_compacted"/);

  console.log("Conversation cutover policy and durable note checks passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
