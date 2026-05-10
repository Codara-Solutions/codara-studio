// Hidden gate 04: the classifier's source restores the missing
// json_schema / not-support OR-branch.
//
// The seed had isStructuredOutputUnsupportedError() with two OR-branches:
//   * `no endpoints found` AND `requested parameters`
//   * `response_format`    AND `not support`
// The third branch — `json_schema` AND `not support` — was the
// regression. We confirm via source-text inspection that the agent
// added it back. We grep for both literals appearing in the same
// function body; this is structural, no compilation needed.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = "src/main/orchestration/openrouter-error-classifier.ts";

module.exports = {
  id: "04-fix-restores-branch",
  description:
    "isStructuredOutputUnsupportedError detects json_schema/not-support refusals",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, SOURCE_PATH);
    if (!fs.existsSync(abs)) {
      return { ok: false, message: `source file missing: ${SOURCE_PATH}` };
    }
    const text = fs.readFileSync(abs, "utf8");

    // Locate the function declaration (not just any mention — the name
    // can also appear at call sites and in comments).
    const decl = text.search(/export\s+function\s+isStructuredOutputUnsupportedError/);
    if (decl === -1) {
      return {
        ok: false,
        message:
          "no `export function isStructuredOutputUnsupportedError` declaration found (the agent moved or removed the function).",
      };
    }
    // Find the function body by scanning forward for the matching brace.
    const openBrace = text.indexOf("{", decl);
    if (openBrace === -1) {
      return { ok: false, message: "could not locate function body opening brace" };
    }
    let depth = 0;
    let close = -1;
    for (let i = openBrace; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      return { ok: false, message: "could not locate function body closing brace" };
    }
    const body = text.slice(openBrace, close + 1);

    // Confirm the json_schema and not-support tokens both appear inside
    // the function body. This is the structural fix.
    const hasJsonSchema = /json_schema/i.test(body);
    const hasNotSupport = /not\s+support|doesn't\s+support|does\s+not\s+support|unsupported/i.test(
      body,
    );
    if (!hasJsonSchema || !hasNotSupport) {
      return {
        ok: false,
        message: `classifier body missing json_schema=${hasJsonSchema} not-support=${hasNotSupport}`,
      };
    }
    // And confirm the existing branches survived.
    const hasNoEndpoints = /no\s+endpoints\s+found/i.test(body);
    const hasResponseFormat = /response_format/i.test(body);
    if (!hasNoEndpoints || !hasResponseFormat) {
      return {
        ok: false,
        message: `existing branches were dropped: noEndpoints=${hasNoEndpoints} responseFormat=${hasResponseFormat}`,
      };
    }
    return {
      ok: true,
      message: "all three classifier branches present in function body",
    };
  },
};
