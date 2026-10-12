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
  markUserPiRuntimeFailed,
  resolveCodaraOpenRouterApiKey,
  resolveCodaraPiExecutionAccount,
  resolveCodaraPiFastMode,
} from "./pi-runtime-electron";
import {
  type PiManagerLaunchPlan,
  type PiProvider,
  type PiThinkingLevel,
} from "./pi-runtime";
import { PiRpcClient, type PiRpcFailure } from "./pi-rpc-client";
import {
  classifyTurnLiveness,
  isLongPollToolName,
  type TurnInFlightTool,
} from "./agent-liveness";
import { piBackendSessionIdentityMatches } from "./pi-session-identity";
import { PiTurnAccumulator } from "./pi-turn";
import { PiManagerCompaction } from "./pi-manager-compaction";
import { describeCompaction, logCompaction } from "./pi-compaction-pipeline";
import { resetCoraMemoryInjection } from "./cora-memory";
import {
  buildTalkReplyDecision,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
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
  /** Settlers of every turn running on this process; stopSession and
   *  interruptChat release all of them, not just the newest. */
  activeTurns: Set<() => void>;
  /** Set by interruptChat: resolves true once Pi confirmed the aborted turn
   *  went idle, which makes the process safe to reuse. */
  interruptSettling: Promise<boolean> | null;
  /** Prompt requests Pi has not answered yet. */
  promptsInFlight: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
  /** The one turn this session is running. Prompting it while another turn
   *  streams is rejected by Pi, and the old failure handling then stopped the
   *  process the live turn was using. */
  activeTurn: ActivePiTurn | null;
}

interface ActivePiTurn {
  startedAt: number;
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
/**
 * An idle chat's Pi process (and every MCP server its bridge started) is
 * stopped after this long without a turn. The session file stays on disk, so
 * the next message relaunches with the same session id at the cost of one
 * cold start.
 */
const PI_SESSION_IDLE_MS = 10 * 60 * 1000;
/** Live manager processes kept at once; the least recently used idle ones go first. */
const PI_MAX_LIVE_SESSIONS = 4;
/** How long an interrupt may take to leave Pi idle before the process is replaced. */
const PI_INTERRUPT_SETTLE_MS = 3 * 1000;
/** Stderr kept for Technical details; the user-facing text never carries it. */
const PI_DIAGNOSTIC_TAIL_CHARS = 2_000;

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

function stderrTail(client: PiRpcClient | undefined): string | undefined {
  const stderr = client?.diagnostics().stderr.trim();
  if (!stderr) return undefined;
  return stderr.length > PI_DIAGNOSTIC_TAIL_CHARS
    ? stderr.slice(stderr.length - PI_DIAGNOSTIC_TAIL_CHARS)
    : stderr;
}

/**
 * The one-line, actionable sentence for a Pi process that never came up. The
 * raw error and stderr stay in the diagnostics; this is what the chat shows.
 */
export function describePiStartupFailure(message: string, stderr = ""): string {
  if (/failed to spawn/i.test(message)) {
    return `Cora's runtime could not be launched (${message.replace(/^Pi RPC failed to spawn:\s*/i, "")}). Restart Codara; if it keeps failing, reinstall Pi from Settings > Accounts.`;
  }
  if (!/startup handshake|Pi RPC process exited/i.test(message)) return message;
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const extensionLine = lines.find((line) => /Failed to load extension|Cannot find module/i.test(line));
  if (extensionLine) {
    return `Cora's runtime exited while loading its extensions: ${extensionLine.slice(0, 300)} Reinstall Pi from Settings > Accounts, or update Codara.`;
  }
  const last = lines.at(-1);
  return `Cora's runtime stopped while starting${last ? `: ${last.slice(0, 300)}` : ` (${message})`}. Try again; if it keeps failing, reinstall Pi from Settings > Accounts.`;
}

/** A startup failure whose message is the user-facing sentence and whose raw
 *  cause rides along for the spark_call failure record. */
function startupError(error: unknown, client?: PiRpcClient): Error & { diagnostics?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = stderrTail(client);
  const friendly = describePiStartupFailure(message, stderr);
  const diagnostics = [friendly === message ? "" : message, stderr ?? ""]
    .filter(Boolean)
    .join("\n");
  // startupCause keeps the raw handshake error ("timed out", "process
  // exited") that run-store's startup retry classifies; the friendly sentence
  // hides it.
  return Object.assign(
    new Error(friendly),
    { startupCause: message },
    diagnostics ? { diagnostics } : {},
  );
}

function clearIdleTimer(session: PiBackendSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function scheduleIdleStop(runId: string, session: PiBackendSession): void {
  clearIdleTimer(session);
  if (SESSIONS.get(runId) !== session || session.activeTurns.size > 0) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (SESSIONS.get(runId) === session && session.activeTurns.size === 0) {
      void stopSession(runId, session);
    }
  }, PI_SESSION_IDLE_MS);
  session.idleTimer.unref?.();
}

function evictIdleSessions(keepRunId: string): void {
  const excess = SESSIONS.size - PI_MAX_LIVE_SESSIONS;
  if (excess <= 0) return;
  const idle = [...SESSIONS.entries()]
    .filter(([runId, session]) =>
      runId !== keepRunId && session.activeTurns.size === 0)
    .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
    .slice(0, excess);
  for (const [runId, session] of idle) void stopSession(runId, session);
}

async function abortWithin(client: PiRpcClient, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      // Pi answers abort only once the session is idle again.
      client.abort().then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SessionIdentityKey =
  | "provider"
  | "accountProfileId"
  | "model"
  | "thinking"
  | "chatMode"
  | "executionPolicy"
  | "projectPolicyMode"
  | "sessionId"
  | "fastMode";

const IDENTITY_LABELS: ReadonlyArray<readonly [SessionIdentityKey, string]> = [
  ["provider", "provider"],
  ["accountProfileId", "account"],
  ["model", "model"],
  ["thinking", "effort"],
  ["chatMode", "mode"],
  ["executionPolicy", "execution policy"],
  ["projectPolicyMode", "project policy"],
  ["sessionId", "conversation"],
  ["fastMode", "fast mode"],
];

/** The note that names why a running process is being replaced. */
function restartNote(
  session: PiBackendSession,
  expected: Pick<PiBackendSession, SessionIdentityKey>,
  observedGeneration: number,
): string {
  if (session.generation !== observedGeneration) {
    return "Restarting Cora's runtime after the interrupted turn.";
  }
  if (session.client.state().phase !== "running") {
    return "Cora's runtime had stopped; starting a fresh one.";
  }
  const changed = IDENTITY_LABELS
    .filter(([key]) => session[key] !== expected[key])
    .map(([, label]) => label);
  if (changed.length > 0) {
    return `Restarting Cora's runtime for the new ${changed.join(", ")}.`;
  }
  return "Restarting Cora's runtime to renew its access.";
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
    clearIdleTimer(session);
    for (const settle of [...session.activeTurns]) settle();
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

/**
 * The session `turn` runs on. The turn's settler is registered before the
 * session is handed back, in the same synchronous step that picked it, so no
 * other run's launch can evict the process in between.
 */
async function ensureSession(
  input: ManagerRequestInput,
  turn: () => void,
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
  const settling = SESSIONS.get(runId)?.interruptSettling;
  const abortedIdle = settling ? await settling : false;
  if ((GENERATIONS.get(runId) ?? 0) !== observedGeneration) {
    throw supersededStartupError();
  }
  const sessionId = safeSessionId(input);
  const current = SESSIONS.get(runId);
  const pendingCurrent = PENDING_SESSIONS.get(runId);
  if (current && settling && current.interruptSettling === settling) {
    current.interruptSettling = null;
    // The interrupt bumped the generation so the aborted turn's late results
    // are discarded. Once Pi confirmed it is idle the process itself is
    // healthy, so this turn adopts it instead of cold-starting a new one.
    if (abortedIdle && !pendingCurrent && current.generation < observedGeneration) {
      current.generation = observedGeneration;
    }
  }
  if (
    current &&
    current.generation === observedGeneration &&
    sessionMatches(current, provider, account.accountProfileId, model, thinking, mode, input.chat.mode, executionPolicy, projectPolicyMode, sessionId, fastMode)
  ) {
    clearIdleTimer(current);
    current.lastUsedAt = Date.now();
    current.activeTurns.add(turn);
    return current;
  }
  const generation = observedGeneration + 1;
  GENERATIONS.set(runId, generation);
  if (current) {
    onStream?.({
      kind: "system_note",
      message: restartNote(current, {
        provider,
        accountProfileId: account.accountProfileId,
        model,
        thinking,
        chatMode: input.chat.mode,
        executionPolicy,
        projectPolicyMode,
        sessionId,
        fastMode,
      }, observedGeneration),
    });
    await stopSession(runId, current);
  }
  if (pendingCurrent) {
    await stopSession(runId, pendingCurrent);
  }
  if (GENERATIONS.get(runId) !== generation) {
    throw supersededStartupError();
  }
  const launchOptions: Parameters<typeof createCodaraPiLaunchPlan>[0] = {
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
  };
  const launch = async (): Promise<{
    client: PiRpcClient;
    plan: PiManagerLaunchPlan;
    pending: PendingPiBackendSession;
    state: Record<string, unknown>;
  }> => {
    const plan = await createCodaraPiLaunchPlan(launchOptions);
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
    let state: Record<string, unknown>;
    try {
      state = await client.start();
    } catch (error) {
      // Read stderr before cleanup: it is the only record of why Pi exited.
      const failure = startupError(error, client);
      if (PENDING_SESSIONS.get(runId) === pending) {
        PENDING_SESSIONS.delete(runId);
      }
      await cleanupPiProcess(pending);
      throw Object.assign(failure, { runtimePlan: plan });
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
    return { client, plan, pending, state };
  };
  let launched: Awaited<ReturnType<typeof launch>>;
  try {
    launched = await launch();
  } catch (error) {
    const failedPlan = (error as { runtimePlan?: PiManagerLaunchPlan }).runtimePlan;
    if (
      failedPlan?.runtimeSource !== "user" ||
      !failedPlan.runtimeVersion ||
      GENERATIONS.get(runId) !== generation
    ) {
      throw error;
    }
    // The user's own Pi may be a version Codara was never tested against.
    // The bundled build is, so one retry on it keeps Cora usable.
    markUserPiRuntimeFailed(failedPlan.runtimeVersion);
    onStream?.({
      kind: "system_note",
      message: `Your installed Pi ${failedPlan.runtimeVersion} failed to start (${error instanceof Error ? error.message : String(error)}). Cora is using the Pi build bundled with Codara instead.`,
    });
    launched = await launch();
  }
  const { client, plan, pending, state } = launched;
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
    activeTurns: new Set([turn]),
    interruptSettling: null,
    promptsInFlight: 0,
    idleTimer: null,
    lastUsedAt: Date.now(),
    activeTurn: null,
    cleanupPromise: pending.cleanupPromise,
  };
  PENDING_SESSIONS.delete(runId);
  SESSIONS.set(runId, session);
  evictIdleSessions(runId);
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
  inFlightTools: Map<string, TurnInFlightTool>;
}

/** The Pi process died under a turn whose prompt it had already accepted. */
class PiRuntimeFailure extends Error {}

/**
 * Resolve when the turn settles; reject when it goes QUIET (see
 * PI_TURN_IDLE_TIMEOUT_MS), blows the absolute ceiling, or the runtime dies.
 * A turn parked inside a long-poll orchestration tool is never idle, however
 * long it waits.
 */
async function waitForSettled(
  settled: Promise<void>,
  liveness: PiTurnLiveness,
  runtimeFailed: Promise<never>,
): Promise<void> {
  let poll: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();
  try {
    await Promise.race([
      settled,
      runtimeFailed,
      new Promise<never>((_, reject) => {
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
  let session: PiBackendSession | undefined;
  let turn: PiTurnAccumulator | undefined;
  let generation: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeFailure: (() => void) | undefined;
  let compaction: PiManagerCompaction | undefined;
  let settle: () => void = () => undefined;
  const releaseTurn = (): void => settle();
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
    accountProfileId: session?.accountProfileId,
    turnAborted: true,
  });
  // Session STARTUP is outside the turn-failure envelope on purpose. A missing
  // or expired subscription auth, an uninstalled pinned runtime, or an RPC
  // process that never came up all mean NO provider turn ever started —
  // reporting them as turnFailed made run-store brand the run failed, which
  // bypassed the degradation its callers own for a manager that yields no
  // decision (SPARK_ENABLE_MANUAL_FALLBACK's manual worker task, or parking
  // the run on an accurate question). Throw instead: askManagerBackend's catch
  // records the spark_call failure and returns null, and the caller degrades.
  try {
    session = await ensureSession(input, releaseTurn, onStream);
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
    session.activeTurns.delete(releaseTurn);
    return {
      decision: buildTalkReplyDecision("Cora is already working on a turn in this chat."),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      accountProfileId: session.accountProfileId,
      notice: "Cora is already working on a turn in this chat; this message waits for it.",
      turnAborted: true,
      sessionBusy: true,
    };
  }
  const activeTurn: ActivePiTurn = { startedAt };
  session.activeTurn = activeTurn;
  try {
    generation = session.generation;
    const turnGeneration = generation;
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
    const liveness: PiTurnLiveness = {
      lastEventAt: Date.now(),
      inFlightTools: new Map(),
    };
    let agentSettledSeen = false;
    const armSettlement = (): Promise<void> => {
      liveness.lastEventAt = Date.now();
      liveness.inFlightTools.clear();
      agentSettledSeen = false;
      return new Promise<void>((resolve) => { settle = resolve; });
    };
    let settled = armSettlement();
    let compactionFailure: string | undefined;
    const activeSession = session;
    compaction = new PiManagerCompaction({
      request: (command, options) => activeSession.client.request(command, options),
      // A mid-turn continuation is a prompt like any other: interruptChat must
      // see it in flight to know the process cannot be trusted idle.
      prompt: async (text) => {
        activeSession.promptsInFlight += 1;
        try {
          return await activeSession.client.prompt(text);
        } finally {
          activeSession.promptsInFlight -= 1;
        }
      },
    }, {
      interrupted: () => activeSession.interrupted || GENERATIONS.get(runId) !== turnGeneration,
      onSettled: () => settle(),
      onError: (error) => { compactionFailure = error.message; },
      onReport: (report) => {
        logCompaction(`run=${runId}`, report);
        onStream?.({ kind: "system_note", message: describeCompaction(report) });
      },
    });
    let failRuntime: (failure: PiRpcFailure) => void = () => undefined;
    const runtimeFailed = new Promise<never>((_, reject) => {
      failRuntime = (failure) => reject(new PiRuntimeFailure(failure.message));
    });
    runtimeFailed.catch(() => undefined);
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
      if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
        const tool = liveness.inFlightTools.get(event.toolCallId);
        if (tool) tool.lastProgressAt = Date.now();
      }
      if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        liveness.inFlightTools.delete(event.toolCallId);
      }
      accumulator.consume(event);
      // A settlement a mid-turn pause produced is not the end of the turn: the
      // continuation still has to run, and a crash during it must fail the turn.
      if (event.type === "agent_settled" && !compaction?.holdsTurnOpen()) agentSettledSeen = true;
      // A finished compaction (host-requested or Pi's native one) summarized
      // the turn that carried the memory sections, so the next turn re-sends them.
      if (event.type === "compaction_end" && event.result) resetCoraMemoryInjection(runId);
      if (compaction?.consume(event)) return;
      if (event.type === "agent_settled") settle();
    });
    // After agent_settled the answer is complete and only the post-turn
    // compaction can still be running; its own request rejects on a crash and
    // reports through compactionFailure, which keeps the answer.
    unsubscribeFailure = session.client.onFailure((failure) => {
      if (!agentSettledSeen) failRuntime(failure);
    });
    const startState = session.client.state();
    if (startState.phase === "failed") {
      failRuntime(startState.failure ?? { code: "PROCESS_EXIT", message: "Pi RPC process exited" });
    }

    const prompt = async (text: string): Promise<void> => {
      activeSession.promptsInFlight += 1;
      try {
        await activeSession.client.prompt(text);
      } finally {
        activeSession.promptsInFlight -= 1;
      }
    };

    await prompt(input.prompt);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return interruptedResult();
    }
    await input.onPromptAccepted?.();
    await waitForSettled(settled, liveness, runtimeFailed);
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
      await prompt(EMPTY_FINAL_REPROMPT);
      await waitForSettled(settled, liveness, runtimeFailed);
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
        return interruptedResult();
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
    // What the manager-turn policy needs to decide whether replaying this
    // turn is safe and whether Pi already spent its own retry budget.
    const replayFacts = {
      ...(accumulated.providerRetried ? { providerRetried: true } : {}),
      replaySafe: accumulated.toolCalls.length === 0 && !liveDecisionApplied,
    };
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
        ...replayFacts,
        notice: accumulated.failure,
        turnFailed: true,
      };
    }
    if (!finalText && liveDecisionApplied) {
      // The orchestration tool already changed the run (workers started, the
      // run completed, a question settled). An empty closing message is a
      // model quirk, not a failed turn, and failing it would tear down the
      // very workers this turn started. Say what the tools did instead.
      const decision = buildExecuteDecisionFromToolCalls(accumulated.successfulToolCalls, "");
      const reply = decision.chatReply?.trim() || decision.summary.trim();
      // The applied-decision path never replays `decision`, so the reply only
      // reaches the transcript as a streamed block.
      onStream?.({ kind: "assistant_block", messageId: `pi-tool-summary-${Date.now()}`, text: reply });
      return {
        decision: { ...decision, chatReply: reply },
        decisionAlreadyApplied: true,
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid: session.sessionId,
        ...cumulativeUsage,
        accountProfileId: session.accountProfileId,
        ...contextUsage,
        ...providerDiagnostics,
        notice: "Cora's closing message was empty, so its reply summarizes what its tools did.",
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
        ...replayFacts,
        notice: detail,
        failureCause: "empty_reply",
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
    // Our own stop (dispose, a superseding launch) is not a failure: the
    // owner of that stop already decided what happens to the run.
    if (
      session &&
      session.client.state().phase !== "failed" &&
      (session.interrupted || (generation !== undefined && GENERATIONS.get(runId) !== generation))
    ) {
      return interruptedResult();
    }
    const runtimeCrashed =
      error instanceof PiRuntimeFailure || session?.client.state().phase === "failed";
    // Stderr goes to diagnostics only. Mixed into the message it buried the
    // cause under stack frames and let a stale "429" line steer the policy.
    const diagnostics = stderrTail(session?.client);
    const partial = turn?.result();
    // A turn exception means this runtime cannot be trusted for reuse. Stop it
    // before parking/requeueing so native tools cannot outlive their run.
    if (session) await stopSession(runId, session);
    if (diagnostics) console.warn(`[pi-backend] turn failed for ${runId}: ${message}\n${diagnostics}`);
    onStream?.({ kind: "error", message });
    return {
      decision: buildTalkReplyDecision(`Cora Pi backend error: ${message}`),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      accountProfileId: session?.accountProfileId,
      newSessionUuid: session?.sessionId,
      notice: message,
      ...(diagnostics ? { diagnostics } : {}),
      ...(runtimeCrashed ? { failureCause: "runtime" as const } : {}),
      ...(partial?.providerRetried ? { providerRetried: true } : {}),
      replaySafe: (partial?.toolCalls.length ?? 0) === 0,
      turnFailed: true,
    };
  } finally {
    compaction?.dispose();
    unsubscribe?.();
    unsubscribeFailure?.();
    if (session.activeTurn === activeTurn) session.activeTurn = null;
    if (session) {
      session.activeTurns.delete(releaseTurn);
      session.lastUsedAt = Date.now();
      scheduleIdleStop(runId, session);
    }
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
    for (const settle of [...session.activeTurns]) settle();
    const aborted = abortWithin(session.client, PI_INTERRUPT_SETTLE_MS);
    // A prompt still in preflight (before_agent_start, a pre-prompt
    // compaction) has no agent run to abort: Pi answers abort at once and
    // then starts that prompt's run anyway, so the process cannot be trusted
    // idle and the next turn replaces it.
    session.interruptSettling = session.promptsInFlight > 0
      ? aborted.then(() => false)
      : aborted;
  },
} satisfies AgentBackend;
