#!/usr/bin/env node
"use strict";

// Composer behaviors that only show up in use: focus across a send, the @file
// index, stopping Cora, and dismissable errors.
//
//   node scripts/test-chat-composer-ux.cjs
//
// The invariants worth pinning:
//
//   - A send in flight makes the textarea readOnly, never disabled: disabling
//     a focused element blurs it, so focus ended on <body> after every send.
//     The first send of a draft remounts the composer, so focus is handed to
//     the next visible instance for the same workspace.
//   - The @file index comes from one main-process fs:listFiles walk (no 700
//     file renderer cap), is reused for 30s, and send only re-reads it for a
//     mention the index cannot answer. Enter while it loads never sends the
//     half-typed token.
//   - chat.stop (Mod+.) reaches only the visible composer, and only while its
//     run has something to stop. The button holds a pending state until the
//     stop lands.
//   - Errors can be dismissed and do not follow the user to another chat.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const composer = read("src/renderer/src/components/chat/ChatComposer.tsx");
const panel = read("src/renderer/src/components/chat/ChatPanel.tsx");
const sidebar = read("src/renderer/src/components/OrchestrationSidebar.tsx");
const commands = read("src/renderer/src/shortcuts/commands.ts");
const app = read("src/renderer/src/App.tsx");
const dismiss = read("src/renderer/src/components/chat/DismissErrorButton.tsx");

// ── Focus across a send ────────────────────────────────────────────────────
const textarea = composer.match(/<textarea\s+ref=\{textareaRef\}[\s\S]*?spellCheck=/);
assert.ok(textarea, "composer textarea not found");
assert.match(textarea[0], /disabled=\{disabled\}/);
assert.match(textarea[0], /readOnly=\{busy\}/);
assert.doesNotMatch(textarea[0], /disabled=\{disabled \|\| busy\}/);
assert.match(textarea[0], /aria-label="Message Cora"/);
assert.match(
  composer,
  /useLayoutEffect\(\(\) => \{\s*const node = textareaRef\.current;\s*return \(\) => \{\s*if \(node && document\.activeElement === node\) composerFocusHandoff = focusHandoffKey;/,
);
assert.match(
  composer,
  /if \(suspendGlobalEvents \|\| composerFocusHandoff !== focusHandoffKey\) return;\s*composerFocusHandoff = null;\s*textareaRef\.current\?\.focus\(/,
);

// ── @file index ────────────────────────────────────────────────────────────
const collect = composer.match(/async function collectWorkspaceFiles\([\s\S]*?\n\}/);
assert.ok(collect, "collectWorkspaceFiles not found");
assert.match(collect[0], /window\.spark\.fs\.listFiles\(cwd\)/);
assert.doesNotMatch(collect[0], /fs\.list\(/);
assert.doesNotMatch(composer, /MAX_FILE_SCAN_RESULTS|MAX_FILE_SCAN_DEPTH|SKIPPED_MENTION_DIRS/);
assert.match(composer, /const FILE_INDEX_TTL_MS = 30_000;/);
assert.match(composer, /Date\.now\(\) - current\.loadedAt < FILE_INDEX_TTL_MS/);
// Switching workspace drops the index along with the mention state.
assert.match(composer, /useEffect\(\(\) => \{\s*fileIndexRef\.current = null;\s*setFileReferences\(\[\]\);/);
// Send re-reads only for an unanswered mention, not for any "@".
assert.match(composer, /if \(cwd && unresolvedMentionTokens\(draft, mentionFiles\)\.length > 0\) \{/);
assert.doesNotMatch(composer, /if \(cwd && draft\.includes\("@"\)\)/);
// Enter/Tab while loading are swallowed before the send path sees them.
assert.match(
  composer,
  /if \(\(event\.key === "Enter" \|\| event\.key === "Tab"\) && filesLoading\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/,
);
// The capabilities button says what it opens.
assert.match(composer, /title="Tools & skills \(Capability Center\)"/);
assert.doesNotMatch(composer, /title="MCP and skills"/);

// ── Stop ───────────────────────────────────────────────────────────────────
assert.match(commands, /\| "chat\.stop"/);
assert.match(
  commands,
  /id: "chat\.stop",\s*label: "Stop Cora",\s*group: "Agent",\s*defaultChords: \[mod\("\."\)\],/,
);
// No other command may claim Mod+. by default.
assert.equal(commands.match(/mod\("\."\)/g).length, 1, "Mod+. is bound twice");
assert.match(
  app,
  /"chat\.stop": \(\) => \{\s*window\.dispatchEvent\(new CustomEvent\("spark:stop-chat"\)\);\s*\},/,
);
const stopListener = composer.match(
  /useEffect\(\(\) => \{\s*if \(suspendGlobalEvents\) return;\s*const onStop = [\s\S]*?\}, \[suspendGlobalEvents\]\);/,
);
assert.ok(stopListener, "spark:stop-chat listener must be gated on suspendGlobalEvents");
assert.match(stopListener[0], /if \(canStopRef\.current\) void stopRef\.current\(\);/);
assert.match(composer, /const canStop = isActive \|\| workerActivity\?\.state === "live";/);
assert.match(
  composer,
  /const stop = async \(\) => \{\s*if \(stopping\) return;\s*setStopping\(true\);\s*try \{\s*await onForcePauseRun\(\);\s*\} finally \{\s*if \(mountedRef\.current\) setStopping\(false\);/,
);
assert.match(composer, /\{canStop && <StopButton onClick=\{\(\) => void stop\(\)\} stopping=\{stopping\} \/>\}/);
assert.match(composer, /const STOP_HINT = chordToHint\(mod\("\."\)\);/);
assert.match(composer, /title=\{stopping \? "Stopping Cora…" : `Stop Cora \(\$\{STOP_HINT\}\)`\}/);
assert.match(composer, /onForcePauseRun: \(\) => void \| Promise<unknown>;/);
assert.match(panel, /onForcePauseRun: \(\) => void \| Promise<unknown>;/);
// The stop's promise reaches the button, so pending clears when it lands.
assert.match(sidebar, /const forcePauseRun = useCallback\(\(\) => \{\s*if \(!activeRun\) return;\s*return mutate\(/);

// ── Errors ─────────────────────────────────────────────────────────────────
assert.match(dismiss, /aria-label="Dismiss error"/);
assert.match(panel, /function ErrorBar\(\{ message, onDismiss \}/);
assert.match(panel, /role="alert"/);
assert.match(panel, /\{onDismiss \? <DismissErrorButton onClick=\{onDismiss\} \/> : null\}/);
assert.match(panel, /<ErrorBar message=\{error\} onDismiss=\{onDismissError\} \/>/);
assert.match(composer, /<DismissErrorButton onClick=\{\(\) => setError\(null\)\} \/>/);
assert.match(sidebar, /onDismissError=\{dismissError\}/);
assert.match(sidebar, /useEffect\(\(\) => \{\s*setError\(null\);\s*\}, \[activeRunId, creatingNewRun\]\);/);

console.log("chat composer ux: ok");
