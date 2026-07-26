"use strict";
// Deterministic check of the long-run manager-context compaction implemented in
// src/main/orchestration/manager-protocol.ts (formatCompactRunState ->
// existingSteps). LLM evals can't affordably reach the 30-50+ step depth where
// the reviewSummary cap engages, so this proves the bounding property directly.
//
// The compaction logic below MIRRORS the source rule. If you change the source
// (STEP_REVIEW_DETAIL_CAP or the keepReviewDetail predicate), mirror it here.
// Run: node scripts/check-manager-compaction.cjs

const STEP_REVIEW_DETAIL_CAP = 12;
const truncate = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) : s; };
const isTerminal = (status) => status === "complete" || status === "failed" || status === "skipped";

// --- mirror of the source compaction (existingSteps branch) ---
function compactExistingSteps(steps) {
  const reviewDetailStart = Math.max(0, steps.length - STEP_REVIEW_DETAIL_CAP);
  let omittedOlderStepSummaries = 0;
  const existingSteps = steps.map((step, index) => {
    const keep = index >= reviewDetailStart || !isTerminal(step.status);
    if (!keep && step.reviewSummary) omittedOlderStepSummaries += 1;
    return {
      id: step.id,
      index: step.index,
      title: truncate(step.title, keep ? 180 : 120),
      kind: step.kind || "worker_batch",
      status: step.status,
      reviewSummary: keep && step.reviewSummary ? truncate(step.reviewSummary, 500) : undefined,
    };
  });
  return { existingSteps, omittedOlderStepSummaries };
}

// --- the OLD behavior: every step carries its full reviewSummary every turn ---
function legacyExistingSteps(steps) {
  return steps.map((step) => ({
    id: step.id,
    index: step.index,
    title: truncate(step.title, 180),
    kind: step.kind || "worker_batch",
    status: step.status,
    reviewSummary: step.reviewSummary ? truncate(step.reviewSummary, 500) : undefined,
  }));
}

function makeSteps(n, { lastNonTerminal = 1 } = {}) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    const terminal = i < n - lastNonTerminal;
    steps.push({
      id: "step-" + i,
      index: i + 1,
      title: "Step " + (i + 1) + " build module " + i,
      kind: "worker_batch",
      status: terminal ? "complete" : i === n - 1 ? "ready" : "reviewing",
      reviewSummary: "S".repeat(480) + " #" + i,
    });
  }
  return steps;
}

const bytes = (obj) => JSON.stringify(obj).length;
const A = (c, m) => { if (!c) { console.error("FAIL  " + m); process.exitCode = 1; } else console.log("PASS  " + m); };

// 1) No regression for short runs (n <= cap): compacted === legacy.
{
  const steps = makeSteps(5);
  const { existingSteps, omittedOlderStepSummaries } = compactExistingSteps(steps);
  A(JSON.stringify(existingSteps) === JSON.stringify(legacyExistingSteps(steps)), "n=5 identical to legacy (no regression on short runs)");
  A(omittedOlderStepSummaries === 0, "n=5 omits nothing");
  A(existingSteps.every((s) => s.reviewSummary), "n=5 every step keeps reviewSummary");
}

// 2) Long run: review detail bounded to cap (+ frontier); skeleton kept for all.
{
  const n = 40;
  const { existingSteps, omittedOlderStepSummaries } = compactExistingSteps(makeSteps(n));
  A(existingSteps.length === n, "n=40 keeps a skeleton for all " + n + " steps");
  const withSummary = existingSteps.filter((s) => s.reviewSummary).length;
  A(withSummary === STEP_REVIEW_DETAIL_CAP, "n=40 review detail bounded to cap (" + withSummary + ")");
  A(omittedOlderStepSummaries === n - STEP_REVIEW_DETAIL_CAP, "n=40 omitted count correct (" + omittedOlderStepSummaries + ")");
  A(existingSteps[0].reviewSummary === undefined, "n=40 oldest terminal step drops reviewSummary");
  A(existingSteps[0].status === "complete" && existingSteps[0].title.length > 0, "n=40 oldest step still carries skeleton (id/title/status)");
}

// 3) Active frontier never loses detail even when far from the tail.
{
  const steps = makeSteps(40);
  steps[0].status = "blocked"; // an early step reopened by a replan/brake
  const { existingSteps } = compactExistingSteps(steps);
  A(existingSteps[0].reviewSummary !== undefined, "frontier: non-terminal step at index 0 keeps reviewSummary despite being old");
}

// 4) Sub-linear growth + concrete savings at scale.
{
  const s10 = compactExistingSteps(makeSteps(10)).existingSteps;
  const s100 = compactExistingSteps(makeSteps(100)).existingSteps;
  const legacy100 = legacyExistingSteps(makeSteps(100));
  const ratio = bytes(s100) / bytes(s10);
  A(ratio < 4, "n=100 grows sub-linearly vs n=10 (ratio " + ratio.toFixed(1) + "x; legacy is ~10x)");
  const reduction = 1 - bytes(s100) / bytes(legacy100);
  A(reduction > 0.5, "n=100 compacted >50% smaller than legacy (saved " + (reduction * 100).toFixed(0) + "%)");
  console.log("      bytes: compacted n=10=" + bytes(s10) + ", compacted n=100=" + bytes(s100) + ", legacy n=100=" + bytes(legacy100));
}

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nAll compaction checks passed.");
