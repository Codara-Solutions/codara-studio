// Contract tests for how a worker's outcome is judged and asked about when no
// Cora turn is live: the auto-review status mapping and step roll-up
// (step-lifecycle.ts), and the unverified-completion question's canned choices
// (worker-outcome-questions.ts). Only a canned click earns a local action;
// free text, including negations, must fall through to the manager.
//
//   node scripts/test-worker-outcome-questions.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ORCH = path.join(ROOT, "src", "main", "orchestration");

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ORCH, file)],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const Q = await load("worker-outcome-questions.ts");
  const L = await load("step-lifecycle.ts");
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("only a complete report is accepted by the auto review", () => {
    assert.equal(L.autoReviewedTaskStatus("complete"), "accepted");
    assert.equal(L.autoReviewedTaskStatus("partial"), "blocked");
    assert.equal(L.autoReviewedTaskStatus("blocked"), "blocked");
    assert.equal(L.autoReviewedTaskStatus("failed"), "failed");
    // A worker that exited without a parseable report did not succeed.
    assert.equal(L.autoReviewedTaskStatus(null), "failed");
    assert.equal(L.autoReviewedTaskStatus(undefined), "failed");
  });

  const run = (tasks) => ({
    id: "run-rollup",
    steps: [{ id: "s1", status: "reviewing" }],
    workerTasks: tasks.map(([id, status]) => ({ id, stepId: "s1", status })),
  });
  test("a step settles on the worst outcome among its tasks", () => {
    assert.equal(L.settledReviewedStepStatus(run([["a", "accepted"]]), "s1"), "complete");
    assert.equal(
      L.settledReviewedStepStatus(run([["a", "accepted"], ["b", "failed"]]), "s1"),
      "failed",
    );
    assert.equal(
      L.settledReviewedStepStatus(run([["a", "accepted"], ["b", "blocked"]]), "s1"),
      "completed_unverified",
    );
    assert.equal(
      L.settledReviewedStepStatus(run([["a", "blocked"], ["b", "failed"]]), "s1"),
      "failed",
    );
    // A cancelled sibling (a superseded fallback, say) is neutral.
    assert.equal(
      L.settledReviewedStepStatus(run([["a", "cancelled"], ["b", "accepted"]]), "s1"),
      "complete",
    );
  });

  test("a step with a live task does not settle", () => {
    for (const live of ["created", "queued", "claimed", "running", "needs_review", "retry_queued"]) {
      assert.equal(
        L.settledReviewedStepStatus(run([["a", "failed"], ["b", live]]), "s1"),
        undefined,
        live,
      );
    }
    assert.equal(L.settledReviewedStepStatus(run([["a", "cancelled"]]), "s1"), undefined);
    assert.equal(L.settledReviewedStepStatus(run([]), "s1"), undefined);
  });

  const options = Q.UNVERIFIED_COMPLETION_OPTIONS;
  const parse = (text) => Q.parseUnverifiedCompletionChoice(text, options);
  const check = options.find((option) => option.id === Q.UNVERIFIED_CHECK_OPTION_ID);
  const accept = options.find((option) => option.id === Q.UNVERIFIED_ACCEPT_OPTION_ID);

  test("the unverified question offers a check and an as-is choice", () => {
    assert.ok(check && accept);
    assert.equal(check.recommended, true);
    assert.equal(accept.recommended, false);
    // Plain words the user can act on, not the internal verdict vocabulary.
    assert.doesNotMatch(Q.UNVERIFIED_COMPLETION_QUESTION, /verdict|verifier/i);
  });

  test("clicking the canned options yields their choice", () => {
    assert.equal(parse(check.answer), "check");
    assert.equal(parse(accept.answer), "accept");
    assert.equal(parse(`  ${accept.answer.toUpperCase()} `), "accept");
    assert.equal(parse(Q.UNVERIFIED_CHECK_OPTION_ID), "check");
    assert.equal(parse(Q.UNVERIFIED_ACCEPT_OPTION_ID), "accept");
    assert.equal(parse(`${check.answer} Thanks`), "check");
  });

  test("free text and negations go to the manager", () => {
    assert.equal(parse("huh?"), null);
    assert.equal(parse("don't check it, just ship"), null);
    assert.equal(parse("check"), null);
    assert.equal(parse(""), null);
    assert.equal(Q.parseUnverifiedCompletionChoice(check.answer, undefined), null);
  });

  test("the unfinished-worker choices stay free-text answers for Cora", () => {
    const ids = Q.UNFINISHED_WORKER_OPTIONS.map((option) => option.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(Q.UNFINISHED_WORKER_OPTIONS.every((option) => option.answer && option.label));
    assert.ok(!ids.includes(Q.UNVERIFIED_CHECK_OPTION_ID));
  });

  test("new modules stay dash-free", () => {
    for (const file of ["worker-outcome-questions.ts"]) {
      assert.doesNotMatch(fs.readFileSync(path.join(ORCH, file), "utf8"), /[–—]/, file);
    }
  });

  console.log(`\n${passed} worker-outcome checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
