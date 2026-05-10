// Hidden gate 05: the regression test file does not skip / focus / .todo
// any of its tests. A test that reports green only because every case
// is `.skip` is a regression waiting to happen.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEST_PATH = "tests/openrouter-error-classifier.test.ts";

const FORBIDDEN = [
  /\btest\.skip\b/,
  /\btest\.only\b/,
  /\btest\.todo\b/,
  /\bit\.skip\b/,
  /\bit\.only\b/,
  /\bdescribe\.skip\b/,
  /\bdescribe\.only\b/,
  /\bxit\b/,
  /\bxdescribe\b/,
  /\{\s*skip\s*:\s*true\b/, // node:test inline-options form: test('foo', { skip: true }, ...)
  /\{\s*only\s*:\s*true\b/,
  /\{\s*todo\s*:\s*true\b/,
];

module.exports = {
  id: "05-no-test-skip",
  description:
    "regression test file contains no .skip / .only / .todo / xit / xdescribe markers",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, TEST_PATH);
    if (!fs.existsSync(abs)) {
      return { ok: false, message: `test file missing: ${TEST_PATH}` };
    }
    const text = fs.readFileSync(abs, "utf8");
    const hits = [];
    for (const rx of FORBIDDEN) {
      if (rx.test(text)) hits.push(String(rx));
    }
    if (hits.length) {
      return {
        ok: false,
        message: `test file contains forbidden skip/focus markers: ${hits.join(", ")}`,
      };
    }
    return { ok: true, message: "no skip/focus markers" };
  },
};
