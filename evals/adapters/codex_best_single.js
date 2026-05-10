// Adapter: CodexBestSingleRunner
//
// Spawns the `codex` CLI (Codex CLI from OpenAI) at the strongest available
// single-agent setting (model: gpt-5.5, reasoning_effort: xhigh by default)
// in non-interactive `codex exec` mode, feeds it the plan, lets it run to
// completion, and reports the diff.
//
// This is the second strongest single-agent baseline we measure Spark
// against (alongside claude_best_single). "Best single" intentionally
// excludes any orchestration — one agent, one shot, no manager/sub-agents.
//
// Approach:
//   * spawn `codex exec --dangerously-bypass-approvals-and-sandbox -m <model>
//     -c model_reasoning_effort="<effort>" -C <cwd> --json --skip-git-repo-check`
//     with the plan piped via stdin.
//   * Codex writes its session log to ~/.codex; we capture stdout/stderr
//     into the artifacts dir for replay.
//   * On budget exhaustion we send SIGTERM, give it 10s to flush, then SIGKILL.
//
// Codex flag surface (verified `codex --help` and `codex exec --help`):
//   * `-m, --model <MODEL>`                          model selection
//   * `-c, --config <key=value>`                     toml override (used for reasoning_effort)
//   * `-s, --sandbox <MODE>`                         not used (we bypass entirely)
//   * `--dangerously-bypass-approvals-and-sandbox`   skip all approval prompts
//   * `-C, --cd <DIR>`                               working dir
//   * `--json`                                       JSONL events on stdout
//   * `--skip-git-repo-check`                        not strictly required (seed IS a git repo)
//   * Codex has no `--effort` flag; reasoning effort lives in config.toml,
//     overridden here via `-c model_reasoning_effort="<effort>"`.
//
// This adapter does NOT silently fall back if `codex` is missing — it
// rejects with a clear error so the harness operator sees what to install.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const runnerLib = require("../lib/runner");
const variantConfig = require("../lib/variant-config");

const ID = "codex_best_single";
const LABEL = "Codex CLI (gpt-5.5, xhigh reasoning)";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_EFFORT = "xhigh";

function which(cmd) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(lookup, [cmd], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0) return null;
  const lines = (res.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // On Windows, npm installs both a POSIX shell wrapper (no extension) and
  // a `.cmd` / `.bat` / `.exe` shim. `child_process.spawn` without
  // `shell: true` cannot execute the unextended wrapper, so prefer the
  // Windows-executable variant when multiple are listed.
  if (process.platform === "win32") {
    const exts = [".cmd", ".bat", ".exe", ".ps1"];
    const winExec = lines.find((p) => exts.some((e) => p.toLowerCase().endsWith(e)));
    if (winExec) return winExec;
  }
  return lines[0];
}

/**
 * Build [cmd, args] for spawnSync/spawn on this platform.
 *
 * On Windows, .cmd / .bat shims are not executable directly via
 * `child_process.spawn` without `shell: true`. We wrap them in `cmd.exe /c`
 * so they run reliably regardless of which shell the harness is invoked
 * from. Direct .exe invocations don't need wrapping.
 */
function buildSpawn(bin, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return ["cmd.exe", ["/c", bin, ...args]];
  }
  return [bin, args];
}

function probeFlagSupport(codexBin) {
  // `codex --help` and `codex exec --help` are both static. We probe both
  // to detect flag-shape drift. The harness keeps running even if a flag
  // is unavailable; it just degrades the configuration loudly in the
  // transcript so a reviewer can see what wasn't honored.
  const [rootCmd, rootArgs] = buildSpawn(codexBin, ["--help"]);
  const [execCmd, execArgs] = buildSpawn(codexBin, ["exec", "--help"]);
  const root = spawnSync(rootCmd, rootArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const exec = spawnSync(execCmd, execArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const text = `${root.stdout || ""}\n${root.stderr || ""}\n${exec.stdout || ""}\n${exec.stderr || ""}`;
  return {
    hasExecSubcommand: /\bcodex exec\b/i.test(text) || /^\s*exec\b/m.test(text),
    hasModel: /-m\b|--model\b/.test(text),
    hasConfigOverride: /-c\b.*--config|<key=value>/.test(text),
    hasBypass: /--dangerously-bypass-approvals-and-sandbox\b/.test(text),
    hasJson: /\s--json\b/.test(text),
    hasCd: /-C\b|--cd\b/.test(text),
    hasOutputLastMessage: /-o\b|--output-last-message\b/.test(text),
  };
}

/**
 * @param {Object} opts
 * @param {string} [opts.bin]    Override the codex binary path.
 *
 * model + effort come from input.config (variant config) on each run, NOT
 * from constructor opts. This makes a single adapter instance reusable
 * across variant configs and ensures the recorded eval-result reflects the
 * config that was actually pinned for the run.
 */
function createRunner(opts = {}) {
  const bin = opts.bin || which("codex");
  // Defer the missing-binary error until run() so the harness can still
  // construct the adapter and surface it cleanly in the result JSON.

  return {
    id: ID,
    label: LABEL,
    async run(input) {
      const startedAtMs = Date.now();
      const transcript = [];
      transcript.push(runnerLib.event("adapter:start", `${LABEL}`));
      if (!bin) {
        const msg =
          "Cannot run codex_best_single: `codex` CLI is not on PATH. Install with `npm i -g @openai/codex` (or your distribution's equivalent) and run `codex login` once.";
        transcript.push(runnerLib.event("error", msg));
        const err = new Error(msg);
        err.code = "CODEX_CLI_NOT_FOUND";
        throw err;
      }
      const cfg = input.config || null;
      const model = (cfg && cfg.model) || DEFAULT_MODEL;
      const effort = (cfg && cfg.effort) || DEFAULT_EFFORT;
      transcript.push(
        runnerLib.event("config", `variantId=${(cfg && cfg.variantId) || "(none)"} model=${model} effort=${effort}`),
      );

      const flagSupport = probeFlagSupport(bin);
      transcript.push(runnerLib.event("flag-probe", "", flagSupport));

      const planText = fs.readFileSync(input.planFile, "utf8");

      // Build args for `codex exec`. The plan is piped via stdin (no
      // positional PROMPT arg) so newlines and shell metacharacters reach
      // the agent verbatim.
      const args = ["exec"];
      if (flagSupport.hasBypass) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
      if (flagSupport.hasModel) {
        args.push("-m", model);
      }
      if (flagSupport.hasConfigOverride) {
        // Codex stores reasoning effort in config.toml; we override per-run.
        // Quote the value so codex's TOML parser sees a string (parens around
        // the key avoid ambiguity if codex ever supports nested overrides
        // for the same key under multiple namespaces).
        args.push("-c", `model_reasoning_effort="${effort}"`);
      }
      if (flagSupport.hasCd) {
        args.push("-C", input.seedRepoPath);
      }
      args.push("--skip-git-repo-check"); // seed IS a git repo, but harmless
      if (flagSupport.hasJson) {
        args.push("--json");
      }
      const [spawnCmd, spawnArgs] = buildSpawn(bin, args);
      transcript.push(runnerLib.event("spawn", `${spawnCmd} ${spawnArgs.join(" ")}`));

      const env = { ...process.env, ...input.env };
      env.NO_COLOR = "1";
      env.CI = "1";
      env.FORCE_COLOR = "0";

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: input.seedRepoPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

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

      const artifactsDir = path.join(
        path.dirname(input.seedRepoPath),
        `${input.runId}-artifacts`,
      );
      fs.mkdirSync(artifactsDir, { recursive: true });
      const stdoutPath = path.join(artifactsDir, "codex.stdout.log");
      const stderrPath = path.join(artifactsDir, "codex.stderr.log");
      fs.writeFileSync(stdoutPath, stdoutBuf.join(""), "utf8");
      fs.writeFileSync(stderrPath, stderrBuf.join(""), "utf8");

      const artifacts = [
        { name: "codex.stdout.log", path: stdoutPath, kind: "agent-log" },
        { name: "codex.stderr.log", path: stderrPath, kind: "agent-log" },
      ];
      if (cfg) {
        const routing = variantConfig.buildCodexBaselineRouting({
          config: cfg,
          runId: input.runId,
          exitReason: result.exitReason,
        });
        const pipelineRecord = variantConfig.buildPipelineRecord({
          config: cfg,
          repoRoot: variantConfig.sparkHomeDir(),
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
