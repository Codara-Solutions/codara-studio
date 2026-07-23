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

const CHILD = String.raw`
const { StringDecoder } = require("node:string_decoder");
const decoder = new StringDecoder("utf8");
let input = "";
if (process.env.FIXTURE_STDERR === "1") {
  const diagnostic = Buffer.from("prefix😀tail", "utf8");
  process.stderr.write(diagnostic.subarray(0, 8));
  setTimeout(() => process.stderr.write(diagnostic.subarray(8)), 2);
}
process.stdin.on("data", (chunk) => {
  input += decoder.write(chunk);
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (command.type === "get_state") {
      if (process.env.FIXTURE_IGNORE_STATE === "1") continue;
      const line = JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "fixture" } }) + "\n";
      process.stdout.write(line.slice(0, 5));
      setTimeout(() => process.stdout.write(line.slice(5)), 5);
    } else if (command.type === "echo") {
      process.stdout.write(JSON.stringify({ type: "glyph", text: "A B C😀" }) + "\n");
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command.value }) + "\n");
    } else if (command.type === "late") {
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: "late" }) + "\n"), 80);
    } else if (command.type === "fail") {
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "fixture failure" }) + "\n");
    } else if (command.type === "malformed") {
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false }) + "\n");
    }
  }
});
process.stdin.resume();
`;

function plan(extraEnv = {}) {
  return {
    command: process.execPath,
    args: ["-e", CHILD],
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
    sessionId: "fixture",
  };
}

async function main() {
  const { PiRpcClient } = loadTypeScriptModule(
    path.join(__dirname, "..", "src", "main", "orchestration", "pi-rpc-client.ts"),
  );
  const client = new PiRpcClient(plan(), { requestTimeoutMs: 250, shutdownGraceMs: 30 });
  assert.deepEqual(await client.start(), { sessionId: "fixture" });
  assert.equal(client.state().phase, "running");
  const events = [];
  client.onEvent(() => { throw new Error("fixture listener failure"); });
  const unsubscribe = client.onEvent((event) => events.push(event));
  assert.deepEqual(await client.request({ type: "echo", value: { ok: true } }), { ok: true });
  assert.equal(events[0].text, "A B C😀");
  assert.deepEqual(client.diagnostics().listenerErrors, ["Pi RPC listener threw while handling glyph"]);
  unsubscribe();
  unsubscribe();
  await assert.rejects(client.request({ type: "fail" }), (error) => error.code === "REMOTE_ERROR");
  await assert.rejects(
    client.request({ type: "late" }, { timeoutMs: 20 }),
    (error) => error.code === "TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.state().phase, "running");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.request({ type: "echo", value: 1 }, { signal: controller.signal }),
    (error) => error.code === "ABORTED",
  );
  let optionGetterCalls = 0;
  const hostileOptions = {};
  Object.defineProperty(hostileOptions, "timeoutMs", {
    get() { optionGetterCalls += 1; return 20; },
  });
  await assert.rejects(
    client.request({ type: "echo", value: 1 }, hostileOptions),
    /must not contain accessors/,
  );
  assert.equal(optionGetterCalls, 0);
  await assert.rejects(
    client.request({ type: "echo", value: 1 }, { unknown: true }),
    /Unknown Pi RPC request option/,
  );
  await client.stop();
  assert.equal(client.state().phase, "stopped");
  assert.equal(client.state().pendingCount, 0);

  const malformed = new PiRpcClient(plan(), { requestTimeoutMs: 250, shutdownGraceMs: 30 });
  await malformed.start();
  await assert.rejects(
    malformed.request({ type: "malformed" }),
    (error) => error.code === "PROTOCOL_ERROR",
  );
  assert.equal(malformed.state().phase, "failed");
  await malformed.stop();

  const startupTimeout = new PiRpcClient(
    plan({ FIXTURE_IGNORE_STATE: "1" }),
    { requestTimeoutMs: 20, shutdownGraceMs: 30 },
  );
  await assert.rejects(startupTimeout.start(), (error) => error.code === "TIMEOUT");
  assert.equal(startupTimeout.state().phase, "failed");
  assert.equal(startupTimeout.state().failure.code, "STARTUP_TIMEOUT");
  await startupTimeout.stop();

  const stderr = new PiRpcClient(
    plan({ FIXTURE_STDERR: "1" }),
    { requestTimeoutMs: 250, maxStderrBytes: 8, shutdownGraceMs: 30 },
  );
  await stderr.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stderr.diagnostics().stderr, "😀tail");
  assert.equal(stderr.diagnostics().droppedStderrBytes, 6);
  await stderr.stop();
  console.log("pi rpc client: ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
