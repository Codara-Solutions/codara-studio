"use strict";

// Model-controlled CLI rivals share the evaluator and task workspaces. This
// module owns their process launch and telemetry normalization.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { headlessCommand, parseCodexOutput, parseClaudeOutput, codexSessionModels } = require("./headless.cjs");

const { hermesSessionId, exportHermesSession } = require("./hermes.cjs");

const RIVAL_AGENTS = ["hermes", "codex", "claude"];

function rivalLabel(agent, model = "gpt-5.6-sol", effort = "high") {
  return `${{ hermes: "Hermes Agent", codex: "Codex CLI", claude: "Claude Code" }[agent] ?? agent} (${model}, ${effort})`;
}

function buildRivalCommand(agent, {
  prompt,
  dir,
  resume,
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
      "chat",
      ...(dir ? ["--in", dir] : []),
      "--model",
      model,
      "--provider",
      "openai-codex",
      "--reasoning",
      effort,
      "--toolsets",
      "terminal,file,code_execution",
      ...resumeArgs,
      "--quiet",
      "--oneshot",
      "--query",
      prompt,
    ],
  };
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
  let env = agent === "hermes" ? { ...process.env, TERMINAL_CWD: dir } : process.env;
  if (agent === "codex") {
    if (!rivalHome) throw new Error("Codex benchmarks require an isolated rival home");
    fs.mkdirSync(rivalHome, { recursive: true });
    const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
    const target = path.join(rivalHome, "auth.json");
    if (!fs.existsSync(target) && fs.existsSync(auth)) fs.symlinkSync(auth, target);
    env = { ...process.env, CODEX_HOME: rivalHome };
  }
  const startedAt = Date.now();
  const before = agent === "hermes" && resume
    ? await exportHermesSession(execute, resume, { dir, effort }, env) : null;
  const invocation = buildRivalCommand(agent, { prompt, dir, resume, model, effort });
  const processResult = await execute(invocation.command, invocation.args, dir, capMs - (Date.now() - startedAt), env);
  let parsed;
  if (agent === "hermes") {
    const sessionId = hermesSessionId(processResult.stderr);
    try { parsed = await exportHermesSession(execute, sessionId, { dir, effort, before }, env); }
    catch (error) { parsed = { sessionId, turns: 0, tokens: 0, usage: null, failed: true, errorMessage: error.message }; }
  } else {
    parsed = agent === "codex" ? parseCodexOutput(processResult.stdout) : parseClaudeOutput(processResult.stdout);
  }
  if (agent === "codex") parsed.models = codexSessionModels(rivalHome, parsed.sessionId);
  parsed.models ??= parsed.model ? [parsed.model] : [];
  parsed.model ??= parsed.models[0] ?? null;

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
  rivalLabel,
  runRivalTurn,
};
