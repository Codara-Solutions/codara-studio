#!/usr/bin/env node
// Pins the contract that lets a desktop chat reach Cora's direct lane.
//
// startAutopilot routes a first message to the direct lane only when it
// creates the run itself (no runId). The composer used to pre-create the run
// to stamp its chip selections, which handed startAutopilot a runId and kept
// every desktop chat on the full manager path while the same message from the
// phone went direct. The routing decision itself is covered executably by
// scripts/test-cora-direct-mode.ts (npm run test:cora-direct-mode).
//
//   node scripts/test-composer-direct-routing.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

// 1. The composer's first send hands chip selections to startAutopilot and
// never pre-creates the run.
const sidebar = read("src/renderer/src/components/OrchestrationSidebar.tsx");
const startChatStart = sidebar.indexOf("const startChat = useCallback(");
assert.ok(startChatStart >= 0, "startChat exists");
const startChat = sidebar.slice(startChatStart, sidebar.indexOf("const mutate = useCallback(", startChatStart));
assert.doesNotMatch(startChat, /orchestration\.createRun\(/, "startChat must not pre-create the run");
for (const field of ["chatBackend", "chatModel", "chatMode", "chatEffort", "coraProfileId", "title"]) {
  assert.match(startChat, new RegExp(`\\b${field}:`), `startChat forwards ${field} to startAutopilot`);
}
assert.match(
  startChat,
  /isUnstartedChatRun\(activeRun\) \? activeRun\.id : undefined/,
  "a board-minted unstarted run is still reused (and stays managed)",
);

// 2. startAutopilot routes only runs it creates, and the direct worker runs
// a connected model from the user's enabled roster instead of a hard-coded
// default, while the chip stays the chat's model.
const runStore = read("src/main/orchestration/run-store.ts");
const startAutopilot = functionBody(runStore, "export async function startAutopilot(");
assert.match(startAutopilot, /!input\.runId &&\s*\(await shouldUseDirectExecution\(/);
assert.match(startAutopilot, /chatMode: input\.chatMode/, "chat mode reaches the routing decision");
assert.match(startAutopilot, /await resolveDirectWorkerModel\(chipModel\)/);
assert.match(startAutopilot, /chatModel: chipModel,/, "the chip is kept as the chat's model");
assert.doesNotMatch(startAutopilot, /"gpt-5\.6-sol"/, "no hard-coded direct model");
const resolveDirect = functionBody(runStore, "async function resolveDirectWorkerModel(");
assert.match(resolveDirect, /coraWorkerModelAvailability\(/, "only connected models are candidates");
assert.match(resolveDirect, /pickDirectWorkerModel\(chipModel, connected\)/);

// 3. A finished direct chat escalates to the manager for a follow-up the
// direct worker cannot serve, and that first manager turn replays the dialogue.
const addRunMessage = functionBody(runStore, "export async function addRunMessage(");
assert.match(addRunMessage, /followUpNeedsManager\(input\.message\)/);
assert.match(addRunMessage, /draft\.executionMode = "managed"/);
assert.ok(
  addRunMessage.indexOf("run.escalated_to_manager") < addRunMessage.indexOf("return addDirectIteration("),
  "the escalation runs before the direct dispatch",
);
assert.match(
  runStore,
  /const escalatedFromDirect =\s*draft\.sparkCalls\.length === 0 && draft\.workerTasks\.some\(\(task\) => Boolean\(task\.loomNodeId\)\);/,
  "only a chat with direct passes replays on its first manager turn",
);

console.log("composer first send reaches direct routing: ok");
