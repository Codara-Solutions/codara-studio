#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "src",
    "renderer",
    "src",
    "components",
    "CopyBranchDialogs.tsx",
  ),
  "utf8",
);

const dirtyMatcher = source.match(
  /const dirty = Boolean\(\s*error &&\s*\/(.+)\/i\.test\(error\),\s*\);/,
);
assert.ok(dirtyMatcher, "dialog must classify dirty worktree errors");
const isDirtyError = new RegExp(dirtyMatcher[1], "i");
const backendDirtyError =
  "Worktree has uncommitted changes. Use force removal to discard them.";

assert.match(
  backendDirtyError,
  isDirtyError,
  "exact backend dirty-worktree error must enable force removal",
);
assert.doesNotMatch(
  "Unable to remove worktree: permission denied",
  isDirtyError,
  "normal errors must not enable force removal",
);
assert.match(
  source,
  /Force removal discards uncommitted changes\./,
  "dirty state must explain the destructive consequence",
);
assert.match(
  source,
  /label=\{busy \? "Removing…" : "Force remove"\}[\s\S]{0,180}onClick=\{\(\) => onConfirm\(\{ deleteBranch, force: true \}\)\}/,
  "force action must preserve the branch checkbox choice",
);
assert.match(
  source,
  /label=\{busy \? "Removing…" : "Delete"\}[\s\S]{0,180}onClick=\{\(\) => onConfirm\(\{ deleteBranch, force: false \}\)\}/,
  "initial delete action must remain non-force",
);

console.log(
  "PASS worktree delete dialog handles the exact backend dirty-worktree error safely",
);
