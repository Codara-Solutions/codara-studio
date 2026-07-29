#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
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

// ── Worker policy (resources/pi-cora/worker-policy.ts): roster + fence ──────
// The pure policy behind worker.ts: which bridge tools a worker registers and
// which Pi tools the automation access fence vetoes.
const policy = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "worker-policy.ts"),
);

// Automation detection is the SPARK_AUTOMATION_ID stamp.
assert.equal(policy.isAutomationWorker({}), false);
assert.equal(policy.isAutomationWorker({ SPARK_AUTOMATION_ID: "  " }), false);
assert.equal(policy.isAutomationWorker({ SPARK_AUTOMATION_ID: "job-1" }), true);

// Chat worker roster: studio surface only (whiteboard + board reads are
// harmless context, scoped to the calling run), no lifecycle tools.
assert.equal(policy.isWorkerSafeBridgeTool("codara_preview_snapshot", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_terminal_create", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_get", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_update", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_ask_user", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_request_next_iteration", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_get", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_update", false), false);

// Automation worker roster: lifecycle pair + board read appear; manager
// orchestration and mutating board/whiteboard tools stay out.
assert.equal(policy.isWorkerSafeBridgeTool("codara_ask_user", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_request_next_iteration", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_get", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_update", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_update", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_spawn_workers", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_complete", true), false);

// Every WORKER-mode bridge tool must pass the allowlist for an automation
// worker: the roster and the allowlist may not drift apart, or a loom worker
// silently loses tools its prompt references.
process.env.SPARK_MCP_MODE = "worker";
delete require.cache[require.resolve(studioBridgePath)];
const workerBridge = require(studioBridgePath);
for (const tool of workerBridge.listTools()) {
  assert.equal(
    policy.isWorkerSafeBridgeTool(tool.name, true),
    true,
    `worker-mode bridge tool ${tool.name} must pass the automation allowlist`,
  );
}

// The access fence. Names are asserted against Pi 0.82.0's REAL tool
// inventory (bash, edit, find, grep, ls, read, write natively; web_search +
// url_context from pi-web-search; deep_search bundled) plus the codara_*
// bridge roster.
const noInput = {};
{
  const env = {
    CODARA_PI_WORKER_ACCESS: "readonly",
    CODARA_PI_WORKER_BLOCKED_TOOLS: "Grep",
  };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("bash")?.block, true, "readonly blocks bash");
  assert.equal(blocked("edit")?.block, true, "readonly blocks edit");
  assert.equal(blocked("web_search")?.block, true, "readonly blocks web_search");
  assert.equal(blocked("deep_search")?.block, true, "readonly blocks deep_search");
  assert.equal(blocked("url_context")?.block, true, "readonly blocks url_context");
  assert.equal(blocked("grep")?.block, true, "blockedTools Grep maps to grep");
  assert.equal(blocked("read"), undefined, "read stays available");
  assert.equal(blocked("write"), undefined, "write (no path arg) stays available for the final report");
  assert.match(blocked("bash").reason, /disabled for this automation worker/);
  assert.match(blocked("bash").reason, /access preset "readonly"/);
  // Bridge fencing: shell-equivalent bridge tools blocked for ANY preset,
  // mutating preview tools additionally blocked for readonly. Read-ish
  // preview tools stay.
  assert.equal(blocked("codara_terminal_create")?.block, true, "readonly blocks terminal create");
  assert.equal(blocked("codara_terminal_write")?.block, true, "readonly blocks terminal write");
  assert.equal(blocked("codara_preview_evaluate")?.block, true, "readonly blocks preview evaluate");
  assert.equal(blocked("codara_preview_run")?.block, true, "readonly blocks preview run (can embed evaluate steps)");
  assert.equal(blocked("codara_preview_click")?.block, true, "readonly blocks preview click");
  assert.equal(blocked("codara_preview_type")?.block, true, "readonly blocks preview type");
  assert.equal(blocked("codara_preview_screenshot"), undefined, "readonly keeps preview screenshot");
  assert.equal(blocked("codara_preview_navigate"), undefined, "readonly keeps preview navigate");
  assert.equal(blocked("codara_ask_user"), undefined, "readonly keeps ask_user");
}
{
  const env = {
    CODARA_PI_WORKER_ACCESS: "edits",
    CODARA_PI_WORKER_BLOCKED_TOOLS: "WebFetch",
  };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("edit", { path: process.cwd() + "/x.txt" }), undefined, "edits keeps the edit tool inside the workspace");
  assert.equal(blocked("bash")?.block, true, "edits blocks bash");
  assert.equal(blocked("url_context")?.block, true, "WebFetch maps to url_context");
  assert.equal(blocked("codara_terminal_create")?.block, true, "edits blocks terminal create");
  assert.equal(blocked("codara_preview_evaluate")?.block, true, "edits blocks preview evaluate");
  assert.equal(blocked("codara_preview_click"), undefined, "edits keeps preview click");
}
{
  // Alias mapping onto REAL tool names: Glob -> find, MultiEdit -> edit.
  const env = { CODARA_PI_WORKER_BLOCKED_TOOLS: "Glob,MultiEdit" };
  const fence = policy.fencedToolNames(env);
  const blocked = (name) => policy.fenceDecision(name, noInput, fence, env);
  assert.equal(blocked("find")?.block, true, "Glob maps to find");
  assert.equal(blocked("edit")?.block, true, "MultiEdit maps to edit");
}
{
  // Bare blockedTools with no preset: camelCase maps to snake_case; Write is
  // blockable explicitly (that is what silences the chat board for a node),
  // and no preset means no bridge fencing and no containment.
  const env = { CODARA_PI_WORKER_BLOCKED_TOOLS: "Write,WebSearch" };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("write")?.block, true, "explicit Write block maps to write");
  assert.equal(blocked("web_search")?.block, true, "WebSearch maps to web_search");
  assert.equal(blocked("bash"), undefined, "no preset means shell stays available");
  assert.equal(blocked("codara_terminal_create"), undefined, "no preset means bridge tools stay");
  assert.equal(
    blocked("edit", { path: os.tmpdir() + "/anywhere.txt" }),
    undefined,
    "no preset means no write containment",
  );
  assert.match(blocked("write").reason, /blocked by its worker config/);
}
{
  // No fence env at all: empty set, nothing vetoed.
  assert.equal(policy.fencedToolNames({}).size, 0);
}

// Write containment for fenced workers: mutations stay inside the session cwd
// plus the launcher's allow-listed dirs (report dir, chat board dir).
{
  const allowDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fence-allow-"));
  const env = {
    CODARA_PI_WORKER_ACCESS: "edits",
    CODARA_PI_WORKER_WRITE_ALLOW: JSON.stringify([allowDir]),
  };
  const fence = policy.fencedToolNames(env);
  const decide = (name, input) => policy.fenceDecision(name, input, fence, env);
  const cwd = process.cwd();
  assert.equal(decide("write", { path: path.join(cwd, "notes.md") }), undefined, "write inside cwd allowed");
  assert.equal(decide("write", { path: "relative/notes.md" }), undefined, "relative write resolves against cwd");
  assert.equal(decide("edit", { file_path: path.join(cwd, "src", "a.ts") }), undefined, "edit inside cwd allowed");
  assert.equal(decide("write", { path: path.join(allowDir, "final-report.json") }), undefined, "write to the allow-listed report dir allowed");
  assert.equal(
    decide("write", { path: path.join(os.tmpdir(), "pi-fence-escape.txt") })?.block,
    true,
    "write outside cwd + allow dirs blocked",
  );
  assert.equal(
    decide("write", { path: path.join(cwd, "..", "escape.txt") })?.block,
    true,
    "traversal out of cwd blocked",
  );
  assert.equal(
    decide("edit", { path: "/etc/hosts" })?.block,
    true,
    "absolute edit outside the workspace blocked",
  );
  assert.match(
    decide("write", { path: "/etc/hosts" }).reason,
    /outside this automation's workspace/,
  );
  assert.equal(decide("read", { path: "/etc/hosts" }), undefined, "containment covers mutations only");
  fs.rmSync(allowDir, { recursive: true, force: true });
}

// Roster vs fence cross-check: a fenced worker's blocked bridge tools must be
// REAL names from the worker-mode roster (no dead entries), and the shell set
// must actually cover the terminal tools the roster offers.
{
  const rosterNames = new Set(workerBridge.listTools().map((tool) => tool.name));
  const fenced = policy.fencedToolNames({ CODARA_PI_WORKER_ACCESS: "readonly" });
  for (const name of fenced) {
    if (!name.startsWith("codara_")) continue;
    assert.equal(rosterNames.has(name), true, `fenced bridge tool ${name} must exist in the worker roster`);
  }
  for (const name of rosterNames) {
    if (name.startsWith("codara_terminal_")) {
      assert.equal(fenced.has(name), true, `terminal tool ${name} must be fenced for readonly`);
    }
  }
  assert.equal(fenced.has("codara_preview_evaluate"), true, "preview evaluate must be fenced for readonly");
  assert.equal(fenced.has("codara_preview_run"), true, "preview run must be fenced for readonly");
}

console.log("pi Cora mode + execution-policy prompts: ok");
console.log("pi worker policy (roster + access fence): ok");
