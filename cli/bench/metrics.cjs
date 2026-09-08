"use strict";

function trialPassed(result) {
  return result.runStatus === "complete" && result.checks.length > 0 && result.checks.every((check) => check.pass === true);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function wilsonInterval(passed, trials) {
  if (!trials) return null;
  const z = 1.959963984540054;
  const proportion = passed / trials;
  const denominator = 1 + z * z / trials;
  const center = (proportion + z * z / (2 * trials)) / denominator;
  const margin = z * Math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function acceptanceSummary(rows) {
  const accepted = rows.filter(trialPassed);
  const perTask = Object.fromEntries([...new Set(rows.map((row) => row.task))].map((task) => {
    const trials = rows.filter((row) => row.task === task);
    const passed = trials.filter(trialPassed).length;
    return [task, {
      passed,
      trials: trials.length,
      passRate: passed / trials.length,
      passRate95CI: wilsonInterval(passed, trials.length),
      allTrialsPassed: passed === trials.length,
    }];
  }));
  return {
    passed: accepted.length,
    oneShotTrials: rows.filter((row) => !row.staged).length,
    oneShotPassed: accepted.filter((row) => !row.staged && (row.questions ?? 0) === 0).length,
    trials: rows.length,
    passRate: rows.length ? accepted.length / rows.length : null,
    // Across-task trials are not identically distributed. Confidence bounds
    // belong to each repeated task, not an inflated pooled sample size.
    perTask,
    acceptedMedianWallMs: median(accepted.map((row) => row.wallMs)),
    acceptedMedianTokens: median(accepted.map((row) => row.tokens).filter((value) => Number.isFinite(value) && value > 0)),
    missingUsageTrials: rows.filter((row) => !Number.isFinite(row.tokens) || row.tokens <= 0).length,
  };
}

module.exports = { trialPassed, acceptanceSummary, wilsonInterval };
