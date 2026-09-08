"use strict";

const fs = require("node:fs");
const path = require("node:path");

function hermesSessionId(stderr) {
  const matches = [...stderr.matchAll(/^session_id: ([A-Za-z0-9_-]+)\s*$/gm)];
  return matches.at(-1)?.[1] ?? null;
}

function parseHermesSession(stdout, { sessionId, dir, effort, before = null }) {
  const rows = stdout.split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const session = rows.find(row => row?.id === sessionId);
  if (!session) throw new Error("Hermes did not export the exact benchmark session");
  const canonical = value => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  if (typeof session.cwd !== "string" || canonical(session.cwd) !== canonical(dir)) throw new Error("Hermes session workspace does not match the benchmark");
  if (session.parent_session_id) throw new Error("Hermes rotated session lineage; complete usage needs a lineage audit");
  const config = typeof session.model_config === "string" ? JSON.parse(session.model_config) : session.model_config;
  const reasoningEffort = config?.reasoning_config?.effort ?? null;
  if (reasoningEffort !== effort) throw new Error(`Hermes reasoning effort mismatch: requested ${effort}; recorded ${reasoningEffort ?? "unset"}`);
  if (before && before.sessionId !== sessionId) throw new Error("Hermes continuation changed session ID");
  const fields = { inputTokens: "input_tokens", outputTokens: "output_tokens", cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens" };
  const cumulativeUsage = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, session[field]]));
  if (!Object.values(cumulativeUsage).every(value => Number.isFinite(value) && value >= 0)) throw new Error("Hermes session usage is missing or invalid");
  const usage = Object.fromEntries(Object.entries(cumulativeUsage).map(([key, value]) => [key, value - (before?.cumulativeUsage[key] ?? 0)]));
  if (Object.values(usage).some(value => value < 0)) throw new Error("Hermes session usage counters decreased");
  const cumulativeTurns = session.api_call_count;
  if (!Number.isFinite(cumulativeTurns) || cumulativeTurns < (before?.cumulativeTurns ?? 0)) throw new Error("Hermes session API count is invalid");
  const cumulativeQuestions = (session.messages ?? []).reduce((count, message) => {
    const calls = typeof message.tool_calls === "string" ? JSON.parse(message.tool_calls) : message.tool_calls;
    return count + (calls ?? []).filter(call => /^(clarify|ask_user)$/.test(call.function?.name ?? call.name ?? "")).length;
  }, 0);
  return { sessionId, model: session.model, provider: session.billing_provider, reasoningEffort,
    usage, cumulativeUsage, tokens: Object.values(usage).reduce((sum, value) => sum + value, 0),
    turns: cumulativeTurns - (before?.cumulativeTurns ?? 0), cumulativeTurns,
    questions: cumulativeQuestions - (before?.cumulativeQuestions ?? 0), cumulativeQuestions,
    failed: false };
}

async function exportHermesSession(execute, sessionId, options, env) {
  if (!sessionId) throw new Error("Hermes did not report an exact session ID");
  const result = await execute("hermes", ["--safe-mode", "sessions", "export", "-", "--session-id", sessionId, "--format", "jsonl", "--redact"], options.dir, 30_000, env);
  if (result.error || result.timedOut) throw new Error("Hermes session telemetry export failed");
  return parseHermesSession(result.stdout, { ...options, sessionId });
}

module.exports = { hermesSessionId, parseHermesSession, exportHermesSession };
