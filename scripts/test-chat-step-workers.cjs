#!/usr/bin/env node
"use strict";

// Step cards and their worker rows in the Cora chat.
//
//   node scripts/test-chat-step-workers.cjs
//
// Pinned:
//   - A live step starts open and folds only on its live -> settled edge, and
//     never after the user toggled it.
//   - A worker with a live attempt offers "Open terminal", keyed by the
//     surviving task id (the row's own id is the chain root), and says so
//     when the pane is gone.
//   - The callback reaches rows through a context, so memoized step cards
//     are not re-rendered by a new prop.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
const panel = read("src/renderer/src/components/chat/ChatPanel.tsx");

const stepCard = conversation.match(/const StepCard = React\.memo\(function StepCard[\s\S]*?\n\}\);/);
assert.ok(stepCard, "StepCard not found");
assert.match(stepCard[0], /const \[open, setOpen\] = useState\(live\);/);
assert.match(
  stepCard[0],
  /if \(wasLiveRef\.current && !live && !toggledRef\.current\) setOpen\(false\);\s*wasLiveRef\.current = live;\s*\}, \[live\]\);/,
);
assert.match(stepCard[0], /toggledRef\.current = true;\s*setOpen\(\(value\) => !value\);/);

const row = conversation.match(/function StepWorkerRow\([\s\S]*?\n\}\n/);
assert.ok(row, "StepWorkerRow not found");
assert.match(row[0], /const openWorkerTerminal = React\.useContext\(WorkerTerminalContext\);/);
assert.match(
  row[0],
  /worker\.runtimeState !== undefined \|\| worker\.status === "claimed" \|\| worker\.status === "running"/,
);
assert.match(row[0], /if \(!openWorkerTerminal\(worker\.taskId\)\) setClosedTerminalKey\(terminalKey\);/);
// A retry or fallback (new task id or runtime state) must re-offer the pane
// instead of leaving the button disabled for the life of the row.
assert.match(row[0], /const terminalKey = `\$\{worker\.taskId \?\? ""\}:\$\{worker\.runtimeState \?\? ""\}`;/);
assert.match(row[0], /const terminalClosed = closedTerminalKey === terminalKey;/);
assert.match(row[0], /\{terminalClosed \? "Terminal closed" : "Open terminal"\}/);
assert.doesNotMatch(row[0], /openWorkerTerminal\(worker\.id\)/);

assert.match(
  conversation,
  /<WorkerTerminalContext\.Provider value=\{onOpenWorkerTerminal \?\? null\}>/,
);
assert.match(panel, /<ChatConversation[\s\S]*?onOpenWorkerTerminal=\{onOpenBoardWorkerTerminal\}/);

console.log("chat step workers: ok");
