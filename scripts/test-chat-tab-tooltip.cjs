#!/usr/bin/env node
"use strict";

// Chat tabs all read "Cora" on purpose (short first prompts made truncated
// labels), so the hover text is what tells parallel chats apart.
//
//   node scripts/test-chat-tab-tooltip.cjs
//
// Pinned: the label stays CHAT_TAB_LABEL, the tooltip carries the run title
// and status, the sync refreshes it in place, and TabBar shows it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const app = read("src/renderer/src/App.tsx");
const useTabs = read("src/renderer/src/tabs/useTabs.ts");
const types = read("src/renderer/src/tabs/types.ts");
const tabBar = read("src/renderer/src/tabs/TabBar.tsx");

assert.match(app, /const CHAT_TAB_LABEL = "Cora";/);
assert.match(
  app,
  /function chatTabTooltip\(run: RunState\): string \{\s*const title = run\.title\?\.trim\(\) \|\| CHAT_TAB_LABEL;\s*return `\$\{title\} · \$\{describeRunStatus\(run\)\.label\}`;/,
);
assert.match(
  app,
  /\.map\(\(run\) => \(\{ id: run\.id, title: CHAT_TAB_LABEL, tooltip: chatTabTooltip\(run\) \}\)\)/,
);

assert.match(types, /export interface ChatTab extends BaseTab \{\s*kind: "chat";[\s\S]*?tooltip\?: string;\s*\}/);
assert.match(useTabs, /syncChatTabsToRuns: \(runs: Array<\{ id: string; title: string; tooltip\?: string \}>\) => void;/);
// A status change alone must refresh the tooltip of an open tab.
assert.match(
  useTabs,
  /if \(!nextTitle \|\| \(nextTitle === tab\.title && nextTooltip === tab\.tooltip\)\) return tab;\s*changed = true;\s*return \{ \.\.\.tab, title: nextTitle, tooltip: nextTooltip \};/,
);
assert.match(useTabs, /additions\.push\(\{ \.\.\.createChatTabForRun\(run\.id, run\.title\), tooltip: run\.tooltip \}\);/);
assert.match(tabBar, /title=\{tab\.tooltip \?\? tab\.title\}/);

console.log("chat tab tooltip: ok");
