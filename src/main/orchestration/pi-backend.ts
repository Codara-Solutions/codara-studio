import { subscriptionForModelId } from "../../shared/agent-families";
import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";

import {
  buildExecuteDecisionFromToolCalls,
  executeDecisionWasAppliedDuringTurn,
} from "./execute-decision";
import {
  cleanupPiMcpBridgeConfig,
  createCodaraPiLaunchPlan,
  resolveCodaraOpenRouterApiKey,
  resolveCodaraPiExecutionAccount,
  resolveCodaraPiFastMode,
} from "./pi-runtime-electron";
import {
  type PiManagerLaunchPlan,
  type PiProvider,
  type PiThinkingLevel,
} from "./pi-runtime";
import { PiRpcClient } from "./pi-rpc-client";
import { classifyTurnLiveness, isLongPollToolName } from "./agent-liveness";
import { piBackendSessionIdentityMatches } from "./pi-session-identity";
import { PiTurnAccumulator } from "./pi-turn";
import { PiManagerCompaction } from "./pi-manager-compaction";
import {
  buildTalkReplyDecision,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
  type ManagerSteerInput,
  type AgentBackend,
} from "./agent-backend";
import { runProjectPolicyMode } from "./project-policy";
import {
  isAgentSocketCapabilityActive,
  revokeAgentSocketCapability,
} from "../agent-socket-capabilities";

interface PiProcessOwner {
  client: PiRpcClient;
  plan: PiManagerLaunchPlan;
  generation: number;
  cleanupPromise: Promise<void> | null;
}

interface PiBackendSession extends PiProcessOwner {
  provider: PiProvider;
  accountProfileId?: string;
  model: string;
  thinking: PiThinkingLevel;
  mode: "talk" | "execute" | "automation";
  chatMode: ChatMode;
  executionPolicy: CoraExecutionPolicy;
  projectPolicyMode: ProjectPolicyMode;
  sessionId: string;
  fastMode: boolean;
  interrupted: boolean;
  activeTurn: ActivePiTurn | null;
}

/**
 * The one turn a session is running. A session serves one turn at a time:
 * prompting it while another turn streams is rejected by Pi, and the old
 * failure handling then stopped the process the live turn was using.
 */
interface ActivePiTurn {
  settle: () => void;
  /** True between the accepted prompt and the end of the turn. */
  acceptingSteers: boolean;
  /** Steered messages Pi has queued but not yet injected, by message id. */
  pendingSteers: Map<string, { text: string; onDelivered?: () => void }>;
}

interface PendingPiBackendSession extends PiProcessOwner {}

const SESSIONS = new Map<string, PiBackendSession>();
const PENDING_SESSIONS = new Map<string, PendingPiBackendSession>();
const GENERATIONS = new Map<string, number>();
/**
 * A manager turn is bounded by INACTIVITY, not by total wall clock — see
 * agent-liveness.ts for the policy and why the old flat cap was the wrong
 * shape for an orchestrator.
 */
const PI_TURN_IDLE_CHECK_MS = 15 * 1000;
const PI_PROCESS_CHECK_MS = 1000;
const STARTUP_STDERR_TAIL_CHARS = 2048;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function piProviderForModel(model: string): PiProvider {
  const provider = subscriptionForModelId(model);
  if (provider) return provider;
  if (model.includes("/")) return "openrouter";
  throw new Error(`Cora's Pi backend does not support model ${model}`);
}

// resolveChatBackendConfig already collapses every chat to auto or automation,
// so the retired talk/plan personas can no longer reach the Pi runtime.
function piModeForChat(mode: ChatMode): "talk" | "execute" | "automation" {
  if (mode === "automation") return "automation";
  return "execute";
}

function piThinkingForEffort(effort: ManagerRequestInput["chat"]["effort"]): PiThinkingLevel {
  return effort;
}

function safeSessionId(input: ManagerRequestInput): string {
  const requested = input.chat.sessionUuid?.trim();
  if (requested) return requested;
  const raw = `${input.run.id}-${input.chat.mode}-${input.chat.executionPolicy}-${input.conversationEpoch}-${input.run.sparkCalls.length}`;
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!safe) throw new Error("Could not derive a safe Pi session id for this Cora chat");
  return safe.slice(0, 200).replace(/[^A-Za-z0-9]+$/g, "");
}

function sessionMatches(
  session: PiBackendSession,
  provider: PiProvider,
  accountProfileId: string | undefined,
  model: string,
  thinking: PiThinkingLevel,
  mode: PiBackendSession["mode"],
  chatMode: ChatMode,
  executionPolicy: CoraExecutionPolicy,
  projectPolicyMode: ProjectPolicyMode,
  sessionId: string,
  fastMode: boolean,
): boolean {
  return piBackendSessionIdentityMatches(session, {
    provider,
    ...(accountProfileId ? { accountProfileId } : {}),
    model,
    thinking,
    mode,
    chatMode,
    executionPolicy,
    projectPolicyMode,
    sessionId,
    fastMode,
  }) &&
    session.client.state().phase === "running" &&
    launchPlanCapabilityIsReusable(session.plan);
}

function launchPlanCapabilityIsReusable(
  plan: PiManagerLaunchPlan,
  now = Date.now(),
): boolean {
  const capabilityId = plan.agentSocketCapabilityId;
  if (!capabilityId) return true;
  if (
    typeof plan.agentSocketCapabilityExpiresAt === "number" &&
    plan.agentSocketCapabilityExpiresAt <= now
  ) {
    return false;
  }
  return isAgentSocketCapabilityActive(capabilityId, now);
}

function cleanupPiProcess(owner: PiProcessOwner): Promise<void> {
  if (owner.cleanupPromise) return owner.cleanupPromise;
  // Revoke synchronously before waiting for process shutdown. A stuck child
  // must not retain run authority throughout its shutdown grace period.
  revokeAgentSocketCapability(owner.plan.agentSocketCapabilityId);
  owner.cleanupPromise = (async () => {
    await owner.client.stop().catch(() => undefined);
    await cleanupPiMcpBridgeConfig(owner.plan).catch(() => undefined);
  })();
  return owner.cleanupPromise;
}

async function cleanupUnstartedPlan(plan: PiManagerLaunchPlan): Promise<void> {
  revokeAgentSocketCapability(plan.agentSocketCapabilityId);
  await cleanupPiMcpBridgeConfig(plan).catch(() => undefined);
}

async function stopSession(
  runId: string,
  expected?: PiProcessOwner,
): Promise<void> {
  const cleanup: Promise<void>[] = [];
  const session = SESSIONS.get(runId);
  if (session && (!expected || session === expected)) {
    SESSIONS.delete(runId);
    session.interrupted = true;
    session.activeTurn?.settle();
    cleanup.push(cleanupPiProcess(session));
  }
  const pending = PENDING_SESSIONS.get(runId);
  if (pending && (!expected || pending === expected)) {
    PENDING_SESSIONS.delete(runId);
    cleanup.push(cleanupPiProcess(pending));
  }
  await Promise.all(cleanup);
}

function supersededStartupError(): Error {
  return new Error("Cora's Pi session startup was superseded by disposal or a newer launch");
}

async function ensureSession(
  input: ManagerRequestInput,
  onStream?: ChatStreamHandler,
): Promise<PiBackendSession> {
  const runId = input.run.id;
  const observedGeneration = GENERATIONS.get(runId) ?? 0;
  const provider = piProviderForModel(input.chat.model);
  const model = input.chat.model;
  const thinking = piThinkingForEffort(input.chat.effort);
  const mode = piModeForChat(input.chat.mode);
  const executionPolicy = input.chat.executionPolicy;
  const projectPolicyMode = runProjectPolicyMode(input.run);
  const openRouterApiKey = provider === "openrouter"
    ? await resolveCodaraOpenRouterApiKey(model)
    : undefined;
  const [account, fastMode] = provider === "openrouter"
    ? [{ accountProfileId: undefined, configDir: "" }, false] as const
    : await Promise.all([
        resolveCodaraPiExecutionAccount({
          provider,
          preferredAccountProfileId: input.chat.accountProfileId,
        }),
        // Fast mode reaches the runtime only as launch-time env, so a session
        // launched under the other value cannot be reused: resolve it here,
        // match on it below, and hand the SAME value to the launch plan.
        resolveCodaraPiFastMode(provider),
      ]);
  if ((GENERATIONS.get(runId) ?? 0) !== observedGeneration) {
    throw supersededStartupError();
  }
  const sessionId = safeSessionId(input);
  const current = SESSIONS.get(runId);
  const pendingCurrent = PENDING_SESSIONS.get(runId);
  if (
    current &&
    current.generation === observedGeneration &&
    sessionMatches(current, provider, account.accountProfileId, model, thinking, mode, input.chat.mode, executionPolicy, projectPolicyMode, sessionId, fastMode)
  ) {
    return current;
  }
  const generation = observedGeneration + 1;
  GENERATIONS.set(runId, generation);
  if (current) {
    onStream?.({ kind: "system_note", message: "Restarting Cora's Pi runtime with the selected model, mode, execution policy, or fast mode." });
    await stopSession(runId, current);
  }
  if (pendingCurrent) {
    await stopSession(runId, pendingCurrent);
  }
  if (GENERATIONS.get(runId) !== generation) {
    throw supersededStartupError();
  }
  const plan = await createCodaraPiLaunchPlan({
    provider,
    ...(openRouterApiKey ? { apiKey: openRouterApiKey } : {}),
    accountProfileId: account.accountProfileId,
    resolvedAccount: account,
    openAiFastMode: fastMode,
    runId,
    sessionId,
    cwd: input.cwd,
    mode,
    chatMode: input.chat.mode,
    executionPolicy,
    model,
    thinking,
    sessionName: input.run.title,
    projectPolicyMode,
  });
  if (GENERATIONS.get(runId) !== generation) {
    await cleanupUnstartedPlan(plan);
    throw supersededStartupError();
  }
  let client: PiRpcClient;
  try {
    client = new PiRpcClient(plan, {
      requestTimeoutMs: 120_000,
      shutdownGraceMs: 2_000,
    });
  } catch (error) {
    await cleanupUnstartedPlan(plan);
    throw error;
  }
  const pending: PendingPiBackendSession = {
    client,
    plan,
    generation,
    cleanupPromise: null,
  };
  PENDING_SESSIONS.set(runId, pending);
  let state;
  try {
    state = await client.start();
  } catch (error) {
    // The handshake error alone ("timed out", "process exited (1)") hides the
    // cause; Pi's own stderr names it (a stack trace, a broken extension).
    const stderr = client.diagnostics().stderr.trim();
    if (PENDING_SESSIONS.get(runId) === pending) {
      PENDING_SESSIONS.delete(runId);
    }
    await cleanupPiProcess(pending);
    if (!stderr) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const tail = stderr.length > STARTUP_STDERR_TAIL_CHARS
      ? stderr.slice(-STARTUP_STDERR_TAIL_CHARS)
      : stderr;
    throw new Error(`${message}\n${tail}`);
  }
  if (
    PENDING_SESSIONS.get(runId) !== pending ||
    GENERATIONS.get(runId) !== generation ||
    !launchPlanCapabilityIsReusable(plan)
  ) {
    if (PENDING_SESSIONS.get(runId) === pending) {
      PENDING_SESSIONS.delete(runId);
    }
    await cleanupPiProcess(pending);
    throw supersededStartupError();
  }
  const reportedSessionId = typeof state.sessionId === "string" && state.sessionId
    ? state.sessionId
    : sessionId;
  const session: PiBackendSession = {
    client,
    plan,
    provider,
    accountProfileId: plan.accountProfileId,
    model,
    thinking,
    mode,
    chatMode: input.chat.mode,
    executionPolicy,
    projectPolicyMode,
    sessionId: reportedSessionId,
    fastMode,
    generation,
    interrupted: false,
    activeTurn: null,
    cleanupPromise: pending.cleanupPromise,
  };
  PENDING_SESSIONS.delete(runId);
  SESSIONS.set(runId, session);
  onStream?.({
    kind: "system_note",
    message: `Cora Pi session ready · ${provider}/${model} · ${thinking} thinking · ${executionPolicy} chat mode`,
  });
  return session;
}

/** Liveness the turn's event listener keeps up to date for waitForSettled. */
interface PiTurnLiveness {
  /** Epoch ms of the last stream event. */
  lastEventAt: number;
  /** Tool starts awaiting their matching tool_execution_end event. */
  inFlightTools: Map<string, { name: string; startedAt: number; longPoll: boolean }>;
}

function runtimeDiedMidTurnError(phase: "failed" | "stopped"): Error {
  return new Error(
    `Cora's Pi runtime ${phase === "failed" ? "failed" : "exited"} in the middle of the turn (transport closed).`,
  );
}

/**
 * Resolve when the turn settles; reject when it goes QUIET (see
 * PI_TURN_IDLE_TIMEOUT_MS) or blows the absolute ceiling. A turn parked inside
 * a long-poll orchestration tool is never idle, however long it waits. A Pi
 * process that died mid-turn never emits agent_settled, so a stopped or failed
 * client rejects at the next check instead of waiting out the idle timeout.
 * Its error must classify as "transport" (see runtimeDiedMidTurnError) so the
 * turn policy parks the run: a crashed manager runtime says nothing about the
 * work, and an unclassified error would fail the run and kill its workers.
 */
async function waitForSettled(
  settled: Promise<void>,
  liveness: PiTurnLiveness,
  session: PiBackendSession,
): Promise<void> {
  let poll: ReturnType<typeof setInterval> | null = null;
  let processPoll: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        processPoll = setInterval(() => {
          if (session.interrupted) return;
          const phase = session.client.state().phase;
          if (phase === "failed" || phase === "stopped") {
            reject(runtimeDiedMidTurnError(phase));
          }
        }, PI_PROCESS_CHECK_MS);
        processPoll.unref();
        poll = setInterval(() => {
          const verdict = classifyTurnLiveness({
            now: Date.now(),
            startedAt,
            lastEventAt: liveness.lastEventAt,
            inFlightTools: [...liveness.inFlightTools.values()],
          });
          if (verdict.action === "fail") reject(new Error(verdict.detail));
        }, PI_TURN_IDLE_CHECK_MS);
        poll.unref();
      }),
    ]);
  } finally {
    if (poll) clearInterval(poll);
    if (processPoll) clearInterval(processPoll);
  }
}

const EMPTY_FINAL_REPROMPT = [
  "Your tool work settled, but your final assistant message was empty.",
  "Reply now with the concise user-facing result: outcome first, what changed, verification, and any remaining issue.",
  "Do not call tools unless that is required to correct a failed check.",
].join(" ");

async function requestPiDecision(
  input: ManagerRequestInput,
  onStream?: ChatStreamHandler,
): Promise<ManagerCallResult> {
  const startedAt = Date.now();
  const runId = input.run.id;
  let session: PiBackendSession;
  // Session STARTUP is outside the turn-failure envelope on purpose. A missing
  // or expired subscription auth, an uninstalled pinned runtime, or an RPC
  // process that never came up all mean NO provider turn ever started —
  // reporting them as turnFailed made run-store brand the run failed, which
  // bypassed the degradation its callers own for a manager that yields no
  // decision (SPARK_ENABLE_MANUAL_FALLBACK's manual worker task, or parking
  // the run on an accurate question). Throw instead: askManagerBackend's catch
  // records the spark_call failure and returns null, and the caller degrades.
  try {
    session = await ensureSession(input, onStream);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onStream?.({ kind: "error", message });
    throw error instanceof Error ? error : new Error(message);
  }
  // Report the session id the moment it exists, so run-store can persist it
  // durably BEFORE the turn settles. Best-effort: a persistence hiccup must
  // not fail an otherwise healthy turn.
  try {
    await input.onSessionEstablished?.(session.sessionId);
  } catch (error) {
    console.warn(`[pi-backend] failed to persist session id for ${runId}:`, error);
  }
  // Never prompt a session that is still streaming another turn, and never
  // touch that turn's process: report this one as aborted so run-store
  // requeues its input behind the live turn.
  if (session.activeTurn) {
    return {
      decision: buildTalkReplyDecision("Cora is already working on a turn in this chat."),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      accountProfileId: session.accountProfileId,
      notice: "Cora is already working on a turn in this chat; this message waits for it.",
      turnAborted: true,
    };
  }
  const activeTurn: ActivePiTurn = {
    settle: () => undefined,
    acceptingSteers: false,
    pendingSteers: new Map(),
  };
  session.activeTurn = activeTurn;
  let result: ManagerCallResult;
  try {
    result = await runPiTurn(input, session, activeTurn, startedAt, onStream);
  } finally {
    activeTurn.acceptingSteers = false;
    if (session.activeTurn === activeTurn) session.activeTurn = null;
  }
  return withdrawUndeliveredSteers(runId, session, activeTurn, result);
}

/**
 * A steer Pi queued but never injected (it arrived after the model's last
 * step) would otherwise open the next turn on its own, on top of run-store
 * delivering it again. Withdraw it from Pi before the turn reports back;
 * run-store returns every steer whose delivery it never heard about.
 */
async function withdrawUndeliveredSteers(
  runId: string,
  session: PiBackendSession,
  turn: ActivePiTurn,
  result: ManagerCallResult,
): Promise<ManagerCallResult> {
  if (turn.pendingSteers.size === 0) return result;
  turn.pendingSteers.clear();
  if (SESSIONS.get(runId) === session && session.client.state().phase === "running") {
    await session.client.request({ type: "clear_queue" }).catch(() => undefined);
  }
  return result;
}

function piUserMessageText(message: unknown): string {
  const record = asRecord(message);
  if (record?.role !== "user") return "";
  const content = record.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const entry = asRecord(part);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("")
    .trim();
}

async function runPiTurn(
  input: ManagerRequestInput,
  session: PiBackendSession,
  activeTurn: ActivePiTurn,
  startedAt: number,
  onStream?: ChatStreamHandler,
): Promise<ManagerCallResult> {
  const runId = input.run.id;
  let unsubscribe: (() => void) | undefined;
  let compaction: PiManagerCompaction | undefined;
  let turn: PiTurnAccumulator | undefined;
  const executes = input.chat.mode === "auto" || input.chat.mode === "execute";
  // An interrupted turn may already have run live tools (spawned workers).
  // Saying so lets run-store acknowledge its input instead of handing the same
  // request to the next turn as new.
  const interruptedResult = (): ManagerCallResult => ({
    decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
    decisionAlreadyApplied:
      (turn !== undefined &&
        executes &&
        executeDecisionWasAppliedDuringTurn(turn.result().successfulToolCalls)) ||
      undefined,
    durationMs: Date.now() - startedAt,
    model: input.chat.model,
    accountProfileId: session.accountProfileId,
    turnAborted: true,
  });
  try {
    const generation = session.generation;
    // `interrupted` belongs to the preceding turn. Generation/map ownership
    // below distinguishes a newly resumed turn from the older request that an
    // interrupt invalidated.
    session.interrupted = false;
    if (
      SESSIONS.get(runId) !== session ||
      GENERATIONS.get(runId) !== generation ||
      !launchPlanCapabilityIsReusable(session.plan)
    ) {
      return interruptedResult();
    }
    const accumulator = new PiTurnAccumulator(onStream, {
      // Pi's native model catalog also reports API-equivalent prices for
      // subscription models. Those are not an OpenRouter charge and must not
      // enter the chat cost pill or run budget.
      captureCost: session.provider === "openrouter",
    });
    turn = accumulator;
    let settle: () => void = () => undefined;
    const liveness: PiTurnLiveness = {
      lastEventAt: Date.now(),
      inFlightTools: new Map(),
    };
    const armSettlement = (): Promise<void> => {
      liveness.lastEventAt = Date.now();
      liveness.inFlightTools.clear();
      const next = new Promise<void>((resolve) => { settle = resolve; });
      activeTurn.settle = settle;
      return next;
    };
    let settled = armSettlement();
    let compactionFailure: string | undefined;
    compaction = new PiManagerCompaction(session.client, {
      interrupted: () => session.interrupted || GENERATIONS.get(runId) !== generation,
      onSettled: () => settle(),
      onError: (error) => { compactionFailure = error.message; },
    });
    unsubscribe = session.client.onEvent((event) => {
      liveness.lastEventAt = Date.now();
      if (
        event.type === "tool_execution_start" &&
        typeof event.toolCallId === "string" && event.toolCallId &&
        typeof event.toolName === "string" && event.toolName
      ) {
        liveness.inFlightTools.set(event.toolCallId, {
          name: event.toolName,
          startedAt: Date.now(),
          longPoll: isLongPollToolName(event.toolName),
        });
      }
      if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        liveness.inFlightTools.delete(event.toolCallId);
      }
      if (event.type === "message_start" && activeTurn.pendingSteers.size > 0) {
        const text = piUserMessageText(event.message);
        for (const [messageId, steer] of activeTurn.pendingSteers) {
          if (steer.text.trim() !== text) continue;
          activeTurn.pendingSteers.delete(messageId);
          try {
            steer.onDelivered?.();
          } catch {
            // Delivery bookkeeping is best-effort; the turn goes on.
          }
          break;
        }
      }
      accumulator.consume(event);
      if (compaction?.consume(event)) return;
      if (event.type === "agent_settled") settle();
    });

    await session.client.prompt(input.prompt);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return interruptedResult();
    }
    activeTurn.acceptingSteers = true;
    await input.onPromptAccepted?.();
    await waitForSettled(settled, liveness, session);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return interruptedResult();
    }

    let accumulated = accumulator.result();
    // A model can finish its tool loop with an explicit empty assistant
    // message. Never promote earlier progress prose into a fake successful
    // answer. Give it one hidden, tightly-scoped chance to produce the result
    // users should have received.
    if (!compactionFailure && !accumulated.failure && accumulated.assistantMessageCount > 0 && !accumulated.finalText) {
      settled = armSettlement();
      await session.client.prompt(EMPTY_FINAL_REPROMPT);
      await waitForSettled(settled, liveness, session);
      if (session.interrupted || GENERATIONS.get(runId) !== generation) {
        return interruptedResult();
      }
      accumulated = accumulator.result();
    }

    if (compactionFailure) {
      // A timed-out summary may still be running. Stop that process before
      // returning the completed answer or allowing another turn to reuse it.
      await stopSession(runId, session);
      if (GENERATIONS.get(runId) !== generation) {
        return {
          decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          accountProfileId: session.accountProfileId,
          turnAborted: true,
        };
      }
      accumulated = accumulator.result();
      onStream?.({ kind: "system_note", message: `Context compaction failed. The conversation remains saved; Cora will restart its runtime on the next turn. ${compactionFailure}` });
    }
    // costUsd is an OpenRouter catalog-priced estimate for the whole turn.
    // Native subscription sessions never capture it, even when Pi's catalog
    // supplies an API-equivalent number.
    const cumulativeUsage = {
      inputTokens: accumulated.usage.inputTokens,
      outputTokens: accumulated.usage.outputTokens,
      cacheReadTokens: accumulated.usage.cacheReadTokens,
      cacheWriteTokens: accumulated.usage.cacheWriteTokens,
      ...(accumulated.usage.costUsd > 0 ? { costUsd: accumulated.usage.costUsd } : {}),
    };
    // Context occupancy is a gauge, so it is the newest request's prompt size
    // rather than a sum over the turn. promptTokens is the field run-store
    // persists onto the SparkCall, which is where the Runs inspector and a
    // re-opened chat read the meter from.
    const contextUsage = {
      ...(accumulated.contextTokens > 0 ? { promptTokens: accumulated.contextTokens } : {}),
      ...(accumulated.contextWindowTokens !== null
        ? { contextWindowTokens: accumulated.contextWindowTokens }
        : {}),
    };
    const providerDiagnostics = accumulated.providerResponseIds.length > 0
      ? { providerResponseIds: accumulated.providerResponseIds }
      : {};
    let finalText = accumulated.finalText;
    if (!finalText && accumulated.assistantMessageCount === 0) {
      // Compatibility fallback for an RPC stream that missed every assistant
      // event. Never use it after observing an explicit empty completion.
      const last = asRecord(await session.client.request({ type: "get_last_assistant_text" }));
      if (typeof last?.text === "string") finalText = last.text.trim();
    }
    const liveDecisionApplied = executes &&
      executeDecisionWasAppliedDuringTurn(accumulated.successfulToolCalls);
    if (accumulated.failure) {
      return {
        // A partial sentence before a failed tool-loop request is not a
        // completed answer. Surface one unambiguous failure card; the streamed
        // partial remains available in the technical trace.
        decision: buildTalkReplyDecision(`Cora Pi backend error: ${accumulated.failure}`),
        decisionAlreadyApplied: liveDecisionApplied || undefined,
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid: session.sessionId,
        ...cumulativeUsage,
        accountProfileId: session.accountProfileId,
        ...contextUsage,
        ...providerDiagnostics,
        notice: accumulated.failure,
        turnFailed: true,
      };
    }
    if (!finalText) {
      const detail = compactionFailure
        ? "Cora finished without a final response and context compaction failed."
        : "Cora finished its tool work without a final response after one retry.";
      return {
        decision: buildTalkReplyDecision(detail),
        decisionAlreadyApplied: liveDecisionApplied || undefined,
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid: session.sessionId,
        ...cumulativeUsage,
        accountProfileId: session.accountProfileId,
        ...contextUsage,
        ...providerDiagnostics,
        notice: detail,
        turnFailed: true,
      };
    }
    const reply = finalText;
    return {
      decision: executes
        ? buildExecuteDecisionFromToolCalls(accumulated.successfulToolCalls, reply)
        : buildTalkReplyDecision(reply),
      decisionAlreadyApplied: liveDecisionApplied,
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      newSessionUuid: session.sessionId,
      ...cumulativeUsage,
      accountProfileId: session.accountProfileId,
      ...contextUsage,
      ...providerDiagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = session.client.diagnostics().stderr.trim();
    const detail = diagnostic ? `${message}\n${diagnostic}` : message;
    // A turn exception means this runtime cannot be trusted for reuse. Stop it
    // before parking/requeueing so native tools cannot outlive their run. Only
    // the turn that owns the session may do so: stopping a process another
    // turn is streaming from left that turn hanging until the idle timeout.
    if (session.activeTurn === activeTurn) await stopSession(runId, session);
    onStream?.({ kind: "error", message: detail });
    return {
      decision: buildTalkReplyDecision(`Cora Pi backend error: ${detail}`),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      accountProfileId: session.accountProfileId,
      newSessionUuid: session.sessionId,
      notice: detail,
      turnFailed: true,
    };
  } finally {
    compaction?.dispose();
    unsubscribe?.();
  }
}

export const piBackend = {
  kind: "pi",
  displayName: "Cora · Pi",
  requestManagerDecision: requestPiDecision,
  async disposeChat(runId) {
    GENERATIONS.set(runId, (GENERATIONS.get(runId) ?? 0) + 1);
    await stopSession(runId);
  },
  interruptChat(runId) {
    const generation = (GENERATIONS.get(runId) ?? 0) + 1;
    GENERATIONS.set(runId, generation);
    const pending = PENDING_SESSIONS.get(runId);
    if (pending) {
      PENDING_SESSIONS.delete(runId);
      void cleanupPiProcess(pending);
    }
    const session = SESSIONS.get(runId);
    if (!session) return;
    session.interrupted = true;
    session.activeTurn?.settle();
    void session.client.abort().catch(() => undefined);
  },
  async steerChat(runId: string, steer: ManagerSteerInput): Promise<boolean> {
    const session = SESSIONS.get(runId);
    const turn = session?.activeTurn;
    if (
      !session ||
      !turn ||
      !turn.acceptingSteers ||
      session.interrupted ||
      session.client.state().phase !== "running"
    ) {
      return false;
    }
    // Registered before the request goes out: Pi can inject the message
    // before the steer response arrives.
    turn.pendingSteers.set(steer.messageId, { text: steer.text, onDelivered: steer.onDelivered });
    try {
      await session.client.request({ type: "steer", message: steer.text });
    } catch {
      turn.pendingSteers.delete(steer.messageId);
      return false;
    }
    return true;
  },
} satisfies AgentBackend;
