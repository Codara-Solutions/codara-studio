#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
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
  const configDir = process.env.CODARA_PI_SMOKE_CONFIG || path.join(os.homedir(), ".Codara", "pi-agent");
  const auth = await runtime.inspectPiSubscriptionAuth(path.join(configDir, "auth.json"), "openai-codex");
  assert.equal(auth.type, "oauth");
  const location = await runtime.resolvePinnedPiRuntime([path.join(root, "node_modules")]);
  const env = runtime.buildPiSubscriptionEnvironment(process.env, configDir, path.join(configDir, "sessions"));
  assert.ok(!Object.keys(env).some((key) => key.toUpperCase().endsWith("_API_KEY")));

  const startedAt = Date.now();
  let firstEventAt = null;
  let lastEventAt = null;
  let lastEventType = null;
  let finalAssistantAt = null;
  let finalAssistantTimestamp = null;
  let finalText = "";
  let stderr = "";
  let buffer = "";
  const child = spawn(process.execPath, [
    location.entrypoint,
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", "openai-codex/gpt-5.6-sol",
    "Reply with exactly PI_SUBAGENT_LIFECYCLE_OK and no other text. Do not use tools.",
  ], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { return; }
    const now = Date.now();
    firstEventAt ??= now;
    lastEventAt = now;
    lastEventType = event.type;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      finalAssistantAt = now;
      finalAssistantTimestamp = event.message.timestamp ?? null;
      finalText = (event.message.content || [])
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Pi subagent lifecycle profile timed out"));
    }, 10 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (buffer.trim()) consume(buffer);
      resolve({ code, signal, at: Date.now() });
    });
  });
  assert.equal(exit.code, 0, stderr);
  assert.equal(finalText.trim(), "PI_SUBAGENT_LIFECYCLE_OK");
  assert.ok(finalAssistantAt !== null && lastEventAt !== null);
  const summary = {
    ok: true,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    totalMs: exit.at - startedAt,
    firstEventMs: firstEventAt - startedAt,
    finalAssistantMs: finalAssistantAt - startedAt,
    processCloseAfterFinalAssistantMs: exit.at - finalAssistantAt,
    lastEventAfterFinalAssistantMs: lastEventAt - finalAssistantAt,
    finalAssistantTimestampLagMs: typeof finalAssistantTimestamp === "number"
      ? finalAssistantAt - finalAssistantTimestamp
      : null,
    lastEventType,
    apiCredentialsInherited: false,
  };
  const outputPath = process.env.CODARA_PI_SUBAGENT_LIFECYCLE_OUTPUT;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
