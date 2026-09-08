"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TASKS } = require("../cli/bench/tasks.cjs");
const { gradeChecks, visibleSource } = require("../cli/bench/grade.cjs");
const { acceptanceSummary, trialPassed, wilsonInterval, modelControlCheck } = require("../cli/bench/metrics.cjs");

function inWorkspace(task, overrides, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cora-bench-integrity-"));
  try {
    for (const [file, content] of Object.entries({ ...task.files, ...overrides })) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    verify(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const typo = TASKS.find((task) => task.name === "typo-fix");
inWorkspace(typo, { "test.js": "// inRange(5, 0, 5)\n" }, (dir) => {
  const checks = gradeChecks(typo, dir, {});
  assert.equal(checks.find((check) => check.name === "visible tests pass").pass, false);
  assert.equal(checks.find((check) => check.name === "test.js untouched").pass, false);
  assert.equal(checks.find((check) => check.hidden).pass, false);
  assert.equal(fs.readdirSync(dir).some((file) => file.includes("__bench_hidden")), false);
});
inWorkspace(typo, { ...typo.reference, "test.js": "process.exit(0); // inRange(5, 0, 5)\n" }, (dir) => {
  const checks = gradeChecks(typo, dir, {});
  assert.equal(checks.find((check) => check.name === "visible tests pass").pass, true);
  assert.equal(trialPassed({ runStatus: "complete", checks }), false);
});

const lru = TASKS.find((task) => task.name === "holdout-lru");
inWorkspace(lru, lru.reference, (dir) => {
  const checks = gradeChecks(lru, dir, { models: ["gpt-5.6-luna"] });
  assert.equal(checks.every((check) => check.pass), true, "correctness is independent of model selection");
});

const staged = TASKS.find((task) => task.name === "checkpoint-tracker");
assert.equal(visibleSource(staged), staged.files["test.js"]);
for (let stage = 1; stage <= staged.stages.length; stage += 1) {
  assert.equal(visibleSource(staged, stage), staged.stages[stage - 1].files["test.js"]);
}
inWorkspace(staged, { ...staged.reference, ...Object.assign({}, ...staged.stages.map((stage) => stage.files)) }, (dir) => {
  assert.equal(gradeChecks(staged, dir, {}).every((check) => check.pass), true);
});

assert.equal(modelControlCheck(["gpt-5.6-sol"], "gpt-5.6-luna").pass, false);
assert.equal(modelControlCheck([], "gpt-5.6-luna").pass, false);
assert.equal(modelControlCheck(["gpt-5.6-luna", "gpt-5.6-luna"], "gpt-5.6-luna").pass, true);
assert.equal(modelControlCheck(["gpt-5.6-luna", "gpt-5.6-sol"], "gpt-5.6-luna").pass, false);
const passed = { task: "a", runStatus: "complete", checks: [{ pass: true }], wallMs: 1000, tokens: 500 };
assert.equal(trialPassed(passed), true);
for (const runStatus of ["timeout", "failed", "cancelled", "running", "error"]) {
  assert.equal(trialPassed({ ...passed, runStatus }), false, `${runStatus} cannot count as accepted`);
}
assert.equal(trialPassed({ ...passed, checks: [] }), false);
assert.equal(trialPassed({ ...passed, checks: [{ pass: true }, { pass: false }] }), false);
const summary = acceptanceSummary([passed, { ...passed, checks: [{ pass: false }], wallMs: 1, tokens: 1 }, { ...passed, task: "b", tokens: 0 }]);
assert.equal(summary.passed, 2);
assert.equal(acceptanceSummary([{ ...passed, questions: 1 }, { ...passed, staged: true }, passed]).oneShotPassed, 1);
assert.equal(acceptanceSummary([{ ...passed, staged: true }, passed]).oneShotTrials, 1);
assert.equal(summary.passRate, 2 / 3);
assert.equal(summary.acceptedMedianWallMs, 1000, "fast failures do not lower successful latency");
assert.equal(summary.acceptedMedianTokens, 500, "missing telemetry is not free usage");
assert.equal(summary.missingUsageTrials, 1);
assert.equal(summary.perTask.a.allTrialsPassed, false);
assert.equal(summary.perTask.b.allTrialsPassed, true);
assert.ok(wilsonInterval(3, 3)[0] < 0.5, "three successes still leave substantial uncertainty");
assert.equal(acceptanceSummary([]).passRate, null);
assert.equal(wilsonInterval(0, 0), null);
const { comparableEntry } = require("../cli/commands/bench.cjs");
assert.equal(comparableEntry({ adopted: true }, {}), false, "recovered trials do not silently compare to uninterrupted ones");
const { selectModels } = require("../cli/bench/matrix.cjs");
const catalog = [
  { id: "a", provider: "openai-codex", thinkingLevels: ["low", "high"] },
  { id: "b", provider: "anthropic", thinkingLevels: ["high"] },
];
assert.deepEqual(selectModels(catalog, "b,a,b", "high").map((model) => model.id), ["b", "a"]);
assert.deepEqual(selectModels(catalog, "all", "high"), catalog);
assert.throws(() => selectModels(catalog, "unknown", "high"), /absent/);
assert.throws(() => selectModels(catalog, "all", "low"), /does not support/);
assert.throws(() => selectModels(catalog, "", "high"), /Use --models/);
console.log("bench integrity tests passed");
