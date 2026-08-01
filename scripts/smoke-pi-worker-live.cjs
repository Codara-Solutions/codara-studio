#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const tsModuleCache = new Map();

if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") {
  console.error("Refusing live subscription inference without CODARA_ALLOW_LIVE_PI_SMOKE=1");
  process.exit(2);
}

function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const cached = tsModuleCache.get(resolved);
  if (cached) return cached;
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier.startsWith("@shared/")) {
      return loadTypeScriptModule(
        path.join(ROOT, "src", "shared", `${specifier.slice("@shared/".length)}.ts`),
      );
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}

async function waitForTurn(client, message, PiTurnAccumulator) {
  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  const counts = new Map();
  const turn = new PiTurnAccumulator();
  const toolResults = [];
  const unsubscribe = client.onEvent((event) => {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
    turn.consume(event);
    if (event.type === "tool_execution_end") toolResults.push(event);
    if (event.type === "agent_settled") resolveSettled();
  });
  const timer = setTimeout(() => resolveSettled(), 20 * 60 * 1000);
  timer.unref();
  try {
    await client.prompt(message);
    await settled;
    assert.ok((counts.get("agent_settled") || 0) > 0, "Pi worker smoke timed out");
    return { counts: Object.fromEntries(counts), result: turn.result(), toolResults };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

async function main() {
  const productRoot = ROOT;
  const runtime = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-runtime.ts"));
  const { PiRpcClient } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-rpc-client.ts"));
  const { PiTurnAccumulator } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-turn.ts"));
  const provider = process.env.CODARA_PI_SMOKE_PROVIDER || "openai-codex";
  const model = process.env.CODARA_PI_SMOKE_MODEL || (provider === "anthropic" ? "claude-opus-4-8" : "gpt-5.6-sol");
  const thinking = process.env.CODARA_PI_SMOKE_THINKING || "high";
  const requireExternalToolLoader = process.env.CODARA_PI_SMOKE_REQUIRE_EXTERNAL_LOADER === "1";
  const mcpConfigPath = process.env.CODARA_PI_SMOKE_MCP_CONFIG?.trim() || null;
  assert.equal(
    !requireExternalToolLoader || Boolean(mcpConfigPath),
    true,
    "CODARA_PI_SMOKE_REQUIRE_EXTERNAL_LOADER=1 requires CODARA_PI_SMOKE_MCP_CONFIG",
  );
  const mcpSdkDir = mcpConfigPath
    ? path.dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    : null;
  const configDir = process.env.CODARA_PI_SMOKE_CONFIG || path.join(os.homedir(), ".Codara", "pi-agent");
  const sessionDir = path.join(configDir, "sessions");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-worker-"));
  const artifactPath = path.join(fixture, "worker-artifact.txt");
  const reportPath = path.join(fixture, "final-report.json");
  let client;
  try {
    const auth = await runtime.inspectPiSubscriptionAuth(path.join(configDir, "auth.json"), provider);
    assert.equal(auth.type, "oauth");
    const location = await runtime.resolvePinnedPiRuntime([path.join(productRoot, "node_modules")]);
    const plan = runtime.buildPiManagerLaunchPlan({
      runtime: location,
      provider,
      configDir,
      sessionDir,
      sessionId: `worker-smoke-${randomUUID()}`,
      runId: `worker-smoke-${randomUUID()}`,
      mode: "talk",
      cwd: fixture,
      bridgePath: path.join(productRoot, "resources/codara-studio-mcp/server.js"),
      extensionPaths: [path.join(productRoot, "resources/pi-cora/worker.ts")],
      processExecutable: process.execPath,
      model,
      thinking,
      sessionName: "Cora Pi worker smoke",
      codaraHomeDir: path.join(os.homedir(), ".Codara"),
      ...(mcpConfigPath && mcpSdkDir ? { mcpConfigPath, mcpSdkDir } : {}),
    });
    assert.equal(Object.keys(plan.env).some((key) => key.toUpperCase().endsWith("_API_KEY")), false);
    assert.equal(plan.args.some((value) => value.endsWith("resources/pi-cora/worker.ts")), true);
    assert.equal(plan.args.some((value) => value.endsWith("resources/pi-cora/index.ts")), false);
    client = new PiRpcClient(plan, { requestTimeoutMs: 120_000, shutdownGraceMs: 2_000 });
    await client.start();
    const turn = await waitForTurn(client, `
Implement this bounded Cora worker fixture directly in ${fixture}.

${requireExternalToolLoader
    ? "Before editing, call codara_external_tools exactly once with query 'Runpod endpoint'. Do not call any newly activated external tool."
    : ""}

1. Write ${artifactPath} containing exactly CORA_PI_WORKER_OK followed by a newline.
2. Verify the exact file contents yourself.
3. Write valid JSON to ${reportPath} with this shape:
{
  "status": "complete",
  "summary": "Created and verified the Pi worker fixture.",
  "files_changed": [{"path": "worker-artifact.txt", "reason": "Smoke fixture"}],
  "commands_run": [],
  "tests": [],
  "proof": ["worker-artifact.txt contains CORA_PI_WORKER_OK"],
  "risks": [],
  "followups": []
}
Do not end until both files exist and the report parses as JSON.
`, PiTurnAccumulator);
    assert.equal(
      turn.result.failure,
      null,
      `Pi worker provider failed: ${turn.result.failure}; stderr=${client.diagnostics().stderr || "<empty>"}`,
    );
    if (requireExternalToolLoader) {
      const loaderCall = turn.result.successfulToolCalls.find(
        (call) => call.toolName === "codara_external_tools",
      );
      assert.ok(loaderCall, "the Pi worker did not execute the external tool loader successfully");
      const loaderResult = turn.toolResults.find(
        (event) => event.toolCallId === loaderCall.toolUseId,
      );
      assert.match(
        JSON.stringify(loaderResult?.result ?? null),
        /Activated [1-9][0-9]* external tool\(s\)/,
        "the Pi worker loader did not activate a Runpod tool definition",
      );
    }
    assert.equal(
      fs.existsSync(artifactPath),
      true,
      `Pi worker created no artifact; finalText=${JSON.stringify(turn.result.finalText)}; ` +
        `events=${JSON.stringify(turn.counts)}; stderr=${client.diagnostics().stderr || "<empty>"}`,
    );
    assert.equal(fs.readFileSync(artifactPath, "utf8"), "CORA_PI_WORKER_OK\n");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "complete");
    assert.ok((turn.counts.tool_execution_start || 0) > 0, "Pi worker used no coding tools");
    console.log(JSON.stringify({
      ok: true,
      provider,
      model,
      thinking,
      workerExtension: true,
      reportStatus: report.status,
      events: turn.counts,
      externalMcpEnabled: Boolean(mcpConfigPath),
      externalToolLoaderVerified: requireExternalToolLoader,
      apiCredentialsInherited: false,
    }));
  } finally {
    if (client) await client.stop().catch(() => undefined);
    if (process.env.CODARA_KEEP_PI_SMOKE_FIXTURE !== "1") {
      fs.rmSync(fixture, { recursive: true, force: true });
    } else {
      console.error(`[pi-worker-live] kept fixture ${fixture}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
