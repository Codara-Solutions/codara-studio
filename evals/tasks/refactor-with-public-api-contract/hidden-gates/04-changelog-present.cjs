// Hidden gate 04: a CHANGELOG-eval.md exists at the repo root and
// documents the rename. The plan asks for both names to appear and a
// short rationale. We accept any prose containing both identifiers and
// at least one explanatory line of rationale beyond the name swap.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHANGELOG_PATH = "CHANGELOG-eval.md";

module.exports = {
  id: "04-changelog-present",
  description:
    "CHANGELOG-eval.md exists at the repo root and mentions both the old and new names",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, CHANGELOG_PATH);
    if (!fs.existsSync(abs)) {
      return { ok: false, message: `${CHANGELOG_PATH} missing` };
    }
    const text = fs.readFileSync(abs, "utf8");
    const hasOld = /\bloadSettings\b/.test(text);
    const hasNew = /\bgetAppSettings\b/.test(text);
    if (!hasOld || !hasNew) {
      return {
        ok: false,
        message: `changelog missing identifiers: hasLoadSettings=${hasOld} hasGetAppSettings=${hasNew}`,
      };
    }
    // Require at least 30 chars of explanatory prose beyond the names —
    // a one-line "loadSettings -> getAppSettings" doesn't count.
    const stripped = text.replace(/loadSettings|getAppSettings/g, "").replace(/[`*_#\->\s]+/g, " ").trim();
    if (stripped.length < 30) {
      return {
        ok: false,
        message: `changelog too sparse (only ${stripped.length} chars of prose) — add a one-line rationale`,
      };
    }
    return { ok: true, message: `${CHANGELOG_PATH} documents the rename` };
  },
};
