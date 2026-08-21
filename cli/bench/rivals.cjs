"use strict";

// Hermes is Cora's model-controlled benchmark rival. Seeding, clocks, hidden
// checks, scoring, and cleanup live in commands/bench.cjs; this file owns only
// Hermes CLI syntax and usage-report parsing.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const RIVAL_AGENTS = ["hermes"];

function rivalLabel(_agent, model = "gpt-5.6-sol", effort = "high") {
  return `Hermes Agent (${model}, ${effort})`;
}

function buildRivalCommand(agent, {
  prompt,
  resume,
  usageFile,
  model = "gpt-5.6-sol",
  effort = "high",
}) {
  if (agent !== "hermes") throw new Error(`unknown rival agent: ${agent}`);
  const resumeArgs = typeof resume === "string" ? ["--resume", resume] : resume ? ["--continue"] : [];
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

function execute(command, args, cwd, capMs) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
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
  });
}

async function runRivalTurn(agent, {
  dir,
  prompt,
  capMs,
  resume,
  model = "gpt-5.6-sol",
  effort = "high",
}) {
  const usageFile = path.join(
    os.tmpdir(),
    `cora-bench-hermes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const invocation = buildRivalCommand(agent, { prompt, resume, usageFile, model, effort });
  const processResult = await execute(invocation.command, invocation.args, dir, capMs);
  const parsed = readHermesUsage(usageFile);
  fs.rmSync(usageFile, { force: true });

  return {
    ...parsed,
    timedOut: processResult.timedOut,
    error:
      processResult.error ??
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
