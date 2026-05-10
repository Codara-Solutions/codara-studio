// Hidden gate 03: the agent's regression test actually passes when run
// against the agent's final repo via Node's built-in test runner.
//
// This is the dynamic confirmation that gate 02's static check didn't
// hallucinate — the test runs, and it green-lights the fix. We use the
// same command the public gate uses, so a passing public gate implies
// this hidden gate passes too. We still run it explicitly because public
// gates can be silently disabled / no-judge'd.

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_PATH = "tests/openrouter-error-classifier.test.ts";

module.exports = {
  id: "03-test-passes-after-fix",
  description:
    "node --test --experimental-strip-types tests/openrouter-error-classifier.test.ts exits 0 in the final repo",
  async run({ finalRepoPath }) {
    const res = spawnSync(
      "node",
      ["--test", "--experimental-strip-types", TEST_PATH],
      {
        cwd: finalRepoPath,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    if (res.error) {
      return {
        ok: false,
        message: `node --test failed to spawn: ${res.error.message}`,
      };
    }
    if (res.status !== 0) {
      const tail = (res.stdout || "").split(/\r?\n/).slice(-20).join("\n");
      const errTail = (res.stderr || "").split(/\r?\n/).slice(-10).join("\n");
      return {
        ok: false,
        message: `node --test exited ${res.status}. stdout tail:\n${tail}\nstderr tail:\n${errTail}`,
      };
    }
    return { ok: true, message: `node --test ${TEST_PATH} exited 0` };
  },
};
