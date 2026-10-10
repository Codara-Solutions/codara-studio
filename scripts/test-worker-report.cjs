// Contract tests for worker report parsing (worker-report.ts): the status
// contract stays strict except for a few unambiguous synonyms of success, and
// the diagnostic reader says exactly what is wrong with a report it cannot
// use, which is what the worker's report follow-up turn is told.
//
//   node scripts/test-worker-report.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "worker-report.ts")],
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
  const R = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cora-worker-report-"));
  const file = (name, body) => {
    const p = path.join(dir, name);
    if (body !== undefined) fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  await test("the four contract statuses parse as themselves", async () => {
    for (const status of ["complete", "partial", "blocked", "failed"]) {
      const report = await R.readWorkerReport(file(`${status}.json`, { status, summary: status }));
      assert.equal(report?.status, status);
    }
  });

  await test("unambiguous synonyms of success read as complete", async () => {
    for (const status of ["success", "Done", "completed", " SUCCEEDED "]) {
      const report = await R.readWorkerReport(file(`alias-${status.trim()}.json`, { status }));
      assert.equal(report?.status, "complete", status);
    }
  });

  await test("anything that could mean unfinished work stays invalid", async () => {
    for (const status of ["ok", "in_progress", "error", "", 1, null]) {
      const report = await R.readWorkerReport(file(`bad-${String(status)}.json`, { status }));
      assert.equal(report, null, String(status));
    }
  });

  await test("the diagnostic reader names the problem", async () => {
    const missing = await R.readWorkerReportWithProblem(file("absent.json"));
    assert.equal(missing.report, null);
    assert.match(missing.problem, /does not exist/);

    const trailingComma = await R.readWorkerReportWithProblem(file("comma.json", '{"status":"complete",}'));
    assert.equal(trailingComma.report, null);
    assert.match(trailingComma.problem, /not valid JSON/);

    const wrongStatus = await R.readWorkerReportWithProblem(file("wrong.json", { status: "in_progress" }));
    assert.equal(wrongStatus.report, null);
    assert.match(wrongStatus.problem, /"in_progress" is not one of "complete", "partial", "blocked", "failed"/);

    const array = await R.readWorkerReportWithProblem(file("array.json", "[]"));
    assert.match(array.problem, /single JSON object/);

    const good = await R.readWorkerReportWithProblem(file("good.json", { status: "partial", summary: "half" }));
    assert.equal(good.problem, null);
    assert.equal(good.report?.summary, "half");
  });

  console.log(`\n${passed} worker report checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
