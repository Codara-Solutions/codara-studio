#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const extension = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "prompt.ts"),
);
const policies = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "shared", "cora-execution-policy.ts"),
);
process.env.SPARK_MCP_MODE = "talk";
const studioBridge = require(path.join(
  __dirname,
  "..",
  "resources",
  "codara-studio-mcp",
  "server.js",
));

const talk = extension.buildCoraPiSystemPrompt("talk");
const auto = extension.buildCoraPiSystemPrompt("auto");
const execute = extension.buildCoraPiSystemPrompt("execute");
const automation = extension.buildCoraPiSystemPrompt("automation");
const deep = extension.buildCoraPiSystemPrompt("execute", "deep");
const frontier = extension.buildCoraPiSystemPrompt("execute", "frontier");

assert.match(talk, /This is Talk mode/);
assert.match(talk, /do not claim that workers were spawned/);
assert.doesNotMatch(talk, /Call codara_complete/);
assert.match(auto, /This is Auto mode/);
assert.match(auto, /Do not spawn a\s+worker and do not call codara_complete/);
assert.match(auto, /at least one bounded worker/);
assert.match(auto, /Never call codara_complete merely to end a conversational turn/);
assert.match(execute, /This is Execute mode/);
assert.match(execute, /Call codara_complete only after/);
assert.match(execute, /Treat worker reports as claims/);
assert.match(automation, /This is Automation mode/);
assert.match(automation, /Do not spawn coding workers/);
assert.doesNotMatch(automation, /Call codara_complete/);
assert.match(deep, /Deep execution policy/);
assert.match(deep, /actively seek a counterexample/);
assert.match(frontier, /Frontier execution policy/);
assert.match(frontier, /content-addressed\s+exact-state artifact/);
assert.match(frontier, /falsify every changed\s+hunk/);
assert.match(execute, /codara_whiteboard_update/);
const studioToolNames = new Set(studioBridge.listTools().map((tool) => tool.name));
assert.equal(studioToolNames.has("codara_whiteboard_get"), true);
assert.equal(studioToolNames.has("codara_whiteboard_update"), true);
assert.equal(policies.normalizeCoraExecutionPolicy("deep"), "deep");
assert.equal(policies.normalizeCoraExecutionPolicy("frontier"), "frontier");
assert.equal(policies.normalizeCoraExecutionPolicy("invalid"), "fast");
// The picker is gone: the policy is derived in main from taskComplexity, so
// the shared module keeps normalization only.
assert.equal(policies.effectiveCoraExecutionPolicy, undefined);
assert.equal(policies.coraExecutionPolicyProfile, undefined);
assert.equal(policies.CORA_EXECUTION_POLICIES, undefined);

// The complexity contract is the manager's only channel into the tier now, so
// it must reach every orchestrating mode and must NOT leak into Talk.
assert.match(auto, /Task complexity contract/);
assert.match(execute, /Task complexity contract/);
assert.match(execute, /Set taskComplexity on codara_spawn_workers/);
assert.match(execute, /do not bid for budget/);
assert.doesNotMatch(talk, /Task complexity contract/);
assert.doesNotMatch(automation, /Task complexity contract/);

// The spawn tool must actually accept the classification the prompt demands.
// The roster is picked once at module load from SPARK_MCP_MODE, so re-require
// the bridge in execute mode to see the orchestration tools.
const studioBridgePath = path.join(
  __dirname,
  "..",
  "resources",
  "codara-studio-mcp",
  "server.js",
);
process.env.SPARK_MCP_MODE = "execute";
delete require.cache[require.resolve(studioBridgePath)];
const executeBridge = require(studioBridgePath);
const spawnTool = executeBridge.listTools().find((tool) => tool.name === "codara_spawn_workers");
assert.ok(spawnTool, "codara_spawn_workers is not exposed in execute mode");
assert.deepEqual(spawnTool.inputSchema.properties.taskComplexity.enum, [
  "trivial",
  "standard",
  "complex",
]);

console.log("pi Cora mode + execution-policy prompts: ok");
