// The Pi extension behind `cora`: what Cora adds on top of Pi's agent loop.
// The loop, tools, sessions, retries and terminal UI are all Pi's.

import { registerContextCompaction } from "../../resources/pi-cora/compaction.ts";
import { CORA_ENGINEERING_RULES, CORA_REPLY_LANGUAGE } from "../../resources/pi-cora/prompt.ts";
import { loginName } from "./accounts.mjs";

const REPORTED_STATUSES = ["complete", "partial", "blocked", "failed"];

export function coraSystemPrompt({ exec }) {
  return `You are Cora, a coding agent working in the user's terminal.

- ${CORA_REPLY_LANGUAGE}
- For greetings, opinions, and questions that need no project work, answer
  directly without inspecting the repository.
- ${CORA_ENGINEERING_RULES}${
    exec
      ? `
- This is a one-shot run: nobody can answer a question. Make the safest
  reversible assumption and state it.
- When finished, call submit_result exactly once with an honest status. Use
  partial when any requested part is unfinished or unverified.`
      : ""
  }`;
}

/** A provider failure in plain words. `raw` stays in the text because Pi decides
 * whether to retry a request by matching the provider's own wording. */
export function explainProviderError(message, stalledMs, streamTimeoutMs) {
  const raw = (message.errorMessage ?? "").trim() || "unknown error";
  const who = `${message.provider ?? "provider"} (${message.model ?? "unknown model"})`;
  if (/\b(401|403)\b|unauthori[sz]ed|authentication|forbidden|invalid.{0,12}(token|api.?key)/i.test(raw)) {
    return `${who} rejected the login: ${raw}. Sign in again with: cora login ${loginName(message.provider)}`;
  }
  if (streamTimeoutMs > 0 && stalledMs >= streamTimeoutMs * 0.9) {
    return `${who} sent no data for ${Math.round(stalledMs / 1000)}s, so the request timed out (${raw})`;
  }
  if (/^terminated\.?$|other side closed|socket|connection|premature|stream (ended|closed)/i.test(raw)) {
    return `${who} dropped the connection before the reply finished (${raw})`;
  }
  return `${who}: ${raw}`;
}

function registerSubmitResult(pi, run) {
  pi.registerTool({
    name: "submit_result",
    label: "Submit result",
    description:
      "Finish this one-shot run and record its honest result. Call once, after edits and focused checks.",
    promptSnippet: "Record the outcome, changed files and checks of this run",
    parameters: {
      type: "object",
      required: ["status", "summary"],
      properties: {
        status: { type: "string", enum: REPORTED_STATUSES },
        summary: { type: "string", description: "One concise outcome sentence." },
        files_changed: {
          type: "array",
          items: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" }, reason: { type: "string" } },
            additionalProperties: false,
          },
        },
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["command", "result"],
            properties: {
              command: { type: "string" },
              result: { type: "string", enum: ["passed", "failed", "not_run"] },
              details: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const reported = REPORTED_STATUSES.includes(params.status) ? params.status : "failed";
      const failedCheck = params.checks?.some((check) => check.result === "failed");
      const status = reported === "complete" && failedCheck ? "partial" : reported;
      run.report = { ...params, status };
      return {
        content: [{ type: "text", text: `Result recorded (${status}).` }],
        details: { status },
        terminate: true,
      };
    },
  });
}

/**
 * @param run  shared state the exec wrapper reads once Pi returns
 * @param options.exec  a one-shot run, which gets submit_result
 * @param options.providerOverrides  provider name to Pi provider config
 * @param options.mcpConfig  normalized MCP roster, or null
 */
export function coraExtension(run, { exec, providerOverrides, mcpConfig }) {
  return async (pi) => {
    for (const [provider, config] of providerOverrides) pi.registerProvider(provider, config);
    registerContextCompaction(pi);
    if (exec) registerSubmitResult(pi, run);

    let lastStreamEvent = Date.now();
    let failedAttempt = null;
    pi.on("agent_start", () => {
      // A new agent run with an error pending is Pi retrying that one request,
      // from the same context. Extensions are not told so any other way.
      if (failedAttempt) {
        run.retries += 1;
        if (exec) process.stderr.write(`cora: ${failedAttempt}. Retrying the request.\n`);
      }
      failedAttempt = null;
    });
    pi.on("turn_start", () => {
      lastStreamEvent = Date.now();
    });
    pi.on("message_update", () => {
      lastStreamEvent = Date.now();
    });
    pi.on("session_start", (_event, ctx) => {
      run.sessionId = ctx.sessionManager.getSessionId();
    });
    pi.on("tool_execution_start", (event) => {
      if (exec && run.progress) process.stderr.write(`cora: ${event.toolName}\n`);
    });
    pi.on("message_end", (event) => {
      const { message } = event;
      if (message.role !== "assistant") return undefined;
      run.last = message;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        run.usage[key] += message.usage?.[key] ?? 0;
      }
      if (message.stopReason !== "error") return undefined;
      failedAttempt = explainProviderError(message, Date.now() - lastStreamEvent, run.streamTimeoutMs);
      run.last = { ...message, errorMessage: failedAttempt };
      return { message: run.last };
    });

    if (mcpConfig) {
      const { registerMcpBridge } = await import("../../resources/pi-cora/mcp-bridge.ts");
      let mcp = null;
      try {
        mcp = registerMcpBridge(pi, mcpConfig);
      } catch (error) {
        process.stderr.write(`cora: MCP servers are unavailable: ${error.message}\n`);
      }
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${mcp?.promptSuffix() ?? ""}`,
      }));
    }
  };
}
