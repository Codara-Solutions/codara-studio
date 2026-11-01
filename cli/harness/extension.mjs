// The Pi extension behind `cora`: what Cora adds on top of Pi's agent loop.
// The loop, tools, sessions, retries and terminal UI are all Pi's.

import { writeSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CORA_ENGINEERING_RULES, CORA_REPLY_LANGUAGE } from "../../resources/pi-cora/prompt.ts";
import { loginName } from "./accounts.mjs";
import { registerCompaction } from "./compaction.mjs";

const REPORTED_STATUSES = ["complete", "partial", "blocked", "failed"];
/** Longer than this is not worth holding a run open for. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const CHATGPT_RESPONSES_PATH = "/codex/responses";

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
- When finished, call submit_result exactly once with an honest status, then
  write your closing message as a normal reply. Use partial when any requested
  part is unfinished or unverified.
- That reply is all the reader sees, so it holds the whole answer at full
  length. Copy code, diffs and output exactly from what you read, never from
  memory. End with any closing line or format the user asked for, word for word.`
      : ""
  }`;
}

/**
 * Pi turns every ChatGPT 429 with an error body into the same "usage limit"
 * sentence and drops the code and reset time, so they are read off the response.
 * WebSocket errors keep their own wording and never reach this.
 */
export function observeChatgptLimits(run) {
  const { fetch } = globalThis;
  globalThis.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 429 && String(input.url ?? input).endsWith(CHATGPT_RESPONSES_PATH)) {
      const error = await response.clone().json().then((body) => body?.error, () => null);
      const retryAfter = Number(response.headers.get("retry-after"));
      run.chatgptLimit = {
        code: String(error?.code ?? error?.type ?? ""),
        plan: error?.plan_type,
        resetsAt: error?.resets_at ? error.resets_at * 1000 : retryAfter > 0 ? Date.now() + retryAfter * 1000 : null,
      };
    }
    return response;
  };
}

/** A rate limit passes in moments. A usage limit needs its reset, so retrying
 * only burns the retry budget and hides the answer. */
function chatgptLimitFailure(limit, now) {
  const waitMs = limit.resetsAt ? Math.max(0, limit.resetsAt - now) : 0;
  const usage = limit.code === "usage_not_included" || (limit.code === "usage_limit_reached" && !limit.resetsAt);
  if (!usage && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
    return { waitMs, errorMessage: `ChatGPT rate limited the request (429), for about ${Math.ceil(waitMs / 1000)}s` };
  }
  const plan = limit.plan ? ` on the ${String(limit.plan).toLowerCase()} plan` : "";
  const when = limit.resetsAt
    ? ` It resets at ${new Date(limit.resetsAt).toLocaleString()}, in about ${Math.ceil(waitMs / 60_000)} min.`
    : "";
  // "quota exceeded" is one of Pi's no-retry phrases, and a number in the time must
  // not read as an HTTP status to its retry check.
  return { resetsAt: limit.resetsAt, errorMessage: `ChatGPT usage limit reached, quota exceeded${plan}.${when}` };
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

function textOf(message) {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function registerSessionLock(pi, run, { exec, locks }) {
  const inUse = (file, pid) => `session ${basename(file, ".jsonl").split("_").at(-1)} is in use by process ${pid}`;
  pi.on("session_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const holder = file ? locks.acquire(file) : null;
    if (!holder) return;
    const error = inUse(file, holder);
    if (ctx.hasUI) {
      // After the terminal interface has given the screen back.
      process.on("exit", (code) => {
        process.stderr.write(`cora: ${error}\n`);
        process.exitCode = code || 1;
      });
      ctx.shutdown();
      return;
    }
    run.finished = true;
    process.stderr.write(`cora: ${error}\n`);
    if (run.json) writeSync(1, `${JSON.stringify({ type: "cora_result", status: "error", exitCode: 1, error })}\n`);
    process.exit(1);
  });
  pi.on("session_before_switch", (event, ctx) => {
    const holder = event.targetSessionFile ? locks.inUseBy(event.targetSessionFile) : null;
    if (!holder) return undefined;
    ctx.ui.notify(`Cora: ${inUse(event.targetSessionFile, holder)}.`, "error");
    return { cancel: true };
  });
}

function registerSubmitResult(pi, run) {
  pi.registerTool({
    name: "submit_result",
    label: "Submit result",
    description:
      "Record the honest result of this one-shot run. Call once, after edits and focused checks, then write " +
      "your closing message as a normal reply.",
    promptSnippet: "Record the outcome, before your closing message",
    parameters: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: REPORTED_STATUSES },
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
        content: [{ type: "text", text: `Result recorded (${status}). Now write your closing message as a normal reply.` }],
        details: { status },
      };
    },
  });
}

/**
 * @param run  shared state the exec wrapper reads once Pi returns
 * @param options.exec  a one-shot run, which gets submit_result
 * @param options.mcpConfig  normalized MCP roster, or null
 * @param options.compaction  { state, config, engine } for registerCompaction
 * @param options.locks  this process's session locks
 */
export function coraExtension(run, { exec, mcpConfig, compaction, locks }) {
  return async (pi) => {
    registerCompaction(pi, run, { exec, ...compaction });
    if (exec) registerSubmitResult(pi, run);
    registerSessionLock(pi, run, { exec, locks });

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
    pi.on("message_end", async (event, ctx) => {
      const { message } = event;
      if (message.role !== "assistant") return undefined;
      run.last = message;
      const said = textOf(message);
      if (said) run.closing = said;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        run.usage[key] += message.usage?.[key] ?? 0;
      }
      if (message.stopReason !== "error") return undefined;
      const limit = run.chatgptLimit && /hit your ChatGPT usage limit/.test(message.errorMessage ?? "");
      const failure = limit ? chatgptLimitFailure(run.chatgptLimit, Date.now()) : null;
      failedAttempt = failure?.errorMessage ?? explainProviderError(message, Date.now() - lastStreamEvent, run.streamTimeoutMs);
      run.chatgptLimit = null;
      run.last = { ...message, errorMessage: failedAttempt };
      if (failure?.resetsAt) run.resetsAt = new Date(failure.resetsAt).toISOString();
      if (failure?.waitMs) await delay(failure.waitMs, undefined, { signal: ctx.signal }).catch(() => undefined);
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
