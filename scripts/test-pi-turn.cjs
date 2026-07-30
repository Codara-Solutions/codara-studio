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

const { frontierTurnHasRequiredCompletion, PiTurnAccumulator } = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-turn.ts"),
);

assert.equal(frontierTurnHasRequiredCompletion("fast", false, []), true);
assert.equal(frontierTurnHasRequiredCompletion("frontier", true, []), true);
assert.equal(frontierTurnHasRequiredCompletion("frontier", false, []), false);
assert.equal(frontierTurnHasRequiredCompletion("frontier", false, [{ toolName: "codara_complete" }]), true);
assert.equal(frontierTurnHasRequiredCompletion("frontier", false, [
  { toolName: "mcp__codara-studio__codara_complete" },
]), true);

const stream = [];
const turn = new PiTurnAccumulator((event) => stream.push(event));
turn.consume({ type: "message_start", message: { role: "assistant", timestamp: 10, content: [] } });
turn.consume({
  type: "message_update",
  message: { role: "assistant", timestamp: 10, content: [] },
  assistantMessageEvent: { type: "text_delta", delta: "Hello " },
});
turn.consume({
  type: "message_update",
  message: { role: "assistant", timestamp: 10, content: [] },
  assistantMessageEvent: { type: "text_delta", delta: "world" },
});
turn.consume({
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "codara_complete",
  args: { summary: "Verified" },
});
turn.consume({
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "codara_complete",
  args: { summary: "duplicate must be ignored" },
});
turn.consume({
  type: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "codara_complete",
  result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
  isError: false,
});
turn.consume({
  type: "message_end",
  message: {
    role: "assistant",
    timestamp: 10,
    content: [{ type: "text", text: "Hello world" }],
    usage: { input: 100, output: 20, cacheRead: 80 },
    stopReason: "stop",
  },
});
turn.consume({ type: "agent_settled" });

assert.deepEqual(turn.result(), {
  finalText: "Hello world",
  toolCalls: [{ toolName: "codara_complete", toolUseId: "call-1", input: { summary: "Verified" } }],
  successfulToolCalls: [{ toolName: "codara_complete", toolUseId: "call-1", input: { summary: "Verified" } }],
  providerResponseIds: [],
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 },
  contextTokens: 180,
  contextWindowTokens: null,
  failure: null,
  settled: true,
});
// The context gauge is the newest request's prompt (uncached input + cached
// reads), and a second round replaces the first rather than adding to it,
// while the billing counters keep accumulating.
const gauge = new PiTurnAccumulator();
gauge.consume({
  type: "message_end",
  message: { role: "assistant", timestamp: 1, content: [], usage: { input: 100, output: 5, cacheRead: 20 } },
});
gauge.consume({
  type: "message_end",
  message: {
    role: "assistant",
    timestamp: 2,
    content: [],
    // contextWindow is NOT a field the pinned Pi 0.82 ever emits on
    // message_end; it is asserted here only to pin the forward-compat read in
    // contextWindowFrom. Production Pi turns leave contextWindowTokens null
    // and the renderer falls back to contextWindowForModel().
    usage: { input: 40, output: 7, cacheRead: 300, contextWindow: 200000 },
  },
});
assert.deepEqual(gauge.result().usage, { inputTokens: 140, outputTokens: 12, cacheReadTokens: 320 });
assert.equal(gauge.result().contextTokens, 340);
assert.equal(gauge.result().contextWindowTokens, 200000);
// A production-shaped stream (no contextWindow anywhere) must leave the
// window null rather than fabricating one.
{
  const bare = new PiTurnAccumulator();
  bare.consume({
    type: "message_end",
    message: { role: "assistant", timestamp: 3, content: [], usage: { input: 9, output: 1 } },
  });
  assert.equal(bare.result().contextTokens, 9);
  assert.equal(bare.result().contextWindowTokens, null);
}
assert.deepEqual(stream.filter((event) => event.kind === "assistant_block").map((event) => event.text), ["Hello ", "world"]);
assert.equal(stream.filter((event) => event.kind === "tool_use").length, 1);
assert.deepEqual(stream.find((event) => event.kind === "tool_result"), {
  kind: "tool_result",
  toolUseId: "call-1",
  output: "{\"ok\":true}",
  isError: false,
});

const failed = new PiTurnAccumulator();
failed.consume({
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage: "subscription limit" },
});
failed.consume({ type: "auto_retry_end", success: false, finalError: "limit persisted" });
assert.equal(failed.result().failure, "limit persisted");

// A failed provider response is provisional: Pi owns its retry loop and emits
// a successful message_end followed by auto_retry_end(success) when it
// recovers. Codara must not keep the first error latched onto the whole turn.
const recovered = new PiTurnAccumulator();
recovered.consume({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "servers overloaded",
    responseId: "resp_failed",
  },
});
assert.equal(recovered.result().failure, "servers overloaded");
recovered.consume({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Recovered." }],
    stopReason: "stop",
    responseId: "resp_recovered",
  },
});
recovered.consume({ type: "auto_retry_end", success: true, attempt: 3 });
assert.equal(recovered.result().failure, null);
assert.deepEqual(recovered.result().providerResponseIds, ["resp_failed", "resp_recovered"]);

const extensionFailed = new PiTurnAccumulator();
extensionFailed.consume({ type: "extension_error", error: "bridge unavailable" });
extensionFailed.consume({ type: "auto_retry_end", success: true, attempt: 1 });
assert.equal(extensionFailed.result().failure, "bridge unavailable");

const rejectedTool = new PiTurnAccumulator();
rejectedTool.consume({
  type: "tool_execution_start",
  toolCallId: "rejected-1",
  toolName: "codara_complete",
  args: { summary: "must not apply" },
});
rejectedTool.consume({
  type: "tool_execution_end",
  toolCallId: "rejected-1",
  toolName: "codara_complete",
  result: { content: [{ type: "text", text: "worker prerequisite missing" }] },
  isError: true,
});
assert.equal(rejectedTool.result().toolCalls.length, 1);
assert.equal(rejectedTool.result().successfulToolCalls.length, 0);

const idless = new PiTurnAccumulator();
idless.consume({ type: "message_start", message: { role: "assistant", content: [] } });
idless.consume({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "same " } });
idless.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "same message" }] } });
assert.equal(idless.result().finalText, "same message");

console.log("pi-turn: ok");
