// Cora manager backend abstraction.
//
// One TypeScript interface per "manager" the chat composer can target. Every
// implementation drives an agent CLI, Cora has no hosted-API manager, so a
// backend is always a local process the user is already licensed for:
//
//   - Pi           (src/main/orchestration/pi-backend.ts)
//       The bundled, subscription-only Cora harness and the default backend
//       for a new chat.
//
//   - Claude Code  (src/main/orchestration/claude-backend.ts)
//       Runs Anthropic's Claude Agent SDK and turns its partial-message deltas,
//       tool boundaries, and final result into ChatStreamEvents. Provider
//       sessions persist and resume by UUID without opening or driving an
//       interactive TUI.
//
//   - Codex        (src/main/orchestration/codex-backend.ts)
//       Runs `codex app-server` over JSON-RPC stdio. The supported rich-client
//       protocol supplies token deltas, ordered item/tool lifecycle events,
//       thread resume, usage, interruption, and turn completion directly.
//
// The dispatch lives in run-store.ts: when the manager pipeline is about to
// fire, it picks the backend from `run.chatBackend` (defaulting to Pi
// for legacy / unset chats) and calls one of the methods below.

import { dirname, isAbsolute, join, relative } from "node:path";
import type {
  AgentEffortLevel,
  AppSettings,
  AgentRuntimeDiagnostic,
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
import {
  effectiveChatFastMode,
  effectiveChatMode,
  effectiveChatOneMillionContext,
} from "@shared/chat-policy";
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
  /** Per-chat Pi execution depth. Non-Pi backends always resolve to Fast. */
  executionPolicy: CoraExecutionPolicy;
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
  /** Fast-mode toggle. Codex-only; Claude Code ignores it. */
  fastMode: boolean;
  /** 1M-context toggle. Claude Code is normalized to true. */
  oneMillionContext: boolean;
}

/**
 * Inputs the manager pipeline hands to a backend's `requestManagerDecision`.
 * Mirrors manager-protocol's `buildManagerRequest` inputs so the dispatch is a
 * 1:1 structural translation, not a redesign.
 */
export interface ManagerRequestInput {
  run: RunState;
  cwd: string;
  mode: ManagerMode;
  workerReports?: SparkManagerWorkerReportContext[];
  availableRuntimes?: AgentRuntimeDiagnostic[];
  agentSyncContext?: string;
  settings: AppSettings;
  /** Ordered immutable user input bundled by run-store before backend startup. */
  prompt: string;
  /** Durable message ownership mirrored onto the SparkCall. */
  inputMessageIds: string[];
  /** Conversation generation captured with the frozen input. */
  conversationEpoch: number;
  /** Called only after the provider/PTY has accepted this exact prompt. */
  onPromptAccepted?: () => void | Promise<void>;
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
  /** Optional usage metadata. Populated when the backend's JSONL transcript
   *  carries token counts; left undefined otherwise so the costs UI shows
   *  ", " instead of $0.00. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
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
   * dispatcher surfaces the reply, fails the SparkCall, and moves the run
   * to status "failed" (which the user can re-prompt out of) instead.
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
 *   - backend: Pi (the bundled, subscription-only Cora harness)
 *   - model:   backend-specific default (Pi/Codex=GPT-5.6 Sol,
 *              Claude=opus-4-8)
 *   - mode:    auto for every chat except an Automations loom (effectiveChatMode)
 *   - effort:  high for Pi, medium for explicitly selected legacy backends
 *
 * This is the single authoritative mode seam: an unset chatMode (explorer "Run
 * plan", `cora start` with no mode) and a legacy talk/plan/execute stamp both
 * dispatch as Auto from here.
 */
export function resolveChatBackendConfig(run: RunState): ChatBackendConfig {
  const backend: ChatBackendKind = run.chatBackend ?? "pi";
  const mode: ChatMode = effectiveChatMode(run.chatMode);
  const effort: AgentEffortLevel = run.chatEffort ?? (backend === "pi" ? "high" : "medium");
  // Pi and Codex both drive the Codex runtime, so they share its default model.
  const model =
    run.chatModel?.trim() ||
    (backend === "claude" ? "claude-opus-5" : DEFAULT_CODEX_CHAT_MODEL);
  return {
    backend,
    model,
    mode,
    effort,
    executionPolicy: effectiveRunExecutionPolicy(run),
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

const CANONICAL_REPLAY_MESSAGE_LIMIT = 32;
const CANONICAL_REPLAY_CHAR_LIMIT = 24_000;

function renderBundledManagerInput(messages: HumanRunMessage[]): string {
  if (messages.length === 0) {
    return "Continue Cora's current manager workflow from the existing run state. There is no new user message attached to this turn.";
  }
  if (messages.length === 1) return messages[0].message.trim();
  return [
    "The user sent the following queued messages in this order. Treat all of them as input for this manager turn:",
    "",
    ...messages.flatMap((message, index) => [
      `${index + 1}. [${message.intent === "answer" ? "Linked answer" : message.intent === "steer" ? "Queued steering" : "User turn"}]`,
      message.message.trim(),
      "",
    ]),
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
  return appendWorkspaceLessons(
    buildManagerTurnInput(run, inputMessages, opts),
    opts?.workspaceLessons,
  );
}

export interface ManagerTurnPromptOptions {
  includeCanonicalReplay?: boolean;
  /**
   * Rendered per-workspace lessons section (workspace-lessons.ts), or null when
   * the workspace has no lessons yet. The caller reads it rather than this
   * module: the lessons store reaches the user's Codara home, and this file is
   * deliberately a pure prompt builder with no disk or Electron dependency (see
   * scripts/test-manager-prompt-cache.cjs, which bundles it standalone).
   */
  workspaceLessons?: string | null;
}

/**
 * Lessons distilled from earlier completed runs of this workspace (search
 * throttling, runtime fallbacks) ride at the tail of the dynamic half. Two
 * reasons they cannot move into the stable prefix: the section changes as the
 * ledger grows, so it would invalidate the cached prefix for every later turn,
 * and it is evidence about this workspace rather than standing guidance. An
 * empty ledger appends nothing, so it costs zero tokens.
 */
function appendWorkspaceLessons(prompt: string, lessons: string | null | undefined): string {
  if (!lessons || !lessons.trim()) return prompt;
  return [prompt, "", lessons.trim(), "[END WORKSPACE LESSONS]"].join("\n");
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
 * guidance plus the run's workspace cwd, and NOTHING else: no clock, no run
 * state, no worker digests, no message counts. Every one of those belongs after
 * the marker, where a changed byte costs nothing because the suffix was never
 * cacheable to begin with.
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
 * Build the cacheable half of a manager turn. Deliberately takes primitives
 * rather than a RunState: a function that cannot see the run cannot leak a
 * timestamp or a worker digest into the cached prefix.
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

const runManagerGuidance = new Map<string, { key: string; guidance: string }>();
// Bounded so a long-lived app with many chats cannot hold every prompt file it
// ever pinned. Eviction is least-recently-USED (each hit reinserts), so the
// entry that gets dropped belongs to a run that is not taking turns; an evicted
// run simply re-reads on its next turn, which is the pre-pin behavior.
const RUN_MANAGER_GUIDANCE_LIMIT = 64;

/**
 * Read a run's manager guidance ONCE per run instead of once per turn.
 *
 * Those bytes are the cacheable prefix of every turn in the run, so re-reading
 * them mid-conversation is the one way this file could split a live prompt
 * cache: a dev editing resources/orchestration/*.md, or an installer swapping
 * the bundle under a running app, would change the prefix between turn N and
 * turn N+1 and throw away every cached token. Pinning per run also drops one
 * disk read per manager turn. A new run reads the file again, so an edit still
 * takes effect without restarting the app.
 *
 * `cacheKey` identifies which guidance was pinned (mode + resolved path), so a
 * mode flip, which already forces a fresh provider session, re-reads.
 */
export async function loadRunManagerGuidance(
  runId: string,
  cacheKey: string,
  read: () => Promise<string>,
): Promise<string> {
  const cached = runManagerGuidance.get(runId);
  if (cached && cached.key === cacheKey) {
    runManagerGuidance.delete(runId);
    runManagerGuidance.set(runId, cached);
    return cached.guidance;
  }
  const guidance = await read();
  runManagerGuidance.set(runId, { key: cacheKey, guidance });
  while (runManagerGuidance.size > RUN_MANAGER_GUIDANCE_LIMIT) {
    const oldest = runManagerGuidance.keys().next();
    if (oldest.done) break;
    runManagerGuidance.delete(oldest.value);
  }
  return guidance;
}

/** Drop a run's pinned guidance when its chat session is torn down. */
export function forgetRunManagerGuidance(runId: string): void {
  runManagerGuidance.delete(runId);
}

/** @deprecated Manager turns must use the frozen `ManagerRequestInput.prompt`. */
export function latestUserPromptFromRun(run: RunState): string {
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const message = run.humanMessages[i];
    if (message.author !== "user") continue;
    if (message.kind !== "note" && message.kind !== "answer") continue;
    if (message.message?.trim()) return message.message;
  }
  return "";
}

// The active plan for a run: the one referenced by planId, else the most recent
// plan still marked active.
function activePlanForRun(run: RunState) {
  const byId = run.planId ? run.plans.find((plan) => plan.id === run.planId) : undefined;
  if (byId) return byId;
  for (let i = run.plans.length - 1; i >= 0; i -= 1) {
    if (run.plans[i].status === "active") return run.plans[i];
  }
  return undefined;
}

// The latest Codara-authored "Run complete." completion summary (the worker-
// authored DONE card), which already lives on the run as a spark/decision.
function latestCompletionSummary(run: RunState): HumanRunMessage | undefined {
  for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
    const message = run.humanMessages[i];
    if (
      message.author === "spark" &&
      message.kind === "decision" &&
      message.message.trim().startsWith("Run complete.")
    ) {
      return message;
    }
  }
  return undefined;
}

/**
 * True when this run ran a Plan-mode Best-of-N council. That work (the candidate
 * planners + the synthesis judge) happens in their own worker terminals, OUTSIDE
 * the chat CLI session — so when the user later flips the SAME chat to Talk or
 * Execute, that session never "saw" it and can't remember what was planned. This
 * is the one case that warrants injecting run context; a normal Execute chat
 * spawned its own workers and already has them in its transcript.
 */
export function runDidPlanCouncil(run: RunState): boolean {
  return run.workerTasks.some((task) => task.councilRole !== undefined);
}

// Turn an absolute file path into a CLI `@`-mention relative to cwd when the
// file lives under cwd (forward slashes for the agent's path parser); otherwise
// fall back to an `@`-mention of the absolute path. Lets the agent pull the file
// in on demand instead of us pasting its whole contents.
function fileMention(cwd: string | undefined, absPath: string): string {
  if (cwd) {
    const rel = relative(cwd, absPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return `@${rel.replace(/\\/g, "/")}`;
    }
  }
  return `@${absPath.replace(/\\/g, "/")}`;
}

/**
 * A compact, read-only snapshot of what a Plan-council run produced, for
 * injection ahead of the user's prompt into a CLI chat session — ONCE, the first
 * time the chat leaves Plan mode (see the backends' contextInjectedRuns guard).
 *
 * The chat session only ever sees its own transcript; the council's workers and
 * the synthesized plan live outside it. Without this, Talk "what did we just
 * do?" guesses and Execute "run the plan" doesn't know the plan exists. We
 * surface: completed steps, the latest Codara completion summary (the worker-
 * authored DONE card), and the plan/PRD as `@`-mentions — NOT their full text,
 * so the paste stays small and the agent reads the files on demand.
 *
 * Returns "" when there's nothing useful to add.
 */
export function buildSparkRunContextBlock(run: RunState, cwd?: string): string {
  const sections: string[] = [];

  const doneSteps = run.steps.filter(
    (step) => step.status === "complete" || step.status === "completed_unverified",
  );
  if (doneSteps.length > 0) {
    const titles = doneSteps.slice(-6).map((step) => `- ${step.title}`);
    sections.push(`Completed steps:\n${titles.join("\n")}`);
  }

  const summary = latestCompletionSummary(run);
  if (summary) {
    sections.push(`Latest run summary (Codara's record of what the workers did):\n${summary.message.trim()}`);
  }

  const plan = activePlanForRun(run);
  if (plan?.sourceFile) {
    const planMention = fileMention(cwd, plan.sourceFile);
    const prdMention = fileMention(cwd, join(dirname(plan.sourceFile), "PRD.md"));
    sections.push(
      `Active plan${plan.title ? ` — ${plan.title}` : ""}: ${planMention}\n` +
        `Product requirements: ${prdMention}\n` +
        `(These files hold the full plan — read them rather than asking me to repeat their contents. ` +
        `When the user says "run the plan", this is the plan to execute.)`,
    );
  }

  if (sections.length === 0) return "";

  return [
    "[SPARK CONTEXT — Codara's record of this run's worker activity and plan, for your awareness. This is NOT a new instruction from the user; use it to answer accurately and to know what has already been done.]",
    "",
    sections.join("\n\n"),
    "",
    "[END SPARK CONTEXT]",
  ].join("\n");
}

/** Re-exported for callers that want to type their HumanRunMessage walks. */
export type { HumanRunMessage };
