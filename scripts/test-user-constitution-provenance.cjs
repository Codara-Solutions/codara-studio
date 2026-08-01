#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-user-constitution-provenance-"));
const VALID = Object.freeze({
  enabledAtCapture: true,
  revision: 7,
  sha256: "a".repeat(64),
});

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return text.slice(from, to);
}

function runShape(overrides = {}) {
  return {
    sparkCalls: [],
    workerAttempts: [],
    ...overrides,
  };
}

async function main() {
  const outfile = path.join(TMP, "capture.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/user-constitution-capture.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  const {
    copyRunUserConstitutionCapture,
    copyUserConstitutionCapture,
    normalizeRunUserConstitutionProvenance,
    normalizeUserConstitutionCapture,
  } = require(outfile);

  const normalized = normalizeUserConstitutionCapture(VALID);
  assert.deepEqual(normalized, VALID);
  assert.notStrictEqual(normalized, VALID);
  assert.ok(Object.isFrozen(normalized));

  for (const malformed of [
    undefined,
    null,
    [],
    { ...VALID, ignored: true },
    { enabledAtCapture: "true", revision: 7, sha256: "a".repeat(64) },
    { enabledAtCapture: true, revision: 0, sha256: "a".repeat(64) },
    { enabledAtCapture: false, revision: -1, sha256: "a".repeat(64) },
    { enabledAtCapture: false, revision: 1.5, sha256: "a".repeat(64) },
    { enabledAtCapture: false, revision: 1, sha256: "A".repeat(64) },
    { enabledAtCapture: false, revision: 1, sha256: "a".repeat(63) },
  ]) {
    assert.throws(() => normalizeUserConstitutionCapture(malformed), /capture is invalid/);
  }
  assert.deepEqual(
    normalizeUserConstitutionCapture({
      enabledAtCapture: false,
      revision: 0,
      sha256: "b".repeat(64),
    }),
    { enabledAtCapture: false, revision: 0, sha256: "b".repeat(64) },
  );

  const run = runShape({ userConstitution: VALID });
  const retry = copyRunUserConstitutionCapture(run);
  const resume = copyRunUserConstitutionCapture(run);
  const compaction = copyRunUserConstitutionCapture(run);
  assert.deepEqual(retry, VALID);
  assert.deepEqual(resume, VALID);
  assert.deepEqual(compaction, VALID);
  assert.notStrictEqual(retry, run.userConstitution);
  assert.notStrictEqual(retry, resume);
  assert.notStrictEqual(resume, compaction);
  assert.ok([retry, resume, compaction].every(Object.isFrozen));
  assert.notStrictEqual(copyUserConstitutionCapture(VALID), VALID);

  const legacy = runShape({
    sparkCalls: [{ id: "legacy-call" }],
    workerAttempts: [{ id: "legacy-attempt" }],
  });
  normalizeRunUserConstitutionProvenance(legacy);
  assert.equal(Object.hasOwn(legacy, "userConstitution"), false);
  assert.equal(Object.hasOwn(legacy.sparkCalls[0], "userConstitution"), false);
  assert.equal(Object.hasOwn(legacy.workerAttempts[0], "userConstitution"), false);
  assert.equal(copyRunUserConstitutionCapture(legacy), undefined);

  const persisted = runShape({
    userConstitution: VALID,
    sparkCalls: [{ userConstitution: VALID }],
    workerAttempts: [{ userConstitution: VALID }],
  });
  normalizeRunUserConstitutionProvenance(persisted);
  assert.deepEqual(persisted.userConstitution, VALID);
  assert.deepEqual(persisted.sparkCalls[0].userConstitution, VALID);
  assert.deepEqual(persisted.workerAttempts[0].userConstitution, VALID);
  assert.notStrictEqual(persisted.userConstitution, persisted.sparkCalls[0].userConstitution);
  assert.notStrictEqual(
    persisted.sparkCalls[0].userConstitution,
    persisted.workerAttempts[0].userConstitution,
  );
  assert.ok(Object.isFrozen(persisted.userConstitution));
  assert.ok(Object.isFrozen(persisted.sparkCalls[0].userConstitution));
  assert.ok(Object.isFrozen(persisted.workerAttempts[0].userConstitution));

  for (const malformedRun of [
    runShape({ userConstitution: { ...VALID, extra: true } }),
    runShape({ sparkCalls: [{ userConstitution: undefined }] }),
    runShape({ workerAttempts: [{ userConstitution: { ...VALID, sha256: "0" } }] }),
  ]) {
    assert.throws(
      () => normalizeRunUserConstitutionProvenance(malformedRun),
      /capture is invalid or corrupted/,
    );
  }

  const runStore = source("src/main/orchestration/run-store.ts");
  const createRun = section(
    runStore,
    "async function createRunInternal(",
    "export async function getRun(",
  );
  assert.equal(
    (createRun.match(/await captureCurrentUserConstitution\(\)/g) ?? []).length,
    1,
    "new managed-run creation must capture current global provenance exactly once",
  );
  assert.match(createRun, /userConstitution:\s*copyUserConstitutionCapture\(userConstitution\)/);
  assert.match(
    runStore,
    /return createRunInternal\(input, runId\)/,
    "new reserved imported-PR runs must converge on the shared creator",
  );

  const manager = section(runStore, "async function askManagerBackend(", "function normalizeModelHint(");
  assert.match(manager, /copyRunUserConstitutionCapture\(run\)/);
  assert.doesNotMatch(manager, /captureCurrentUserConstitution/);
  const worker = section(runStore, "export async function prepareWorkerTask(", "export async function launchWorkerAttempt(");
  assert.match(worker, /copyRunUserConstitutionCapture\(run\)/);
  assert.doesNotMatch(worker, /captureCurrentUserConstitution/);
  const compact = section(runStore, "async function performAutoCompaction(", "async function markConversationRewindFailed(");
  assert.match(compact, /copyRunUserConstitutionCapture\(run\)/);
  assert.doesNotMatch(compact, /captureCurrentUserConstitution/);

  const normalize = section(runStore, "function normalizeRun(run: RunState)", "function recomputeRunCostRollups(");
  assert.match(normalize, /normalizeRunUserConstitutionProvenance\(run\)/);
  assert.doesNotMatch(normalize, /captureCurrentUserConstitution/);

  const types = source("src/shared/types.ts");
  assert.match(types, /export interface UserConstitutionCapture\s*{[\s\S]*readonly enabledAtCapture:[\s\S]*readonly revision:[\s\S]*readonly sha256:/);
  assert.equal(
    (types.match(/userConstitution\?: UserConstitutionCapture;/g) ?? []).length,
    3,
    "RunState, SparkCall, and WorkerAttempt must carry the exact optional capture",
  );

  for (const providerPath of [
    "src/main/orchestration/claude-backend.ts",
    "src/main/orchestration/codex-backend.ts",
    "src/main/orchestration/pi-backend.ts",
    "src/main/orchestration/worker-prompt.ts",
  ]) {
    assert.doesNotMatch(
      source(providerPath),
      /userConstitution/,
      `provenance-only change must not inject provider prompts: ${providerPath}`,
    );
  }

  console.log("PASS immutable user-constitution run/call/attempt provenance");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
