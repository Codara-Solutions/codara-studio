#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") {
  console.error("Refusing live subscription inference without CODARA_ALLOW_LIVE_PI_SMOKE=1");
  process.exit(2);
}

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

async function main() {
  const root = path.resolve(__dirname, "..");
  const runtime = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-runtime.ts"));
  const { PiRpcClient } = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-rpc-client.ts"));
  const { PiTurnAccumulator } = loadTypeScriptModule(path.join(root, "src/main/orchestration/pi-turn.ts"));
  const provider = process.env.CODARA_PI_SMOKE_PROVIDER || "openai-codex";
  const model = process.env.CODARA_PI_SMOKE_MODEL || "gpt-5.6-sol";
  const thinking = process.env.CODARA_PI_SMOKE_THINKING || "high";
  const requireTool = process.env.CODARA_PI_SMOKE_REQUIRE_TOOL === "1";
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
  });
  for (const key of Object.keys(plan.env)) {
    assert.equal(key.endsWith("_API_KEY"), false, `metered credential survived: ${key}`);
  }
  const makeClient = () => new PiRpcClient(plan, { requestTimeoutMs: 120_000, shutdownGraceMs: 2_000 });
  const runTurn = async (client, message, { abortAfterDelta = false } = {}) => {
    const turn = new PiTurnAccumulator();
    const eventCounts = new Map();
    let resolveSettled;
    let abortPromise = null;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const unsubscribe = client.onEvent((event) => {
      eventCounts.set(event.type, (eventCounts.get(event.type) || 0) + 1);
      turn.consume(event);
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
      return { result: turn.result(), eventCounts: Object.fromEntries(eventCounts), aborted: Boolean(abortPromise) };
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
      requireTool
        ? "Call codara_preview_list exactly once. After the tool returns, reply with exactly PI_STUDIO_TOOL_OK and no other text."
        : "Reply with exactly PI_STUDIO_LIVE_OK and no other text. Do not use tools.",
    );
    assert.equal(first.result.settled, true);
    assert.equal(first.result.failure, null);
    assert.equal(first.result.finalText.trim(), requireTool ? "PI_STUDIO_TOOL_OK" : "PI_STUDIO_LIVE_OK");
    assert.ok((first.eventCounts.message_update || 0) > 0, "Pi did not stream message updates");
    if (requireTool) {
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
