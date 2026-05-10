// Hidden gate 01: the agent wrote a regression test at the expected path
// and the test file references the function under test.
//
// We don't yet require the test to be runnable here — gate 03 covers that.
// This gate just confirms the basic deliverable shape: a file at the path
// the plan requested, mentioning the classifier the plan describes.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEST_PATH = "tests/openrouter-error-classifier.test.ts";

module.exports = {
  id: "01-regression-test-exists",
  description:
    "regression test file exists at the expected path and references the classifier",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, TEST_PATH);
    if (!fs.existsSync(abs)) {
      return {
        ok: false,
        message: `regression test not found at ${TEST_PATH}`,
      };
    }
    const text = fs.readFileSync(abs, "utf8");
    if (!/isStructuredOutputUnsupportedError/.test(text)) {
      return {
        ok: false,
        message:
          "test file does not reference isStructuredOutputUnsupportedError — the function the plan describes",
      };
    }
    if (!/node:test/.test(text) && !/from\s+['"]node:test['"]/.test(text)) {
      return {
        ok: false,
        message: "test file does not import node:test (the plan requires it)",
      };
    }
    return {
      ok: true,
      message: `${TEST_PATH} present and references the classifier under test`,
    };
  },
};
