// Hidden gate 03: every known main-process caller imports and calls the
// new name `getAppSettings`. The known callers are enumerated below
// based on the seed snapshot. If a future caller is added before we
// re-pin, this gate may need updating — but as of the seed commit
// these are the two files that import `loadSettings` from `./storage`
// (and `../storage` from the orchestration tree).

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KNOWN_CALLER_PATHS = [
  "src/main/ipc.ts",
  "src/main/orchestration/run-store.ts",
];

module.exports = {
  id: "03-callers-updated",
  description:
    "every known caller imports `getAppSettings` from storage and uses it (no surviving `loadSettings`)",
  async run({ finalRepoPath }) {
    const failures = [];
    for (const rel of KNOWN_CALLER_PATHS) {
      const abs = path.join(finalRepoPath, rel);
      if (!fs.existsSync(abs)) {
        failures.push(`${rel} missing — agent removed an expected caller file?`);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      // The caller must import getAppSettings from a relative storage path.
      // We accept either `./storage` or `../storage` (varies by depth).
      const importRx = /import\s*\{[^}]*\bgetAppSettings\b[^}]*\}\s*from\s*['"]\.{1,2}\/(?:[^'"]*\/)?storage['"]/;
      if (!importRx.test(text)) {
        failures.push(`${rel}: missing import { getAppSettings } from "...storage"`);
      }
      // The caller must invoke the new name at least once.
      if (!/\bgetAppSettings\s*\(\s*\)/.test(text)) {
        failures.push(`${rel}: no getAppSettings() invocation`);
      }
      // Belt-and-suspenders: confirm the old name has been scrubbed too.
      if (/\bloadSettings\b/.test(text)) {
        failures.push(`${rel}: surviving \`loadSettings\` reference`);
      }
    }
    if (failures.length) {
      return { ok: false, message: failures.join("; ") };
    }
    return {
      ok: true,
      message: `${KNOWN_CALLER_PATHS.length} known callers updated cleanly`,
    };
  },
};
