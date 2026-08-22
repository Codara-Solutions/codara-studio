#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");

function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  loaded._compile(output, resolved);
  return loaded.exports;
}

const diffModule = loadTypeScriptModule(
  path.join(ROOT, "src/renderer/src/components/chat/tool-file-diff.ts"),
);
const { MAX_TOOL_DIFF_LINES, toolFileDiff } = diffModule;

assert.deepEqual(
  toolFileDiff("edit", {
    path: "src/example.ts",
    oldText: "const before = 1;\nconst removed = true;\n",
    newText: "const after = 2;\n",
  }),
  {
    path: "src/example.ts",
    additions: 1,
    deletions: 2,
    lines: [
      { kind: "del", text: "const before = 1;" },
      { kind: "del", text: "const removed = true;" },
      { kind: "add", text: "const after = 2;" },
    ],
    truncated: false,
  },
);

const jsonEdits = toolFileDiff("mcp__pi__multi_edit", {
  path: "README.md",
  edits: JSON.stringify([
    { oldText: "old", newText: "new" },
    { oldText: "", newText: "extra" },
  ]),
});
assert.equal(jsonEdits?.additions, 2);
assert.equal(jsonEdits?.deletions, 1);
assert.equal(toolFileDiff("read", { path: "README.md" }), null);

const contextualEdit = toolFileDiff("edit", {
  path: "src/context.ts",
  edits: [{
    oldText: "unchanged header\nconst value = 1;\nunchanged footer",
    newText: "unchanged header\nconst value = 2;\nunchanged footer",
  }],
});
assert.equal(contextualEdit?.deletions, 1, "matching context is not counted as deleted");
assert.equal(contextualEdit?.additions, 1, "matching context is not counted as added");

const largeWrite = toolFileDiff("write", {
  path: "generated.txt",
  content: Array.from(
    { length: MAX_TOOL_DIFF_LINES + 3 },
    (_, index) => `line ${index}`,
  ).join("\n"),
});
assert.equal(largeWrite?.additions, MAX_TOOL_DIFF_LINES + 3, "stats cover the full write");
assert.equal(largeWrite?.lines.length, MAX_TOOL_DIFF_LINES, "preview memory remains capped");
assert.equal(largeWrite?.truncated, true);

const conversationSource = fs.readFileSync(
  path.join(ROOT, "src/renderer/src/components/chat/ChatConversation.tsx"),
  "utf8",
);
assert.match(
  conversationSource,
  /const appliedFileDiff = finished && !failed \? fileDiff : null/,
  "failed and in-flight edits must not render as applied changes",
);
assert.doesNotMatch(conversationSource, /function ToolCluster\(/);
assert.doesNotMatch(conversationSource, /TOOL_CLUSTER_TOGGLE_STYLE/);
assert.match(
  conversationSource,
  /segments\.push\(\{ kind: "tool", id: block\.id, call: block \}\)/,
  "each provider tool event remains its own ordered transcript segment",
);

const panelSource = fs.readFileSync(
  path.join(ROOT, "src/renderer/src/components/chat/ChatPanel.tsx"),
  "utf8",
);
assert.match(panelSource, /\}, \[run\.id\]\);/);
assert.doesNotMatch(panelSource, /Measured OpenRouter cost for this chat/);
assert.match(panelSource, /Estimated OpenRouter usage for this chat/);

const inspectorSource = fs.readFileSync(
  path.join(ROOT, "src/renderer/src/components/SessionInspector.tsx"),
  "utf8",
);
assert.match(inspectorSource, /isOpenRouterModelId\(call\.model\)/);
assert.match(inspectorSource, /OpenRouter USD/);

console.log("chat tool transcript, edit preview, and live cost UI: all assertions passed");
