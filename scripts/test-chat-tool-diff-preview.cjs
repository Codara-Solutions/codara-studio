#!/usr/bin/env node
"use strict";

// The changed-lines preview under Cora's own edit/write rows.
//
//   node scripts/test-chat-tool-diff-preview.cjs
//
// Clicking the path used to open the working-tree diff, which shows what the
// file holds now (empty once staged or committed, mixed with later edits),
// not what this call changed. The path now expands this call's change in
// place; the working-tree diff is a separate, labelled action.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const conversation = fs.readFileSync(
  path.join(ROOT, "src/renderer/src/components/chat/ChatConversation.tsx"),
  "utf8",
);

const preview = conversation.match(/function ToolFileDiffPreview\([\s\S]*?\n\}\n/);
assert.ok(preview, "ToolFileDiffPreview not found");
const body = preview[0];
assert.match(conversation, /const TOOL_DIFF_EXPANDED_LINES = 400;/);
assert.match(
  body,
  /change\.lines\.slice\(0, expanded \? TOOL_DIFF_EXPANDED_LINES : TOOL_DIFF_PREVIEW_LINES\)/,
);
assert.match(body, /if \(expandable\) setExpanded\(\(value\) => !value\);/);
// The working-tree diff is still reachable, but only as its own action.
const openDiff = body.match(/spark:open-diff/g) ?? [];
assert.equal(openDiff.length, 1);
assert.match(body, /title=\{`Open the current working-tree diff of \$\{change\.path\}`\}[\s\S]*?Working tree/);

// Worker rows still open the working tree; their tooltip says so.
assert.match(
  conversation,
  /title=\{`Open the current working-tree diff of \$\{file\.path\} \(it can include changes made after this worker\)`\}/,
);

console.log("chat tool diff preview: ok");
