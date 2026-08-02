#!/usr/bin/env node
"use strict";

// Source contracts for native Codex worker fast mode propagation.
//
//   node scripts/test-codex-worker-fast-mode.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const runStore = read("src/main/orchestration/run-store.ts");
const structuredWorker = read("src/main/orchestration/structured-worker.ts");
const workerAccess = read("src/main/orchestration/worker-access.ts");
const providersCodex = read("src/main/providers/codex.ts");
const launchCommands = read("src/renderer/src/workers/launch-commands.ts");

assert.match(
  workerAccess,
  /fastMode === true \? "--enable" : "--disable", "fast_mode"/,
  "the helper makes false and absent settings explicit",
);
assert.match(
  runStore,
  /!usePiWorkerHarness && task\.runtimePreference === "codex"[\s\S]{0,220}loadSettings\(\)\.then\([\s\S]{0,180}\(\) => false/,
  "settings are read only for native Codex and failures resolve false",
);
assert.equal(
  runStore.match(/openAiFastMode: nativeCodexFastMode/g)?.length,
  2,
  "the same launch-time value reaches both native worker entry points",
);
assert.match(
  runStore,
  /openAiFastMode,\s*onStarted/,
  "the structured session forwards the immutable launch-time value",
);
assert.match(
  runStore,
  /args\.push\(\.\.\.codexFastModeArgs\(opts\?\.openAiFastMode\)\)/,
  "the visible native Codex CLI command receives the explicit pair",
);
assert.match(
  structuredWorker,
  /args\.push\(\.\.\.codexFastModeArgs\(input\.openAiFastMode\)\)/,
  "the native Codex app-server argv receives the explicit pair",
);

const launchBuilder = runStore.slice(
  runStore.indexOf("function buildLaunchCommandLine("),
  runStore.indexOf("function mapClaudeEffort("),
);
const claudeBranch = launchBuilder.slice(
  launchBuilder.indexOf('if (task.runtimePreference === "claude") {'),
  launchBuilder.indexOf('if (task.runtimePreference === "codex") {'),
);
assert.doesNotMatch(claudeBranch, /codexFastModeArgs|fast_mode|--enable|--disable/);
assert.match(launchBuilder, /return null;\s*\}/, "shell and manual tasks still have no launch command");

const claudeStructured = structuredWorker.slice(
  structuredWorker.indexOf("async function runClaudeWorker("),
  structuredWorker.indexOf("function asRecord("),
);
assert.doesNotMatch(claudeStructured, /codexFastModeArgs|fast_mode|--enable|--disable/);

const standingTerminal = runStore.slice(
  runStore.indexOf("function buildStandingTerminalCommand("),
  runStore.indexOf("function standingTerminalTitle("),
);
assert.doesNotMatch(standingTerminal, /fast_mode|--enable|--disable/);
assert.doesNotMatch(providersCodex, /fast_mode|--enable|--disable/);
assert.match(launchCommands, /CODEX_LAUNCH_COMMAND = "codex --yolo"/);
assert.match(launchCommands, /return `codex resume \$\{sessionId\} --yolo`/);
assert.doesNotMatch(launchCommands, /fast_mode|--enable|--disable/);

console.log(
  "PASS native Codex worker fast mode wiring, explicit false, Claude isolation, and manual terminal isolation",
);
