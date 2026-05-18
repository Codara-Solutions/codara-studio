#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { readResults } = require("./scorecard.cjs");

const DEFAULT_BASELINE = "spark_sequential";
const DEFAULT_CHALLENGER = "spark_hybrid_parallel";

function parseArgs(argv) {
  const out = {
    dir: path.join(__dirname, "..", "results"),
    baseline: DEFAULT_BASELINE,
    challenger: DEFAULT_CHALLENGER,
    minSpeedupPct: 0.1,
    minSpeedupSeconds: 20,
    qualityTolerance: 0.05,
    requirePeerMessages: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") out.baseline = argv[++i] || out.baseline;
    else if (arg === "--challenger") out.challenger = argv[++i] || out.challenger;
    else if (arg === "--min-speedup-pct") out.minSpeedupPct = Number(argv[++i] || out.minSpeedupPct);
    else if (arg === "--min-speedup-seconds") out.minSpeedupSeconds = Number(argv[++i] || out.minSpeedupSeconds);
    else if (arg === "--quality-tolerance") out.qualityTolerance = Number(argv[++i] || out.qualityTolerance);
    else if (arg === "--no-require-peer-messages") out.requirePeerMessages = false;
    else if (!arg.startsWith("-")) out.dir = path.resolve(arg);
  }
  return out;
}

function judgeResults(results, opts = {}) {
  const options = {
    baseline: opts.baseline || DEFAULT_BASELINE,
    challenger: opts.challenger || DEFAULT_CHALLENGER,
    minSpeedupPct: finiteOr(opts.minSpeedupPct, 0.1),
    minSpeedupSeconds: finiteOr(opts.minSpeedupSeconds, 20),
    qualityTolerance: finiteOr(opts.qualityTolerance, 0.05),
    requirePeerMessages: opts.requirePeerMessages !== false,
  };
  const pairs = buildPairs(results, options);
  const comparisons = pairs.map((pair) => comparePair(pair, options));
  const baselineStats = summarizeVariant(results, options.baseline);
  const challengerStats = summarizeVariant(results, options.challenger);
  const collaboration = summarizeCollaboration(comparisons, options);
  const recommendations = buildRecommendations({
    comparisons,
    baselineStats,
    challengerStats,
    collaboration,
    options,
  });
  const verdict = chooseVerdict({
    comparisons,
    baselineStats,
    challengerStats,
    collaboration,
    options,
  });
  return {
    judge: "spark_best_fastest_judge_v1",
    generatedAt: new Date().toISOString(),
    options,
    verdict,
    summary: {
      comparablePairs: comparisons.length,
      baseline: baselineStats,
      challenger: challengerStats,
      wins: countBy(comparisons, "winner"),
      reasons: countBy(comparisons, "reason"),
      collaboration,
    },
    comparisons,
    recommendations,
  };
}

function buildPairs(results, options) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.task.id}:${result.run.repetition}`;
    const group = groups.get(key) || {};
    group[result.variant.id] = result;
    groups.set(key, group);
  }
  const pairs = [];
  for (const group of groups.values()) {
    const baseline = group[options.baseline];
    const challenger = group[options.challenger];
    if (baseline && challenger) pairs.push({ baseline, challenger });
  }
  return pairs;
}

function comparePair(pair, options) {
  const base = pair.baseline;
  const challenge = pair.challenger;
  const basePassed = Boolean(base.quality.passed);
  const challengePassed = Boolean(challenge.quality.passed);
  const qualityDelta = round((challenge.quality.score || 0) - (base.quality.score || 0));
  const durationDeltaSeconds = round((base.run.durationSeconds || 0) - (challenge.run.durationSeconds || 0));
  const speedupPct = base.run.durationSeconds > 0
    ? round(durationDeltaSeconds / base.run.durationSeconds)
    : 0;
  const collaborationExpected = expectsPeerCollaboration(challenge);
  const peerAgents = number(challenge.telemetry.peerAgentCount);
  const peerMessages = number(challenge.telemetry.peerMessageCount);
  const maxConcurrentWorkers = number(challenge.telemetry.maxConcurrentWorkers);
  const parallelLaunchGroups = number(challenge.telemetry.parallelLaunchGroups);
  const collaborationOk = !collaborationExpected || (
    maxConcurrentWorkers >= 2 &&
    peerAgents >= 2 &&
    (!options.requirePeerMessages || peerMessages >= 1)
  );

  let winner = "tie";
  let reason = "equivalent";
  if (challengePassed && !basePassed) {
    winner = options.challenger;
    reason = "challenger_passed_baseline_failed";
  } else if (!challengePassed && basePassed) {
    winner = options.baseline;
    reason = "quality_regression_failed_gates";
  } else if (!challengePassed && !basePassed) {
    winner = "tie";
    reason = "both_failed_gates";
  } else if (qualityDelta < -options.qualityTolerance) {
    winner = options.baseline;
    reason = "quality_regression_score";
  } else if (qualityDelta > options.qualityTolerance) {
    winner = options.challenger;
    reason = "quality_improvement";
  } else if (durationDeltaSeconds >= options.minSpeedupSeconds || speedupPct >= options.minSpeedupPct) {
    winner = options.challenger;
    reason = "faster_at_equal_quality";
  } else if (-durationDeltaSeconds >= options.minSpeedupSeconds || -speedupPct >= options.minSpeedupPct) {
    winner = options.baseline;
    reason = "slower_at_equal_quality";
  }

  return {
    taskId: challenge.task.id,
    taskCategory: challenge.task.category,
    repetition: challenge.run.repetition,
    winner,
    reason,
    baseline: resultSummary(base),
    challenger: resultSummary(challenge),
    deltas: {
      qualityScore: qualityDelta,
      durationSeconds: durationDeltaSeconds,
      speedupPct,
    },
    collaboration: {
      expected: collaborationExpected,
      ok: collaborationOk,
      maxConcurrentWorkers,
      parallelLaunchGroups,
      peerAgents,
      peerMessages,
    },
  };
}

function resultSummary(result) {
  return {
    variantId: result.variant.id,
    passed: Boolean(result.quality.passed),
    qualityScore: number(result.quality.score),
    hiddenGateRatio: number(result.quality.hiddenGateRatio),
    durationSeconds: number(result.run.durationSeconds),
    finalStatus: result.run.finalStatus,
    workerCount: number(result.telemetry.workerCount),
    maxConcurrentWorkers: number(result.telemetry.maxConcurrentWorkers),
    parallelLaunchGroups: number(result.telemetry.parallelLaunchGroups),
    peerMessages: number(result.telemetry.peerMessageCount),
  };
}

function summarizeVariant(results, variantId) {
  const list = results.filter((result) => result.variant.id === variantId);
  return {
    variantId,
    runs: list.length,
    passRate: round(mean(list.map((result) => result.quality.passed ? 1 : 0))),
    qualityScore: round(mean(list.map((result) => result.quality.score))),
    medianDurationSeconds: round(median(list.map((result) => result.run.durationSeconds))),
    medianMaxConcurrentWorkers: round(median(list.map((result) => result.telemetry.maxConcurrentWorkers))),
    meanPeerMessages: round(mean(list.map((result) => result.telemetry.peerMessageCount))),
  };
}

function summarizeCollaboration(comparisons, options) {
  const expected = comparisons.filter((comparison) => comparison.collaboration.expected);
  const ok = expected.filter((comparison) => comparison.collaboration.ok);
  return {
    expectedRuns: expected.length,
    okRuns: ok.length,
    requiredPeerMessages: options.requirePeerMessages,
    allExpectedRunsOk: expected.length === 0 || ok.length === expected.length,
    totalPeerMessages: expected.reduce((sum, comparison) => sum + comparison.collaboration.peerMessages, 0),
    maxConcurrentWorkers: expected.reduce(
      (max, comparison) => Math.max(max, comparison.collaboration.maxConcurrentWorkers),
      0,
    ),
  };
}

function chooseVerdict({ comparisons, baselineStats, challengerStats, collaboration, options }) {
  if (comparisons.length === 0) {
    return {
      status: "insufficient_data",
      winner: null,
      reason: "No comparable baseline/challenger result pairs were found.",
      promoteHybrid: false,
    };
  }
  const wins = countBy(comparisons, "winner");
  const bothFailed = comparisons.every((comparison) =>
    !comparison.baseline.passed && !comparison.challenger.passed
  );
  if (bothFailed) {
    return {
      status: "fix_quality",
      winner: null,
      reason: "Both baseline and hybrid failed gates; speed is not promotable until correctness passes.",
      promoteHybrid: false,
    };
  }
  const regression = comparisons.find((comparison) =>
    comparison.winner === options.baseline &&
    comparison.reason.startsWith("quality_regression")
  );
  if (regression || challengerStats.passRate < baselineStats.passRate) {
    return {
      status: "keep_sequential",
      winner: options.baseline,
      reason: regression
        ? `Hybrid regressed quality on ${regression.taskId}.`
        : "Hybrid pass rate is below the sequential baseline.",
      promoteHybrid: false,
    };
  }
  if (!collaboration.allExpectedRunsOk) {
    return {
      status: "tune_hybrid_collaboration",
      winner: null,
      reason: "Hybrid did not prove peer collaboration on a task designed to require it.",
      promoteHybrid: false,
    };
  }
  if ((wins[options.challenger] || 0) > (wins[options.baseline] || 0)) {
    return {
      status: "promote_hybrid",
      winner: options.challenger,
      reason: "Hybrid beat sequential on paired runs without quality regression.",
      promoteHybrid: true,
    };
  }
  return {
    status: "needs_more_data",
    winner: null,
    reason: "Hybrid is not worse, but it has not yet shown a clear speed or quality win.",
    promoteHybrid: false,
  };
}

function buildRecommendations({ comparisons, baselineStats, challengerStats, collaboration, options }) {
  const out = [];
  if (comparisons.length === 0) {
    out.push("Run both spark_sequential and spark_hybrid_parallel on the same task/repetition before judging.");
    return out;
  }
  if (comparisons.some((comparison) => !comparison.baseline.passed && !comparison.challenger.passed)) {
    out.push("Both variants failed at least one comparable task; fix the task contract or worker prompting before using speed as a decision signal.");
  }
  if (challengerStats.passRate < baselineStats.passRate) {
    out.push("Do not optimize for speed yet; fix hybrid correctness until pass rate matches sequential.");
  }
  if (!collaboration.allExpectedRunsOk) {
    if (collaboration.maxConcurrentWorkers < 2) {
      out.push("Hybrid did not launch true peers on the peer task; tighten manager decomposition or allowedPaths so at least two non-conflicting workers run.");
    }
    if (collaboration.totalPeerMessages < 1 && options.requirePeerMessages) {
      out.push("Hybrid launched peers but did not prove two-way help; require a short contract note through the mailbox on shared-interface tasks.");
    }
  }
  const challengerSpeedWins = comparisons.filter((comparison) => comparison.reason === "faster_at_equal_quality").length;
  if (challengerSpeedWins === 0 && challengerStats.passRate >= baselineStats.passRate) {
    out.push("Hybrid quality is acceptable, but speed is not proven; profile manager-call count and worker critical path before adding more workers.");
  }
  if (out.length === 0) {
    out.push("Hybrid is a promotion candidate; run at least 3 repetitions before making it the default.");
  }
  return out;
}

function expectsPeerCollaboration(result) {
  return result.task.category === "parallel_contract" || /peer|contract|coordination/i.test(result.task.id);
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  const numeric = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (numeric.length === 0) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function number(value) {
  return finiteOr(value, 0);
}

function round(value) {
  return Math.round(number(value) * 1000) / 1000;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = judgeResults(readResults(args.dir), args);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { judgeResults };
