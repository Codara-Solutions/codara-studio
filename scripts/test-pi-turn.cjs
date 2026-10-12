#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

// Transpile-and-require for a single .ts file. `@shared/*` is a tsconfig path
// alias, not a real package, so nested requires of it are resolved here the
// same way tsconfig.node.json maps them.
const tsModuleCache = new Map();

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
        path.join(__dirname, "..", "src", "shared", `${specifier.slice("@shared/".length)}.ts`),
      );
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}

const piTurnModule = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-turn.ts"),
);
const { PiTurnAccumulator } = piTurnModule;
// The frontier policy (and its required-completion gate) was removed 2026-08.
assert.equal(piTurnModule.frontierTurnHasRequiredCompletion, undefined);

// Pi 0.84+ (the bundled 0.85.1 included) sends message_update as
// { type, usage, assistantMessageEvent } with no `message`; the delta belongs
// to the assistant message that message_start opened.
const stream = [];
const turn = new PiTurnAccumulator((event) => stream.push(event));
turn.consume({ type: "message_start", message: { role: "assistant", timestamp: 10, content: [] } });
turn.consume({
  type: "message_update",
  usage: { input: 0, output: 1 },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
});
turn.consume({
  type: "message_update",
  usage: { input: 0, output: 2 },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
});
assert.deepEqual(
  stream.filter((event) => event.kind === "assistant_block"),
  [
    { kind: "assistant_block", messageId: "pi-assistant-10", text: "Hello " },
    { kind: "assistant_block", messageId: "pi-assistant-10", text: "world" },
  ],
  "deltas stream live under the message_start id, before message_end",
);
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
  assistantMessageCount: 1,
  toolCalls: [{ toolName: "codara_complete", toolUseId: "call-1", input: { summary: "Verified" } }],
  successfulToolCalls: [{ toolName: "codara_complete", toolUseId: "call-1", input: { summary: "Verified" } }],
  providerResponseIds: [],
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0, costUsd: 0 },
  contextTokens: 180,
  contextWindowTokens: null,
  failure: null,
  providerRetried: false,
  settled: true,
});

const cacheEvents = [];
const cacheWrites = new PiTurnAccumulator((event) => cacheEvents.push(event));
for (const [timestamp, usage] of [[1, { input: 5, output: 2, cacheRead: 11, cacheWrite: 23 }], [2, { input: 7, output: 3, cacheRead: 13, cacheCreation: 29 }]]) {
  cacheWrites.consume({ type: "message_end", message: { role: "assistant", timestamp, content: [], usage } });
}
assert.deepEqual(cacheWrites.result().usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: 24, cacheWriteTokens: 52, costUsd: 0 });
assert.equal(cacheWrites.result().contextTokens, 49, "occupancy is the latest prompt including cache writes, not cumulative usage");
assert.equal(cacheEvents.filter((event) => event.kind === "usage").at(-1).cacheWriteTokens, 52);

// Only the newest assistant message is the final answer. Progress prose from
// an earlier tool-loop round must never be promoted when the actual final
// completion is explicitly empty.
{
  const emptyFinal = new PiTurnAccumulator();
  emptyFinal.consume({
    type: "message_end",
    message: {
      role: "assistant",
      id: "progress",
      content: [{ type: "text", text: "I am checking the files." }],
      usage: { input: 5, output: 4 },
    },
  });
  emptyFinal.consume({
    type: "message_end",
    message: {
      role: "assistant",
      id: "final",
      content: [],
      usage: { input: 7, output: 0 },
    },
  });
  assert.equal(emptyFinal.result().assistantMessageCount, 2);
  assert.equal(emptyFinal.result().finalText, "");
}
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
assert.deepEqual(gauge.result().usage, { inputTokens: 140, outputTokens: 12, cacheReadTokens: 320, cacheWriteTokens: 0, costUsd: 0 });
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
extensionFailed.consume({ type: "extension_error", event: "session_start", error: "bridge unavailable" });
extensionFailed.consume({ type: "auto_retry_end", success: true, attempt: 1 });
assert.equal(extensionFailed.result().failure, "bridge unavailable");

// A hook that shapes the prompt or enforces policy stays fatal even when the
// model still answers: the turn ran without Cora's contract.
{
  const contractMissing = new PiTurnAccumulator();
  contractMissing.consume({ type: "extension_error", event: "before_agent_start", error: "prompt hook threw" });
  contractMissing.consume({ type: "message_end", message: { role: "assistant", id: "a", content: [{ type: "text", text: "answer" }] } });
  assert.equal(contractMissing.result().failure, "prompt hook threw");
  const unnamed = new PiTurnAccumulator();
  unnamed.consume({ type: "extension_error", error: "unknown hook" });
  assert.equal(unnamed.result().failure, "unknown hook", "an unnamed hook is treated as fatal");
}

// Pi catches a throwing observer hook and carries on; the answer stands and
// the failure is reported as a note rather than failing the turn.
{
  const notes = [];
  const observer = new PiTurnAccumulator((event) => notes.push(event));
  observer.consume({ type: "message_end", message: { role: "assistant", id: "a", content: [{ type: "text", text: "Done." }] } });
  observer.consume({ type: "extension_error", extensionPath: "/x/pi-web-search/index.ts", event: "agent_end", error: "observer threw" });
  assert.equal(observer.result().failure, null);
  assert.equal(observer.result().finalText, "Done.");
  assert.ok(notes.some((event) => event.kind === "system_note" && /agent_end/.test(event.message)));
  assert.equal(notes.some((event) => event.kind === "error"), false);
}

// Pi's own provider retry loop is visible and recorded, so the manager-turn
// policy can tell a turn Pi already retried from one it never did.
{
  const notes = [];
  const retrying = new PiTurnAccumulator((event) => notes.push(event));
  assert.equal(retrying.result().providerRetried, false);
  retrying.consume({ type: "auto_retry_start", attempt: 2, maxAttempts: 6, delayMs: 4000, errorMessage: "overloaded" });
  assert.equal(retrying.result().providerRetried, true);
  assert.ok(notes.some((event) => event.kind === "system_note" && /retrying \(2\/6\) in 4s/.test(event.message)));
}

// A provider that declined fast mode is retried at standard speed by the Pi
// extension; the user sees that, not a "provider is busy" note, and a
// successful retry clears the provisional failure.
{
  const notes = [];
  const fallback = new PiTurnAccumulator((event) => notes.push(event));
  const errorMessage =
    "[codara-fast-fallback] claude-opus-4-7 declined fast mode (HTTP 400); it runs at standard speed for this session, so you can retry your request.";
  fallback.consume({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
  fallback.consume({ type: "message_end", message: { role: "assistant", timestamp: 1, stopReason: "error", errorMessage, content: [] } });
  fallback.consume({ type: "auto_retry_start", attempt: 1, maxAttempts: 6, delayMs: 2000, errorMessage });
  const note = notes.find((event) => event.kind === "system_note");
  assert.equal(
    note?.message,
    "claude-opus-4-7 declined fast mode (HTTP 400); it runs at standard speed for this session. Retrying now.",
  );
  assert.equal(notes.some((event) => /provider is busy/.test(event.message ?? "")), false);
  fallback.consume({ type: "message_start", message: { role: "assistant", timestamp: 2 } });
  fallback.consume({ type: "message_end", message: { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "Done." }] } });
  assert.equal(fallback.result().failure, null);
  assert.equal(fallback.result().finalText, "Done.");
}

// Compaction holds the reply back; say so instead of going silent.
{
  const notes = [];
  const compacting = new PiTurnAccumulator((event) => notes.push(event));
  compacting.consume({ type: "compaction_start", reason: "manual" });
  assert.ok(notes.some((event) => event.kind === "system_note" && /Compacting the conversation/.test(event.message)));
}

// A delta with no message_start has no id that message_end will agree with,
// so it is skipped rather than counted as a phantom assistant message.
{
  const orphan = new PiTurnAccumulator();
  orphan.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stray" } });
  assert.equal(orphan.result().assistantMessageCount, 0);
}

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

// Pre-0.84 builds put the message on every update; that shape still streams.
{
  const legacyStream = [];
  const legacy = new PiTurnAccumulator((event) => legacyStream.push(event));
  legacy.consume({ type: "message_start", message: { role: "assistant", timestamp: 5, content: [] } });
  legacy.consume({
    type: "message_update",
    message: { role: "assistant", timestamp: 5, content: [] },
    assistantMessageEvent: { type: "text_delta", delta: "legacy" },
  });
  legacy.consume({ type: "message_end", message: { role: "assistant", timestamp: 5, content: [{ type: "text", text: "legacy" }] } });
  assert.deepEqual(
    legacyStream.filter((event) => event.kind === "assistant_block").map((event) => event.messageId),
    ["pi-assistant-5"],
  );
  assert.equal(legacy.result().assistantMessageCount, 1);
}


// A running bash call's output streams as throttled tails: the first update
// goes out at once, a burst inside the interval collapses into one trailing
// send of the newest tail, and nothing follows the tool's end.
(async () => {
  const progress = [];
  const running = new PiTurnAccumulator((event) => progress.push(event));
  const update = (text) =>
    running.consume({
      type: "tool_execution_update",
      toolCallId: "bash-1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text }] },
    });
  update("ignored: no tool_execution_start yet");
  assert.equal(progress.length, 0);
  running.consume({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "npm test" } });
  progress.length = 0;
  update("line 1");
  update("line 1\nline 2");
  update("line 1\nline 2\nline 3");
  assert.deepEqual(progress, [{ kind: "tool_progress", toolUseId: "bash-1", output: "line 1" }]);
  await new Promise((resolve) => setTimeout(resolve, piTurnModule.TOOL_PROGRESS_INTERVAL_MS + 60));
  assert.deepEqual(progress.at(-1), {
    kind: "tool_progress",
    toolUseId: "bash-1",
    output: "line 1\nline 2\nline 3",
  });
  assert.equal(progress.length, 2);

  update("line 1\nline 2\nline 3\nline 4");
  running.consume({
    type: "tool_execution_end",
    toolCallId: "bash-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  });
  await new Promise((resolve) => setTimeout(resolve, piTurnModule.TOOL_PROGRESS_INTERVAL_MS + 60));
  assert.equal(progress.filter((event) => event.kind === "tool_progress").length, 2);
  assert.equal(progress.at(-1).kind, "tool_result");
  update("after the end");
  assert.equal(progress.at(-1).kind, "tool_result");

  // Only the tail travels.
  const many = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");
  const tail = piTurnModule.toolProgressTail({ content: [{ type: "text", text: `${many}\n\n` }] });
  assert.equal(tail.split("\n").length, piTurnModule.TOOL_PROGRESS_MAX_LINES);
  assert.ok(tail.endsWith("row 99"));
  const wide = piTurnModule.toolProgressTail({ content: [{ type: "text", text: "x".repeat(10_000) }] });
  assert.equal(wide.length, piTurnModule.TOOL_PROGRESS_MAX_CHARS);
  assert.equal(piTurnModule.toolProgressTail({ content: [] }), "");

  // The usage stream reports the limit the session's own extension enforces:
  // the owner's percentage of the model's window, else the stamped tokens.
  {
    const budgetFor = (launchEnv, model) => {
      const events = [];
      const accumulator = new PiTurnAccumulator((event) => events.push(event), { launchEnv, model });
      accumulator.consume({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } },
      });
      return events.filter((event) => event.kind === "usage").at(-1)?.compactAtTokens;
    };
    assert.equal(budgetFor({ CODARA_PI_COMPACT_AT_TOKENS: "256000", CODARA_PI_COMPACT_PERCENT: "70" }, "claude-sonnet-4-5"), 140_000);
    assert.equal(budgetFor({ CODARA_PI_COMPACT_AT_TOKENS: "256000", CODARA_PI_COMPACT_PERCENT: "70" }, "claude-fable-5"), 700_000);
    assert.equal(budgetFor({ CODARA_PI_COMPACT_AT_TOKENS: "256000" }, "claude-fable-5"), 256_000);
    assert.equal(budgetFor({ CODARA_PI_COMPACT_AT_TOKENS: "120000" }, "claude-fable-5"), 120_000);
  }

  console.log("pi-turn: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
