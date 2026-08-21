// Cora manager backend abstraction.
//
// One TypeScript interface per "manager" the chat composer can target. Pi
// (src/main/orchestration/pi-backend.ts) — the bundled, subscription-only
// Cora harness — is the only implementation left: the Claude Code and Codex
// manager backends were retired in 2026-08. The interface survives because
// run-store's dispatch is written against it, not against pi-backend.
//
// The dispatch lives in run-store.ts: when the manager pipeline is about to
// fire, it picks the backend from `run.chatBackend` (defaulting to Pi
// for legacy / unset chats) and calls one of the methods below.

import type {
  AgentEffortLevel,
  ChatBackendKind,
  ChatMode,
  CoraExecutionPolicy,
  HumanRunMessage,
  RunState,
} from "@shared/types";
import { DEFAULT_CODEX_CHAT_MODEL } from "@shared/model-catalog";
import type {
  ManagerMode,
  SparkManagerDecision,
  SparkManagerWorkerReportContext,
} from "./manager-protocol";
import { effectiveChatMode } from "@shared/chat-policy";
import { effectiveRunExecutionPolicy } from "./execution-policy";

/**
 * Per-chat configuration passed into every backend call. Resolved by
 * run-store from the RunState's chat* fields with backend-aware defaults
 * applied — see `resolveChatBackendConfig` below.
 */
export interface ChatBackendConfig {
  backend: ChatBackendKind;
  /** Backend-specific model id, one of the enum values for the backend's
   *  runtime. */
  model: string;
  mode: ChatMode;
  effort: AgentEffortLevel;
  /** Opaque Pi profile pin resolved from the run for this frozen turn. */
  accountProfileId?: string;
  /** Per-chat Pi execution depth. */
  executionPolicy: CoraExecutionPolicy;
  /** Provider-side session UUID, when this chat already has one. Empty on
   *  the first call; the backend populates it onto the RunState on first
   *  spawn so subsequent calls can resume. */
  sessionUuid?: string;
  /** Which mode the persisted `sessionUuid` was spawned under. Set in lockstep
   *  with sessionUuid. The backend compares this to `mode` and forces a fresh
   *  session on mismatch — the persisted UUID's transcript contains assistant
   *  replies from the OLD mode's persona, and the model anchors on that when
   *  it resumes. */
  sessionMode?: ChatMode;
}

/**
 * Inputs the manager pipeline hands to a backend's `requestManagerDecision`.
 */
export interface ManagerRequestInput {
  run: RunState;
  cwd: string;
  mode: ManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
  /** Ordered immutable user input bundled by run-store before backend startup. */
  prompt: string;
  /** Durable message ownership mirrored onto the SparkCall. */
  inputMessageIds: string[];
  /** Conversation generation captured with the frozen input. */
  conversationEpoch: number;
  /** Called only after the provider/PTY has accepted this exact prompt. */
  onPromptAccepted?: () => void | Promise<void>;
  /** Called as soon as the backend knows which provider session this turn is
   *  writing to — before the turn settles. Run-store persists the uuid
   *  durably here so a crash mid-turn can still resume the same transcript;
   *  waiting for the final ManagerCallResult loses the id (and with it the
   *  whole conversation) when the process dies while the turn is in flight. */
  onSessionEstablished?: (sessionUuid: string) => void | Promise<void>;
  /** Resolved per-chat backend config. The backend uses this to pick its
   *  model/effort and to know whether this is its first call for the chat. */
  chat: ChatBackendConfig;
}

/**
 * Result shape every backend returns from `requestManagerDecision`. Uniform
 * across backends so run-store doesn't need to branch on backend after the
 * call. The `decision` is the canonical Codara structured output, which every
 * CLI backend synthesizes (typically status=complete + chatReply for Talk
 * mode, or a parsed MCP-tool-call payload for Execute mode).
 */
export interface ManagerCallResult {
  decision: SparkManagerDecision;
  /** The selected CLI MCP tool already mutated the run while the turn was
   * live. Run-store must record the call but must not synthesize it again. */
  decisionAlreadyApplied?: boolean;
  durationMs: number;
  model: string;
  /** Opaque Pi profile that actually served the turn, when profile-routed. */
  accountProfileId?: string;
  /** Optional usage metadata. Populated when the backend's JSONL transcript
   *  carries token counts; left undefined otherwise so the costs UI shows
   *  ", " instead of $0.00. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Provider response ids observed during the call, when the backend exposes
   *  them. Useful for correlating capacity failures with provider support. */
  providerResponseIds?: string[];
  /** The model's context window, when the backend reported one for this turn.
   *  Persisted onto the SparkCall so the context meter reads a real window
   *  instead of contextWindowForModel()'s per-model default. */
  contextWindowTokens?: number;
  /**
   * If the backend rotated this chat onto a new CLI session UUID (e.g. a
   * fresh `claude` spawn that printed a new id), it returns the new id here.
   * run-store persists it to RunState.chatSessionUuid so the NEXT call can
   * `--resume <uuid>`.
   */
  newSessionUuid?: string;
  /** Free-form non-fatal status — surfaced as a system event in the run log
   *  but doesn't block the decision. Used by a backend to tell the user
   *  something about the turn without failing it. */
  notice?: string;
  /**
   * The backend could NOT complete this turn (turn timeout, CLI crash,
   * backend error). `decision` then only carries a best-effort chatReply
   * (partial assistant text or the error description) and MUST NOT be
   * applied as a normal manager decision — a status:"complete" decision
   * from a dead turn would record "Cora answered the chat turn" and mark
   * the run complete even though nothing was answered. run-store's
   * dispatcher fails the SparkCall and applies the manager-turn failure
   * policy: preserve an authoritative state, retry, park provider trouble,
   * or mark a genuine turn failure.
   */
  turnFailed?: boolean;
  /**
   * The turn ended because the USER interrupted it (Stop button →
   * interruptChat), not because anything went wrong. run-store treats this
   * as a quiet no-op: no manager decision applied (no "Cora answered the
   * chat turn"), no run.failed, run status untouched — the Stop path
   * (forcePauseRun / stopAndUndoPending) already put the run where it
   * belongs. Wins over turnFailed when both could apply.
   */
  turnAborted?: boolean;
}

/**
 * Streaming event a Talk-mode (and Execute-mode) backend emits between
 * request and response. The run-store dispatcher relays each event onto the
 * orchestration event bus as a `chat.<kind>` SparkEvent so the renderer's
 * ChatConversation can grow a live assistant bubble + render tool calls in
 * place as they arrive — without waiting for the full manager-decision
 * result.
 *
 * Naming convention is snake_case-after-dot to match Codara's existing
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
      /** Tokens occupying the model's latest request context. Unlike
       * inputTokens (an incremental billing/audit counter), this is a gauge:
       * renderers replace the previous value instead of summing it. */
      contextTokens?: number;
      /** Model's full context window in tokens, when the backend exposes it.
       *  Defaults handled renderer-side via contextWindowForModel(). */
      contextWindowTokens?: number;
      /** Context tokens at which this session auto-compacts. Pi sessions only:
       *  the claude and codex backends drive CLIs that compact on their own
       *  terms. The renderer measures its meter against this, not the raw
       *  window. Absent means "assume the shared default". */
      compactAtTokens?: number;
    }
  | { kind: "error"; message: string };

export type ChatStreamHandler = (event: ChatStreamEvent) => void;

/** Pure epoch guards shared by manager completion and checkpoint jobs. */
export function isManagerTurnCurrent(
  run: RunState,
  callId: string,
  epoch: number,
): boolean {
  return (
    (run.conversationEpoch ?? 0) === epoch &&
    run.sparkCalls.some(
      (call) => call.id === callId && (call.conversationEpoch ?? 0) === epoch,
    )
  );
}

export function isCheckpointJobCurrent(
  run: RunState,
  epoch: number | undefined,
  messageId?: string,
): boolean {
  if (epoch !== undefined && (run.conversationEpoch ?? 0) !== epoch) return false;
  return !messageId || run.humanMessages.some((message) => message.id === messageId);
}

/**
 * A fresh CLI session after rewind needs canonical dialogue replay until one
 * manager turn in the new epoch was actually accepted by the provider. Failed
 * pre-submission attempts do not consume replay ownership, so an idempotent
 * retry still receives the retained conversation.
 *
 * Epoch 0 is the original conversation, no rewind happened, so the live CLI
 * session still holds the whole dialogue and replaying it would double it up.
 * Every backend drives a CLI session, so this applies to all of them.
 */
export function shouldIncludeCanonicalReplay(
  run: RunState,
  epoch: number,
): boolean {
  if (epoch <= 0) return false;
  const currentCallIds = new Set(
    run.sparkCalls
      .filter((call) => (call.conversationEpoch ?? 0) === epoch)
      .map((call) => call.id),
  );
  return !run.humanMessages.some(
    (message) =>
      message.author === "user" &&
      (message.conversationEpoch ?? 0) === epoch &&
      Boolean(message.backendTurnId) &&
      currentCallIds.has(message.backendTurnId as string) &&
      (message.deliveryState === "submitted" ||
        message.deliveryState === "acknowledged"),
  );
}

/**
 * The backend contract. Each implementation lives in its own file under
 * src/main/orchestration/ and is registered in `backend-registry.ts`.
 */
export interface AgentBackend {
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
 * with fallbacks applied. Run-store calls this once per manager turn so the
 * backend sees a fully-populated config.
 *
 * Defaults:
 *   - backend: Pi (the bundled Cora harness — the only one; it also carries
 *     verified OpenRouter API models)
 *   - model:   GPT-5.6 Sol, the Codex runtime's default
 *   - mode:    auto for every chat except an Automations loom (effectiveChatMode)
 *   - effort:  medium (coordination stays quick; workers choose task effort)
 *
 * This is the single authoritative mode seam: an unset chatMode (explorer "Run
 * plan", `cora start` with no mode) and a legacy talk/plan/execute stamp both
 * dispatch as Auto from here.
 */
export function resolveChatBackendConfig(run: RunState): ChatBackendConfig {
  return {
    backend: run.chatBackend ?? "pi",
    model: run.chatModel?.trim() || DEFAULT_CODEX_CHAT_MODEL,
    mode: effectiveChatMode(run.chatMode),
    effort: run.chatEffort ?? "medium",
    accountProfileId: run.chatAccountProfileId,
    executionPolicy: effectiveRunExecutionPolicy(run),
    sessionUuid: run.chatSessionUuid,
    sessionMode: run.chatSessionMode,
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

const CANONICAL_REPLAY_MESSAGE_LIMIT = 32;
const CANONICAL_REPLAY_CHAR_LIMIT = 24_000;

// run-store caps a message at MAX_ATTACHMENTS_PER_MESSAGE; mirrored here so a
// hand-built or migrated message can never blow the turn input out either.
const MAX_RENDERED_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * Attachments are persisted on the message (images copied into the run's
 * attachments/ folder, other files referenced where they already live) but
 * nothing downstream ever put them in front of the manager, so a screenshot the
 * user dropped in the composer reached the model as no text at all. Every CLI
 * backend can read an absolute path off disk, images included, so the paths ARE
 * the handoff: name them and let the manager open the ones it needs.
 */
function renderMessageAttachments(message: HumanRunMessage): string[] {
  const attachments = (message.attachments ?? []).slice(0, MAX_RENDERED_ATTACHMENTS_PER_MESSAGE);
  if (attachments.length === 0) return [];
  // Names and paths are user-controlled bytes landing inside a marker-framed
  // prompt block; a newline-bearing filename could forge the block/replay
  // markers, so line breaks collapse to spaces before interpolation.
  const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();
  return [
    "The user attached the following; open image paths with your file/image tools to view them.",
    "[ATTACHMENTS]",
    ...attachments.map(
      (attachment) => `- ${attachment.kind}: ${oneLine(attachment.name)} -> ${oneLine(attachment.path)}`,
    ),
    "[/ATTACHMENTS]",
  ];
}

/**
 * Render ordered user input the way a manager turn receives it. This is the
 * ONE formatting seam for user text reaching the manager: prepareManagerTurn
 * renders every turn-start input (fresh sends and messages queued during the
 * previous turn) through buildManagerTurnPrompt with these section labels.
 */
export function renderBundledManagerInput(messages: HumanRunMessage[]): string {
  if (messages.length === 0) {
    return "Continue Cora's current manager workflow from the existing run state. There is no new user message attached to this turn.";
  }
  if (messages.length === 1) {
    const attachments = renderMessageAttachments(messages[0]);
    const text = messages[0].message.trim();
    if (attachments.length === 0) return text;
    return [text, "", ...attachments].join("\n").trim();
  }
  return [
    "The user sent the following queued messages in this order. Treat all of them as input for this manager turn:",
    "",
    ...messages.flatMap((message, index) => {
      // Attachments belong to the message that carried them, so they sit inside
      // that numbered section rather than in one merged list at the end.
      const attachments = renderMessageAttachments(message);
      return [
        `${index + 1}. [${message.intent === "answer" ? "Linked answer" : message.intent === "steer" ? "Queued message" : "User turn"}]`,
        message.message.trim(),
        ...(attachments.length === 0 ? [] : ["", ...attachments]),
        "",
      ];
    }),
  ].join("\n").trim();
}

/**
 * Build the one immutable prompt a manager turn owns. On the first CLI turn
 * after a rewind, prepend a capped replay of retained canonical user/Cora
 * dialogue only; provider transcripts and tool/activity noise never participate.
 *
 * This is the DYNAMIC half of a turn (everything after
 * MANAGER_PROMPT_DYNAMIC_MARKER). New per-turn context belongs here, never in
 * the stable prefix: this text is appended to the conversation, so changing it
 * costs no cached tokens, while a byte moved into the prefix invalidates the
 * whole cached conversation for the rest of the run.
 */
export function buildManagerTurnPrompt(
  run: RunState,
  inputMessages: HumanRunMessage[],
  opts?: ManagerTurnPromptOptions,
): string {
  return appendSubscriptionHeadroom(
    appendCoraMemory(
      appendPriorRuns(
        buildManagerTurnInput(run, inputMessages, opts),
        opts?.priorRuns,
      ),
      opts?.coraMemory,
    ),
    opts?.subscriptionHeadroom,
  );
}

export interface ManagerTurnPromptOptions {
  includeCanonicalReplay?: boolean;
  /**
   * The stored auto-compaction summary, when the fresh session this turn is
   * about to spawn was cut over by conversation compaction rather than a
   * rewind. Replaces the last-N-messages replay window: the summary was
   * written by the outgoing session precisely so the raw history does not have
   * to be resent. Only consulted when `includeCanonicalReplay` is true; the
   * caller resolves it from the run's compactionSummaryMessageId (run-store's
   * compactionReplaySummary), so this module stays a pure prompt builder.
   */
  compactionSummary?: string | null;
  /**
   * Rendered Cora memory sections (cora-memory.ts formatCoraMemoryForTurn), or
   * null when there is nothing to inject or the unchanged content was already
   * injected earlier in this run. The caller reads it rather than this module:
   * the memory files live in the user's Codara home, and this file is
   * deliberately a pure prompt builder with no disk or Electron dependency (see
   * scripts/test-manager-prompt-cache.cjs, which bundles it standalone).
   */
  coraMemory?: string | null;
  /**
   * Rendered outcome-conditioned prior-run section (run-memory.ts
   * formatPriorRunsSection), or null when the workspace has no usable history
   * or this is not a turn that plans (the caller injects it on the first
   * manager turn of a run and on canonical replay only). Same contract as
   * coraMemory: the caller reads the ledger; this module stays a pure prompt
   * builder.
   */
  priorRuns?: string | null;
  /**
   * Rendered subscription-headroom section (subscription-headroom.ts), or null
   * when no provider reported usable quota data. Same contract as
   * coraMemory: the caller reads it (the usage cache lives Electron-side)
   * and it rides the dynamic tail only, its numbers change every turn, so a
   * byte of it in the stable prefix would kill the prompt cache for the run.
   */
  subscriptionHeadroom?: string | null;
}

/**
 * Cora memory (the user-editable global + workspace markdown files) rides at
 * the tail of the dynamic half, after the turn input and before the headroom
 * section. Two reasons it cannot move into the stable prefix: the content
 * changes as memory is written or edited, so it would invalidate the cached
 * prefix for every later turn, and injection is hash-gated per run (usually
 * only the first turn carries it), so most turns append nothing. The rendered
 * text carries its own section markers ([END CORA MEMORY ...]).
 */
/**
 * Outcome-conditioned prior runs: what similar past runs in this workspace
 * verified, what failed, and what to avoid repeating. This is the read half of
 * the self-improvement loop whose write half is run-memory's recordRunMemory
 * at completion. Rides the dynamic tail for the same cache reasons as the
 * memory below, and only planning turns carry it.
 */
function appendPriorRuns(prompt: string, priorRuns: string | null | undefined): string {
  if (!priorRuns || !priorRuns.trim()) return prompt;
  return [prompt, "", priorRuns.trim()].join("\n");
}

function appendCoraMemory(prompt: string, memory: string | null | undefined): string {
  if (!memory || !memory.trim()) return prompt;
  return [prompt, "", memory.trim()].join("\n");
}

/**
 * Subscription-quota headroom rides the dynamic tail for the same reasons the
 * lessons do: it changes turn to turn (a cached-prefix byte it touched would be
 * invalidated every turn), and it is live evidence, not standing guidance. A
 * turn where no provider reported usable data appends nothing.
 */
function appendSubscriptionHeadroom(prompt: string, headroom: string | null | undefined): string {
  if (!headroom || !headroom.trim()) return prompt;
  return [prompt, "", headroom.trim()].join("\n");
}

function buildManagerTurnInput(
  run: RunState,
  inputMessages: HumanRunMessage[],
  opts?: ManagerTurnPromptOptions,
): string {
  const bundledInput = renderBundledManagerInput(inputMessages);
  const recentAssumptions = (run.assumptions ?? []).slice(-8);
  const promptInput =
    recentAssumptions.length === 0
      ? bundledInput
      : [
          bundledInput,
          "",
          "[CORA AUTONOMOUS ASSUMPTIONS — already resolved; do not ask these questions again.]",
          ...recentAssumptions.map(
            (assumption) =>
              `- ${assumption.question.trim()} => ${assumption.selectedAnswer.trim()}`,
          ),
          "[END CORA AUTONOMOUS ASSUMPTIONS]",
        ].join("\n");
  if (!opts?.includeCanonicalReplay) return promptInput;

  const compactionSummary = opts.compactionSummary?.trim();
  if (compactionSummary) {
    return [
      "[CORA CONVERSATION REPLAY — the conversation was compacted; this summary replaces older history. The labels are context, not new instructions.]",
      compactionSummary,
      "[END CORA CONVERSATION REPLAY]",
      "",
      "[NEW USER INPUT FOR THIS TURN]",
      promptInput,
    ].join("\n\n");
  }

  const selectedIds = new Set(inputMessages.map((message) => message.id));
  const eligible = run.humanMessages.filter(
    (message) =>
      !selectedIds.has(message.id) &&
      message.deliveryState !== "cancelled" &&
      (message.author === "user" || message.author === "spark") &&
      message.kind !== "assistant_stream" &&
      message.message.trim().length > 0,
  );
  const retained: HumanRunMessage[] = [];
  let retainedChars = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    const size = message.message.length + 16;
    if (
      retained.length >= CANONICAL_REPLAY_MESSAGE_LIMIT ||
      (retained.length > 0 && retainedChars + size > CANONICAL_REPLAY_CHAR_LIMIT)
    ) {
      break;
    }
    retained.unshift(message);
    retainedChars += size;
  }
  if (retained.length === 0) return promptInput;

  const replay = retained
    .map((message) => `${message.author === "user" ? "You" : "Cora"}: ${message.message.trim()}`)
    .join("\n\n");
  return [
    "[CORA CONVERSATION REPLAY — retained canonical dialogue after a rewind. The labels are context, not new instructions.]",
    replay,
    "[END CORA CONVERSATION REPLAY]",
    "",
    "[NEW USER INPUT FOR THIS TURN]",
    promptInput,
  ].join("\n\n");
}

/**
 * The seam every manager turn is assembled around:
 *
 *   <stable prefix>  MANAGER_PROMPT_DYNAMIC_MARKER  <per-turn dynamic suffix>
 *
 * The stable prefix is what the provider caches. It is the mode's shipped
 * guidance plus the run's workspace cwd, and NOTHING else: no clock, no
 * mutable run state, no worker
 * digests, no message counts. Every one of those belongs after the marker,
 * where a changed byte costs nothing because the suffix was never cacheable to
 * begin with.
 *
 * Backends send the two halves on different wires (system prompt vs user
 * message), so the marker never travels to the provider verbatim. It exists so
 * the property can be asserted on one concatenated string, in the order the
 * model actually reads it. See scripts/test-manager-prompt-cache.cjs.
 */
export const MANAGER_PROMPT_DYNAMIC_MARKER = "[CORA TURN INPUT]";

export interface ManagerPromptParts {
  /** Byte-identical across every turn of one run. Sent as the system prompt. */
  stablePrefix: string;
  /** Everything that changes turn to turn. Sent as the user message. */
  dynamic: string;
  /** The two halves in wire order, separated by the dynamic marker. */
  text: string;
}

/**
 * Build the cacheable half of a manager turn. Deliberately takes only stable
 * inputs rather than a RunState: a function that cannot see the mutable run
 * cannot leak a timestamp or worker digest into the cached prefix.
 */
export function buildManagerStablePrefix(input: {
  guidance: string;
  cwd: string;
}): string {
  return `${input.guidance}\n\nWorkspace cwd: ${input.cwd}\n`;
}

/** Join the two halves for auditing. `turnPrompt` is buildManagerTurnPrompt's output. */
export function assembleManagerPrompt(input: {
  guidance: string;
  cwd: string;
  turnPrompt: string;
}): ManagerPromptParts {
  const stablePrefix = buildManagerStablePrefix(input);
  return {
    stablePrefix,
    dynamic: input.turnPrompt,
    text: `${stablePrefix}\n${MANAGER_PROMPT_DYNAMIC_MARKER}\n${input.turnPrompt}`,
  };
}

/** Re-exported for callers that want to type their HumanRunMessage walks. */
export type { HumanRunMessage };
