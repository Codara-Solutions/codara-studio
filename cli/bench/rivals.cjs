"use strict";

// Model-controlled CLI rivals share the evaluator and task workspaces. This
// module owns their process launch and telemetry normalization.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { headlessCommand, parseCodexOutput, parseClaudeOutput, codexSessionModels } = require("./headless.cjs");

const RIVAL_AGENTS = ["hermes", "codex", "claude"];

function rivalLabel(agent, model = "gpt-5.6-sol", effort = "high") {
  return `${{ hermes: "Hermes Agent", codex: "Codex CLI", claude: "Claude Code" }[agent] ?? agent} (${model}, ${effort})`;
}

function buildRivalCommand(agent, {
  prompt,
  resume,
  usageFile,
  model = "gpt-5.6-sol",
  effort = "high",
}) {
  if (agent === "codex" || agent === "claude") return headlessCommand(agent, { prompt, resume, model, effort });
  if (agent !== "hermes") throw new Error(`unknown rival agent: ${agent}`);
  if (resume && typeof resume !== "string") throw new Error("hermes continuation requires an exact session ID");
  const resumeArgs = resume ? ["--resume", resume] : [];
  return {
    command: "hermes",
    args: [
      "--safe-mode",
      "--yolo",
      "--model",
      model,
      "--provider",
      "openai-codex",
      "--reasoning",
      effort,
      "--toolsets",
      "terminal,file,code_execution",
      "--usage-file",
      usageFile,
      ...resumeArgs,
      "--oneshot",
      prompt,
    ],
  };
}

function readHermesUsage(file) {
  try {
    const usage = JSON.parse(fs.readFileSync(file, "utf8"));
    const tokens = Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_read_tokens ?? 0) +
        (usage.cache_write_tokens ?? 0);
    return {
      usage: Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens) ? {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_tokens ?? 0,
        cacheWriteTokens: usage.cache_write_tokens ?? 0,
      } : null,
      sessionId: usage.session_id ?? null,
      turns: usage.api_calls ?? 0,
      tokens,
      model: usage.model ?? null,
      provider: usage.provider ?? null,
      failed: Boolean(usage.failed),
    };
  } catch {
    return {
      sessionId: null,
      turns: 0,
      tokens: 0,
      model: null,
      provider: null,
      failed: false,
    };
  }
}

function execute(command, args, cwd, capMs, env = process.env) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        env,
        timeout: Math.max(1, capMs),
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error.killed || error.signal === "SIGKILL"));
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut,
          error: error && !timedOut ? error : null,
        });
      },
    );
    // Headless CLIs may read piped stdin before starting, even with a prompt argv.
    child.stdin?.end();
  });
}

async function runRivalTurn(agent, {
  dir,
  prompt,
  capMs,
  resume,
  model = "gpt-5.6-sol",
  effort = "high",
  rivalHome,
}) {
  let env = process.env;
  if (agent === "codex") {
    if (!rivalHome) throw new Error("Codex benchmarks require an isolated rival home");
    fs.mkdirSync(rivalHome, { recursive: true });
    const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
    const target = path.join(rivalHome, "auth.json");
    if (!fs.existsSync(target) && fs.existsSync(auth)) fs.symlinkSync(auth, target);
    env = { ...process.env, CODEX_HOME: rivalHome };
  }
  const usageFile = path.join(
    os.tmpdir(),
    `cora-bench-hermes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const invocation = buildRivalCommand(agent, { prompt, resume, usageFile, model, effort });
  const processResult = await execute(invocation.command, invocation.args, dir, capMs, env);
  const parsed = agent === "codex" ? parseCodexOutput(processResult.stdout)
    : agent === "claude" ? parseClaudeOutput(processResult.stdout)
      : readHermesUsage(usageFile);
  if (agent === "codex") parsed.models = codexSessionModels(rivalHome, parsed.sessionId);
  parsed.models ??= parsed.model ? [parsed.model] : [];
  parsed.model ??= parsed.models[0] ?? null;
  fs.rmSync(usageFile, { force: true });

  return {
    ...parsed,
    timedOut: processResult.timedOut,
    error:
      (parsed.errorMessage ? new Error(parsed.errorMessage) : processResult.error) ??
      (parsed.failed ? new Error(`${agent} reported a failed one-shot run`) : null),
    stderr: processResult.stderr,
  };
}

module.exports = {
  RIVAL_AGENTS,
  buildRivalCommand,
  readHermesUsage,
  rivalLabel,
  runRivalTurn,
};
