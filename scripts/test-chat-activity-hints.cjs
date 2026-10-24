#!/usr/bin/env node
"use strict";

// What the conversation says about activity it is not showing.
//
//   node scripts/test-chat-activity-hints.cjs
//
// Pinned:
//   - The floating jump button says "New activity" only when rows or events
//     arrived after the reader left the bottom (history hydration does not count);
//     otherwise it is "Jump to latest".
//   - A live turn that produced nothing for 90s says so and names the Stop
//     chord, but never while a tool is in flight (wait_for_workers is silent
//     for as long as the workers take), nor while it waits on the user.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const conversation = fs.readFileSync(
  path.join(ROOT, "src/renderer/src/components/chat/ChatConversation.tsx"),
  "utf8",
);

assert.match(
  conversation,
  /const activityMark = execution\.hydrated \? `\$\{rowCount\}:\$\{execution\.events\.length\}` : null;/,
);
assert.match(
  conversation,
  /if \(readerAtBottom\) \{\s*leftBottomMarkRef\.current = null;\s*setNewActivity\(false\);\s*return;\s*\}\s*if \(activityMark === null\) return;\s*if \(leftBottomMarkRef\.current === null\) leftBottomMarkRef\.current = activityMark;\s*else if \(leftBottomMarkRef\.current !== activityMark\) setNewActivity\(true\);/,
);
assert.match(conversation, /aria-label=\{newActivity \? "New activity" : "Jump to latest"\}/);

const liveTurn = conversation.match(/function AssistantLiveTurn\([\s\S]*?\n\}\n/);
assert.ok(liveTurn, "AssistantLiveTurn not found");
assert.match(
  liveTurn[0],
  /const toolInFlight = blocks\.some\(\(block\) => block\.kind === "tool" && block\.output === undefined\);/,
);
assert.match(
  liveTurn[0],
  /\{!item\.awaitingReply && !compaction && !toolInFlight \? \(\s*<StallHint since=\{executionTurn\?\.lastEventAt \|\| item\.at\} \/>/,
);
assert.match(conversation, /const STALL_AFTER_MS = 90_000;/);
assert.match(conversation, /const STOP_CHORD_HINT = chordToHint\(mod\("\."\)\);/);
const stall = conversation.match(/function StallHint\([\s\S]*?\n\}\n/);
assert.ok(stall, "StallHint not found");
assert.match(stall[0], /now - last < STALL_AFTER_MS\) return null;/);
assert.match(stall[0], /stop Cora \(\{STOP_CHORD_HINT\}\)/);
// Esc is not the stop key; the hint must not teach it.
assert.doesNotMatch(stall[0], /Esc/);

console.log("chat activity hints: ok");
