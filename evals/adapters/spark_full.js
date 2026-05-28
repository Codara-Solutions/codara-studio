// Adapter: SparkFullRunner
//
// Spawns Spark Agent's main process in headless eval mode. Spark used to
// require an operator to drive its UI, but it now exposes a `--eval-plan`
// startup flag (see src/main/eval/headless-runner.ts) that boots the same
// autopilot loop the renderer's start button calls — without ever creating
// a BrowserWindow.
//
// Headless contract (mirrored from src/main/eval/headless-runner.ts):
//   stdin:  ignored
//   stdout: exactly one JSON line on terminal state, e.g.
//             {"runId":"run-abc","runDir":"/path","status":"completed","durationSeconds":42}
//   stderr: structured progress, one JSON object per line ("ts" + "type" +
//           payload). Adapters can stream these to surface live progress.
//   exit:   0  -> completed; 1  -> failed/cancelled/paused;
//           2  -> adapter error (bad args, missing config); 124 -> timed_out
//
// On budget exhaustion this adapter sends SIGTERM, then SIGKILL if the
// process refuses to exit cleanly. We mirror the harness's `budgetSeconds`
// onto Spark via `--eval-budget`; Spark also enforces it internally so we
// have two stops (process kill + run-store budget) covering both Electron
// crashes and a stuck OpenRouter call.
//
// Default variant config (when --config is omitted):
//   evals/configs/spark_full-grok43.json (variantId=spark_full_grok43)
// The four Spark variants we compare differ only in the manager — workers
// are always max-everything Claude/Codex (subscription-flat).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const runnerLib = require("../lib/runner");
const variantConfig = require("../lib/variant-config");
const seedRepoLib = require("../lib/seed-repo");

const ID = "spark_full";
const LABEL = "Spark Agent (full orchestration, headless)";

function sparkHomeDir() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".SparkAgent");
}

function runsRoot() {
  return path.join(sparkHomeDir(), "runs");
}

// Locate the Electron entry point we'll spawn for headless mode. We use
// node's module resolver to find the electron binary from the source repo
// (works for both standalone installs and git worktrees that share the
// parent repo's node_modules). The compiled main bundle lives at
// out/main/index.js after `npm run build`.
function resolveLaunchCommand({ repoRoot, planFile, evalConfigPath, outputDir, budgetSeconds }) {
  let electronBin;
  try {
    // require('electron') returns the absolute path of the binary, courtesy
    // of the @electron/get postinstall hook. Resolve from repoRoot so we
    // pick up the project's pinned electron version even when the harness
    // is invoked from a different cwd.
    const electronPkg = require.resolve("electron", { paths: [repoRoot] });
    // electronPkg points at electron/index.js; the binary lives next to it
    // exposed by electron's own package main.
    electronBin = require(electronPkg);
  } catch (err) {
    throw new Error(
      `could not locate electron from ${repoRoot}: ${err.message}. Run 'npm install' first.`,
    );
  }
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    throw new Error(
      `electron module did not resolve to a real binary path (got ${electronBin}). Run 'npm install' from ${repoRoot}.`,
    );
  }
  const mainBundle = path.join(repoRoot, "out", "main", "index.js");
  if (!fs.existsSync(mainBundle)) {
    throw new Error(
      `compiled main bundle not found at ${mainBundle} — run 'npm run build' from ${repoRoot} before running the eval.`,
    );
  }
  const args = [
    mainBundle,
    "--eval-plan", planFile,
    "--eval-budget", String(budgetSeconds),
  ];
  if (evalConfigPath) args.push("--eval-config", evalConfigPath);
  if (outputDir) args.push("--eval-output-dir", outputDir);
  return { command: electronBin, args };
}

function parseStderrLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseStdoutLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function createRunner(opts = {}) {
  return {
    id: ID,
    label: LABEL,
    async run(input) {
      const startedAtMs = Date.now();
      const transcript = [];
      transcript.push(runnerLib.event("adapter:start", LABEL));

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

      // Stage the seed repo's plan as the headless plan file. The plan
      // shipped under evals/tasks/<id>/plan.md is the canonical prompt; we
      // pass it through unchanged. (Spark uses the plan file's parent dir
      // as the workspace cwd, so we copy plan.md into the seed repo first.)
      const planInRepo = path.join(input.seedRepoPath, "spark-eval-plan.md");
      try {
        fs.copyFileSync(input.planFile, planInRepo);
      } catch (err) {
        const msg = `failed to stage plan file in seed repo: ${err.message}`;
        transcript.push(runnerLib.event("error", msg));
        return errorResult({
          input,
          transcript,
          startedAtMs,
          exitReason: "launch_failed",
          errorMessage: msg,
        });
      }

      // Where Spark should mirror its run dir for harness consumption.
      const artifactsDir = path.join(
        path.dirname(input.seedRepoPath),
        `${input.runId}-artifacts`,
      );
      fs.mkdirSync(artifactsDir, { recursive: true });
      const sparkRunMirror = path.join(artifactsDir, "spark-run");

      let launch;
      try {
        launch = resolveLaunchCommand({
          repoRoot,
          planFile: planInRepo,
          evalConfigPath: cfg ? cfg._sourcePath : null,
          outputDir: sparkRunMirror,
          budgetSeconds: input.budgetSeconds,
        });
      } catch (err) {
        transcript.push(runnerLib.event("error", err.message));
        return errorResult({
          input,
          transcript,
          startedAtMs,
          exitReason: "launch_failed",
          errorMessage: err.message,
        });
      }

      transcript.push(runnerLib.event("spawn", `${launch.command} ${launch.args.join(" ")}`));

      // Isolate the headless Spark's state dir per-eval so concurrent
      // runs (another eval + the operator's desktop app, two evals in
      // parallel, etc.) cannot collide on spark-state.json /
      // spark-settings.json / runs/<runId>. Each eval gets a fresh
      // `.SparkAgent` under its artifacts dir; the existing user
      // settings (OpenRouter key, manager model, etc.) are mirrored over
      // so the manager can authenticate. Spark Agent already honors
      // SPARK_HOME_DIR via spark-home.ts.
      const isolatedHome = path.join(artifactsDir, ".SparkAgent");
      fs.mkdirSync(isolatedHome, { recursive: true });
      try {
        const userSettings = path.join(sparkHomeDir(), "spark-settings.json");
        if (fs.existsSync(userSettings)) {
          fs.copyFileSync(userSettings, path.join(isolatedHome, "spark-settings.json"));
        }
      } catch (err) {
        transcript.push(
          runnerLib.event(
            "warn",
            `failed to mirror spark-settings.json into isolated home: ${err.message}`,
          ),
        );
      }

      // Spark in headless mode listens to spark-settings.json for the
      // OpenRouter API key plus environment overrides. Forward env from the
      // pilot so the operator's existing auth (SPARK_OPENROUTER_API_KEY,
      // OPENROUTER_API_KEY) reaches the child without a settings round-trip.
      const env = {
        ...process.env,
        ...input.env,
        SPARK_HOME_DIR: isolatedHome,
      };

      const child = spawn(launch.command, launch.args, {
        cwd: input.seedRepoPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let summary = null;
      const stdoutBuf = [];
      const stderrBuf = [];
      let stdoutLineRemainder = "";
      let stderrLineRemainder = "";

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdoutBuf.push(text);
        // The headless runner promises a single JSON line on stdout at the
        // very end; capture it incrementally so we can pluck the summary as
        // soon as it appears. We tolerate Spark printing other stdout lines
        // earlier (e.g. Electron diagnostics) by always picking the LAST
        // parseable JSON line we see.
        stdoutLineRemainder += text;
        const lines = stdoutLineRemainder.split(/\r?\n/);
        stdoutLineRemainder = lines.pop() || "";
        for (const line of lines) {
          const parsed = parseStdoutLine(line);
          if (parsed && parsed.runId && parsed.status) summary = parsed;
        }
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrBuf.push(text);
        stderrLineRemainder += text;
        const lines = stderrLineRemainder.split(/\r?\n/);
        stderrLineRemainder = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = parseStderrLine(line);
          if (parsed && parsed.type) {
            transcript.push(runnerLib.event(`spark:${parsed.type}`, "", parsed));
          } else {
            transcript.push(runnerLib.event("stderr", line));
          }
        }
      });

      // Process supervision. The harness's wall-clock budget is the master;
      // Spark also enforces an internal budget, so we add a small grace
      // period before SIGTERM so the run-store can flush the final summary.
      const budgetMs = Math.max(60_000, input.budgetSeconds * 1000);
      const exitInfo = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(budgetTimer);
          resolve(value);
        };
        const budgetTimer = setTimeout(() => {
          transcript.push(
            runnerLib.event(
              "budget-exhausted",
              `Adapter budget hit after ${budgetMs}ms; sending SIGTERM to headless Spark.`,
            ),
          );
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 10_000);
          finish({ code: null, signal: "SIGTERM", budgetExhausted: true });
        }, budgetMs + 30_000);

        child.on("error", (err) => {
          transcript.push(runnerLib.event("error", err.message));
          finish({ code: null, signal: null, error: err.message });
        });
        child.on("exit", (code, signal) => {
          // Drain any tail line from stderr / stdout into the transcript /
          // summary lookup before we resolve.
          if (stderrLineRemainder.trim()) {
            const parsed = parseStderrLine(stderrLineRemainder);
            if (parsed && parsed.type) {
              transcript.push(runnerLib.event(`spark:${parsed.type}`, "", parsed));
            } else {
              transcript.push(runnerLib.event("stderr", stderrLineRemainder));
            }
            stderrLineRemainder = "";
          }
          if (stdoutLineRemainder.trim()) {
            const parsed = parseStdoutLine(stdoutLineRemainder);
            if (parsed && parsed.runId && parsed.status) summary = parsed;
            stdoutLineRemainder = "";
          }
          transcript.push(runnerLib.event("exit", "", { code, signal }));
          finish({ code, signal });
        });
      });

      // Persist headless stdout/stderr alongside the existing run.json
      // mirror so reviewers can replay the agent's launch banner + any
      // Electron diagnostics.
      const stdoutPath = path.join(artifactsDir, "spark.stdout.log");
      const stderrPath = path.join(artifactsDir, "spark.stderr.log");
      try {
        fs.writeFileSync(stdoutPath, stdoutBuf.join(""), "utf8");
        fs.writeFileSync(stderrPath, stderrBuf.join(""), "utf8");
      } catch (err) {
        transcript.push(runnerLib.event("error", `failed to persist agent logs: ${err.message}`));
      }

      // Map exit code + summary status to RunnerResult.exitReason. The
      // headless runner's mapping is authoritative when we have a summary;
      // exit code is used only as a fallback for crashes / signals.
      let exitReason;
      let errorMessage;
      if (summary) {
        if (summary.status === "completed") exitReason = "completed";
        else if (summary.status === "timed_out") {
          exitReason = "budget_exhausted";
          errorMessage = "Headless Spark exited with timed_out (run-store budget)";
        } else {
          exitReason = "crashed";
          errorMessage = `Headless Spark reported status: ${summary.status}`;
        }
      } else if (exitInfo.budgetExhausted) {
        exitReason = "budget_exhausted";
        errorMessage = `No final summary from headless Spark within ${input.budgetSeconds}s`;
      } else if (exitInfo.signal && exitInfo.signal !== "SIGTERM") {
        exitReason = "crashed";
        errorMessage = `Headless Spark received signal ${exitInfo.signal}`;
      } else if (typeof exitInfo.code === "number" && exitInfo.code !== 0) {
        exitReason = "crashed";
        errorMessage = `Headless Spark exited with code ${exitInfo.code}`;
      } else {
        exitReason = "completed";
      }

      const artifacts = [
        { name: "spark.stdout.log", path: stdoutPath, kind: "agent-log" },
        { name: "spark.stderr.log", path: stderrPath, kind: "agent-log" },
      ];

      // The mirror dir contains run.json + events.jsonl; surface them as
      // typed artifacts so the pilot can extract routing.
      if (summary && summary.runDir && fs.existsSync(summary.runDir)) {
        const runJsonPath = path.join(summary.runDir, "run.json");
        const eventsPath = path.join(summary.runDir, "events.jsonl");
        if (fs.existsSync(runJsonPath)) {
          artifacts.push({ name: "run.json", path: runJsonPath, kind: "spark-state" });
        }
        if (fs.existsSync(eventsPath)) {
          artifacts.push({ name: "events.jsonl", path: eventsPath, kind: "spark-events" });
        }
      } else {
        // Fallback to the canonical Spark home dir when --eval-output-dir
        // mirroring failed.
        const fallbackRunDir =
          summary && summary.runId ? path.join(runsRoot(), summary.runId) : null;
        if (fallbackRunDir && fs.existsSync(fallbackRunDir)) {
          const runJsonPath = path.join(fallbackRunDir, "run.json");
          const eventsPath = path.join(fallbackRunDir, "events.jsonl");
          if (fs.existsSync(runJsonPath)) {
            artifacts.push({ name: "run.json", path: runJsonPath, kind: "spark-state" });
          }
          if (fs.existsSync(eventsPath)) {
            artifacts.push({ name: "events.jsonl", path: eventsPath, kind: "spark-events" });
          }
        }
      }

      // Snapshot the resolved variant config + extracted routing into the
      // adapter's artifact dir. We pull routing from the run.json artifact
      // we just located so the snapshot stands on its own even if the live
      // Spark home dir is wiped later.
      if (cfg) {
        let routing = [];
        const runJsonArtifact = artifacts.find(
          (a) => a.name === "run.json" && a.kind === "spark-state",
        );
        if (runJsonArtifact && fs.existsSync(runJsonArtifact.path)) {
          try {
            const runJson = JSON.parse(fs.readFileSync(runJsonArtifact.path, "utf8"));
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

      // Attempt count + human interventions are extracted from the captured
      // run.json when present.
      let attemptCount = 1;
      let humanInterventions = 0;
      const runJsonArtifact = artifacts.find(
        (a) => a.name === "run.json" && a.kind === "spark-state",
      );
      if (runJsonArtifact && fs.existsSync(runJsonArtifact.path)) {
        try {
          const runJson = JSON.parse(fs.readFileSync(runJsonArtifact.path, "utf8"));
          attemptCount = (runJson.workerAttempts && runJson.workerAttempts.length) || 1;
          humanInterventions =
            (runJson.humanMessages || []).filter((m) => m.author === "user").length;
        } catch {
          /* keep defaults */
        }
      }

      const durationSeconds = (Date.now() - startedAtMs) / 1000;
      return {
        finalRepoPath: input.seedRepoPath,
        transcript,
        artifacts,
        attemptCount,
        humanInterventions,
        durationSeconds,
        exitReason,
        errorMessage,
        label: LABEL,
      };
    },
  };
}

function errorResult({ input, transcript, startedAtMs, exitReason, errorMessage }) {
  const durationSeconds = (Date.now() - startedAtMs) / 1000;
  return {
    finalRepoPath: input.seedRepoPath,
    transcript,
    artifacts: [],
    attemptCount: 0,
    humanInterventions: 0,
    durationSeconds,
    exitReason,
    errorMessage,
    label: LABEL,
  };
}

module.exports = { createRunner };
