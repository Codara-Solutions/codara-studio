// Adapter: SparkFullRunner
//
// Invokes the full Spark Agent run loop on a plan and waits for terminal
// state. Spark is an Electron app — it cannot run truly headless today —
// so this adapter has two operational modes:
//
//   AUTO (env SPARK_EVAL_AUTO=1):
//     Spawns `npx electron-vite preview` (or a compiled binary if present)
//     pre-seeded with a workspace + plan. This requires Spark to support a
//     "--eval" CLI flag, which is on the next-step roadmap. If Spark
//     doesn't recognize the flag, the adapter falls back to MANUAL mode.
//
//   MANUAL (default until Spark grows the CLI flag):
//     Prints the exact steps the operator must perform inside Spark's UI:
//       1. Open a workspace pointed at <seedRepoPath>
//       2. Drop the plan file (`evals/tasks/<task>/plan.md`) into the
//          plan picker
//       3. Click "Start Autopilot"
//     Then watches `~/.SparkAgent/runs/` for a new run.json whose
//     workspace cwd matches our seedRepoPath. When that run reaches a
//     terminal status (complete | failed | cancelled), the adapter
//     captures run.json + events.jsonl as artifacts and returns.
//
// MANUAL mode is honest: the operator drives the desktop app, the harness
// records the result. AUTO mode will replace it once Spark has a headless
// entry point. The downstream eval (judge panel + gates) is identical.
//
// Watchdog: in either mode the adapter respects budgetSeconds. When the
// budget elapses we record a "budget_exhausted" run and abort.
//
// Default variant config (when --config is omitted):
//   evals/configs/spark_full-grok43.json (variantId=spark_full_grok43)
// The four Spark variants we compare differ only in the manager — workers
// are always max-everything Claude/Codex (subscription-flat). The actual
// default-resolution mapping lives in lib/variant-config.js DEFAULT_CONFIGS.
// The other three variants are opt-in via `--config`:
//   evals/configs/spark_full-sonnet46.json
//   evals/configs/spark_full-gpt55.json
//   evals/configs/spark_full-gemini25.json

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const runnerLib = require("../lib/runner");
const variantConfig = require("../lib/variant-config");
const seedRepoLib = require("../lib/seed-repo");

const ID = "spark_full";
const LABEL = "Spark Agent (full orchestration)";

function sparkHomeDir() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".SparkAgent");
}

function runsRoot() {
  return path.join(sparkHomeDir(), "runs");
}

function isTerminal(status) {
  return status === "complete" || status === "failed" || status === "cancelled";
}

/**
 * Watch ~/.SparkAgent/runs/ for a new run.json whose cwd matches the seed
 * repo and that reaches terminal state within the budget. Returns the
 * matched run id + the absolute paths of run.json and events.jsonl.
 */
async function waitForTerminalRun({ seedRepoPath, transcript, budgetSeconds, onEvent }) {
  const startedMs = Date.now();
  const budgetMs = budgetSeconds * 1000;
  const seenRuns = new Map(); // runId -> last status
  // First pass: snapshot existing runs so we don't pick up an old one.
  const baseline = new Set(safeReaddir(runsRoot()));
  transcript.push(runnerLib.event("watch:start", `${runsRoot()}, baseline=${baseline.size} runs`));

  while (Date.now() - startedMs < budgetMs) {
    const dirs = safeReaddir(runsRoot());
    for (const d of dirs) {
      if (baseline.has(d)) continue;
      const runJsonPath = path.join(runsRoot(), d, "run.json");
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      } catch {
        continue; // run.json not yet flushed
      }
      const cwdMatches =
        parsed.cwd && path.resolve(parsed.cwd) === path.resolve(seedRepoPath);
      // Some Spark installs put cwd on the workspace, not the run.
      const workspaceCwdMatches =
        parsed.workspaceCwd && path.resolve(parsed.workspaceCwd) === path.resolve(seedRepoPath);
      if (!cwdMatches && !workspaceCwdMatches) continue;

      if (!seenRuns.has(d)) {
        seenRuns.set(d, parsed.status);
        transcript.push(
          runnerLib.event("run:detected", d, { status: parsed.status }),
        );
        onEvent({ kind: "run:detected", runId: d, status: parsed.status });
      }
      if (parsed.status !== seenRuns.get(d)) {
        seenRuns.set(d, parsed.status);
        transcript.push(
          runnerLib.event("run:status", d, { status: parsed.status }),
        );
        onEvent({ kind: "run:status", runId: d, status: parsed.status });
      }
      if (isTerminal(parsed.status)) {
        return {
          runId: d,
          runJsonPath,
          eventsJsonlPath: path.join(runsRoot(), d, "events.jsonl"),
          status: parsed.status,
          attemptCount:
            (parsed.workerAttempts && parsed.workerAttempts.length) || 1,
          humanInterventions:
            (parsed.humanMessages || []).filter((m) => m.author === "human").length,
        };
      }
    }
    await delay(1500);
  }
  // Budget elapsed.
  const matchedAny = [...seenRuns.entries()];
  return {
    runId: matchedAny.length ? matchedAny[matchedAny.length - 1][0] : null,
    runJsonPath: null,
    eventsJsonlPath: null,
    status: "budget_exhausted",
    attemptCount: 0,
    humanInterventions: 0,
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * AUTO-mode launch. Spawns whatever Spark binary is available with the
 * (future) --eval CLI flag and watches for terminal state. Returns the
 * spawned process so we can kill it on budget exhaustion. If Spark doesn't
 * support the flag yet, returns null and the caller falls back to MANUAL.
 */
function tryAutoLaunch({ seedRepoPath, planFile, transcript }) {
  // Check for a packaged binary first; otherwise fall back to dev preview.
  const repoRoot = runnerLib && require("../lib/seed-repo").findSourceRepo();
  const candidates = [
    process.platform === "win32"
      ? path.join(repoRoot, "out", "win-unpacked", "Spark Agent.exe")
      : null,
    process.platform === "win32"
      ? path.join(repoRoot, "build", "win-unpacked", "Spark Agent.exe")
      : null,
    process.platform === "darwin"
      ? path.join(repoRoot, "out", "mac", "Spark Agent.app", "Contents", "MacOS", "Spark Agent")
      : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      transcript.push(runnerLib.event("auto:bin", c));
      const child = spawn(c, [
        "--eval",
        "--workspace", seedRepoPath,
        "--plan", planFile,
      ], { stdio: "ignore", detached: false });
      return { child };
    }
  }
  transcript.push(
    runnerLib.event(
      "auto:skipped",
      "No packaged Spark binary found; falling back to MANUAL mode.",
    ),
  );
  return null;
}

function printManualInstructions({ seedRepoPath, planFile }) {
  const lines = [
    "",
    "================================================================",
    "  Spark Agent eval — MANUAL launch needed",
    "================================================================",
    "",
    "  The eval harness has prepared a fresh seed repo. Now drive Spark:",
    "",
    `    1. Launch Spark Agent (e.g. 'npm run dev' or the installed app).`,
    `    2. In Spark, create / select a workspace whose cwd is:`,
    `         ${seedRepoPath}`,
    `    3. Open the plan file:`,
    `         ${planFile}`,
    `    4. Click 'Start Autopilot' and let the run complete.`,
    "",
    "  The harness is watching ~/.SparkAgent/runs/ and will exit when",
    "  it sees a run on this workspace reach a terminal status.",
    "",
    "  Tip: set SPARK_EVAL_AUTO=1 once Spark grows a --eval CLI flag",
    "  and the harness will skip these manual steps.",
    "================================================================",
    "",
  ];
  process.stderr.write(lines.join("\n"));
}

function createRunner(opts = {}) {
  return {
    id: ID,
    label: LABEL,
    async run(input) {
      const startedAtMs = Date.now();
      const transcript = [];
      transcript.push(runnerLib.event("adapter:start", LABEL));

      // Pull the variant config off the runner input and snapshot it for
      // the operator. The pilot has already verified the live Spark
      // settings/profile match (or the operator passed --skip-config-check
      // and accepts that the run is not exactly reproducible). We snapshot
      // the configResolved blob (profile hash, settings path) into the
      // adapter's artifact dir so the eval-result has it even if the live
      // settings file changes after the run.
      const cfg = input.config || null;
      transcript.push(
        runnerLib.event(
          "config",
          `variantId=${(cfg && cfg.variantId) || "(none)"}`,
        ),
      );
      const repoRoot = seedRepoLib.findSourceRepo();
      const pipelineRecord = cfg
        ? variantConfig.buildPipelineRecord({ config: cfg, repoRoot })
        : null;
      if (pipelineRecord) {
        transcript.push(
          runnerLib.event(
            "config:resolved",
            `profileHash=${(pipelineRecord.configResolved && pipelineRecord.configResolved.profileHash) || "n/a"}`,
          ),
        );
      }

      const auto = process.env.SPARK_EVAL_AUTO === "1"
        ? tryAutoLaunch({
            seedRepoPath: input.seedRepoPath,
            planFile: input.planFile,
            transcript,
          })
        : null;
      if (!auto) {
        printManualInstructions({
          seedRepoPath: input.seedRepoPath,
          planFile: input.planFile,
        });
      }

      const watchResult = await waitForTerminalRun({
        seedRepoPath: input.seedRepoPath,
        transcript,
        budgetSeconds: input.budgetSeconds,
        onEvent: () => undefined,
      });

      // Budget exhausted, but Spark may still be running. Kill the auto
      // process if we own it; otherwise leave the desktop instance alone.
      if (auto && watchResult.status === "budget_exhausted") {
        try {
          auto.child.kill();
        } catch {
          /* ignore */
        }
      }

      // Collect run.json + events.jsonl as artifacts (if we found a run).
      const artifacts = [];
      if (watchResult.runJsonPath && fs.existsSync(watchResult.runJsonPath)) {
        artifacts.push({
          name: "run.json",
          path: watchResult.runJsonPath,
          kind: "spark-state",
        });
      }
      if (watchResult.eventsJsonlPath && fs.existsSync(watchResult.eventsJsonlPath)) {
        artifacts.push({
          name: "events.jsonl",
          path: watchResult.eventsJsonlPath,
          kind: "spark-events",
        });
      }

      // Snapshot the resolved variant config + extracted routing into the
      // adapter's artifact dir. We extract routing from the captured
      // run.json (when present) so the snapshot stands on its own even if
      // the live Spark state later changes.
      if (cfg) {
        const artifactsDir = path.join(
          path.dirname(input.seedRepoPath),
          `${input.runId}-artifacts`,
        );
        let routing = [];
        if (watchResult.runJsonPath && fs.existsSync(watchResult.runJsonPath)) {
          try {
            const runJson = JSON.parse(fs.readFileSync(watchResult.runJsonPath, "utf8"));
            routing = variantConfig.extractRoutingFromSparkRun(runJson);
          } catch {
            /* leave routing empty — pilot will surface the parse failure */
          }
        }
        const written = variantConfig.writeConfigResolvedArtifact({
          artifactsDir,
          config: cfg,
          configResolved: pipelineRecord ? pipelineRecord.configResolved : null,
          routing,
        });
        if (written) {
          artifacts.push({
            name: "config-resolved.json",
            path: written,
            kind: "variant-config",
          });
        }
      }

      const durationSeconds = (Date.now() - startedAtMs) / 1000;
      let exitReason;
      let errorMessage;
      if (watchResult.status === "complete") exitReason = "completed";
      else if (watchResult.status === "failed") {
        exitReason = "crashed";
        errorMessage = "Spark run reached terminal status: failed";
      } else if (watchResult.status === "cancelled") {
        exitReason = "aborted";
        errorMessage = "Spark run was cancelled";
      } else {
        exitReason = "budget_exhausted";
        errorMessage = `No terminal run on workspace within ${input.budgetSeconds}s`;
      }

      return {
        finalRepoPath: input.seedRepoPath,
        transcript,
        artifacts,
        attemptCount: watchResult.attemptCount || 1,
        humanInterventions: watchResult.humanInterventions || 0,
        durationSeconds,
        exitReason,
        errorMessage,
        label: LABEL,
      };
    },
  };
}

module.exports = { createRunner };
