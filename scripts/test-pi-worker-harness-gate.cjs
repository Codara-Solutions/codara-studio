#!/usr/bin/env node
"use strict";

// Pins the worker-harness contract after the 2026-08 legacy-harness removal.
//
// Every autonomous Cora worker runs on the bundled Pi harness. The
// runtimePreference the manager sets ("claude" or "codex") selects the model
// PROVIDER (anthropic / openai-codex), not a command-line tool. The legacy
// CLI worker transports and their SPARK_E2E_LEGACY_WORKER_HARNESS escape
// hatch were deleted; this harness asserts they cannot silently return.
//
//   node scripts/test-pi-worker-harness-gate.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ── 1. The escape hatch is gone from the entire main-process source ────────
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
for (const file of walk(path.join(ROOT, "src"))) {
  assert.equal(
    fs.readFileSync(file, "utf8").includes("SPARK_E2E_LEGACY_WORKER_HARNESS"),
    false,
    `${path.relative(ROOT, file)} still references the deleted legacy worker harness gate`,
  );
}

// ── 2. The deleted legacy transports stay deleted ──────────────────────────
for (const gone of [
  "src/main/orchestration/structured-worker.ts",
  "src/main/orchestration/cli-session.ts",
  "src/main/orchestration/jsonl-tail.ts",
]) {
  assert.equal(
    fs.existsSync(path.join(ROOT, gone)),
    false,
    `${gone} was deleted with the legacy worker harness and must not return`,
  );
}

// ── 3. run-store launches workers on the Pi harness unconditionally ────────
const runStore = fs.readFileSync(
  path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
  "utf8",
);
assert.match(
  runStore,
  /result = isPiWorker\s*\?\s*await runPiWorkerSession\(/,
  "run-store must dispatch claude/codex worker attempts straight to runPiWorkerSession",
);
assert.match(
  runStore,
  /const isPiWorker =\s*\n?\s*task\.runtimePreference === "claude" \|\| task\.runtimePreference === "codex";/,
  "the Pi-harness predicate is provider preference only — no env escape hatch",
);
for (const legacySymbol of [
  "runStructuredWorker",
  "runStructuredAutomationWorkerSession",
  "buildLaunchCommandLine(task",
]) {
  assert.equal(
    runStore.includes(legacySymbol),
    false,
    `run-store still mentions legacy transport symbol ${legacySymbol}`,
  );
}

// ── 4. worker-prompt's harness predicate is provider-preference only ───────
const workerPrompt = fs.readFileSync(
  path.join(ROOT, "src", "main", "orchestration", "worker-prompt.ts"),
  "utf8",
);
const gateMatch = workerPrompt.match(
  /function usesPiWorkerHarness\([^)]*\): boolean \{\n([\s\S]*?)\n\}/,
);
assert.ok(gateMatch, "worker-prompt.ts must keep its usesPiWorkerHarness predicate");
const evaluateGate = new Function(
  "run",
  "task",
  gateMatch[1],
);
for (const runtimePreference of ["claude", "codex"]) {
  assert.equal(
    evaluateGate({}, { runtimePreference }),
    true,
    `runtimePreference "${runtimePreference}" must use the Pi worker harness`,
  );
}
for (const runtimePreference of ["shell", "manual", "", undefined]) {
  assert.equal(
    Boolean(evaluateGate({}, { runtimePreference })),
    false,
    `runtimePreference "${String(runtimePreference)}" is not an autonomous provider`,
  );
}

console.log("test-pi-worker-harness-gate: all assertions passed");
