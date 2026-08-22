#!/usr/bin/env node
"use strict";

// Contract verification for the per-chat OpenRouter-cost capture chain:
//   1. PiTurnAccumulator sums message_end usage.cost.total into the turn's
//      usage, emits it on the live usage stream event, and returns it in
//      result() so pi-backend can stamp the SparkCall.
//   2. An all-zero cost block stays silent on the stream (subscription chats
//      must not grow a $0 pill) while still emitting token counts.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
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
    if (specifier.startsWith(".")) {
      return loadTypeScriptModule(path.join(path.dirname(resolved), `${specifier}.ts`));
    }
    return nativeRequire(specifier);
  };
  loaded._compile(output, resolved);
  return loaded.exports;
}

const { PiTurnAccumulator } = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-turn.ts"),
);

const events = [];
const turn = new PiTurnAccumulator(
  (event) => events.push(event),
  { captureCost: true },
);

// Request 1: an OpenRouter-shaped message_end with a cost block.
turn.consume({
  type: "message_start",
  message: { role: "assistant", id: "msg-1" },
});
turn.consume({
  type: "message_end",
  message: {
    role: "assistant",
    id: "msg-1",
    content: [{ type: "text", text: "Working on it." }],
    usage: {
      input: 1200,
      output: 340,
      cacheRead: 500,
      cost: { input: 0.006, output: 0.0102, cacheRead: 0.00075, cacheWrite: 0, total: 0.01695 },
    },
  },
});

// Request 2 (same turn, tool loop): cost accumulates across requests.
turn.consume({
  type: "message_end",
  message: {
    role: "assistant",
    id: "msg-2",
    content: [{ type: "text", text: "Done." }],
    usage: {
      input: 2000,
      output: 100,
      cost: { input: 0.01, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.013 },
    },
  },
});

const result = turn.result();
assert.ok(Math.abs(result.usage.costUsd - 0.02995) < 1e-9, `turn cost sums: ${result.usage.costUsd}`);

const usageEvents = events.filter((event) => event.kind === "usage");
assert.equal(usageEvents.length, 2, "one usage event per message_end with usage");
// Turn-cumulative on the wire, not per-request.
assert.ok(Math.abs(usageEvents[0].costUsd - 0.01695) < 1e-9);
assert.ok(Math.abs(usageEvents[1].costUsd - 0.02995) < 1e-9);

// A native subscription session may still receive positive API-equivalent
// catalog prices from Pi. With captureCost disabled those must be ignored.
const freeEvents = [];
const freeTurnWithSink = new PiTurnAccumulator((event) => freeEvents.push(event));
freeTurnWithSink.consume({
  type: "message_end",
  message: {
    role: "assistant",
    id: "m",
    content: [{ type: "text", text: "hi" }],
    usage: { input: 10, output: 5, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
  },
});
const freeUsage = freeEvents.find((event) => event.kind === "usage");
assert.ok(freeUsage, "token usage still streams without cost");
assert.equal(freeUsage.costUsd, undefined, "subscription catalog cost stays silent on the stream");
assert.equal(freeTurnWithSink.result().usage.costUsd, 0);

// A message with no cost block at all (older Pi shapes) must not crash.
const legacyTurn = new PiTurnAccumulator(() => {});
legacyTurn.consume({
  type: "message_end",
  message: { role: "assistant", id: "m2", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1 } },
});
assert.equal(legacyTurn.result().usage.costUsd, 0);

const runStoreSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "main", "orchestration", "run-store.ts"),
  "utf8",
);
assert.match(
  runStoreSource,
  /if \(provider === "openrouter"\) measuredCostTotal \+= usage\.cost/,
  "worker provider cost is accepted only at the OpenRouter boundary",
);
assert.match(
  runStoreSource,
  /isOpenRouterModelId\(call\.model\)[\s\S]{0,180}gauge\.costUsd > 0/,
  "restart recovery cannot backfill historical native catalog cost",
);
assert.match(
  runStoreSource,
  /for \(const call of run\.sparkCalls \?\? \[\]\) \{\s+if \(!isOpenRouterModelId\(call\.model\)\) continue;/,
  "run and step manager-cost rollups discard historical native catalog cost",
);

console.log("pi-turn OpenRouter-cost capture: all assertions passed");
