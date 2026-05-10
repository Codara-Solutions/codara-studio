// Hidden gate 02: the regression test contains an assertion targeting
// the missing case (json_schema + not-support without `response_format`),
// such that running it against the un-fixed seed source would have failed.
//
// We do this statically: parse the test file's text and confirm at least
// one literal string near a true-asserting `equal` / `ok` / `strictEqual`
// call contains both `json_schema` and a "not support" / "doesn't
// support" / "unsupported" hint AND does NOT contain `response_format`.
//
// Static-only check. Cheap, deterministic, no compilation needed.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEST_PATH = "tests/openrouter-error-classifier.test.ts";

// Match string literals: 'foo', "foo", `foo` (backticks may include
// embedded ${} which we don't try to evaluate — the matcher trims).
const STRING_LITERAL = /['"`]([^'"`\n]+)['"`]/g;

// We accept either a json_schema-mentioning literal that appears inside
// a true-asserting call, or a json_schema-mentioning literal whose nearby
// (next ~80 chars) context includes a true-assertion of any flavor.
const TRUE_ASSERT = /(equal|strictEqual|deepEqual|ok)\s*\(\s*[^)]*?\b(true|isStructuredOutputUnsupportedError\s*\([^)]*\))[^)]*\)/g;

function looksLikeNotSupport(s) {
  const lower = s.toLowerCase();
  return (
    lower.includes("not support") ||
    lower.includes("doesn't support") ||
    lower.includes("does not support") ||
    lower.includes("unsupported")
  );
}

module.exports = {
  id: "02-test-targets-bug-case",
  description:
    "regression test contains an assertion that would fail on the seed (json_schema + not-support, without response_format)",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, TEST_PATH);
    if (!fs.existsSync(abs)) {
      return { ok: false, message: `test file missing: ${TEST_PATH}` };
    }
    const text = fs.readFileSync(abs, "utf8");

    // Collect every string literal in the file with its index.
    const literals = [];
    let m;
    STRING_LITERAL.lastIndex = 0;
    while ((m = STRING_LITERAL.exec(text)) !== null) {
      literals.push({ value: m[1], index: m.index });
    }

    const candidates = literals.filter((l) => {
      const v = l.value.toLowerCase();
      const hasJsonSchema = v.includes("json_schema");
      const hasNotSupport = looksLikeNotSupport(v);
      const hasResponseFormat = v.includes("response_format");
      // Targeted case: json_schema + a not-support hint, WITHOUT relying
      // on response_format. The seed fix would have caught
      // "response_format ... not support" already (gate 02 of the seed
      // version's existing two branches), so the discriminating literal
      // is one that mentions json_schema but not response_format.
      return hasJsonSchema && hasNotSupport && !hasResponseFormat;
    });

    if (candidates.length === 0) {
      return {
        ok: false,
        message:
          "no test literal targets the seed bug (need a string mentioning json_schema and a not-support hint, without response_format).",
      };
    }

    // Make sure at least one candidate sits inside an assertion that
    // expects the classifier to return TRUE. We approximate by checking
    // that the literal occurs within ~200 chars of a true-asserting call.
    const asserts = [];
    TRUE_ASSERT.lastIndex = 0;
    while ((m = TRUE_ASSERT.exec(text)) !== null) {
      asserts.push({ start: m.index, end: m.index + m[0].length });
    }
    if (asserts.length === 0) {
      return {
        ok: false,
        message:
          "test file has a json_schema/not-support literal but no true-asserting call (assert.equal(..., true) or assert.ok / strictEqual).",
      };
    }
    const hasNearby = candidates.some((c) =>
      asserts.some((a) => Math.abs(c.index - a.start) < 200),
    );
    if (!hasNearby) {
      return {
        ok: false,
        message:
          "json_schema/not-support literal exists but is not adjacent to a true-asserting call.",
      };
    }
    return {
      ok: true,
      message: `${candidates.length} literal(s) target the seed regression case`,
    };
  },
};
