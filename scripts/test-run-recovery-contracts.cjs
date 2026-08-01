#!/usr/bin/env node
"use strict";

// Contract tests for three fixes that came out of run-msamjw8y-tnthy2 and
// run-msang7ge-codl0u:
//
//   1. A manager turn that TIMED OUT parks the run resumable instead of
//      branding it failed. The old `fail` verdict terminalized a worker that
//      was three commits from done and then invented cleanup work against a
//      tree that did not need it.
//   2. A plan_approval ask must state whether the plan was actually proven.
//      Six read-only planners spent 11 minutes agreeing on a 16-commit split
//      that did not compile; the user approved it on their authority.
//   3. A worker's retained artifacts are a structured handoff, so the next
//      worker is handed the 24-minute dry run instead of rebuilding it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

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
    if (specifier.startsWith(".")) {
      return loadTypeScriptModule(path.join(path.dirname(resolved), `${specifier}.ts`));
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}

const orchestration = path.join(__dirname, "..", "src", "main", "orchestration");
const { planManagerTurnFailure } = loadTypeScriptModule(
  path.join(orchestration, "manager-turn-policy.ts"),
);
const { planValidationAskProblem, parsePlanValidation } = loadTypeScriptModule(
  path.join(orchestration, "run-question-policy.ts"),
);

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

// ── 1. A timed-out manager turn parks; it does not fail ───────────────────

const TURN_TIMEOUT = "Cora's Pi turn timed out.";

check("a manager-turn timeout parks the run instead of failing it", () => {
  const plan = planManagerTurnFailure({
    error: TURN_TIMEOUT,
    runStatus: "reviewing",
    mode: "chat",
    transientRetryCount: 0,
    backend: "pi",
  });
  assert.equal(plan.action, "park", "failing here killed a worker that was still working");
  assert.equal(plan.kind, "timeout");
  assert.equal(plan.lastAction, "chat_turn_parked");
  assert.ok(plan.parkReason.length > 0);
});

check("the park reason tells the user their workers survived", () => {
  const plan = planManagerTurnFailure({
    error: TURN_TIMEOUT,
    runStatus: "running",
    mode: "chat",
    transientRetryCount: 0,
    backend: "pi",
  });
  assert.equal(plan.action, "park");
  assert.match(plan.parkReason, /kept running/i,
    "the whole point of parking is that in-flight work is not lost; say so");
  assert.match(plan.parkReason, /retry/i, "and name the control that actually exists");
});

check("the new idle-timeout message also parks", () => {
  // waitForSettled's wording changed with the inactivity cap; the taxonomy has
  // to keep classifying it, or the park silently reverts to a fail.
  for (const error of [
    "Cora's Pi turn went quiet for 25 min with no tool call in flight.",
    "Cora's Pi turn is stuck in codara_wait_for_workers: 30 min with no result, past the point that call can legally take.",
    "Cora's Pi turn exceeded its 6h ceiling.",
  ]) {
    const plan = planManagerTurnFailure({
      error,
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 0,
      backend: "pi",
    });
    assert.equal(plan.action, "park", `should park, got ${plan.action} for: ${error}`);
  }
});

check("a real failure still fails", () => {
  const plan = planManagerTurnFailure({
    error: "spawn codex ENOENT",
    runStatus: "running",
    mode: "chat",
    transientRetryCount: 0,
    backend: "pi",
  });
  assert.equal(plan.action, "fail", "a broken launch is the turn genuinely failing");
});

check("a terminal run is never rewritten by a late timeout", () => {
  for (const runStatus of ["complete", "cancelled", "failed", "blocked", "paused"]) {
    const plan = planManagerTurnFailure({
      error: TURN_TIMEOUT,
      runStatus,
      mode: "chat",
      transientRetryCount: 0,
      backend: "pi",
    });
    assert.equal(plan.action, "keep_state", `${runStatus} must survive a late turn timeout`);
  }
});

// ── 2. plan_approval must declare whether the plan was proven ─────────────

check("a plan_approval ask with no validation claim is rejected", () => {
  const problem = planValidationAskProblem("plan_approval", undefined);
  assert.ok(problem, "silence about verification is exactly what shipped the unbuildable plan");
  assert.match(problem, /planValidation/);
  assert.match(problem, /validated/);
  assert.match(problem, /unvalidated/);
  assert.match(problem, /not_applicable/);
});

check("a validated ask with real evidence passes", () => {
  const problem = planValidationAskProblem("plan_approval", {
    status: "validated",
    evidence: "dry-ran all 16 commit boundaries in a scratch worktree; tsc + jest green at each",
  });
  assert.equal(problem, null);
});

check("an evidence-free claim is rejected whatever its status", () => {
  for (const status of ["validated", "unvalidated", "not_applicable"]) {
    const problem = planValidationAskProblem("plan_approval", { status, evidence: "   " });
    assert.ok(problem, `${status} without evidence must not pass`);
    assert.match(problem, /evidence/);
  }
});

check("an honest unvalidated claim is allowed through, and warns the user", () => {
  const problem = planValidationAskProblem("plan_approval", {
    status: "unvalidated",
    evidence: "no scratch worktree was built; the boundaries were reasoned about only",
  });
  assert.equal(problem, null, "the gate forces disclosure, it does not forbid honesty");
});

check("non-approval questions are untouched", () => {
  for (const category of [
    "credentials_access",
    "destructive_irreversible",
    "safety_policy",
    "irreducible_product_scope",
    undefined,
  ]) {
    assert.equal(planValidationAskProblem(category, undefined), null);
  }
});

check("untrusted planValidation payloads are normalized or dropped", () => {
  assert.equal(parsePlanValidation(null), null);
  assert.equal(parsePlanValidation("validated"), null);
  assert.equal(parsePlanValidation([]), null);
  assert.equal(parsePlanValidation({ status: "probably", evidence: "x" }), null);
  assert.deepEqual(parsePlanValidation({ status: "validated", evidence: "  ran tsc  " }), {
    status: "validated",
    evidence: "ran tsc",
  });
  const long = parsePlanValidation({ status: "validated", evidence: "x".repeat(5000) });
  assert.ok(long.evidence.length <= 600, "evidence must be bounded before it is persisted");
});

// ── 3. Retained work is a structured handoff ──────────────────────────────

const { readWorkerReport } = loadTypeScriptModule(path.join(orchestration, "worker-report.ts"));
const os = require("node:os");

check("a report's handoff artifacts survive parsing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cora-handoff-"));
  const file = path.join(dir, "final-report.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "blocked",
      summary: "Built the full dry run, could not commit without an amendment.",
      handoff: [
        {
          path: "/tmp/cora-bisect",
          description: "Complete validated dry run of all 16 commit boundaries.",
          reuse: "python3 build.py dryrun 1 16 replays it; do not rebuild the plan.",
        },
        { description: "no path, must be dropped", reuse: "n/a" },
      ],
    }),
    "utf8",
  );
  return readWorkerReport(file).then((report) => {
    assert.equal(report.handoff.length, 1, "a handoff with no path points at nothing");
    assert.equal(report.handoff[0].path, "/tmp/cora-bisect");
    assert.match(report.handoff[0].reuse, /replays it/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

check("a report with no handoff stays undefined rather than empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cora-handoff-"));
  const file = path.join(dir, "final-report.json");
  fs.writeFileSync(file, JSON.stringify({ status: "complete", summary: "done" }), "utf8");
  return readWorkerReport(file).then((report) => {
    assert.equal(report.handoff, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

check("the successor prompt actually hands the artifacts over", () => {
  const source = fs.readFileSync(path.join(orchestration, "worker-prompt.ts"), "utf8");
  assert.match(source, /## WORK ALREADY DONE FOR YOU/,
    "a handoff nobody is shown is the prose-summary situation all over again");
  assert.match(source, /INSPECT THEM BEFORE PLANNING/);
  const runStore = fs.readFileSync(path.join(orchestration, "run-store.ts"), "utf8");
  assert.match(runStore, /collectPriorWorkerHandoffs/,
    "the prompt section is only real if prepareWorkerTask populates it");
  assert.match(runStore, /priorHandoffs,/);
});

Promise.all(results.filter((r) => r && typeof r.then === "function")).then(() => {
  for (const name of results) console.log(`PASS ${name}`);
  console.log(`\n${results.length} run recovery contract checks passed.`);
});
