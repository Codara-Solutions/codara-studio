"use strict";

// Harness scoring: turns one bench run into a 0-100 score that rates HOW the
// harness worked, not just whether the tree ended up correct.
//
//   correctness   55  weighted checks; hidden contract checks keep 100 honest
//   efficiency    20  wall time and manager tokens against the task's par
//   discipline    15  time spent AFTER the visible tests first went green is
//                     waste (over-verification); never-green scores 0 here
//   orchestration 10  parallel tasks: did independent work actually overlap?
//                     everything else: economy — no worker armies on small jobs
//   penalties         -5 per question asked, -2 per crashed worker attempt,
//                     -5 for outliving the bench window
//
// Pars and weights are FROZEN. Changing them invalidates every score in
// history.jsonl, so a change must come with a new history file.

const WEIGHTS = { correctness: 55, efficiency: 20, discipline: 15, orchestration: 10 };

// How many workers each tier can use before economy penalties kick in. The
// floor is 2 everywhere: the completion gate requires a verifier worker after
// any files-changing implementation, so implementer + verifier is the minimum.
const TIER_WORKER_BUDGET = { trivial: 2, standard: 4, hard: 6, project: 12 };

// Post-green grace: the code-mandated verifier round plus the final manager
// turn legitimately happen after the tests go green. Only wrap-up beyond this
// counts as over-verification. The grace scales with tier because a real
// verification round on a five-module project is not the same work as on a
// one-line fix; without this, any harness that independently verifies at all
// is structurally locked out of a top score on big tasks.
const POST_GREEN_GRACE_MS = { trivial: 90_000, standard: 90_000, hard: 120_000, project: 180_000 };

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * @param task   bench task (tier, par, parallel, expectedParallel)
 * @param result one run's raw numbers:
 *   checks           [{ name, pass, weight }]
 *   wallMs           task wall clock
 *   greenAtMs        ms from start until the visible test first passed (null if never)
 *   tokens           manager input+output tokens
 *   workers          worker task count
 *   maxConcurrent    max simultaneously-running worker attempts
 *   questionsAsked   how often Cora blocked on a question
 *   churn            worker attempts that crashed (nonzero exit)
 *   runStatus        complete | timeout | failed | cancelled
 */
function scoreTask(task, result) {
  const parts = {};

  const totalWeight = result.checks.reduce((sum, check) => sum + (check.weight ?? 1), 0);
  const passedWeight = result.checks.reduce(
    (sum, check) => sum + (check.pass ? (check.weight ?? 1) : 0),
    0,
  );
  parts.correctness = WEIGHTS.correctness * (totalWeight > 0 ? passedWeight / totalWeight : 0);

  const wallRatio = result.wallMs > 0 ? clamp01((task.par.wallS * 1000) / result.wallMs) : 0;
  const tokenRatio = result.tokens > 0 ? clamp01((task.par.tokensK * 1000) / result.tokens) : 0;
  parts.efficiency = (WEIGHTS.efficiency / 2) * (wallRatio + tokenRatio);

  if (result.greenAtMs === null || result.greenAtMs === undefined) {
    parts.discipline = 0;
  } else {
    const grace = POST_GREEN_GRACE_MS[task.tier] ?? 90_000;
    const excess = Math.max(0, result.wallMs - result.greenAtMs - grace);
    parts.discipline = WEIGHTS.discipline * clamp01(1 - (2 * excess) / Math.max(1, result.wallMs));
  }

  if (task.parallel) {
    // Reward the OUTCOME parallelism exists to buy, not fan-out for its own
    // sake: full credit for genuine overlap, and equally for finishing the
    // parallelizable work under par without it. Micro-slices done fast by one
    // worker beat cold-started worker fleets; the score must not punish that.
    const expected = Math.max(2, task.expectedParallel ?? 2);
    const fanOut = clamp01((result.maxConcurrent - 1) / (expected - 1));
    const beatPar = result.wallMs <= task.par.wallS * 1000 ? 1 : 0;
    parts.orchestration = WEIGHTS.orchestration * Math.max(fanOut, beatPar);
  } else {
    const budget = TIER_WORKER_BUDGET[task.tier] ?? 3;
    const excess = Math.max(0, (result.workers ?? 0) - budget);
    parts.orchestration = Math.max(0, WEIGHTS.orchestration - excess * 3);
  }

  parts.penalties =
    -5 * (result.questionsAsked ?? 0) -
    2 * (result.churn ?? 0) -
    (result.runStatus === "timeout" ? 5 : 0);

  const total = Math.max(
    0,
    Math.min(100, parts.correctness + parts.efficiency + parts.discipline + parts.orchestration + parts.penalties),
  );
  return { total: round1(total), parts: mapValues(parts, round1) };
}

/** Suite rollup: mean score plus the per-tier calibration read-out. */
function summarize(scored) {
  const score = round1(scored.reduce((sum, s) => sum + s.score.total, 0) / Math.max(1, scored.length));
  const tiers = {};
  for (const s of scored) {
    const tier = (tiers[s.task.tier] ??= { count: 0, parRatioSum: 0 });
    tier.count += 1;
    tier.parRatioSum += s.result.wallMs / (s.task.par.wallS * 1000);
  }
  const calibration = Object.fromEntries(
    Object.entries(tiers).map(([tier, t]) => [tier, round1(t.parRatioSum / t.count)]),
  );
  return { score, calibration };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

module.exports = { scoreTask, summarize, WEIGHTS, TIER_WORKER_BUDGET };
