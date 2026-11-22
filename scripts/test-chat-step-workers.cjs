#!/usr/bin/env node
"use strict";

// Step cards and their worker rows in the Cora chat.
//
//   node scripts/test-chat-step-workers.cjs
//
// Pinned:
//   - A live step starts open and folds only on its live -> settled edge, and
//     never after the user toggled it.
//   - A worker that launched is one button that goes inside it, by its
//     logical id; no "Open terminal" in Cora. Main stays mounted under it.
//   - The callback reaches rows through a context, so memoized step cards
//     are not re-rendered by a new prop.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
const panel = read("src/renderer/src/components/chat/ChatPanel.tsx");

// A direct chat's pass is Cora's own turn, never a step card (DESIGN.md,
// "Direct chats"); every other step keeps the card below.
assert.match(
  conversation,
  /const StepCard = React\.memo\(function StepCard\(\{ item \}: \{ item: StepItem \}\) \{[\s\S]{0,200}?if \(item\.direct\) \{[\s\S]{0,120}?<DirectTurnWork item=\{item\} runId=\{item\.direct\.runId\} \/>[\s\S]{0,80}?\}\s*return <ManagedStepCard item=\{item\} \/>;/,
);
const stepCard = conversation.match(/const ManagedStepCard = React\.memo\(function ManagedStepCard[\s\S]*?\n\}\);/);
assert.ok(stepCard, "ManagedStepCard not found");
assert.match(stepCard[0], /const \[open, setOpen\] = useState\(live\);/);
assert.match(
  stepCard[0],
  /if \(wasLiveRef\.current && !live && !toggledRef\.current\) setOpen\(false\);\s*wasLiveRef\.current = live;\s*\}, \[live\]\);/,
);
assert.match(stepCard[0], /toggledRef\.current = true;\s*setOpen\(\(value\) => !value\);/);

const row = conversation.match(/function StepWorkerRow\([\s\S]*?\n\}\n/);
assert.ok(row, "StepWorkerRow not found");
// The row goes inside the worker (option A, DESIGN.md): the whole row is one
// button carrying the logical worker id, and Cora offers no terminal button.
assert.match(row[0], /const openWorker = React\.useContext\(WorkerOpenContext\);/);
assert.match(row[0], /const canOpen = Boolean\(openWorker && worker\.attemptId\);/);
assert.match(row[0], /<button\s+type="button"\s+className="cora-step-worker-open"\s+data-worker-row=\{worker\.id\}/);
assert.match(row[0], /onClick=\{\(\) => openWorker\?\.\(worker\.id\)\}/);
assert.doesNotMatch(row[0], /Open terminal/);
assert.doesNotMatch(conversation, /WorkerTerminalContext/);

assert.match(conversation, /<WorkerOpenContext\.Provider value=\{onOpenWorker \?\? null\}>/);
assert.match(panel, /<ChatConversation[\s\S]*?onOpenWorker=\{setInsideWorker\}/);
// Main stays mounted, hidden and out of the tab order, under the worker view.
assert.match(panel, /visibility: chatView === "chat" && !inside \? undefined : "hidden"/);
assert.match(panel, /\{ inert: "" \}/);
assert.match(panel, /const WorkerView = lazy\(\(\) => import\("\.\/WorkerView"\)\);/);

console.log("chat step workers: ok");
