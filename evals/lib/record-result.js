// Record-result: assemble a normalized eval-result.json from a single
// adapter run + gate results + judge verdicts.
//
// The shape mirrors evals/results/example-result.json so consumers (the
// scorecard script, dashboards, the integration judge) can read both
// historical and freshly-produced results with the same parser.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {Object} RecordResultInput
 * @property {string} taskId
 * @property {string} adapterId
 * @property {string} runId
 * @property {string} startedAt        ISO8601
 * @property {string} finishedAt       ISO8601
 * @property {Object} runner           Adapter result (RunnerResult)
 * @property {string} diff             unified diff text (post-blinded for judges, raw for record)
 * @property {Array} changedFiles
 * @property {Array} publicGates
 * @property {Array} hiddenGates
 * @property {Object} judgePanel       JudgePanelResult (or null if judging skipped)
 * @property {Object} suite            { id, version, scoring }
 * @property {Object} rubric           rubric object
 * @property {Object} [pipeline]       { config, configResolved, routing } — the variant
 *                                      pin recorded so two runs with the same variantId
 *                                      are reproducible. Null when no config was provided.
 */
function buildResult(input) {
  const publicSummary = summarize(input.publicGates);
  const hiddenSummary = summarize(input.hiddenGates);
  const passed =
    publicSummary.failed === 0 &&
    hiddenSummary.failed === 0 &&
    input.runner.exitReason === "completed";
  // Headline score blends judge mean with hidden gate completion. Public
  // gates already gate the run via passed/failed, so we don't double-count.
  const judgeScore =
    input.judgePanel && Number.isFinite(input.judgePanel.weightedTotal)
      ? input.judgePanel.weightedTotal
      : 0;
  const hiddenRatio = hiddenSummary.total === 0 ? 1 : hiddenSummary.passed / hiddenSummary.total;
  const headlineScore =
    input.suite.scoring.rubricWeight * judgeScore +
    input.suite.scoring.hiddenGateWeight * (hiddenRatio * 5);

  return {
    schemaVersion: 1,
    suite: { id: input.suite.id, version: input.suite.version },
    task: { id: input.taskId },
    adapter: { id: input.adapterId, label: input.runner.label || input.adapterId },
    run: {
      id: input.runId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationSeconds: input.runner.durationSeconds,
      attemptCount: input.runner.attemptCount,
      humanInterventions: input.runner.humanInterventions,
      exitReason: input.runner.exitReason,
      errorMessage: input.runner.errorMessage,
    },
    diff: {
      changedFiles: input.changedFiles,
      lineCount: countLines(input.diff),
    },
    gates: {
      public: { ...publicSummary, results: input.publicGates },
      hidden: { ...hiddenSummary, results: input.hiddenGates.map(redactGateForRecord) },
    },
    judges: input.judgePanel
      ? {
          rubricId: input.rubric.id,
          panel: input.judgePanel.verdicts.map((v) => ({
            judgeId: v.judgeId,
            family: v.family,
            verdict: v.verdict,
            overallScore: v.overallScore,
            scores: v.scores,
            justifications: v.justifications,
            issues: v.issues,
            parseError: v.parseError,
          })),
          aggregated: input.judgePanel.aggregated,
          weightedTotal: input.judgePanel.weightedTotal,
          flaggedDisagreements: input.judgePanel.flaggedDisagreements,
          mergedIssues: input.judgePanel.mergedIssues,
        }
      : null,
    headline: {
      passed,
      score: headlineScore,
      hiddenRatio,
      publicGatesGreen: publicSummary.failed === 0,
    },
    pipeline: input.pipeline || null,
    transcriptHead: input.runner.transcript.slice(0, 200),
    artifacts: input.runner.artifacts,
  };
}

function writeResult(resultsDir, result) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${result.adapter.id}-${result.task.id}-${result.run.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return outPath;
}

function summarize(gates) {
  const total = gates.length;
  const passed = gates.filter((g) => g.ok).length;
  const failed = total - passed;
  const failedIds = gates.filter((g) => !g.ok).map((g) => g.id);
  return { total, passed, failed, failedIds };
}

function countLines(s) {
  if (!s) return 0;
  return s.split("\n").length;
}

// Hidden gate inputs are themselves spec material we don't want leaking into
// shared result files (so we don't accidentally publish them in a repo). We
// keep the boolean outcome and the gate id, drop the raw stdout/stderr.
function redactGateForRecord(gate) {
  return {
    id: gate.id,
    description: gate.description,
    ok: gate.ok,
    durationMs: gate.durationMs,
    message: gate.message,
  };
}

module.exports = { buildResult, writeResult };
