// Hidden gate 01: the linter handles CRLF line endings.
//
// The seed parser splits raw markdown on `\n`, which leaves a trailing
// `\r` on every line in CRLF-authored files. Several rules use regex
// anchored at end-of-line (`...$`) and silently miss matches when the
// last character is `\r` instead of the expected token. The user's docs
// are CRLF on purpose (pinned via .gitattributes), so on the real input
// the rules were no-ops.
//
// We probe two rules that are sensitive to this — bare-link and
// trailing-whitespace — by feeding the agent's lint module a small
// CRLF source containing violations of each. Both rules must fire.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CRLF_FIXTURE =
  "---\r\n" +
  "title: Probe\r\n" +
  "---\r\n" +
  "\r\n" +
  "# Heading\r\n" +
  "\r\n" +
  "A line with trailing whitespace.   \r\n" +
  "See https://example.com/docs\r\n";

module.exports = {
  id: "01-crlf-line-endings",
  description:
    "lint module flags trailing-whitespace and bare-link violations on CRLF input",
  async run({ finalRepoPath }) {
    const lintEntry = path.join(
      finalRepoPath,
      "vendor",
      "markdown-linter",
      "src",
      "lint.js",
    );
    if (!fs.existsSync(lintEntry)) {
      return {
        ok: false,
        message: `expected lint module at ${lintEntry}, not found`,
      };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdlint-gate-01-"));
    const fixture = path.join(tmpDir, "crlf.md");
    fs.writeFileSync(fixture, CRLF_FIXTURE);

    let mod;
    try {
      mod = await import(pathToFileURL(lintEntry).href);
    } catch (err) {
      return {
        ok: false,
        message: `failed to import lint module: ${err.message}`,
      };
    }

    const lintFn = mod.lintString || mod.lintFile;
    if (typeof lintFn !== "function") {
      return {
        ok: false,
        message:
          "lint.js does not export lintString or lintFile (the eval relies on at least one of these)",
      };
    }

    let issues;
    try {
      issues = mod.lintString
        ? mod.lintString(CRLF_FIXTURE)
        : mod.lintFile(fixture);
    } catch (err) {
      return {
        ok: false,
        message: `lint threw on CRLF input: ${err.message}`,
      };
    }

    if (!Array.isArray(issues)) {
      return {
        ok: false,
        message: `lint returned non-array (${typeof issues})`,
      };
    }

    const ruleIds = new Set(issues.map((i) => i && i.rule).filter(Boolean));
    const sawTrailing = ruleIds.has("trailing-whitespace");
    const sawBare = ruleIds.has("bare-link");

    if (!sawTrailing && !sawBare) {
      return {
        ok: false,
        message: `no CRLF-sensitive rules fired (trailing-whitespace, bare-link). saw rules: ${[...ruleIds].join(", ") || "(none)"}`,
      };
    }
    if (!sawTrailing) {
      return {
        ok: false,
        message: `bare-link fired but trailing-whitespace did not — line "A line with trailing whitespace.   " (CRLF) was missed`,
      };
    }
    if (!sawBare) {
      return {
        ok: false,
        message: `trailing-whitespace fired but bare-link did not — line "See https://example.com/docs" (CRLF) was missed`,
      };
    }
    return {
      ok: true,
      message:
        "trailing-whitespace and bare-link both fired on CRLF probe input",
    };
  },
};
