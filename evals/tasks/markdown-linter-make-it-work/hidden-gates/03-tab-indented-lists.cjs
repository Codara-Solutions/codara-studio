// Hidden gate 03: the linter recognizes tab-indented list items.
//
// The seed `list-indent` rule's regex is `^( *)([-*+]) ` — leading
// whitespace must be SPACES. The user's docs use tabs, so on the real
// input the rule never sees a list item and silently no-ops on every
// list (including ones with bad mixed indentation that should fire).
//
// We probe via the agent's CLI: write a probe markdown file containing
// a tab-indented list with one obviously-broken item (mixed tab + space
// indentation that no reasonable indent scheme accepts), run the CLI
// against the file, and assert that at least one `list-indent` issue
// fires.
//
// We also accept the rule firing on the consistent items (e.g. agent
// chose "tab indent is always odd → flag every tab"), since the user's
// complaint was about silent no-ops, not specific verdicts.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TAB_FIXTURE =
  '---\n' +
  'title: Tab Probe\n' +
  '---\n' +
  '\n' +
  '# Heading\n' +
  '\n' +
  'Steps:\n' +
  '\n' +
  '\t- first\n' +
  '\t \t- mixed tab+space+tab indent\n' +
  '\t- third\n';

module.exports = {
  id: "03-tab-indented-lists",
  description:
    "list-indent rule recognizes tab-indented items (fires on mixed tab+space indent rather than silently skipping every tab line)",
  async run({ finalRepoPath }) {
    const cliPath = path.join(
      finalRepoPath,
      "vendor",
      "markdown-linter",
      "src",
      "cli.js",
    );
    if (!fs.existsSync(cliPath)) {
      return {
        ok: false,
        message: `expected CLI at ${cliPath}, not found`,
      };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdlint-gate-03-"));
    const fixture = path.join(tmpDir, "tabs.md");
    fs.writeFileSync(fixture, TAB_FIXTURE);

    const res = spawnSync("node", [cliPath, fixture], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });

    if (res.error) {
      return {
        ok: false,
        message: `node spawn failed: ${res.error.message}`,
      };
    }

    if (res.status === 2) {
      return {
        ok: false,
        message: `CLI exited with usage-error status 2: ${res.stderr || res.stdout}`,
      };
    }

    const stdout = (res.stdout || "").trim();
    const sawListIndent = /\[list-indent\]/.test(stdout);
    if (!sawListIndent) {
      const tail = stdout.split(/\r?\n/).slice(-15).join("\n");
      return {
        ok: false,
        message: `list-indent rule never fired on tab-indented probe (rule still skips tab-prefixed lines silently). stdout tail:\n${tail || "(empty)"}`,
      };
    }
    return {
      ok: true,
      message:
        "list-indent rule fired on a tab-indented probe (rule no longer silently skips tab-prefixed lines)",
    };
  },
};
