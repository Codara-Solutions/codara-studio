// Hidden gate 01: the old name `loadSettings` is gone from src/main/.
//
// We grep across src/main/ for the literal identifier (word-boundaried so
// "applyInMemorySettingsOverride" et al. don't trigger). Any surviving
// occurrence — declaration, import, call, or comment — fails the gate.
//
// We deliberately do NOT scan src/renderer / src/preload / src/shared:
// the rename is main-process internal per the plan, and those trees are
// in forbiddenPaths. If the agent touched them anyway, separate task.json
// path enforcement catches it.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_REL = "src/main";
const OLD_NAME = "loadSettings";

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile() && /\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
      acc.push(p);
    }
  }
}

module.exports = {
  id: "01-old-name-removed",
  description:
    "no occurrences of `loadSettings` remain anywhere under src/main/ (declarations, imports, calls, or comments)",
  async run({ finalRepoPath }) {
    const root = path.join(finalRepoPath, ROOT_REL);
    const files = [];
    walk(root, files);
    const rx = new RegExp(`\\b${OLD_NAME}\\b`);
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (rx.test(line)) {
          offenders.push(`${path.relative(finalRepoPath, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    if (offenders.length) {
      return {
        ok: false,
        message: `${offenders.length} surviving \`${OLD_NAME}\` reference(s):\n  ${offenders.slice(0, 10).join("\n  ")}`,
      };
    }
    return { ok: true, message: `no \`${OLD_NAME}\` references in src/main/` };
  },
};
