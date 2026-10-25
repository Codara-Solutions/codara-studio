#!/usr/bin/env node
"use strict";

// A workflow agent's prompt leaves Cora memory out on purpose: the agent()
// prompt is its whole input, and a resumed run trusts a cached answer to the
// same prompt. The same memory must not arrive later either, through the copy
// a Pi worker re-sends after each compaction (workerMemoryContext).
//
//   node scripts/test-workflow-agent-memory.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const stubs = {
  name: "workflow-agent-memory-stubs",
  setup(build) {
    build.onResolve({ filter: /^\.\/cora-memory$/ }, () => ({ path: "cora-memory", namespace: "stub" }));
    build.onLoad({ filter: /^cora-memory$/, namespace: "stub" }, () => ({
      contents: `export function formatCoraMemoryForWorker() { return "CORA MEMORY\\n- Answer in Spanish."; }`,
      loader: "js",
    }));
  },
};

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "worker-prompt.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    external: ["electron"],
    plugins: [stubs],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { workerMemoryContext } = await load();
  const run = { id: "run-1", workspaceId: "ws1", coraProfileId: "default" };
  const task = { title: "Audit", description: "Audit the parser." };
  assert.match(workerMemoryContext(run, task), /Answer in Spanish/, "a chat worker carries memory");
  assert.equal(
    workerMemoryContext(run, { ...task, workflowCall: { runId: "run-1", seq: 3 } }),
    null,
    "a workflow agent carries no memory, so a compaction cannot add it",
  );
  assert.equal(workerMemoryContext({ ...run, automationId: "auto-1" }, task), null);
  const runStore = fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "run-store.ts"), "utf8");
  assert.match(runStore, /const pinnedMemory = \(\): string \| null => \{[\s\S]{0,200}?workerMemoryContext\(run, task\)/);
  console.log("PASS workflow agents never receive Cora memory, before or after a compaction");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
