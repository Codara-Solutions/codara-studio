#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "lib",
  "worker-session-memory.ts",
);

async function main() {
  const output = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.web.json"),
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  const T = mod.exports;

  assert.match(T.workerSessionMemoryDeleteOption("claude").detail, /Claude project/);
  assert.equal(T.workerSessionMemoryScope("claude", true), "claude-project");
  assert.match(T.workerSessionMemoryDeleteOption("codex").detail, /Codex memories/);
  assert.equal(T.workerSessionMemoryScope("codex", true), "codex-all");
  assert.equal(
    T.workerSessionMemoryDeleteOption("grok"),
    null,
    "Grok session deletion must not advertise another runtime's memory",
  );
  assert.equal(
    T.workerSessionMemoryScope("grok", true),
    "none",
    "even stale checked UI state cannot turn a Grok delete into a Codex purge",
  );
  assert.equal(T.workerSessionMemoryScope("codex", false), "none");
  console.log("Worker session memory option contracts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
