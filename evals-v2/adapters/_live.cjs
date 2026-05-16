"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const oldRunnerLib = require("../../evals/lib/runner.js");

const OLD_ADAPTERS = {
  claude_single: "../../evals/adapters/claude_best_single.js",
  codex_single: "../../evals/adapters/codex_best_single.js",
  spark_sequential: "../../evals/adapters/spark_full.js",
  spark_hybrid_parallel: "../../evals/adapters/spark_full.js",
};

function disabledResult(adapterId) {
  return {
    passed: false,
    qualityScore: 0,
    publicGates: [],
    hiddenGates: [],
    durationSeconds: 0,
    changedFiles: [],
    retryCount: 0,
    workerCount: 0,
    managerCallCount: 0,
    humanInterventions: 0,
    timeToFirstWorkerSeconds: null,
    totalWorkerRuntimeSeconds: 0,
    estimatedCriticalPathSeconds: 0,
    parallelEfficiency: 0,
    finalStatus: "disabled",
    errorMessage:
      `${adapterId} is a live adapter. Set SPARK_EVAL_V2_ALLOW_LIVE=1 and wire the CLI credentials before running it.`,
    artifacts: {},
  };
}

async function runLiveAdapter(adapterId, input) {
  if (process.env.SPARK_EVAL_V2_ALLOW_LIVE !== "1") return disabledResult(adapterId);
  const adapterPath = OLD_ADAPTERS[adapterId];
  if (!adapterPath) throw new Error(`No live adapter is registered for ${adapterId}`);
  const adapterModule = require(adapterPath);
  const runner = adapterModule.createRunner();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `spark-eval-v2-${adapterId}-`));
  const seedSource = path.join(input.task.dir, input.task.seed || "seed");
  const seedRepoPath = path.join(workRoot, "repo");
  fs.cpSync(seedSource, seedRepoPath, { recursive: true });
  initGit(seedRepoPath);

  const runnerResult = await runner.run({
    seedRepoPath,
    planFile: path.join(input.task.dir, "prompt.md"),
    env: process.env,
    budgetSeconds: input.task.budgetSeconds || 900,
    taskId: input.task.id,
    runId: input.runId,
    config: null,
  });

  const publicGates = runGates(input.task.publicGates, runnerResult.finalRepoPath);
  const hiddenGates = runGates(input.task.hiddenGates, runnerResult.finalRepoPath);
  const allGates = [...publicGates, ...hiddenGates];
  const gatePassRatio =
    allGates.length === 0 ? 1 : allGates.filter((gate) => gate.ok).length / allGates.length;
  const changedFiles = oldRunnerLib.listChangedFiles(runnerResult.finalRepoPath);
  const sparkTelemetry = telemetryFromSparkArtifact(runnerResult.artifacts);
  const isSpark = adapterId.startsWith("spark_");

  return {
    passed: runnerResult.exitReason === "completed" && allGates.every((gate) => gate.ok),
    qualityScore: Math.round(gatePassRatio * 500) / 100,
    publicGates,
    hiddenGates,
    durationSeconds: runnerResult.durationSeconds,
    changedFiles,
    retryCount: Math.max(0, (runnerResult.attemptCount || 1) - (isSpark ? sparkTelemetry.workerCount : 1)),
    workerCount: isSpark ? sparkTelemetry.workerCount : 1,
    managerCallCount: isSpark ? sparkTelemetry.managerCallCount : 0,
    humanInterventions: runnerResult.humanInterventions || 0,
    timeToFirstWorkerSeconds: isSpark ? sparkTelemetry.timeToFirstWorkerSeconds : 0,
    totalWorkerRuntimeSeconds: isSpark ? sparkTelemetry.totalWorkerRuntimeSeconds : runnerResult.durationSeconds,
    estimatedCriticalPathSeconds: isSpark ? sparkTelemetry.estimatedCriticalPathSeconds : runnerResult.durationSeconds,
    parallelEfficiency: isSpark ? sparkTelemetry.parallelEfficiency : 1,
    finalStatus: runnerResult.exitReason,
    errorMessage: runnerResult.errorMessage || null,
    artifacts: {
      runner: runnerResult.artifacts,
      transcriptHead: (runnerResult.transcript || []).slice(0, 40),
      workRoot,
    },
  };
}

function initGit(cwd) {
  run("git", ["init"], cwd);
  run("git", ["config", "user.email", "spark-eval@example.local"], cwd);
  run("git", ["config", "user.name", "Spark Eval"], cwd);
  run("git", ["add", "-A"], cwd);
  run("git", ["commit", "-m", "seed"], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function runGates(gates, cwd) {
  return (gates || []).map((gate) => {
    const started = Date.now();
    const result = spawnSync(gate.command, {
      cwd,
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: gate.timeoutMs || 60_000,
    });
    const ok = result.status === 0;
    return {
      id: gate.id,
      description: gate.command,
      ok,
      durationMs: Date.now() - started,
      message: ok ? "passed" : (result.stderr || result.stdout || `exit ${result.status}`).slice(0, 1200),
    };
  });
}

function telemetryFromSparkArtifact(artifacts) {
  const base = {
    retryCount: 0,
    workerCount: 0,
    managerCallCount: 0,
    timeToFirstWorkerSeconds: null,
    totalWorkerRuntimeSeconds: 0,
    estimatedCriticalPathSeconds: 0,
    parallelEfficiency: 0,
  };
  const runArtifact = (artifacts || []).find((artifact) => artifact.name === "run.json");
  if (!runArtifact || !fs.existsSync(runArtifact.path)) return base;
  try {
    const run = JSON.parse(fs.readFileSync(runArtifact.path, "utf8"));
    const attempts = run.workerAttempts || [];
    const startedAt = Date.parse(run.autopilot?.startedAt || run.createdAt || "") || 0;
    const starts = attempts.map((attempt) => Date.parse(attempt.startedAt || "")).filter(Boolean);
    const ends = attempts.map((attempt) => Date.parse(attempt.finishedAt || "") || Date.now()).filter(Boolean);
    const first = starts.length ? Math.min(...starts) : 0;
    const last = ends.length ? Math.max(...ends) : 0;
    const totalRuntime = attempts.reduce((sum, attempt) => {
      const s = Date.parse(attempt.startedAt || "");
      const e = Date.parse(attempt.finishedAt || "") || Date.now();
      return s ? sum + Math.max(0, (e - s) / 1000) : sum;
    }, 0);
    const critical = first && last ? Math.max(0, (last - first) / 1000) : 0;
    return {
      retryCount: Math.max(0, attempts.length - (run.workerTasks || []).length),
      workerCount: (run.workerTasks || []).length,
      managerCallCount: (run.sparkCalls || []).length,
      timeToFirstWorkerSeconds: first && startedAt ? Math.max(0, (first - startedAt) / 1000) : null,
      totalWorkerRuntimeSeconds: Math.round(totalRuntime),
      estimatedCriticalPathSeconds: Math.round(critical),
      parallelEfficiency: totalRuntime > 0 && critical > 0 ? Math.min(1, totalRuntime / (critical * Math.max(1, attempts.length))) : 0,
    };
  } catch {
    return base;
  }
}

module.exports = { runLiveAdapter };
