#!/usr/bin/env node
// Spark Agent eval pilot — runs one task with one adapter end to end and
// emits a normalized eval-result.json.
//
// Usage:
//   node evals/run-pilot.cjs --adapter <id> --task <id> [--config <path>]
//
//   --adapter            Adapter id (matches a file under evals/adapters/, e.g.
//                        claude_best_single, spark_full).
//   --task               Task id (matches a directory under evals/tasks/, e.g.
//                        safe-worker-command-construction).
//   --config             Path to a variant config (evals/configs/<id>.json).
//                        Defaults to a per-adapter convention when omitted
//                        (see DEFAULT_CONFIGS in lib/variant-config.js).
//   --skip-config-check  Skip the live-Spark vs config consistency check.
//                        Use only when you know the local Spark setup
//                        differs from the variant on purpose.
//   --budget             Optional override for the wall-clock budget (seconds).
//   --no-judge           Skip the judge panel (faster smoke test).
//   --keep               Don't delete the temp seed repo on exit.
//
// Exit codes:
//   0   pilot ran end-to-end (judge errors / gate failures are recorded
//       in eval-result.json, not in the exit code).
//   2   missing dependency (claude CLI absent, OpenRouter key missing, etc.).
//   3   harness invariant broken (adapter returned bad shape, etc.).
//   1   anything else.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runnerLib = require("./lib/runner");
const seedRepo = require("./lib/seed-repo");
const gateRunner = require("./lib/gate-runner");
const judgePanel = require("./lib/judge-panel");
const recordResult = require("./lib/record-result");
const variantConfig = require("./lib/variant-config");
const { resolveOpenRouterConfig } = require("./lib/openrouter");

function parseArgs(argv) {
  const out = {
    adapter: null,
    task: null,
    config: null,
    skipConfigCheck: false,
    budget: null,
    judge: true,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--adapter") out.adapter = argv[++i];
    else if (a === "--task") out.task = argv[++i];
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--skip-config-check") out.skipConfigCheck = true;
    else if (a === "--budget") out.budget = Number(argv[++i]);
    else if (a === "--no-judge") out.judge = false;
    else if (a === "--keep") out.keep = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node evals/run-pilot.cjs --adapter <id> --task <id> [--config <path>]",
      "",
      "  --adapter             Adapter id (e.g. claude_best_single, spark_full)",
      "  --task                Task id (e.g. safe-worker-command-construction)",
      "  --config              Path to a variant config under evals/configs/",
      "  --skip-config-check   Skip the live-Spark vs config consistency check",
      "  --budget              Wall-clock budget in seconds (defaults to task.json)",
      "  --no-judge            Skip the OpenRouter judge panel",
      "  --keep                Keep the temp seed repo on exit (for debugging)",
      "",
    ].join("\n"),
  );
}

function logHeader(line) {
  process.stderr.write(`\n[pilot] ${line}\n`);
}

function logStep(line) {
  process.stderr.write(`[pilot]   ${line}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adapter || !args.task) {
    printHelp();
    process.exit(2);
  }
  const evalsRoot = path.resolve(__dirname);
  const taskDir = path.join(evalsRoot, "tasks", args.task);
  if (!fs.existsSync(taskDir)) {
    process.stderr.write(`task directory not found: ${taskDir}\n`);
    process.exit(2);
  }
  const taskJsonPath = path.join(taskDir, "task.json");
  if (!fs.existsSync(taskJsonPath)) {
    process.stderr.write(`task.json not found: ${taskJsonPath}\n`);
    process.exit(2);
  }
  const task = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));
  const planFile = path.join(taskDir, "plan.md");
  if (!fs.existsSync(planFile)) {
    process.stderr.write(`plan.md not found: ${planFile}\n`);
    process.exit(2);
  }
  const suiteJsonPath = path.join(evalsRoot, "suites", "frontier-one-shot.json");
  const suite = JSON.parse(fs.readFileSync(suiteJsonPath, "utf8"));
  const rubricPath = path.join(
    evalsRoot,
    "rubrics",
    `${suite.scoring.rubric}.json`,
  );
  if (!fs.existsSync(rubricPath)) {
    process.stderr.write(`rubric not found: ${rubricPath}\n`);
    process.exit(2);
  }
  const rubric = JSON.parse(fs.readFileSync(rubricPath, "utf8"));

  const runId = `${args.adapter}-${args.task}-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  logHeader(`task=${args.task} adapter=${args.adapter} runId=${runId}`);

  // 1. Resolve + load variant config (the pipeline pin). Optional for noop;
  //    required-by-convention for claude_best_single / spark_full.
  const repoRoot = seedRepo.findSourceRepo();
  const configPath = variantConfig.resolveConfigPath({
    adapterId: args.adapter,
    override: args.config,
    evalsRoot,
  });
  let config = null;
  if (configPath) {
    try {
      config = variantConfig.loadConfig(configPath);
      logStep(`variant config: ${path.relative(evalsRoot, configPath)} (id=${config.variantId})`);
    } catch (err) {
      process.stderr.write(`could not load variant config: ${err.message}\n`);
      process.exit(2);
    }
  } else {
    logStep(`variant config: none (adapter=${args.adapter} runs without a pinned config)`);
  }

  // 1b. Verify Spark settings/profile match the variant config when adapter
  //     is spark_full and the operator hasn't asked us to skip.
  if (config && config.agent === "spark" && !args.skipConfigCheck) {
    const verdict = variantConfig.verifySparkConfig({ config, repoRoot });
    if (!verdict.ok) {
      process.stderr.write(
        `\n[pilot] variant config does not match live Spark setup:\n`,
      );
      for (const m of verdict.mismatches) {
        process.stderr.write(`  - ${m}\n`);
      }
      process.stderr.write(
        `\n[pilot] ${verdict.hint}\n` +
          `[pilot] re-run with --skip-config-check to override.\n`,
      );
      process.exit(2);
    }
    logStep(
      `spark config check: profileHash=${verdict.profileHash || "n/a"} pool=[${verdict.poolHint || "empty"}]`,
    );
  } else if (config && config.agent === "spark") {
    logStep("spark config check: skipped (--skip-config-check)");
  }

  // 2. Reset to seed commit in a fresh temp tree.
  logStep("preparing seed repo at recorded commit ...");
  const { dir: seedDir, seed } = seedRepo.prepareSeedRepo({
    taskDir,
    runId,
  });
  logStep(`seed repo: ${seedDir} @ ${seed.seedCommit}`);

  // 3. Load + run the adapter.
  let createRunner;
  try {
    createRunner = runnerLib.loadAdapter(args.adapter);
  } catch (err) {
    process.stderr.write(`could not load adapter: ${err.message}\n`);
    if (!args.keep) seedRepo.cleanupSeedRepo(seedDir);
    process.exit(2);
  }
  const runner = createRunner({});
  const budgetSeconds = args.budget || task.budgetSeconds || 1800;
  logStep(`adapter: ${runner.label} (id=${runner.id})`);
  logStep(`budget: ${budgetSeconds}s`);

  let runnerResult;
  try {
    runnerResult = await runner.run({
      seedRepoPath: seedDir,
      planFile,
      env: { ...process.env },
      budgetSeconds,
      taskId: args.task,
      runId,
      config,
    });
  } catch (err) {
    process.stderr.write(`adapter raised: ${err && err.message}\n`);
    if (err && (err.code === "CLAUDE_CLI_NOT_FOUND" || err.code === "CODEX_CLI_NOT_FOUND")) {
      if (!args.keep) seedRepo.cleanupSeedRepo(seedDir);
      process.exit(2);
    }
    if (!args.keep) seedRepo.cleanupSeedRepo(seedDir);
    process.exit(1);
  }
  try {
    runnerLib.validateResult(runnerResult);
  } catch (err) {
    process.stderr.write(`adapter returned invalid result: ${err.message}\n`);
    if (!args.keep) seedRepo.cleanupSeedRepo(seedDir);
    process.exit(3);
  }
  logStep(
    `adapter exited: ${runnerResult.exitReason} after ${runnerResult.durationSeconds.toFixed(1)}s`,
  );

  // 3. Capture diff.
  logStep("capturing diff against seed commit ...");
  let diff = "";
  let changedFiles = [];
  try {
    diff = runnerLib.captureDiff(runnerResult.finalRepoPath);
    changedFiles = runnerLib.listChangedFiles(runnerResult.finalRepoPath);
  } catch (err) {
    process.stderr.write(`diff capture failed: ${err.message}\n`);
  }
  logStep(`diff: ${diff.length} bytes, ${changedFiles.length} changed files`);

  // 4. Public gates.
  logStep("running public gates ...");
  let publicGateResults = [];
  try {
    publicGateResults = gateRunner.runPublicGates(
      runnerResult.finalRepoPath,
      taskDir,
    );
  } catch (err) {
    process.stderr.write(`public gates raised: ${err.message}\n`);
  }
  const publicSummary = gateRunner.summarizeGates(publicGateResults);
  logStep(
    `public gates: ${publicSummary.passed}/${publicSummary.total} passed (${publicSummary.failedIds.join(", ") || "none failed"})`,
  );

  // 5. Hidden gates.
  logStep("running hidden gates ...");
  let hiddenGateResults = [];
  try {
    hiddenGateResults = await gateRunner.runHiddenGates(
      runnerResult.finalRepoPath,
      taskDir,
    );
  } catch (err) {
    process.stderr.write(`hidden gates raised: ${err.message}\n`);
  }
  const hiddenSummary = gateRunner.summarizeGates(hiddenGateResults);
  logStep(
    `hidden gates: ${hiddenSummary.passed}/${hiddenSummary.total} passed (${hiddenSummary.failedIds.join(", ") || "none failed"})`,
  );

  // 6. Judge panel.
  let panel = null;
  if (args.judge) {
    if (!resolveOpenRouterConfig()) {
      process.stderr.write(
        "[pilot]   skipping judge panel: no OpenRouter API key configured. Set SPARK_OPENROUTER_API_KEY to enable.\n",
      );
    } else {
      logStep("running 3-judge panel via OpenRouter ...");
      const judges = (suite.judges || []).map((id) => ({
        model: id,
        family: id.split("/")[0],
      }));
      const blindList = (task.judgeBlindList || []).concat([
        runner.id,
        runner.label,
      ]);
      const planText = fs.readFileSync(planFile, "utf8");
      const hiddenSummaryText = (
        task.hiddenGateSummaryForJudgeTemplate || "Hidden gates: {passed}/{total}"
      )
        .replace("{passed}", hiddenSummary.passed)
        .replace("{total}", hiddenSummary.total);
      try {
        panel = await judgePanel.evaluate({
          rubricPath,
          judges,
          diff,
          plan: planText,
          blindList,
          publicGateSummary: task.publicGateSummaryForJudge,
          hiddenGateSummary: hiddenSummaryText,
          onEvent: (ev) => logStep(`judge ${ev.kind}: ${ev.judgeId || ""} ${ev.error || ev.verdict || ""}`),
        });
        logStep(`panel weighted total: ${panel.weightedTotal.toFixed(2)} / 5`);
      } catch (err) {
        process.stderr.write(
          `[pilot]   judge panel raised: ${(err && err.message) || err}\n`,
        );
      }
    }
  }

  // 7. Build pipeline record (config + computed hash + actual routing).
  let pipeline = null;
  if (config) {
    pipeline = variantConfig.buildPipelineRecord({ config, repoRoot });
    if (config.agent === "spark") {
      // Extract routing from the SparkFullRunner's run.json artifact.
      const runJsonArtifact = runnerResult.artifacts.find(
        (a) => a.name === "run.json" && a.kind === "spark-state",
      );
      if (runJsonArtifact && fs.existsSync(runJsonArtifact.path)) {
        try {
          const runJson = JSON.parse(fs.readFileSync(runJsonArtifact.path, "utf8"));
          pipeline.routing = variantConfig.extractRoutingFromSparkRun(runJson);
        } catch (err) {
          process.stderr.write(
            `[pilot]   failed to extract Spark routing: ${err.message}\n`,
          );
          pipeline.routing = [];
        }
      } else {
        pipeline.routing = [];
      }
    } else if (config.agent === "claude_code") {
      pipeline.routing = variantConfig.buildClaudeBaselineRouting({
        config,
        runId,
        exitReason: runnerResult.exitReason,
      });
    } else if (config.agent === "codex") {
      pipeline.routing = variantConfig.buildCodexBaselineRouting({
        config,
        runId,
        exitReason: runnerResult.exitReason,
      });
    } else {
      pipeline.routing = [];
    }
  }

  // 8. Emit eval-result.json.
  const finishedAt = new Date().toISOString();
  const result = recordResult.buildResult({
    taskId: args.task,
    adapterId: args.adapter,
    runId,
    startedAt,
    finishedAt,
    runner: { ...runnerResult, label: runner.label },
    diff,
    changedFiles,
    publicGates: publicGateResults,
    hiddenGates: hiddenGateResults,
    judgePanel: panel,
    suite,
    rubric,
    pipeline,
  });

  const resultsDir = path.join(evalsRoot, "results");
  const outPath = recordResult.writeResult(resultsDir, result);
  logHeader(`done — eval-result written to ${outPath}`);
  logStep(
    `headline: passed=${result.headline.passed} score=${result.headline.score.toFixed(2)} hiddenRatio=${result.headline.hiddenRatio.toFixed(2)} publicGreen=${result.headline.publicGatesGreen}`,
  );

  // 9. Cleanup (unless --keep).
  if (!args.keep) {
    seedRepo.cleanupSeedRepo(seedDir);
    logStep("cleaned up seed repo");
  } else {
    logStep(`seed repo retained at ${seedDir}`);
  }
}

main().catch((err) => {
  process.stderr.write(`pilot failed: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
