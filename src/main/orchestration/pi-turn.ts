import type { ChatStreamHandler } from "./agent-backend";
import type { PiRpcEvent } from "./pi-rpc-client";
import { resolveCompactAtTokens } from "@shared/context-compaction";

export interface PiTurnToolCall {
  toolName: string;
  toolUseId: string;
  input: unknown;
}

export interface PiTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** OpenRouter catalog-priced estimate for every request in this turn,
   *  summed. Captured only for an OpenRouter-backed session; native
   *  subscription sessions intentionally remain 0 even if Pi's catalog
   *  supplies an API-equivalent cost. */
  costUsd: number;
}

export interface PiTurnResult {
  finalText: string;
  /** Number of distinct assistant messages observed. This lets the backend
   *  distinguish a missed event stream from an explicitly empty final. */
  assistantMessageCount: number;
  toolCalls: PiTurnToolCall[];
  successfulToolCalls: PiTurnToolCall[];
  /** Provider response ids observed during this turn. Persisted on the
   *  SparkCall so support can correlate a capacity failure without needing
   *  Pi's ephemeral in-memory error object. */
  providerResponseIds: string[];
  usage: PiTurnUsage;
  /** Context the newest request occupied, not a sum over the turn. 0 when the
   *  provider reported no usable usage. */
  contextTokens: number;
  /** The provider's context window when it reported one, else null. */
  contextWindowTokens: number | null;
  failure: string | null;
  settled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Pi normalizes provider usage to `{ input, output, cacheRead, cacheWrite,
 *  total }` under `usage.cost`. Only the summed `total` survives to Codara;
 *  the split is provider-specific and unused here. */
function costTotalFrom(usage: Record<string, unknown> | null): number {
  const cost = asRecord(usage?.cost);
  return finiteCount(cost?.total);
}

/** A positive count, or null when the field is absent or unusable. Distinct
 *  from finiteCount because an absent context window must stay absent rather
 *  than collapsing to 0 and overriding the renderer's per-model default. */
function positiveCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Tokens occupying the model's context for ONE request. Pi normalizes provider
 * usage to `{ input, output, cacheRead }`, where `input` excludes what came
 * back from the prompt cache, so the prompt the model actually read is the
 * uncached input plus the cached reads plus anything written to the cache on
 * this request. Alternate spellings are accepted because this reads a provider
 * passthrough, not a Codara-owned shape.
 */
function contextTokensFrom(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  return (
    finiteCount(usage.input ?? usage.inputTokens ?? usage.input_tokens) +
    finiteCount(usage.cacheRead ?? usage.cache_read ?? usage.cached) +
    finiteCount(usage.cacheWrite ?? usage.cache_write ?? usage.cacheCreation)
  );
}

/** Forward-compatibility only: the pinned Pi 0.82 never puts a context window
 *  on message_end usage (it lives on the Model definition), so this returns
 *  null on every production event today. Kept because the shape is a provider
 *  passthrough that may grow the field, and the renderer already falls back to
 *  contextWindowForModel() while it is absent. */
function contextWindowFrom(
  message: Record<string, unknown>,
  usage: Record<string, unknown> | null,
): number | null {
  return (
    positiveCount(usage?.contextWindow ?? usage?.context_window) ??
    positiveCount(message.contextWindow ?? message.context_window) ??
    null
  );
}

function textBlocks(value: unknown): string {
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : [];
  return content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantText(messageValue: unknown): string {
  const message = asRecord(messageValue);
  if (message?.role !== "assistant") return "";
  return textBlocks(message);
}

function assistantMessageId(messageValue: unknown, fallback: string): string {
  const message = asRecord(messageValue);
  if (typeof message?.id === "string" && message.id) return message.id;
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return `pi-assistant-${message.timestamp}`;
  }
  return fallback;
}

function toolOutput(resultValue: unknown): string {
  const text = textBlocks(resultValue);
  if (text) return text;
  if (resultValue === undefined) return "";
  try { return JSON.stringify(resultValue); }
  catch { return String(resultValue); }
}

/**
 * Deterministically converts one Pi RPC turn into Codara's existing stream and
 * manager-decision inputs. It deliberately consumes only documented RPC
 * fields; unknown future events are ignored instead of corrupting a run.
 */
export class PiTurnAccumulator {
  private readonly onStream?: ChatStreamHandler;
  private readonly captureCost: boolean;
  private readonly toolCalls: PiTurnToolCall[] = [];
  private readonly toolIds = new Set<string>();
  private readonly completedToolIds = new Set<string>();
  private readonly failedToolIds = new Set<string>();
  private readonly streamedText = new Map<string, string>();
  private readonly completedText = new Map<string, string>();
  private readonly assistantOrder: string[] = [];
  private assistantSequence = 0;
  private currentAssistantId: string | null = null;
  private usage: PiTurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  // Context occupancy is a gauge, not a counter: the newest assistant message
  // carries the whole conversation so far, so a tool loop's later rounds
  // supersede the earlier ones instead of adding to them.
  private contextTokens = 0;
  private contextWindowTokens: number | null = null;
  // Provider errors are provisional while Pi's own auto-retry loop is active.
  // Keep them separate from extension failures so a later successful provider
  // response can clear only the retryable failure, never a broken bridge.
  private providerFailure: string | null = null;
  private fatalFailure: string | null = null;
  private readonly providerResponseIds = new Set<string>();
  private settled = false;

  constructor(
    onStream?: ChatStreamHandler,
    options: { captureCost?: boolean } = {},
  ) {
    this.onStream = onStream;
    this.captureCost = options.captureCost === true;
  }

  consume(event: PiRpcEvent): void {
    if (event.type === "message_start") {
      const message = asRecord(event.message);
      if (message?.role === "assistant") this.ensureAssistant(message, true);
      return;
    }

    if (event.type === "message_update") {
      const message = asRecord(event.message);
      const delta = asRecord(event.assistantMessageEvent);
      if (message?.role !== "assistant" || delta?.type !== "text_delta" || typeof delta.delta !== "string") {
        return;
      }
      const messageId = this.ensureAssistant(message);
      this.streamedText.set(messageId, `${this.streamedText.get(messageId) ?? ""}${delta.delta}`);
      this.onStream?.({ kind: "assistant_block", messageId, text: delta.delta });
      return;
    }

    if (event.type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role !== "assistant") return;
      const messageId = this.ensureAssistant(message);
      // Store even an empty completion. An explicit empty final is materially
      // different from a message_end event that was never observed, and must
      // not fall back to earlier streamed progress text.
      this.completedText.set(messageId, assistantText(message));
      const usage = asRecord(message.usage);
      this.usage = {
        inputTokens: this.usage.inputTokens + finiteCount(usage?.input),
        outputTokens: this.usage.outputTokens + finiteCount(usage?.output),
        cacheReadTokens: this.usage.cacheReadTokens + finiteCount(
          usage?.cacheRead ?? usage?.cache_read ?? usage?.cached,
        ),
        costUsd: this.usage.costUsd + (this.captureCost ? costTotalFrom(usage) : 0),
      };
      const context = contextTokensFrom(usage);
      if (context > 0) this.contextTokens = context;
      this.contextWindowTokens = contextWindowFrom(message, usage) ?? this.contextWindowTokens;
      if (typeof message.responseId === "string" && message.responseId.trim()) {
        this.providerResponseIds.add(message.responseId.trim());
      }
      if (message.stopReason === "error") {
        this.providerFailure = typeof message.errorMessage === "string" && message.errorMessage.trim()
          ? message.errorMessage.trim()
          : "Pi provider turn failed.";
      } else {
        // Pi emits the successful message_end before auto_retry_end(success),
        // so clear the provisional error at the first authoritative recovery
        // signal. The later retry event is handled too for forward compatibility.
        this.providerFailure = null;
      }
      // An errored request reports all-zero usage; emitting that gauge would
      // wipe every consumer's context meter to 0. No reading beats a false
      // zero, so stay quiet until real usage accumulates.
      if (
        this.usage.inputTokens + this.usage.outputTokens + this.usage.cacheReadTokens > 0 ||
        this.contextTokens > 0
      ) {
        const { costUsd, ...tokenUsage } = this.usage;
        this.onStream?.({
          kind: "usage",
          ...tokenUsage,
          // Turn-cumulative OpenRouter catalog estimate. Emitted only once it
          // is positive; native subscription chats never capture this field.
          ...(costUsd > 0 ? { costUsd } : {}),
          ...(this.contextTokens > 0 ? { contextTokens: this.contextTokens } : {}),
          ...(this.contextWindowTokens !== null
            ? { contextWindowTokens: this.contextWindowTokens }
            : {}),
          // The ceiling this session will actually compact at. Only Pi sessions
          // carry it, which is exactly the set of chats the extension runs in.
          compactAtTokens: resolveCompactAtTokens(process.env.CODARA_PI_COMPACT_AT_TOKENS),
        });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      if (typeof event.toolCallId !== "string" || !event.toolCallId ||
          typeof event.toolName !== "string" || !event.toolName || this.toolIds.has(event.toolCallId)) {
        return;
      }
      this.toolIds.add(event.toolCallId);
      const call = {
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        input: event.args,
      };
      this.toolCalls.push(call);
      this.onStream?.({ kind: "tool_use", ...call });
      return;
    }

    if (event.type === "tool_execution_end") {
      if (typeof event.toolCallId !== "string" || !event.toolCallId) return;
      this.completedToolIds.add(event.toolCallId);
      if (event.isError === true) this.failedToolIds.add(event.toolCallId);
      this.onStream?.({
        kind: "tool_result",
        toolUseId: event.toolCallId,
        output: toolOutput(event.result),
        isError: event.isError === true,
      });
      return;
    }

    if (event.type === "extension_error") {
      const detail = typeof event.error === "string" && event.error.trim()
        ? event.error.trim()
        : "Pi extension failed.";
      this.fatalFailure = detail;
      this.onStream?.({ kind: "error", message: detail });
      return;
    }

    if (event.type === "auto_retry_end") {
      if (event.success === true) {
        this.providerFailure = null;
        return;
      }
      if (event.success === false) {
        const detail = typeof event.finalError === "string" && event.finalError.trim()
          ? event.finalError.trim()
          : "Pi exhausted automatic retries.";
        this.providerFailure = detail;
        this.onStream?.({ kind: "error", message: detail });
      }
      return;
    }

    if (event.type === "agent_settled") this.settled = true;
  }

  result(): PiTurnResult {
    const finalAssistantId = this.assistantOrder[this.assistantOrder.length - 1];
    const finalText = finalAssistantId
      ? (
          this.completedText.has(finalAssistantId)
            ? this.completedText.get(finalAssistantId)
            : this.streamedText.get(finalAssistantId)
        )?.trim() ?? ""
      : "";
    return {
      finalText,
      assistantMessageCount: this.assistantOrder.length,
      toolCalls: this.toolCalls.map((call) => ({ ...call })),
      successfulToolCalls: this.toolCalls
        .filter((call) => this.completedToolIds.has(call.toolUseId) && !this.failedToolIds.has(call.toolUseId))
        .map((call) => ({ ...call })),
      providerResponseIds: [...this.providerResponseIds],
      usage: { ...this.usage },
      contextTokens: this.contextTokens,
      contextWindowTokens: this.contextWindowTokens,
      failure: this.fatalFailure ?? this.providerFailure,
      settled: this.settled,
    };
  }

  private ensureAssistant(message: Record<string, unknown>, begin = false): string {
    if (!begin && typeof message.id !== "string" && typeof message.timestamp !== "number" && this.currentAssistantId) {
      return this.currentAssistantId;
    }
    const fallback = `pi-assistant-${++this.assistantSequence}`;
    const id = assistantMessageId(message, fallback);
    if (!this.assistantOrder.includes(id)) this.assistantOrder.push(id);
    this.currentAssistantId = id;
    return id;
  }
}
