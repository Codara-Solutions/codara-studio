"use strict";

const VARIANTS = [
  "claude_single",
  "codex_single",
  "spark_sequential",
  "spark_hybrid_parallel",
];

function emptyGateSummary() {
  return { total: 0, passed: 0, failed: 0, failedIds: [], results: [] };
}

function summarizeGates(results) {
  const normalized = Array.isArray(results) ? results : [];
  const failed = normalized.filter((gate) => !gate.ok);
  return {
    total: normalized.length,
    passed: normalized.length - failed.length,
    failed: failed.length,
    failedIds: failed.map((gate) => gate.id),
    results: normalized,
  };
}

function buildResult(input) {
  const publicGates = summarizeGates(input.publicGates);
  const hiddenGates = summarizeGates(input.hiddenGates);
  const hiddenGateRatio = hiddenGates.total === 0 ? 1 : hiddenGates.passed / hiddenGates.total;
  const publicGreen = publicGates.failed === 0;
  const passed = Boolean(input.passed ?? (publicGreen && hiddenGates.failed === 0));
  return {
    schemaVersion: 2,
    task: {
      id: input.taskId,
      category: input.taskCategory,
      prompt: input.prompt,
    },
    variant: {
      id: input.variantId,
      label: input.variantLabel || input.variantId,
    },
    run: {
      id: input.runId,
      repetition: input.repetition,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationSeconds: number(input.durationSeconds),
      finalStatus: input.finalStatus || "unknown",
      errorMessage: input.errorMessage || null,
    },
    gates: {
      public: publicGates,
      hidden: hiddenGates,
    },
    quality: {
      score: number(input.qualityScore),
      hiddenGateRatio,
      publicGatesGreen: publicGreen,
      passed,
    },
    changes: {
      changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : [],
    },
    telemetry: {
      retryCount: number(input.retryCount),
      workerCount: number(input.workerCount),
      managerCallCount: number(input.managerCallCount),
      humanInterventions: number(input.humanInterventions),
      timeToFirstWorkerSeconds:
        input.timeToFirstWorkerSeconds === null || input.timeToFirstWorkerSeconds === undefined
          ? null
          : number(input.timeToFirstWorkerSeconds),
      totalWorkerRuntimeSeconds: number(input.totalWorkerRuntimeSeconds),
      estimatedCriticalPathSeconds: number(input.estimatedCriticalPathSeconds),
      parallelEfficiency: number(input.parallelEfficiency),
      maxConcurrentWorkers: number(input.maxConcurrentWorkers),
      parallelLaunchGroups: number(input.parallelLaunchGroups),
      peerMessageCount: number(input.peerMessageCount),
      peerAgentCount: number(input.peerAgentCount),
      routing: Array.isArray(input.routing) ? input.routing : [],
      runtimeBreakdown:
        input.runtimeBreakdown && typeof input.runtimeBreakdown === "object"
          ? input.runtimeBreakdown
          : {},
    },
    artifacts: input.artifacts || {},
  };
}

function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") errors.push("result must be an object");
  if (result?.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!result?.task?.id) errors.push("task.id is required");
  if (!VARIANTS.includes(result?.variant?.id)) errors.push(`unknown variant: ${result?.variant?.id}`);
  if (!result?.run?.id) errors.push("run.id is required");
  if (typeof result?.quality?.score !== "number") errors.push("quality.score must be a number");
  if (typeof result?.telemetry?.parallelEfficiency !== "number") {
    errors.push("telemetry.parallelEfficiency must be a number");
  }
  return { ok: errors.length === 0, errors };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  VARIANTS,
  buildResult,
  emptyGateSummary,
  summarizeGates,
  validateResult,
};
