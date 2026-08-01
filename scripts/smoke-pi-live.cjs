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

async function main() {
  const root = ROOT;
  const runtime = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-runtime.ts"));
  const { PiRpcClient } = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-rpc-client.ts"));
  const { PiTurnAccumulator } = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-turn.ts"));
  const provider = process.env.CODARA_PI_SMOKE_PROVIDER || "openai-codex";
  const model = process.env.CODARA_PI_SMOKE_MODEL || "gpt-5.6-sol";
  const thinking = process.env.CODARA_PI_SMOKE_THINKING || "high";
  const requireTool = process.env.CODARA_PI_SMOKE_REQUIRE_TOOL === "1";
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
  const auth = await runtime.inspectPiSubscriptionAuth(path.join(configDir, "auth.json"), provider);
  assert.equal(auth.type, "oauth");
  const location = await runtime.resolvePinnedPiRuntime([path.join(root, "node_modules")]);
  const plan = runtime.buildPiManagerLaunchPlan({
    runtime: location,
    provider,
    configDir,
    sessionDir,
    sessionId: `studio-smoke-${randomUUID()}`,
    runId: `studio-smoke-${randomUUID()}`,
    mode: "talk",
    cwd: root,
    bridgePath: path.join(root, "resources/codara-studio-mcp/server.js"),
    extensionPaths: [path.join(root, "resources/pi-cora/index.ts")],
    processExecutable: process.execPath,
    model,
    thinking,
    sessionName: "Codara Pi live smoke",
    codaraHomeDir: path.join(os.homedir(), ".Codara"),
    ...(mcpConfigPath && mcpSdkDir ? { mcpConfigPath, mcpSdkDir } : {}),
  });
  for (const key of Object.keys(plan.env)) {
    assert.equal(key.endsWith("_API_KEY"), false, `metered credential survived: ${key}`);
  }
  const makeClient = () => new PiRpcClient(plan, { requestTimeoutMs: 120_000, shutdownGraceMs: 2_000 });
  const runTurn = async (client, message, { abortAfterDelta = false } = {}) => {
    const turn = new PiTurnAccumulator();
    const eventCounts = new Map();
    const toolResults = [];
    let resolveSettled;
    let abortPromise = null;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const unsubscribe = client.onEvent((event) => {
      eventCounts.set(event.type, (eventCounts.get(event.type) || 0) + 1);
      turn.consume(event);
      if (event.type === "tool_execution_end") toolResults.push(event);
      if (abortAfterDelta && event.type === "message_update" && !abortPromise) {
        abortPromise = client.abort();
      }
      if (event.type === "agent_settled") resolveSettled();
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; resolveSettled(); }, 20 * 60 * 1000);
    timer.unref();
    try {
      await client.prompt(message);
      await settled;
      if (abortPromise) await abortPromise;
      assert.equal(timedOut, false, "Pi smoke timed out before agent_settled");
      return {
        result: turn.result(),
        eventCounts: Object.fromEntries(eventCounts),
        toolResults,
        aborted: Boolean(abortPromise),
      };
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  };

  let client = makeClient();
  try {
    const state = await client.start();
    const first = await runTurn(
      client,
      requireExternalToolLoader
        ? "Call codara_external_tools exactly once with query 'Runpod endpoint'. After it returns, do not call any newly activated tool; reply with exactly PI_EXTERNAL_LOADER_OK and no other text."
        : requireTool
        ? "Call codara_preview_list exactly once. After the tool returns, reply with exactly PI_STUDIO_TOOL_OK and no other text."
        : "Reply with exactly PI_STUDIO_LIVE_OK and no other text. Do not use tools.",
    );
    assert.equal(first.result.settled, true);
    assert.equal(first.result.failure, null);
    const expectedFirstText = requireExternalToolLoader
      ? "PI_EXTERNAL_LOADER_OK"
      : requireTool ? "PI_STUDIO_TOOL_OK" : "PI_STUDIO_LIVE_OK";
    assert.equal(first.result.finalText.trim(), expectedFirstText);
    assert.ok((first.eventCounts.message_update || 0) > 0, "Pi did not stream message updates");
    if (requireExternalToolLoader) {
      const loaderCall = first.result.successfulToolCalls.find(
        (call) => call.toolName === "codara_external_tools",
      );
      assert.ok(loaderCall, "Pi did not execute the external tool loader successfully");
      const loaderResult = first.toolResults.find(
        (event) => event.toolCallId === loaderCall.toolUseId,
      );
      assert.match(
        JSON.stringify(loaderResult?.result ?? null),
        /Activated [1-9][0-9]* external tool\(s\)/,
        "the external loader did not activate a Runpod tool definition",
      );
    } else if (requireTool) {
      assert.ok(
        first.result.toolCalls.some((call) => call.toolName === "codara_preview_list"),
        "Pi did not execute the required Codara bridge tool",
      );
    }
    await client.stop();

    client = makeClient();
    const resumedState = await client.start();
    assert.equal(resumedState.sessionId, state.sessionId);
    assert.ok(Number(resumedState.messageCount) >= 2, "Pi did not restore the prior conversation");
    const resumed = await runTurn(client, "Reply with exactly PI_STUDIO_RESUME_OK and no other text. Do not use tools.");
    assert.equal(resumed.result.failure, null);
    assert.match(resumed.result.finalText.trim(), /^PI_STUDIO_RESUME_OK$/);

    const interrupted = await runTurn(
      client,
      "Write a very long, detailed analysis of deterministic distributed systems. Do not use tools.",
      { abortAfterDelta: true },
    );
    assert.equal(interrupted.result.settled, true);
    assert.equal(interrupted.aborted, true, "Pi interruption was never issued after streaming began");
    console.log(JSON.stringify({
      ok: true,
      provider,
      model,
      thinking,
      sessionId: state.sessionId,
      firstTurnUsage: first.result.usage,
      resumedTurnUsage: resumed.result.usage,
      firstTurnEvents: first.eventCounts,
      resumedMessageCount: resumedState.messageCount,
      interruptionSettled: interrupted.result.settled,
      toolCalls: first.result.toolCalls.length + resumed.result.toolCalls.length,
      externalMcpEnabled: Boolean(mcpConfigPath),
      externalToolLoaderVerified: requireExternalToolLoader,
      apiCredentialsInherited: false,
    }));
  } finally {
    await client.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
