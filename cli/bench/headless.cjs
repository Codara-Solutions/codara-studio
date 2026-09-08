"use strict";

const fs = require("node:fs");
const path = require("node:path");

function headlessCommand(agent, { prompt, resume, model, effort }) {
  if (resume && typeof resume !== "string") throw new Error(`${agent} continuation requires an exact session ID`);
  if (agent === "codex") {
    const common = ["--json", "--ignore-user-config", "--ignore-rules", "--model", model,
      "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="workspace-write"'];
    return { command: "codex", args: ["exec", ...(resume ? ["resume"] : []), ...common, ...(resume ? [resume] : []), prompt] };
  }
  if (agent === "claude") {
    return { command: "claude", args: ["--print", "--safe-mode", "--output-format", "json", "--model", model,
      "--effort", effort, "--permission-mode", "bypassPermissions", "--tools", "Bash,Read,Edit,Write,Glob,Grep",
      ...(resume ? ["--resume", resume] : []), "--", prompt] };
  }
  throw new Error(`Unknown headless agent: ${agent}`);
}

function jsonLines(text) {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseCodexOutput(stdout) {
  const events = jsonLines(stdout);
  const completed = events.filter((event) => event.type === "turn.completed");
  const lastTurn = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed").at(-1);
  const usage = completed.reduce((sum, event) => ({
    inputTokens: sum.inputTokens + (event.usage?.input_tokens ?? 0),
    outputTokens: sum.outputTokens + (event.usage?.output_tokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (event.usage?.cached_input_tokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  return {
    sessionId: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
    turns: completed.length,
    // Codex reports cached input as a subset of input_tokens.
    tokens: usage.inputTokens + usage.outputTokens,
    usage: { ...usage, inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens), cacheWriteTokens: 0 },
    failed: lastTurn?.type !== "turn.completed",
    models: [],
  };
}

function parseClaudeOutput(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { result = jsonLines(stdout).findLast((event) => event.type === "result"); }
  if (Array.isArray(result)) result = result.findLast((event) => event.type === "result");
  const raw = result?.usage ?? {};
  const usage = {
    inputTokens: raw.input_tokens ?? 0, outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0, cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
  };
  return {
    sessionId: result?.session_id ?? null,
    turns: result?.num_turns ?? 0,
    tokens: Object.values(usage).reduce((sum, value) => sum + value, 0),
    usage,
    errorMessage: result?.is_error === true && typeof result.result === "string" ? result.result : null,
    failed: result?.type !== "result" || result?.subtype !== "success" || result?.is_error === true,
    models: Object.keys(result?.modelUsage ?? {}),
  };
}

function codexSessionControl(home, sessionId) {
  const missing = { models: [], reasoningEfforts: [] };
  if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId)) return missing;
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return missing;
  const file = fs.readdirSync(root, { recursive: true }).find((file) => typeof file === "string" && file.endsWith(`-${sessionId}.jsonl`));
  if (!file) return missing;
  const contexts = jsonLines(fs.readFileSync(path.join(root, file), "utf8"))
    .filter((event) => event.type === "turn_context");
  return {
    models: [...new Set(contexts.map((event) => event.payload?.model ?? "unset"))],
    reasoningEfforts: [...new Set(contexts.map((event) => event.payload?.effort ?? "unset"))],
  };
}

module.exports = { headlessCommand, parseCodexOutput, parseClaudeOutput, codexSessionControl };
