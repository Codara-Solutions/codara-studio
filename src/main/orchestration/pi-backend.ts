import { createHash } from "node:crypto";
import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";

import {
  buildExecuteDecisionFromToolCalls,
  executeDecisionWasAppliedDuringTurn,
} from "./claude-backend";
import {
  archiveCodaraPiFrontierRevision,
  cleanupPiMcpBridgeConfig,
  createCodaraPiLaunchPlan,
  promoteCodaraPiFrontierAdmission,
  resolveCodaraPiExecutionAccount,
  resolveCodaraPiFastMode,
} from "./pi-runtime-electron";
import {
  type PiManagerLaunchPlan,
  type PiSubscriptionProvider,
  type PiThinkingLevel,
} from "./pi-runtime";
import { PiRpcClient } from "./pi-rpc-client";
import { classifyTurnLiveness, isLongPollToolName } from "./agent-liveness";
import { piBackendSessionIdentityMatches } from "./pi-session-identity";
import { frontierTurnHasRequiredCompletion, PiTurnAccumulator } from "./pi-turn";
import {
  buildTalkReplyDecision,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
  type SparkAgentBackend,
} from "./spark-agent-backend";
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
  provider: PiSubscriptionProvider;
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
  contractPromptSha256: string | null;
  settleActiveTurn: (() => void) | null;
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
const FRONTIER_CONTRACT_DRIFT_MARKER = "CORA_FRONTIER_CONTRACT_DRIFT";
const MAX_FRONTIER_CONTRACT_RESTARTS = 3;

interface FrontierRestartContext {
  count: number;
  startedAt: number;
  promptAccepted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  accountProfileId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function piResultText(value: unknown): string {
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : [];
  return content.map((item) => {
    const block = asRecord(item);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

function hasFrontierContractDrift(value: unknown): boolean {
  if (piResultText(value).includes(FRONTIER_CONTRACT_DRIFT_MARKER)) return true;
  try { return JSON.stringify(value).includes(FRONTIER_CONTRACT_DRIFT_MARKER); }
  catch { return false; }
}

// Marks an error thrown before any provider turn started (ensureSession).
// Startup failures must escape requestPiDecision as THROWS at every recursion
// depth so run-store can degrade instead of failing the run; the symbol lets
// the outer turn-failure catch recognize one arriving from the Frontier
// contract-restart recursion.
const PI_SESSION_STARTUP_FAILURE = Symbol("piSessionStartupFailure");

function markPiSessionStartupFailure(error: Error): void {
  (error as Error & { [PI_SESSION_STARTUP_FAILURE]?: true })[PI_SESSION_STARTUP_FAILURE] = true;
}

function isPiSessionStartupFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { [PI_SESSION_STARTUP_FAILURE]?: true })[PI_SESSION_STARTUP_FAILURE] === true
  );
}

export function piProviderForModel(model: string): PiSubscriptionProvider {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai-codex";
  throw new Error(`Pi subscription backend does not support model ${model}`);
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

function frontierContractPrompt(input: ManagerRequestInput): string {
  const userMessages = input.run.humanMessages.filter((message) =>
    message.author === "user" && message.deliveryState !== "cancelled" &&
    (message.kind === "note" || message.kind === "answer") && message.message.trim().length > 0);
  if (!userMessages.length) return input.prompt;
  return [
    "# Live user contract",
    ...userMessages.flatMap((message, index) => ["", `## Request ${index + 1}`, "", message.message.trim()]),
  ].join("\n");
}

function sessionMatches(
  session: PiBackendSession,
  provider: PiSubscriptionProvider,
  accountProfileId: string | undefined,
  model: string,
  thinking: PiThinkingLevel,
  mode: PiBackendSession["mode"],
  chatMode: ChatMode,
  executionPolicy: CoraExecutionPolicy,
  projectPolicyMode: ProjectPolicyMode,
  sessionId: string,
  contractPromptSha256: string | null,
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
    contractPromptSha256,
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
    session.settleActiveTurn?.();
    session.settleActiveTurn = null;
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
  restartAccountProfileId?: string,
): Promise<PiBackendSession> {
  const runId = input.run.id;
  const observedGeneration = GENERATIONS.get(runId) ?? 0;
  const provider = piProviderForModel(input.chat.model);
  const model = input.chat.model;
  const thinking = piThinkingForEffort(input.chat.effort);
  const mode = piModeForChat(input.chat.mode);
  const executionPolicy = input.chat.executionPolicy;
  const projectPolicyMode = runProjectPolicyMode(input.run);
  const [account, fastMode] = await Promise.all([
    resolveCodaraPiExecutionAccount({
      provider,
      preferredAccountProfileId:
        restartAccountProfileId ?? input.chat.accountProfileId,
    }),
    // Fast mode reaches the runtime only as launch-time env, so a session
    // launched under the other value cannot be reused: resolve it here, match
    // on it below, and hand the SAME value to the launch plan.
    resolveCodaraPiFastMode(provider),
  ]);
  if ((GENERATIONS.get(runId) ?? 0) !== observedGeneration) {
    throw supersededStartupError();
  }
  const sessionId = safeSessionId(input);
  const contractPrompt = executionPolicy === "frontier" ? frontierContractPrompt(input) : null;
  const contractPromptSha256 = executionPolicy === "frontier"
    ? createHash("sha256").update(contractPrompt!.replaceAll("\r\n", "\n").trim()).digest("hex")
    : null;
  const current = SESSIONS.get(runId);
  const pendingCurrent = PENDING_SESSIONS.get(runId);
  if (
    current &&
    current.generation === observedGeneration &&
    sessionMatches(current, provider, account.accountProfileId, model, thinking, mode, input.chat.mode, executionPolicy, projectPolicyMode, sessionId, contractPromptSha256, fastMode)
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
    contractPrompt: contractPrompt ?? undefined,
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
    if (PENDING_SESSIONS.get(runId) === pending) {
      PENDING_SESSIONS.delete(runId);
    }
    await cleanupPiProcess(pending);
    throw error;
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
    contractPromptSha256,
    settleActiveTurn: null,
    cleanupPromise: pending.cleanupPromise,
  };
  PENDING_SESSIONS.delete(runId);
  SESSIONS.set(runId, session);
  onStream?.({
    kind: "system_note",
    message: `Cora Pi session ready · ${provider}/${model} · ${thinking} thinking · ${executionPolicy} chat mode${plan.frontierAdmissionArtifactSha256 ? " · exact-state admission cache hit" : ""}`,
  });
  return session;
}

/** Liveness the turn's event listener keeps up to date for waitForSettled. */
interface PiTurnLiveness {
  /** Epoch ms of the last stream event. */
  lastEventAt: number;
  /** Epoch ms a long-poll tool call started, or null when none is in flight. */
  longPollSince: number | null;
  /** Name of the last long-poll tool, for the timeout message. */
  longPollName: string | null;
}

/**
 * Resolve when the turn settles; reject when it goes QUIET (see
 * PI_TURN_IDLE_TIMEOUT_MS) or blows the absolute ceiling. A turn parked inside
 * a long-poll orchestration tool is never idle, however long it waits.
 */
async function waitForSettled(settled: Promise<void>, liveness: PiTurnLiveness): Promise<void> {
  let poll: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        poll = setInterval(() => {
          const verdict = classifyTurnLiveness({
            now: Date.now(),
            startedAt,
            lastEventAt: liveness.lastEventAt,
            longPollSince: liveness.longPollSince,
            longPollName: liveness.longPollName,
          });
          if (verdict.action === "fail") reject(new Error(verdict.detail));
        }, PI_TURN_IDLE_CHECK_MS);
        poll.unref();
      }),
    ]);
  } finally {
    if (poll) clearInterval(poll);
  }
}

async function requestPiDecision(
  input: ManagerRequestInput,
  onStream?: ChatStreamHandler,
  restartContext?: FrontierRestartContext,
): Promise<ManagerCallResult> {
  const startedAt = restartContext?.startedAt ?? Date.now();
  const runId = input.run.id;
  let session: PiBackendSession | undefined;
  let unsubscribe: (() => void) | undefined;
  // Session STARTUP is outside the turn-failure envelope on purpose. A missing
  // or expired subscription auth, an uninstalled pinned runtime, or an RPC
  // process that never came up all mean NO provider turn ever started —
  // reporting them as turnFailed made run-store brand the run failed, which
  // bypassed the degradation its callers own for a manager that yields no
  // decision (SPARK_ENABLE_MANUAL_FALLBACK's manual worker task, or parking
  // the run on an accurate question). Throw instead: askManagerBackend's catch
  // records the spark_call failure and returns null, and the caller degrades.
  // The marker keeps that contract at every recursion depth: a Frontier
  // contract-restart re-runs this function INSIDE the parent's turn envelope,
  // and without it the restart's own startup failure would decay to turnFailed.
  try {
    session = await ensureSession(
      input,
      onStream,
      restartContext?.accountProfileId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onStream?.({ kind: "error", message });
    const startupError = error instanceof Error ? error : new Error(message);
    markPiSessionStartupFailure(startupError);
    throw startupError;
  }
  // Report the session id the moment it exists, so run-store can persist it
  // durably BEFORE the turn settles. Best-effort: a persistence hiccup must
  // not fail an otherwise healthy turn.
  try {
    await input.onSessionEstablished?.(session.sessionId);
  } catch (error) {
    console.warn(`[pi-backend] failed to persist session id for ${runId}:`, error);
  }
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
      return {
        decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        accountProfileId: session.accountProfileId,
        turnAborted: true,
      };
    }
    const turn = new PiTurnAccumulator(onStream);
    let contractDriftDetected = false;
    let contractBlockerOutput: string | null = null;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    session.settleActiveTurn = settle;
    const liveness: PiTurnLiveness = {
      lastEventAt: Date.now(),
      longPollSince: null,
      longPollName: null,
    };
    unsubscribe = session.client.onEvent((event) => {
      liveness.lastEventAt = Date.now();
      // A blocking orchestration tool means the manager is waiting on workers
      // or on the user. Hold the idle clock for its duration instead of ageing
      // a perfectly healthy turn toward a timeout.
      if (event.type === "tool_execution_start" && isLongPollToolName(event.toolName)) {
        liveness.longPollSince = Date.now();
        liveness.longPollName = typeof event.toolName === "string" ? event.toolName : null;
      }
      if (event.type === "tool_execution_end" && liveness.longPollSince !== null) {
        liveness.longPollSince = null;
      }
      turn.consume(event);
      if (event.type === "tool_execution_end" && hasFrontierContractDrift(event.result)) {
        contractDriftDetected = true;
      }
      if (event.type === "tool_execution_end") {
        const output = piResultText(event.result);
        if (output.includes("frontier=contract-blocked")) contractBlockerOutput = output;
      }
      if (event.type === "agent_settled") settle();
    });

    const prompt = restartContext
      ? `${input.prompt}\n\nCORA FRONTIER CONTRACT REVISION ${restartContext.count}: The machine detected that an authoritative tracked requirement changed during the preceding attempt. Preserve still-valid working-tree changes, but discard stale reasoning. Re-run the exact baseline and fresh managed admission against the newly compiled contract atlas before any further mutation, then complete the original task against the revised contract.`
      : input.prompt;
    await session.client.prompt(prompt);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return {
        decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        accountProfileId: session.accountProfileId,
        turnAborted: true,
      };
    }
    if (!restartContext?.promptAccepted) await input.onPromptAccepted?.();
    await waitForSettled(settled, liveness);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return {
        decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        accountProfileId: session.accountProfileId,
        turnAborted: true,
      };
    }

    const accumulated = turn.result();
    const cumulativeUsage = {
      inputTokens: (restartContext?.inputTokens ?? 0) + accumulated.usage.inputTokens,
      outputTokens: (restartContext?.outputTokens ?? 0) + accumulated.usage.outputTokens,
      cacheReadTokens: (restartContext?.cacheReadTokens ?? 0) + accumulated.usage.cacheReadTokens,
    };
    // Context occupancy is a gauge, so it is the newest request's prompt size
    // rather than a sum over the turn, and it is deliberately NOT carried into
    // a Frontier restart: a restarted turn measures its own fresh session.
    // promptTokens is the field run-store persists onto the SparkCall, which is
    // where the Runs inspector and a re-opened chat read the meter from.
    const contextUsage = {
      ...(accumulated.contextTokens > 0 ? { promptTokens: accumulated.contextTokens } : {}),
      ...(accumulated.contextWindowTokens !== null
        ? { contextWindowTokens: accumulated.contextWindowTokens }
        : {}),
    };
    const providerDiagnostics = accumulated.providerResponseIds.length > 0
      ? { providerResponseIds: accumulated.providerResponseIds }
      : {};
    if (contractDriftDetected && session.executionPolicy === "frontier") {
      const restartCount = restartContext?.count ?? 0;
      if (restartCount >= MAX_FRONTIER_CONTRACT_RESTARTS) {
        const notice = `Cora Frontier detected more than ${MAX_FRONTIER_CONTRACT_RESTARTS} contract revisions during one turn and stopped to avoid an unstable re-admission loop.`;
        return {
          decision: buildTalkReplyDecision(notice),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          accountProfileId: session.accountProfileId,
          newSessionUuid: session.sessionId,
          ...cumulativeUsage,
          ...contextUsage,
          ...providerDiagnostics,
          notice,
          turnFailed: true,
        };
      }
      unsubscribe?.();
      unsubscribe = undefined;
      const archive = await archiveCodaraPiFrontierRevision(session.plan, restartCount + 1).catch(() => null);
      await stopSession(runId, session);
      onStream?.({
        kind: "system_note",
        message: `Cora Frontier detected an authoritative contract revision · preserving the working tree and rebuilding admission (${restartCount + 1}/${MAX_FRONTIER_CONTRACT_RESTARTS})${archive ? ` · archived ${archive.files} proof files` : ""}.`,
      });
      return requestPiDecision(input, onStream, {
        count: restartCount + 1,
        startedAt,
        promptAccepted: true,
        ...cumulativeUsage,
        accountProfileId: session.accountProfileId,
      });
    }
    let finalText = accumulated.finalText;
    if (!finalText) {
      const last = asRecord(await session.client.request({ type: "get_last_assistant_text" }));
      if (typeof last?.text === "string") finalText = last.text.trim();
    }
    const executes = input.chat.mode === "auto" || input.chat.mode === "execute";
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
    const contractBlocked = Boolean(contractBlockerOutput);
    const frontierCompleted = session.executionPolicy === "frontier" &&
      accumulated.successfulToolCalls.some((call) => call.toolName === "codara_complete");
    if (!frontierTurnHasRequiredCompletion(session.executionPolicy, contractBlocked, accumulated.successfulToolCalls)) {
      const notice = "Cora Frontier reached the end of the Pi turn without a successful codara_complete call; the run was not marked complete.";
      return {
        decision: buildTalkReplyDecision(finalText || notice),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid: session.sessionId,
        ...cumulativeUsage,
        accountProfileId: session.accountProfileId,
        ...contextUsage,
        ...providerDiagnostics,
        notice,
        turnFailed: true,
      };
    }
    if (frontierCompleted) {
      const promotion = await promoteCodaraPiFrontierAdmission(session.plan).catch((error) => ({
        promoted: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      onStream?.({
        kind: "system_note",
        message: promotion.promoted
          ? "Cora Frontier stored this exact-state contract admission for safe reuse."
          : `Cora Frontier admission cache unchanged · ${promotion.reason}`,
      });
      // A Frontier manifest and its gate state describe one exact task
      // baseline. Rotate the Pi process after completion so the next user task
      // discovers its new workspace state instead of inheriting an admitted
      // baseline from the previous task.
      await stopSession(runId, session);
    }
    if (contractBlocked && contractBlockerOutput && !finalText.includes("CONTRACT_BLOCKER_JSON=")) {
      finalText = `${finalText ? `${finalText}\n\n` : ""}${contractBlockerOutput}`;
    }
    if (contractBlocked) {
      onStream?.({ kind: "system_note", message: "Cora Frontier stopped before mutation because the tracked contract is not jointly implementable or verifiable as written." });
    }
    const reply = finalText || "Cora finished the Pi turn without a visible message.";
    return {
      decision: contractBlocked
        ? buildTalkReplyDecision(reply)
        : executes
        ? buildExecuteDecisionFromToolCalls(accumulated.successfulToolCalls, reply)
        : buildTalkReplyDecision(reply),
      decisionAlreadyApplied: !contractBlocked
        ? liveDecisionApplied
        : undefined,
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      newSessionUuid: session.sessionId,
      ...cumulativeUsage,
      accountProfileId: session.accountProfileId,
      ...contextUsage,
      ...providerDiagnostics,
      notice: contractBlocked ? "Cora Frontier found a machine-validated contract blocker; repository mutation remained locked." : undefined,
    };
  } catch (error) {
    // A marked error is a session-STARTUP failure surfacing from the Frontier
    // contract-restart recursion above; rethrow so the startup contract holds
    // instead of decaying into a turnFailed result one level up.
    if (isPiSessionStartupFailure(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = session?.client.diagnostics().stderr.trim();
    const detail = diagnostic ? `${message}\n${diagnostic}` : message;
    onStream?.({ kind: "error", message: detail });
    return {
      decision: buildTalkReplyDecision(`Cora Pi backend error: ${detail}`),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      accountProfileId: session?.accountProfileId,
      newSessionUuid: session?.sessionId,
      notice: detail,
      turnFailed: true,
    };
  } finally {
    unsubscribe?.();
    if (session) session.settleActiveTurn = null;
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
    session.settleActiveTurn?.();
    void session.client.abort().catch(() => undefined);
  },
} satisfies SparkAgentBackend;
