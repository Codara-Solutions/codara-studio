"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const profile = JSON.parse(
  fs.readFileSync(path.join(root, "resources", "orchestration", "manager-profile.json"), "utf8"),
).workerPrompt;
const renderer = fs.readFileSync(
  path.join(root, "src", "main", "orchestration", "worker-prompt.ts"),
  "utf8",
);

const implementationChars = profile.opening.join("\n").length;
const verifierChars = profile.verifierOpening.join("\n").length;
assert.ok(implementationChars <= 2_500, `implementation preamble is ${implementationChars} chars`);
assert.ok(verifierChars <= 2_500, `verifier preamble is ${verifierChars} chars`);
assert.match(renderer, /offline\|no web\|without web/);
assert.match(renderer, /web research\|search the web/);
assert.doesNotMatch(
  profile.verifierOpening.join("\n"),
  /SYNTHESIZE 3|at most 12 custom probe|20 minutes|200-400 words/,
);

console.log(
  `PASS worker prompt budgets: implementation ${implementationChars} chars, verifier ${verifierChars} chars`,
);
