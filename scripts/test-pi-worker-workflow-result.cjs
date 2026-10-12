#!/usr/bin/env node
// Guards the workflow variant of the Pi worker's submit_result
// (resources/pi-cora/worker.ts): with CODARA_PI_WORKFLOW the caller's schema
// becomes a required `result` parameter, the report carries the result, the
// summary cap is the workflow one, the system prompt speaks to a script, and
// the agent gets neither memory writes nor worktree tools.
//
//   node scripts/test-pi-worker-workflow-result.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-workflow-"));

async function bundle(entry) {
  const output = await esbuild.build({
    entryPoints: [entry],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerProvider: () => {},
    registerCommand: () => {},
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {},
  };
}

async function main() {
  const bridgePath = path.join(TMP, "bridge.cjs");
  fs.writeFileSync(bridgePath, "module.exports = { listTools: () => [], callToolByName: async () => ({ content: [] }) };\n");
  const reportPath = path.join(TMP, "final-report.json");
  const schemaPath = path.join(TMP, "schema.json");
  const schema = {
    type: "object",
    properties: { bugs: { type: "array", items: { type: "string" } } },
    required: ["bugs"],
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema));
  Object.assign(process.env, {
    CODARA_PI_BRIDGE_PATH: bridgePath,
    CODARA_PI_DIRECT_TASK: "1",
    CODARA_PI_FINAL_REPORT: reportPath,
    CODARA_PI_WORKFLOW: "1",
    CODARA_PI_WORKFLOW_RESULT_SCHEMA_PATH: schemaPath,
  });
  delete process.env.CODARA_PI_DIRECT_STUDIO_TOOLS;

  const worker = await bundle(path.join(ROOT, "resources", "pi-cora", "worker.ts"));
  const pi = fakePi();
  worker.default(pi);
  const submit = pi.tools.get("submit_result");
  assert.ok(submit, "workflow agents get submit_result");
  assert.deepEqual(submit.parameters.required, ["status", "summary", "result"], "result is required with a schema");
  assert.deepEqual(submit.parameters.properties.result, schema, "the caller's schema is the result parameter");
  assert.match(submit.parameters.properties.summary.description, /progress view/);

  await submit.execute("call-1", { status: "complete", summary: "two bugs", result: { bugs: ["a", "b"] } });
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.deepEqual(report.result, { bugs: ["a", "b"] }, "the report carries the result");
  assert.equal(report.status, "complete");

  const long = "x".repeat(40_000);
  await submit.execute("call-2", { status: "complete", summary: long, result: { bugs: [] } });
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).summary.length, 40_000, "workflow summaries keep up to 64K characters");

  const [beforeStart] = pi.handlers.get("before_agent_start");
  const { systemPrompt } = await beforeStart({ systemPrompt: "BASE" });
  assert.match(systemPrompt, /inside a workflow/);
  assert.doesNotMatch(systemPrompt, /shown to the user verbatim/, "no chat voice for a script's agent");

  // Without a schema the summary is the answer and there is no result field.
  delete process.env.CODARA_PI_WORKFLOW_RESULT_SCHEMA_PATH;
  const plain = fakePi();
  worker.default(plain);
  const plainSubmit = plain.tools.get("submit_result");
  assert.deepEqual(plainSubmit.parameters.required, ["status", "summary"]);
  assert.equal(plainSubmit.parameters.properties.result, undefined);
  assert.match(plainSubmit.parameters.properties.summary.description, /receives it verbatim/);

  // Memory and worktree tools stay with chat direct tasks.
  const policy = await bundle(path.join(ROOT, "resources", "pi-cora", "worker-policy.ts"));
  const chatEnv = { CODARA_PI_DIRECT_TASK: "1" };
  const workflowEnv = { CODARA_PI_DIRECT_TASK: "1", CODARA_PI_WORKFLOW: "1" };
  assert.equal(policy.isWorkerSafeBridgeTool("codara_remember", false, chatEnv), true);
  assert.equal(policy.isWorkerSafeBridgeTool("codara_remember", false, workflowEnv), false);
  assert.equal(policy.isWorkerSafeBridgeTool("codara_worktree_create", false, workflowEnv), false);
  assert.equal(policy.isWorkerSafeBridgeTool("codara_preview_snapshot", false, workflowEnv), true);

  console.log("pi worker workflow result: ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
