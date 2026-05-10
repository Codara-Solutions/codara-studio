// Hidden gate 02: the linter recognizes TOML frontmatter.
//
// The seed parser only treats `---` as the frontmatter delimiter and
// parses the block as YAML. The user's docs use TOML (`+++` delimiters,
// `key = "value"` body), so the parser sees the frontmatter as content
// and `frontmatter-required` falsely fires "missing frontmatter" on
// every file.
//
// We probe by feeding the lint module a doc with valid TOML frontmatter
// declaring `title`. After a correct fix, the parser recognizes the TOML
// block, reads `title`, and `frontmatter-required` does NOT fire.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TOML_FIXTURE =
  '+++\n' +
  'title = "TOML Probe"\n' +
  'order = 7\n' +
  '+++\n' +
  '\n' +
  '# Heading\n' +
  '\n' +
  'Body paragraph.\n';

module.exports = {
  id: "02-toml-frontmatter",
  description:
    "lint module recognizes TOML frontmatter (+++ delimiters) and skips frontmatter-required when title is present",
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

    let mod;
    try {
      mod = await import(pathToFileURL(lintEntry).href);
    } catch (err) {
      return {
        ok: false,
        message: `failed to import lint module: ${err.message}`,
      };
    }

    if (typeof mod.lintString !== "function") {
      return {
        ok: false,
        message:
          "lint.js does not export lintString — the gate needs to feed it raw markdown",
      };
    }

    let issues;
    try {
      issues = mod.lintString(TOML_FIXTURE);
    } catch (err) {
      return {
        ok: false,
        message: `lint threw on TOML-frontmatter input: ${err.message}`,
      };
    }

    if (!Array.isArray(issues)) {
      return {
        ok: false,
        message: `lint returned non-array (${typeof issues})`,
      };
    }

    const fmIssues = issues.filter((i) => i && i.rule === "frontmatter-required");
    if (fmIssues.length > 0) {
      return {
        ok: false,
        message: `frontmatter-required fired on TOML-frontmatter input declaring title: ${fmIssues.map((i) => i.message).join("; ")}`,
      };
    }

    return {
      ok: true,
      message:
        "frontmatter-required did not fire on a TOML-frontmatter doc declaring `title`",
    };
  },
};
