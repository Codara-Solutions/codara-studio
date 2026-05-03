// Hidden gate 03: `allowedPaths` containing `..` must NOT escape the
// worker root.
//
// The plan invariant (3) requires path normalization + validation against
// the workspace cwd. We exercise both representative escapes:
//   * "../etc/passwd"   — relative escape via parent traversal
//   * "/etc/passwd"     — absolute escape that isn't a child of cwd
//   * "C:\\Windows\\System32" — windows drive escape on win32
//   * "src/../../leak"  — embedded traversal that resolves outside cwd
// The normalizer must reject all of them. Inputs that resolve cleanly
// inside cwd (e.g. "src/main/foo") must still be accepted.

"use strict";

const path = require("node:path");
const { findExportedFunction } = require("./_lib.cjs");

const POSITIVE = ["src/main/pty-manager.ts", "src/", "tests/launcher.test.ts"];
const NEGATIVE = [
  "../etc/passwd",
  "..",
  "/etc/passwd",
  "../../leak",
  "src/../../leak",
];
if (process.platform === "win32") {
  NEGATIVE.push("C:\\Windows\\System32");
  NEGATIVE.push("\\\\server\\share\\evil");
}

module.exports = {
  id: "03-allowed-paths-traversal",
  description:
    "path normalizer rejects parent-traversal and absolute-outside-cwd inputs",
  async run({ finalRepoPath }) {
    const found = findExportedFunction(finalRepoPath, (name) =>
      /normalize.*Path|sanitize.*Path|resolveAllowedPath|validatePath|guardWorkspacePath/i.test(name),
    );
    if (!found) {
      return {
        ok: false,
        message:
          "No exported path normalizer found (expected normalizeAllowedPath / sanitizeWorkspacePath / similar). Plan invariant 3 was not implemented.",
      };
    }
    const cwd = finalRepoPath; // pretend the worker workspace is repo root.
    const failures = [];
    for (const input of POSITIVE) {
      let result;
      let threw = false;
      try {
        result = found.fn(input, cwd);
      } catch {
        threw = true;
      }
      if (threw || result === null || result === undefined || result === false) {
        failures.push(`positive case rejected: ${input}`);
      }
    }
    for (const input of NEGATIVE) {
      let rejected = false;
      try {
        const result = found.fn(input, cwd);
        // Two acceptable shapes for a rejection:
        //   * returns null/undefined/false
        //   * returns an object { ok: false }
        //   * throws
        if (result === null || result === undefined || result === false) rejected = true;
        else if (typeof result === "object" && result.ok === false) rejected = true;
      } catch {
        rejected = true;
      }
      if (!rejected) {
        failures.push(`adversarial path accepted: ${input}`);
      }
    }
    if (failures.length) {
      return {
        ok: false,
        message: failures.join("; "),
      };
    }
    return { ok: true, message: "all 5+ traversal vectors rejected" };
  },
};
