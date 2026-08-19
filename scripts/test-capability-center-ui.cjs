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
    "AgentCapabilitiesDialog.tsx",
  ),
  "utf8",
);

// The point of this file: what an agent inside Codara may use is a different
// question from which external CLI config carries the entry, and the dialog has
// to keep asking them separately. The columns are now where that separation
// lives — Cora/Workers are Codara-side, Claude/Codex report the CLI configs.
assert.match(source, /labels=\{\["Server", "Cora", "Workers", "Claude", "Codex", "Grok", ""\]\}/);
assert.match(source, /labels=\{\["Skill", "Enabled", "Claude", "Codex", ""\]\}/);
// Header and rows must share one grid template or the columns stop aligning.
assert.match(source, /const MCP_GRID = /);
assert.match(source, /const SKILL_GRID = /);
assert.match(source, /gridTemplateColumns: MCP_GRID/);
assert.match(source, /gridTemplateColumns: SKILL_GRID/);
assert.match(source, /template=\{MCP_GRID\}/);
assert.match(source, /template=\{SKILL_GRID\}/);

// The built-in server keeps its own row and its own install controls.
assert.match(source, /Codara Studio tools/);
assert.match(source, /Set up by you/);

// The CLI columns name the external tools the way the user does, and the copy
// action still routes through installAsset via onInstall.
assert.match(source, /const CLI_LABEL: Record<"claude" \| "codex" \| "grok", string>/);
assert.match(source, /onInstall\(group, runtime\)/);

// Retired vocabulary must not come back: the boxed clusters, the badge strip,
// and the jargon the user could not read.
assert.doesNotMatch(source, /ControlCluster/);
assert.doesNotMatch(source, /External CLI configs/);
assert.doesNotMatch(source, /RuntimeStrip/);
assert.doesNotMatch(source, /external configs auto-managed/);
assert.doesNotMatch(source, /In Claude \+ Codex/);
assert.doesNotMatch(source, /Share to \$\{RUNTIME_LABEL\[rt\]\}/);
assert.doesNotMatch(source, /label="Uninstall"/);

// Regressions found in adversarial review of the tabbed layout.
// 1. A nav click must not dismiss the form while its save is in flight.
assert.match(source, /if \(editorBusy\) return;/);
// 2. A save that fails after the form closed reports in the footer instead.
assert.match(source, /if \(editorRef\.current\) setEditorError\(message\);/);
// 3. The MCP nav count includes the pinned built-in rows the pane renders.
assert.match(source, /mcpGroups\.length \+ \(builtins\?\.length \?\? 0\)/);
// 4. The footer never claims memory edits are waiting for Save.
assert.match(source, /Memory changes apply immediately\./);
// 5. A per-row result does not follow the user to an unrelated section. Anchored
//    on the tab onClick body so it cannot be satisfied by the other setStatus
//    calls (sync, memory actions, remove).
assert.match(
  source,
  /if \(editorBusy\) return;[\s\S]{0,300}?setStatus\(null\);\s*\n\s*setEditor\(null\);\s*\n\s*setActiveTab\(tab\.id\);/,
);

console.log(
  "PASS Capability Center separates Codara access from external CLI configuration",
);
