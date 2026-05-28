// Spark Agent backend abstraction.
//
// One TypeScript interface per "manager" the chat composer can target. Today
// there are three implementations:
//
//   - OpenRouter   (src/main/orchestration/openrouter-backend.ts)
//       The original Spark Agent. Calls an LLM over HTTPS with a strict
//       json_schema response_format and produces a SparkManagerDecision the
//       run-store consumes directly. Execute and Talk modes are both
//       structured-output calls.
//
//   - Claude Code  (src/main/orchestration/claude-backend.ts)
//       Spawns a real `claude` CLI process under the existing pty-manager so
//       the conversation runs on the user's paid Claude.ai subscription
//       (interactive REPL is subscription-billed; `claude -p` will move to a
//       separate Agent SDK credit on 2026-06-15 — REPL is the durable choice).
//       Output comes from tailing the session JSONL at
//       ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl. Input is injected via
//       a UserPromptSubmit hook side-channel because the Ink REPL ignores
//       programmatic Enter from PTY stdin (claude-code issue #15553).
//
//   - Codex        (src/main/orchestration/codex-backend.ts)
//       Spawns a `codex` CLI process under pty-manager. Output comes from
//       tailing ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Input via plain
//       PTY stdin `\n` (Codex doesn't have the Ink bug).
//
// The dispatch lives in run-store.ts: when the manager pipeline is about to
// fire, it picks the backend from `run.chatBackend` (defaulting to OpenRouter
// for legacy / unset chats) and calls one of the methods below.

import type {
  AgentEffortLevel,
  AppSettings,
  AgentRuntimeDiagnostic,
  ChatBackendKind,
  ChatMode,
  HumanRunMessage,
  RunState,
} from "@shared/types";
import type {
  OpenRouterManagerMode,
  SparkManagerDecision,
  SparkManagerWorkerReportContext,
} from "./openrouter-manager";
import {
  effectiveChatFastMode,
  effectiveChatOneMillionContext,
} from "@shared/chat-policy";

/**
 * Per-chat configuration passed into every backend call. Resolved by
 * run-store from the RunState's chat* fields with backend-aware defaults
 * applied — see `resolveChatBackendConfig` below.
 */
export interface ChatBackendConfig {
  backend: ChatBackendKind;
  /** Backend-specific model id. Free-form for OpenRouter; one of the enum
   *  values for Claude/Codex. */
  model: string;
  mode: ChatMode;
  effort: AgentEffortLevel;
  /** Provider-side session UUID, when this chat already has one. Empty on
   *  the first call; the backend populates it onto the RunState on first
   *  spawn so subsequent calls can resume. */
  sessionUuid?: string;
  /** Which mode the persisted `sessionUuid` was spawned under. Set in lockstep
   *  with sessionUuid. Backends compare this to `mode` and force a fresh
   *  session on mismatch — the persisted UUID's JSONL transcript contains
   *  assistant replies from the OLD mode's persona, and CC/Codex anchor on
   *  that when they resume. */
  sessionMode?: ChatMode;
  /** Fast-mode toggle. Codex-only; Claude Code and OpenRouter ignore it. */
  fastMode: boolean;
  /** 1M-context toggle. Claude Code is normalized to true. */
  oneMillionContext: boolean;
}

/**
 * Inputs the manager pipeline hands to a backend's `requestManagerDecision`.
 * Mirrors the existing OpenRouter call site so the dispatch is a 1:1
 * structural translation, not a redesign.
 */
export interface ManagerRequestInput {
  run: RunState;
  cwd: string;
  mode: OpenRouterManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
  availableRuntimes?: AgentRuntimeDiagnostic[];
  agentSyncContext?: string;
  settings: AppSettings;
  /** Resolved per-chat backend config. The backend uses this to pick its
   *  model/effort and to know whether this is its first call for the chat. */
  chat: ChatBackendConfig;
}

/**
 * Result shape every backend returns from `requestManagerDecision`. Identical
 * to the OpenRouter manager's existing OpenRouterManagerResult so run-store
 * doesn't need to branch on backend after the call. The `decision` is the
 * canonical Spark structured output; non-OpenRouter backends synthesize a
 * decision (typically status=complete + chatReply for Talk mode, or a parsed
 * MCP-tool-call payload for Execute mode).
 */
export interface ManagerCallResult {
  decision: SparkManagerDecision;
  durationMs: number;
  model: string;
  /** Optional usage metadata. Populated for OpenRouter (priced) and for
   *  Claude/Codex when their JSONL transcript carries token counts; left
   *  undefined otherwise so the costs UI shows "—" instead of $0.00. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * If the backend rotated this chat onto a new CLI session UUID (e.g. a
   * fresh `claude` spawn that printed a new id), it returns the new id here.
   * run-store persists it to RunState.chatSessionUuid so the NEXT call can
   * `--resume <uuid>`.
   */
  newSessionUuid?: string;
  /** Free-form non-fatal status — surfaced as a system event in the run log
   *  but doesn't block the decision. Used by the stub backends to tell the
   *  user "claude backend is not yet wired; falling back to OpenRouter". */
  notice?: string;
}

/**
 * Streaming event a Talk-mode (and Execute-mode) backend emits between
 * request and response. The run-store dispatcher relays each event onto the
 * orchestration event bus as a `chat.<kind>` SparkEvent so the renderer's
 * ChatConversation can grow a live assistant bubble + render tool calls in
 * place as they arrive — without waiting for the full manager-decision
 * result.
 *
 * Naming convention is snake_case-after-dot to match Spark's existing
 * SparkEvent type vocabulary (`spark_call.completed`, `run.status_updated`).
 */
export type ChatStreamEvent =
  | {
      kind: "assistant_block";
      /** Stable per-message id from the CLI's JSONL transcript. Consecutive
       *  blocks may share a messageId — the renderer concatenates them into
       *  the same bubble. */
      messageId: string;
      text: string;
    }
  | {
      kind: "tool_use";
      toolName: string;
      input: unknown;
      toolUseId: string;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      output: string;
      isError?: boolean;
    }
  | { kind: "system_note"; message: string }
  | {
      kind: "usage";
      /** Tokens the backend reports for this turn. Drives the composer's
       *  token-counter chip when accumulated across the chat. */
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      /** Model's full context window in tokens, when the backend exposes it.
       *  Defaults handled renderer-side via contextWindowForModel(). */
      contextWindowTokens?: number;
    }
  | { kind: "error"; message: string };

export type ChatStreamHandler = (event: ChatStreamEvent) => void;

/**
 * The backend contract. Each implementation lives in its own file under
 * src/main/orchestration/ and is registered in `backend-registry.ts`.
 */
export interface SparkAgentBackend {
  kind: ChatBackendKind;
  /** Display name shown in the composer chip dropdown. */
  displayName: string;

  /**
   * Make a manager decision for the next pipeline step. In Execute mode this
   * is the structured plan-analysis / step-planning / worker-result-review
   * call; in Talk mode it returns a status=complete decision with a chatReply
   * populated from the backend's free-form response.
   *
   * Backends that drive a long-running CLI process (Claude, Codex) may stream
   * intermediate events via `onStream` while the call is in flight. The
   * dispatcher forwards those to the renderer; the returned promise resolves
   * once the backend has a final decision.
   */
  requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult>;

  /**
   * Dispose any per-chat resources (pty handles, file watchers, hook queue
   * files). Called when a chat is deleted or when the app shuts down. Idempotent.
   */
  disposeChat?(runId: string): Promise<void>;

  /**
   * Interrupt the in-flight turn for this chat without tearing the session
   * down. Sends ESC (or the runtime's equivalent) to the live CLI so the
   * model stops calling tools mid-turn. Called from forcePauseRun so the
   * user's "stop" doesn't have to wait for the 90s turn timeout. No-op if
   * the backend has no active session for this run.
   */
  interruptChat?(runId: string): void;
}

/**
 * Resolve effective backend config for a chat. Pulls values off the RunState
 * with backend-aware fallbacks applied. Run-store calls this once per
 * manager turn so every backend sees a fully-populated config.
 *
 * Defaults:
 *   - backend: openrouter (preserves pre-feature behaviour)
 *   - model:   backend-specific default (OpenRouter from settings,
 *              Claude=opus-4-8, Codex=gpt-5.5)
 *   - mode:    execute (the original behaviour)
 *   - effort:  medium
 */
export function resolveChatBackendConfig(
  run: RunState,
  settings: AppSettings,
): ChatBackendConfig {
  const backend: ChatBackendKind = run.chatBackend ?? "openrouter";
  const mode: ChatMode = run.chatMode ?? "execute";
  const effort: AgentEffortLevel = run.chatEffort ?? "medium";
  let model = run.chatModel?.trim();
  if (!model) {
    if (backend === "openrouter") {
      model = settings.openRouterModel || "google/gemini-flash-latest";
    } else if (backend === "claude") {
      model = "claude-opus-4-8";
    } else {
      model = "gpt-5.5";
    }
  }
  return {
    backend,
    model,
    mode,
    effort,
    sessionUuid: run.chatSessionUuid,
    sessionMode: run.chatSessionMode,
    fastMode: effectiveChatFastMode(backend, run.chatFastMode),
    oneMillionContext: effectiveChatOneMillionContext(backend),
  };
}

/**
 * Last-line-of-defense decision builder used by Talk-mode backends and stub
 * backends to package a free-form assistant reply as a SparkManagerDecision.
 * The run-store treats status=complete with a chatReply as a "no work to
 * do, just answer the user" outcome — perfect for Talk mode.
 */
export function buildTalkReplyDecision(
  chatReply: string,
  summary?: string,
): SparkManagerDecision {
  return {
    status: "complete",
    summary: summary?.trim() || "Backend chat reply.",
    chatReply: chatReply.trim(),
    steps: [],
    tasks: [],
  };
}

/**
 * Helper used by Claude/Codex backends when their CLI hasn't been spawned
 * yet for this chat and they only need to forward the latest user note as
 * the next prompt. Pulls the most recent user-authored `note` / `answer`
 * message off the run; empty string if the chat is freshly created.
 */
export function latestUserPromptFromRun(run: RunState): string {
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const message = run.humanMessages[i];
    if (message.author !== "user") continue;
    if (message.kind !== "note" && message.kind !== "answer") continue;
    if (message.message?.trim()) return message.message;
  }
  return "";
}

/** Re-exported for callers that want to type their HumanRunMessage walks. */
export type { HumanRunMessage };
