// Adapter: ClaudeBestSingleRunner
//
// Spawns the `claude` CLI as a child process at the strongest available
// single-agent setting (model: claude-opus-4-7, effort/thinking: max), feeds
// it the plan, lets it run to completion, and reports the diff.
//
// This is the strongest single-agent baseline we measure Spark against.
// "Best single" intentionally excludes any orchestration — one agent, one
// shot, no manager/sub-agents.
//
// Approach:
//   * spawn `claude --dangerously-skip-permissions --model claude-opus-4-7
//     --effort max --output-format stream-json` with the plan piped to stdin.
//     Claude Code CLI supports prompt piping via stdin and streams JSON
//     events on stdout when --output-format stream-json is set; we capture
//     them into the transcript.
//   * If the agent's CLI lacks --effort/--output-format, we degrade:
//     try without --effort, then without --output-format. The CLI still
//     runs the agent; we just lose structured event capture.
//   * We watch the process for exit. The plan is a request to refactor an
//     existing repo; the agent edits files in seedRepoPath in place.
//   * On budget exhaustion we send SIGTERM, give it 10s to flush, then SIGKILL.
//
// This adapter does NOT silently fall back if `claude` is missing — it
// rejects with a clear error so the harness operator sees what to install.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const runnerLib = require("../lib/runner");
const variantConfig = require("../lib/variant-config");

const ID = "claude_best_single";
const LABEL = "Claude Code (claude-opus-4-7, max thinking)";
const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_EFFORT = "max";

function which(cmd) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(lookup, [cmd], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0) return null;
  const first = (res.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
}

function probeFlagSupport(claudeBin) {
  // `claude --help` should mention --model, --effort, --output-format if
  // they're supported. We check the help text rather than spawning a real
  // run, since spawning the agent inevitably costs tokens.
  const res = spawnSync(claudeBin, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  return {
    hasModel: /--model\b/.test(text),
    hasEffort: /--effort\b/.test(text) || /--reasoning-effort\b/.test(text),
    hasStreamJson: /stream-json|--output-format\s+json/i.test(text),
    hasPrint: /--print\b/.test(text) || /--prompt\b/.test(text),
  };
}

/**
 * @param {Object} opts
 * @param {string} [opts.bin]    Override the claude binary path.
 *
 * model + effort come from input.config (variant config) on each run, NOT
 * from constructor opts. This makes a single adapter instance reusable
 * across variant configs and ensures the recorded eval-result reflects the
 * config that was actually pinned for the run.
 */
function createRunner(opts = {}) {
  const bin = opts.bin || which("claude");
  if (!bin) {
    // Defer the error until run() so the harness can still construct the
    // adapter object and report the exact missing dependency in the
    // eval-result.json.
  }

  return {
    id: ID,
    label: LABEL,
    async run(input) {
      const startedAtMs = Date.now();
      const transcript = [];
      transcript.push(runnerLib.event("adapter:start", `${LABEL}`));
      if (!bin) {
        const msg =
          "Cannot run claude_best_single: `claude` CLI is not on PATH. Install with `npm i -g @anthropic-ai/claude-code` and run `claude` once to log in.";
        transcript.push(runnerLib.event("error", msg));
        const err = new Error(msg);
        err.code = "CLAUDE_CLI_NOT_FOUND";
        throw err;
      }
      // Pull model/effort from the variant config; fall back to defaults
      // only when no config was provided (e.g. an adapter author running
      // smoke tests directly). The pilot always passes a resolved config.
      const cfg = input.config || null;
      const model = (cfg && cfg.model) || DEFAULT_MODEL;
      const effort = (cfg && cfg.effort) || DEFAULT_EFFORT;
      transcript.push(
        runnerLib.event("config", `variantId=${(cfg && cfg.variantId) || "(none)"} model=${model} effort=${effort}`),
      );

      const flagSupport = probeFlagSupport(bin);
      transcript.push(runnerLib.event("flag-probe", "", flagSupport));

      const planText = fs.readFileSync(input.planFile, "utf8");

      // Build args. We send the plan via stdin (--print mode) so we don't
      // bake it into argv (which would lose newlines on Windows).
      // Claude Code requires --verbose alongside --output-format=stream-json
      // when --print is set; without it the CLI exits with an arg validation
      // error before doing anything.
      const args = ["--dangerously-skip-permissions"];
      if (flagSupport.hasModel) args.push("--model", model);
      if (flagSupport.hasEffort) args.push("--effort", effort);
      if (flagSupport.hasStreamJson) {
        args.push("--output-format", "stream-json", "--verbose");
      }
      if (flagSupport.hasPrint) {
        args.push("--print");
      }
      transcript.push(runnerLib.event("spawn", `${bin} ${args.join(" ")}`));

      const env = { ...process.env, ...input.env };
      // Make sure colour fights and pager nonsense don't trip the CLI.
      env.NO_COLOR = "1";
      env.CI = "1";
      env.FORCE_COLOR = "0";

      const child = spawn(bin, args, {
        cwd: input.seedRepoPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // Write the plan to stdin and close so claude knows EOF.
      child.stdin.write(planText);
      child.stdin.end();

      const stdoutBuf = [];
      const stderrBuf = [];
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdoutBuf.push(text);
        transcript.push(runnerLib.event("stdout", "", { bytes: chunk.length, text: text.slice(0, 500) }));
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrBuf.push(text);
        transcript.push(runnerLib.event("stderr", "", { bytes: chunk.length, text: text.slice(0, 500) }));
      });

      // Honor whatever budget the harness passes. The pilot script is the
      // single source of truth for budgets — adapters should not silently
      // raise them. (We keep a 10s minimum so a typo doesn't immediately
      // kill the spawn before claude even starts up.)
      const budgetMs = Math.max(10_000, input.budgetSeconds * 1000);
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(budgetTimer);
          resolve(value);
        };
        const budgetTimer = setTimeout(() => {
          transcript.push(
            runnerLib.event("budget-exhausted", `Hit budget after ${budgetMs}ms; sending SIGTERM.`),
          );
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          // Hard kill 10s later if still alive.
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 10_000);
          finish({ exitReason: "budget_exhausted", code: null });
        }, budgetMs);

        child.on("error", (err) => {
          transcript.push(runnerLib.event("error", err.message));
          finish({ exitReason: "crashed", code: null, errorMessage: err.message });
        });
        child.on("exit", (code, signal) => {
          transcript.push(runnerLib.event("exit", "", { code, signal }));
          if (signal && signal !== "SIGTERM") {
            finish({ exitReason: "crashed", code, errorMessage: `signal=${signal}` });
            return;
          }
          finish({
            exitReason: code === 0 ? "completed" : "crashed",
            code,
            errorMessage: code === 0 ? undefined : `exited with code ${code}`,
          });
        });
      });

      // Persist stdout/stderr as artifacts so a reviewer can replay.
      const artifactsDir = path.join(
        path.dirname(input.seedRepoPath),
        `${input.runId}-artifacts`,
      );
      fs.mkdirSync(artifactsDir, { recursive: true });
      const stdoutPath = path.join(artifactsDir, "claude.stdout.log");
      const stderrPath = path.join(artifactsDir, "claude.stderr.log");
      fs.writeFileSync(stdoutPath, stdoutBuf.join(""), "utf8");
      fs.writeFileSync(stderrPath, stderrBuf.join(""), "utf8");

      // Record the resolved variant config alongside the agent logs.
      const artifacts = [
        { name: "claude.stdout.log", path: stdoutPath, kind: "agent-log" },
        { name: "claude.stderr.log", path: stderrPath, kind: "agent-log" },
      ];
      if (cfg) {
        const routing = variantConfig.buildClaudeBaselineRouting({
          config: cfg,
          runId: input.runId,
          exitReason: result.exitReason,
        });
        const pipelineRecord = variantConfig.buildPipelineRecord({
          config: cfg,
          repoRoot: variantConfig.sparkHomeDir(), // unused for claude; kept for shape symmetry
        });
        const written = variantConfig.writeConfigResolvedArtifact({
          artifactsDir,
          config: cfg,
          configResolved: pipelineRecord ? pipelineRecord.configResolved : null,
          routing,
        });
        if (written) {
          artifacts.push({ name: "config-resolved.json", path: written, kind: "variant-config" });
        }
      }

      const durationSeconds = (Date.now() - startedAtMs) / 1000;
      return {
        finalRepoPath: input.seedRepoPath,
        transcript,
        artifacts,
        attemptCount: 1,
        humanInterventions: 0,
        durationSeconds,
        exitReason: result.exitReason,
        errorMessage: result.errorMessage,
        label: LABEL,
      };
    },
  };
}

module.exports = { createRunner };
