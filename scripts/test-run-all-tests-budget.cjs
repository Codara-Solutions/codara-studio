#!/usr/bin/env node
// CI splits the unit suites across two macOS machines (CODARA_TEST_PART) and
// holds each half to a time budget (CODARA_TEST_BUDGET_SECONDS). A run that
// goes over must fail with a message naming what it stopped, well before the
// job's own timeout would cancel it with no explanation (issue #204).
//
//   node scripts/test-run-all-tests-budget.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests, selectPart, budgetFromEnv } = require("./run-all-tests.cjs");

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-budget-"));
const fixture = (name, body) => fs.writeFileSync(path.join(dir, name), body);
fixture("test-quick.cjs", "process.exit(0);\n");
fixture("test-also-quick.cjs", "setTimeout(() => process.exit(0), 50);\n");
fixture("test-slow.cjs", "console.log('ok - case before the hang');\nsetTimeout(() => process.exit(0), 60_000);\n");
fixture("test-alone.cjs", "// test-runner: serial (fixture)\nprocess.exit(0);\n");
const all = ["test-alone.cjs", "test-also-quick.cjs", "test-quick.cjs", "test-slow.cjs"];

const quietly = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

(async () => {
  await check("the pool part leaves out the serial suites, the serial part keeps only them", () => {
    assert.deepEqual(selectPart(all, "pool", dir), ["test-also-quick.cjs", "test-quick.cjs", "test-slow.cjs"]);
    assert.deepEqual(selectPart(all, "serial", dir), ["test-alone.cjs"]);
    assert.deepEqual(selectPart(all, undefined, dir), all);
  });

  await check("every real suite lands in exactly one part", () => {
    const real = fs.readdirSync(__dirname).filter((f) => /^test-.*\.(cjs|mjs)$/.test(f));
    const pool = selectPart(real, "pool");
    const serial = selectPart(real, "serial");
    assert.equal(pool.length + serial.length, real.length);
    assert.ok(serial.includes("test-cora-harness.mjs"));
    assert.ok(!pool.some((f) => serial.includes(f)));
  });

  await check("the budget is read from the environment and ignored when unset or nonsense", () => {
    assert.equal(budgetFromEnv({ CODARA_TEST_BUDGET_SECONDS: "900" }), 900);
    assert.equal(budgetFromEnv({}), 0);
    assert.equal(budgetFromEnv({ CODARA_TEST_BUDGET_SECONDS: "soon" }), 0);
    assert.equal(budgetFromEnv({ CODARA_TEST_BUDGET_SECONDS: "-5" }), 0);
  });

  await check("a run over its budget stops, fails, and says what it stopped and skipped", async () => {
    const summaryFile = path.join(dir, "summary-over.md");
    const t0 = Date.now();
    const failures = await quietly(() => runTests(all, { dir, jobs: 2, budgetSeconds: 2, summaryFile }));
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms; the slow suite was not stopped`);
    const byFile = new Map(failures.map((f) => [f.file, f.out]));
    assert.match(byFile.get("test-slow.cjs") ?? "", /time budget of 2s/);
    assert.match(byFile.get("test-slow.cjs") ?? "", /ok - case before the hang/);
    const message = byFile.get("time budget") ?? "";
    assert.match(message, /CODARA_TEST_BUDGET_SECONDS/);
    assert.match(message, /1 running suite\(s\) were stopped and 1 never started \(test-alone\.cjs\)/);
    assert.ok(!byFile.has("test-quick.cjs") && !byFile.has("test-also-quick.cjs"));
    assert.match(fs.readFileSync(summaryFile, "utf8"), /went over/);
  });

  await check("a run within its budget passes and lists its slowest suites in the summary", async () => {
    const summaryFile = path.join(dir, "summary-ok.md");
    const quick = ["test-alone.cjs", "test-also-quick.cjs", "test-quick.cjs"];
    const failures = await quietly(() => runTests(quick, { dir, jobs: 2, budgetSeconds: 60, summaryFile }));
    assert.deepEqual(failures, []);
    const summary = fs.readFileSync(summaryFile, "utf8");
    assert.match(summary, /3 suites, all passed/);
    assert.match(summary, /budget 60s\)/);
    for (const f of quick) assert.ok(summary.includes(`\`${f}\``), `${f} missing from the summary`);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
})();
