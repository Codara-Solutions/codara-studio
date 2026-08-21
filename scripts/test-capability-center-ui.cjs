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
const settings = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "src",
    "renderer",
    "src",
    "components",
    "SettingsDialog.tsx",
  ),
  "utf8",
);
const composer = fs.readFileSync(
  path.join(__dirname, "..", "src", "renderer", "src", "components", "chat", "ChatComposer.tsx"),
  "utf8",
);
const sidebar = fs.readFileSync(
  path.join(__dirname, "..", "src", "renderer", "src", "components", "OrchestrationSidebar.tsx"),
  "utf8",
);
const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload", "index.ts"), "utf8");
const agentSync = fs.readFileSync(path.join(__dirname, "..", "src", "main", "agent-sync.ts"), "utf8");

// Worker routing is a Cora capability, not an API/model preference. Keep the
// editor and its persisted AppSettings draft in this dialog only.
assert.match(source, /\{ id: "workers", label: "Worker models" \}/);
assert.match(source, /renderedTab === "workers"/);
assert.match(source, /aria-label="Cora worker models"/);
assert.match(source, /setDraft\(\(current\) => \{/);
assert.doesNotMatch(settings, /Cora worker models/);

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

// The Server column is the only flexible MCP_GRID track, so rowNameStyle stays
// a nowrap + ellipsis line. That is fine for the name and fatal for a badge:
// the `built in` accent badge used to sit there and was sliced in half.
assert.match(
  source,
  /const rowNameStyle: React\.CSSProperties = \{[\s\S]*?whiteSpace: "nowrap",\n\};/,
);
assert.match(
  source,
  /<div style=\{rowNameStyle\} title="Codara Studio tools">\s*\n\s*Codara Studio tools\s*\n\s*<\/div>/,
);
// It now rides the wrapping meta row next to the tool count, which is the same
// place McpRow parks its own badges for exactly this reason.
assert.match(
  source,
  /<span style=\{rowScopeStyle\}>\{builtin\.name\}<\/span>\s*\n\s*<span className="spark-badge is-accent" style=\{flagBadgeStyle\}>\s*\n\s*built in\s*\n\s*<\/span>\s*\n\s*<span className="spark-badge" style=\{flagBadgeStyle\} title=\{builtin\.tools\.join\(", "\)\}>/,
);

// The CLI columns name the external tools the way the user does, and the copy
// action still routes through installAsset via onInstall.
assert.match(source, /const CLI_LABEL: Record<"claude" \| "codex" \| "grok", string>/);
assert.match(source, /onInstall\(group, runtime\)/);

// Grok Build is a real copy target: the Grok column renders the same CliCell
// the Claude and Codex columns do, not a hardcoded em dash, and the whole
// install path carries "grok" from the row down to the preload bridge.
assert.match(source, /<CliCell group=\{group\} runtime="claude" busyKey=\{busyKey\} onInstall=\{onInstall\} \/>/);
assert.match(source, /<CliCell group=\{group\} runtime="codex" busyKey=\{busyKey\} onInstall=\{onInstall\} \/>/);
assert.match(source, /<CliCell group=\{group\} runtime="grok" busyKey=\{busyKey\} onInstall=\{onInstall\} \/>/);
assert.doesNotMatch(source, /Third-party MCP copy into Grok Build is not available yet/);
assert.doesNotMatch(source, /label="Grok Build"/);
assert.match(source, /runtime: "claude" \| "codex" \| "grok";/);
assert.match(
  source,
  /const installToRuntime = \(group: NameGroup, target: "claude" \| "codex" \| "grok"\) =>/,
);
assert.match(preload, /installAsset: \(id: string, target: "claude" \| "codex" \| "grok"\)/);
assert.match(agentSync, /target: "claude" \| "codex" \| "grok";\n\}\): Promise<AgentAssetInstallResult>/);
// Grok discovery reads the same user-scope TOML mcp-installer writes into.
assert.match(agentSync, /\{ runtime: "grok", scope: "user", path: join\(home, "\.grok", "config\.toml"\) \}/);

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

// A profile is chosen where a new conversation starts and then frozen onto
// that run. The Capability Center remains the editor, not the only selector.
assert.match(source, /Every new chat also has a profile picker/);
assert.match(source, /description: profileDescription\.trim\(\) \|\| undefined/);
assert.match(composer, /<ProfilePicker/);
assert.match(composer, /profileId: latestDraft\?\.profileId \?\? draftCoraProfileId/);
assert.match(sidebar, /coraProfileId: chatConfig\?\.profileId/);

console.log(
  "PASS Capability Center separates Codara access from external CLI configuration",
);
