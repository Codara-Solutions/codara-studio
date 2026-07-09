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
    maxConcurrentWorkers: 0,
    parallelLaunchGroups: 0,
    peerMessageCount: 0,
    peerAgentCount: 0,
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
  const config = loadVariantConfig(input, adapterId);
  const adapterModule = require(adapterPath);
  const runner = adapterModule.createRunner();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `spark-eval-v2-${adapterId}-`));
  const seedSource = path.join(input.task.dir, input.task.seed || "seed");
  const seedRepoPath = path.join(workRoot, "repo");
  if (fs.existsSync(seedSource)) {
    fs.cpSync(seedSource, seedRepoPath, { recursive: true });
  } else {
    fs.mkdirSync(seedRepoPath, { recursive: true });
  }
  initGit(seedRepoPath);

  const env = { ...process.env };
  const maxParallelWorkers = config?.workerPolicy?.maxParallelWorkers;
  if (Number.isFinite(maxParallelWorkers) && maxParallelWorkers > 0) {
    env.SPARK_EVAL_MAX_PARALLEL_WORKERS = String(Math.floor(maxParallelWorkers));
  }

  const runnerResult = await runner.run({
    seedRepoPath,
    planFile: path.join(input.task.dir, "prompt.md"),
    env,
    budgetSeconds: input.task.budgetSeconds || 900,
    taskId: input.task.id,
    runId: input.runId,
    config,
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
    retryCount: isSpark ? sparkTelemetry.retryCount : Math.max(0, (runnerResult.attemptCount || 1) - 1),
    workerCount: isSpark ? sparkTelemetry.workerCount : 1,
    managerCallCount: isSpark ? sparkTelemetry.managerCallCount : 0,
    humanInterventions: runnerResult.humanInterventions || 0,
    timeToFirstWorkerSeconds: isSpark ? sparkTelemetry.timeToFirstWorkerSeconds : 0,
    totalWorkerRuntimeSeconds: isSpark ? sparkTelemetry.totalWorkerRuntimeSeconds : runnerResult.durationSeconds,
    estimatedCriticalPathSeconds: isSpark ? sparkTelemetry.estimatedCriticalPathSeconds : runnerResult.durationSeconds,
    parallelEfficiency: isSpark ? sparkTelemetry.parallelEfficiency : 1,
    maxConcurrentWorkers: isSpark ? sparkTelemetry.maxConcurrentWorkers : 1,
    parallelLaunchGroups: isSpark ? sparkTelemetry.parallelLaunchGroups : 0,
    peerMessageCount: isSpark ? sparkTelemetry.peerMessageCount : 0,
    peerAgentCount: isSpark ? sparkTelemetry.peerAgentCount : 0,
    workerToolCalls: isSpark ? sparkTelemetry.workerToolCalls : 0,
    previewToolCalls: isSpark ? sparkTelemetry.previewToolCalls : 0,
    verificationRoundTrips: isSpark ? sparkTelemetry.verificationRoundTrips : 0,
    toolCallsByName: isSpark ? sparkTelemetry.toolCallsByName || {} : {},
    routing: isSpark ? sparkTelemetry.routing || [] : [],
    runtimeBreakdown: isSpark ? sparkTelemetry.runtimeBreakdown || {} : {},
    finalStatus: runnerResult.exitReason,
    errorMessage: runnerResult.errorMessage || null,
    artifacts: {
      runner: runnerResult.artifacts,
      transcriptHead: (runnerResult.transcript || []).slice(0, 40),
      workRoot,
      variantConfig: config?._sourcePath || null,
      telemetry: isSpark ? sparkTelemetry : null,
    },
  };
}

function loadVariantConfig(input, adapterId) {
  const configPath = path.join(input.root, "configs", `${adapterId}.json`);
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { ...config, _sourcePath: configPath };
}

function initGit(cwd) {
  run("git", ["init"], cwd);
  run("git", ["config", "user.email", "spark-eval@example.local"], cwd);
  run("git", ["config", "user.name", "Spark Eval"], cwd);
  run("git", ["add", "-A"], cwd);
  run("git", ["commit", "--allow-empty", "-m", "seed"], cwd);
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
    maxConcurrentWorkers: 0,
    parallelLaunchGroups: 0,
    peerMessageCount: 0,
    peerAgentCount: 0,
    workerToolCalls: 0,
    previewToolCalls: 0,
    verificationRoundTrips: 0,
    toolCallsByName: {},
  };
  base.routing = [];
  base.runtimeBreakdown = {};
  const runArtifact = (artifacts || []).find((artifact) => artifact.name === "run.json");
  if (!runArtifact || !fs.existsSync(runArtifact.path)) return base;
  try {
    const run = JSON.parse(fs.readFileSync(runArtifact.path, "utf8"));
    const attempts = run.workerAttempts || [];
    const startedAt = Date.parse(run.autopilot?.startedAt || run.createdAt || "") || 0;
    const starts = attempts.map((attempt) => Date.parse(attempt.startedAt || "")).filter(Boolean);
    const ends = attempts.map((attempt) => Date.parse(attempt.finishedAt || "") || Date.now()).filter(Boolean);
    const intervals = attempts
      .map((attempt) => {
        const started = Date.parse(attempt.startedAt || "");
        const finished = Date.parse(attempt.finishedAt || "") || Date.now();
        return started && finished >= started ? { started, finished } : null;
      })
      .filter(Boolean);
    const first = starts.length ? Math.min(...starts) : 0;
    const last = ends.length ? Math.max(...ends) : 0;
    const totalRuntime = attempts.reduce((sum, attempt) => {
      const s = Date.parse(attempt.startedAt || "");
      const e = Date.parse(attempt.finishedAt || "") || Date.now();
      return s ? sum + Math.max(0, (e - s) / 1000) : sum;
    }, 0);
    const critical = first && last ? Math.max(0, (last - first) / 1000) : 0;
    const { routing, runtimeBreakdown } = extractRouting(run);
    return {
      routing,
      runtimeBreakdown,
      retryCount: Math.max(0, attempts.length - (run.workerTasks || []).length),
      workerCount: (run.workerTasks || []).length,
      managerCallCount: (run.sparkCalls || []).length,
      timeToFirstWorkerSeconds: first && startedAt ? Math.max(0, (first - startedAt) / 1000) : null,
      totalWorkerRuntimeSeconds: Math.round(totalRuntime),
      estimatedCriticalPathSeconds: Math.round(critical),
      parallelEfficiency: totalRuntime > 0 && critical > 0 ? Math.min(1, totalRuntime / (critical * Math.max(1, attempts.length))) : 0,
      maxConcurrentWorkers: maxConcurrentIntervals(intervals),
      parallelLaunchGroups: countParallelLaunchGroups(artifacts),
      ...peerCommsTelemetry(path.dirname(runArtifact.path)),
      ...toolCallTelemetry(artifacts, path.dirname(runArtifact.path)),
    };
  } catch {
    return base;
  }
}

// Per-worker runtime/model routing, so the codex-vs-claude split is
// measurable from the result file alone. `runtimeBreakdown` splits the
// implementer count from the verifier count because verifiers are
// deliberately routed to the opposite runtime of their implementer.
function extractRouting(run) {
  const workerTasks = run.workerTasks || [];
  const attempts = run.workerAttempts || [];
  const attemptRuntimeByTask = new Map();
  for (const attempt of attempts) {
    if (attempt.workerTaskId && attempt.runtime) {
      attemptRuntimeByTask.set(attempt.workerTaskId, attempt.runtime);
    }
  }
  const routing = workerTasks.map((task) => {
    const isVerifier = task.taskClass === "verifier";
    return {
      taskId: task.id,
      title: task.title || "",
      taskClass: task.taskClass || null,
      role: isVerifier ? "verifier" : "implementer",
      runtimePreference: task.runtimePreference || null,
      runtimeUsed: attemptRuntimeByTask.get(task.id) || task.runtimePreference || null,
      model: task.modelHint || null,
      effort: task.effortHint || null,
    };
  });
  // Pre-allocate the known runtime buckets (claude, codex, cursor) so the
  // breakdown is comparable across runs even when a runtime never fired on
  // this particular task. A new "cursor" worker runtime was added alongside
  // the original claude/codex pair, so it must appear here too.
  const KNOWN_RUNTIMES = ["claude", "codex", "cursor"];
  const runtimeBreakdown = {
    implementer: Object.fromEntries(KNOWN_RUNTIMES.map((rt) => [rt, 0])),
    verifier: Object.fromEntries(KNOWN_RUNTIMES.map((rt) => [rt, 0])),
    total: Object.fromEntries(KNOWN_RUNTIMES.map((rt) => [rt, 0])),
  };
  for (const entry of routing) {
    const runtime = entry.runtimeUsed || "unknown";
    runtimeBreakdown[entry.role][runtime] = (runtimeBreakdown[entry.role][runtime] || 0) + 1;
    runtimeBreakdown.total[runtime] = (runtimeBreakdown.total[runtime] || 0) + 1;
  }
  return { routing, runtimeBreakdown };
}

function maxConcurrentIntervals(intervals) {
  const points = [];
  for (const interval of intervals) {
    points.push({ t: interval.started, delta: 1 });
    points.push({ t: interval.finished, delta: -1 });
  }
  points.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));
  let current = 0;
  let max = 0;
  for (const point of points) {
    current += point.delta;
    if (current > max) max = current;
  }
  return max;
}

function countParallelLaunchGroups(artifacts) {
  const eventsArtifact = (artifacts || []).find((artifact) => artifact.name === "events.jsonl");
  if (!eventsArtifact || !fs.existsSync(eventsArtifact.path)) return 0;
  const groups = new Set();
  const lines = fs.readFileSync(eventsArtifact.path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const groupId = event?.payload?.parallelGroupId;
      const groupSize = Number(event?.payload?.parallelGroupSize || 0);
      if (groupId && groupSize > 1) groups.add(groupId);
    } catch {
      /* ignore malformed event line */
    }
  }
  return groups.size;
}

function peerCommsTelemetry(runDir) {
  const peerDir = path.join(runDir, "peer-comms");
  const messagesDir = path.join(peerDir, "messages");
  let peerMessageCount = 0;
  if (fs.existsSync(messagesDir)) {
    peerMessageCount = fs
      .readdirSync(messagesDir)
      .filter((name) => name.endsWith(".json"))
      .length;
  }

  let peerAgentCount = 0;
  const agentsPath = path.join(peerDir, "agents.json");
  if (fs.existsSync(agentsPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
      peerAgentCount = Array.isArray(registry.agents) ? registry.agents.length : 0;
    } catch {
      peerAgentCount = 0;
    }
  }
  return { peerMessageCount, peerAgentCount };
}

// Per-worker tool-call telemetry. This is the signal that exposes the
// verification bottleneck: a worker can write a deliverable in a handful of
// edits, then spend most of its wall-clock driving the live preview one
// keystroke at a time (each codara_preview_* call is a full MCP round-trip).
// Counting those round-trips makes "fast vs slow verification" measurable.
//
// Primary source: hook.PreToolUse events in events.jsonl (Claude Code workers
// emit these via Spark's PreToolUse hook). Fallback: scan the per-attempt raw
// CC stream-json logs under the run dir for tool_use blocks, for configs where
// the hook did not record into events.jsonl. Codex workers do not emit the
// PreToolUse hook, so their tool calls are undercounted — the metric is most
// meaningful for the preview-heavy Claude UI worker, which is the case we care
// about most.
function extractToolName(ev) {
  const p = (ev && (ev.payload || ev)) || {};
  const direct =
    p.tool_name || p.toolName || (p.hookData && p.hookData.tool_name) || p.name;
  if (typeof direct === "string" && direct) return direct;
  const m = /"tool_name":"([^"]+)"/.exec(JSON.stringify(ev));
  return m ? m[1] : null;
}

function toolCallTelemetry(artifacts, runDir) {
  const byName = {};
  let total = 0;
  let counted = false;
  const eventsArtifact = (artifacts || []).find((a) => a.name === "events.jsonl");
  if (eventsArtifact && fs.existsSync(eventsArtifact.path)) {
    const lines = fs.readFileSync(eventsArtifact.path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev && ev.type === "hook.PreToolUse") {
        const name = extractToolName(ev) || "unknown";
        byName[name] = (byName[name] || 0) + 1;
        total += 1;
        counted = true;
      }
    }
  }
  if (!counted && runDir) {
    const fromLogs = countToolCallsFromAttemptLogs(runDir);
    if (fromLogs.total > 0) return finalizeToolCalls(fromLogs.byName, fromLogs.total);
  }
  return finalizeToolCalls(byName, total);
}

function finalizeToolCalls(byName, total) {
  const previewEntries = Object.entries(byName).filter(([name]) =>
    /spark[-_]preview/i.test(name),
  );
  const previewToolCalls = previewEntries.reduce((sum, [, count]) => sum + count, 0);
  // Round-trips are the preview calls that actually drive/inspect the page —
  // click/type/press_key/snapshot/screenshot/evaluate/wait_for. navigate/list/
  // url are cheap setup/meta and excluded so the number reflects probe churn.
  const verificationRoundTrips = previewEntries
    .filter(([name]) => !/(?:_|\.)(navigate|list|url)$/i.test(name))
    .reduce((sum, [, count]) => sum + count, 0);
  return { workerToolCalls: total, previewToolCalls, verificationRoundTrips, toolCallsByName: byName };
}

function countToolCallsFromAttemptLogs(runDir) {
  const byName = {};
  let total = 0;
  const stepsDir = path.join(runDir, "steps");
  if (!fs.existsSync(stepsDir)) return { byName, total };
  const logFiles = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(raw|stdout)\.log$/i.test(entry.name)) logFiles.push(full);
    }
  };
  walk(stepsDir);
  const re = /"type"\s*:\s*"tool_use"[\s\S]{0,240}?"name"\s*:\s*"([^"]+)"/g;
  for (const file of logFiles) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let match;
    while ((match = re.exec(text))) {
      const name = match[1];
      byName[name] = (byName[name] || 0) + 1;
      total += 1;
    }
  }
  return { byName, total };
}

module.exports = { runLiveAdapter, toolCallTelemetry };
