// Contract tests for the manual-review verdict parser: only the CANNED
// accept/fail option earns a local verdict; every other answer - including
// negations - is free text that must fall through to the manager path.
// Bundles the real main-process module with esbuild; no Electron involved.
//
//   node scripts/test-manual-review.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE = path.join(ROOT, "src", "main", "orchestration", "manual-review.ts");

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [MODULE],
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
  const M = await loadContract();
  const options = M.MANUAL_REVIEW_QUESTION_OPTIONS;
  const parse = (text) => M.parseManualReviewVerdict(text, options);
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("clicking the canned options yields their verdicts", () => {
    const accept = options.find((option) => option.id === M.MANUAL_REVIEW_ACCEPT_OPTION_ID);
    const fail = options.find((option) => option.id === M.MANUAL_REVIEW_FAIL_OPTION_ID);
    assert.equal(parse(accept.answer), "accept");
    assert.equal(parse(fail.answer), "fail");
    // Case and surrounding whitespace do not change a click's meaning.
    assert.equal(parse(`  ${accept.answer.toUpperCase()}  `), "accept");
    // The raw option id is accepted as a programmatic answer.
    assert.equal(parse(M.MANUAL_REVIEW_ACCEPT_OPTION_ID), "accept");
    assert.equal(parse(M.MANUAL_REVIEW_FAIL_OPTION_ID), "fail");
    // A canned answer with a trailing user note still reads as that option.
    assert.equal(parse(`${accept.answer} Thanks!`), "accept");
  });

  test("negations and free text fall through to the manager path", () => {
    // The exact probes that defeated the keyword parser: each contains an
    // accept/reject keyword but names the OPPOSITE (or no) verdict.
    assert.equal(parse("Don't accept this, the report is wrong"), null);
    assert.equal(parse("cannot accept"), null);
    assert.equal(parse("do not reject"), null);
    // Ordinary free text carries no verdict either.
    assert.equal(parse("accept"), null);
    assert.equal(parse("fail"), null);
    assert.equal(parse("Looks good, ship it"), null);
    assert.equal(parse("Please redo the folders with different names"), null);
    assert.equal(parse(""), null);
    assert.equal(parse("   "), null);
  });

  test("a question without the canned options never yields a verdict", () => {
    assert.equal(M.parseManualReviewVerdict("Accept the manual worker's report.", []), null);
    assert.equal(M.parseManualReviewVerdict("Accept the manual worker's report.", undefined), null);
  });

  console.log(`\n${passed} manual review contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
