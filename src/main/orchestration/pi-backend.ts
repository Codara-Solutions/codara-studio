import { createHash } from "node:crypto";
import type { ChatMode, CoraExecutionPolicy } from "@shared/types";

import {
  buildExecuteDecisionFromToolCalls,
  executeDecisionWasAppliedDuringTurn,
} from "./claude-backend";
import {
  archiveCodaraPiFrontierRevision,
  cleanupPiMcpBridgeConfig,
  createCodaraPiLaunchPlan,
  promoteCodaraPiFrontierAdmission,
} from "./pi-runtime-electron";
import {
  type PiManagerLaunchPlan,
  type PiSubscriptionProvider,
  type PiThinkingLevel,
} from "./pi-runtime";
import { PiRpcClient } from "./pi-rpc-client";
import { frontierTurnHasRequiredCompletion, PiTurnAccumulator } from "./pi-turn";
import {
  buildTalkReplyDecision,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
  type SparkAgentBackend,
} from "./spark-agent-backend";

interface PiBackendSession {
  client: PiRpcClient;
  plan: PiManagerLaunchPlan;
  provider: PiSubscriptionProvider;
  model: string;
  thinking: PiThinkingLevel;
  mode: "talk" | "execute" | "automation";
  chatMode: ChatMode;
  executionPolicy: CoraExecutionPolicy;
  sessionId: string;
  generation: number;
  interrupted: boolean;
  contractPromptSha256: string | null;
  settleActiveTurn: (() => void) | null;
}

const SESSIONS = new Map<string, PiBackendSession>();
const GENERATIONS = new Map<string, number>();
const PI_TURN_TIMEOUT_MS = 90 * 60 * 1000;
const FRONTIER_CONTRACT_DRIFT_MARKER = "CORA_FRONTIER_CONTRACT_DRIFT";
const MAX_FRONTIER_CONTRACT_RESTARTS = 3;

interface FrontierRestartContext {
  count: number;
  startedAt: number;
  promptAccepted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
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

export function piProviderForModel(model: string): PiSubscriptionProvider {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai-codex";
  throw new Error(`Pi subscription backend does not support model ${model}`);
}

function piModeForChat(mode: ChatMode): "talk" | "execute" | "automation" {
  if (mode === "talk" || mode === "plan") return "talk";
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
  model: string,
  thinking: PiThinkingLevel,
  mode: PiBackendSession["mode"],
  chatMode: ChatMode,
  executionPolicy: CoraExecutionPolicy,
  sessionId: string,
  contractPromptSha256: string | null,
): boolean {
  return session.provider === provider &&
    session.model === model &&
    session.thinking === thinking &&
    session.mode === mode &&
    session.chatMode === chatMode &&
    session.executionPolicy === executionPolicy &&
    session.sessionId === sessionId &&
    session.contractPromptSha256 === contractPromptSha256 &&
    session.client.state().phase === "running";
}

async function stopSession(runId: string, expected?: PiBackendSession): Promise<void> {
  const session = SESSIONS.get(runId);
  if (!session || (expected && session !== expected)) return;
  SESSIONS.delete(runId);
  session.interrupted = true;
  session.settleActiveTurn?.();
  session.settleActiveTurn = null;
  await session.client.stop().catch(() => undefined);
  await cleanupPiMcpBridgeConfig(session.plan).catch(() => undefined);
}

async function ensureSession(
  input: ManagerRequestInput,
  onStream?: ChatStreamHandler,
): Promise<PiBackendSession> {
  const runId = input.run.id;
  const provider = piProviderForModel(input.chat.model);
  const model = input.chat.model;
  const thinking = piThinkingForEffort(input.chat.effort);
  const mode = piModeForChat(input.chat.mode);
  const executionPolicy = input.chat.executionPolicy;
  const sessionId = safeSessionId(input);
  const contractPrompt = executionPolicy === "frontier" ? frontierContractPrompt(input) : null;
  const contractPromptSha256 = executionPolicy === "frontier"
    ? createHash("sha256").update(contractPrompt!.replaceAll("\r\n", "\n").trim()).digest("hex")
    : null;
  const current = SESSIONS.get(runId);
  if (current && sessionMatches(current, provider, model, thinking, mode, input.chat.mode, executionPolicy, sessionId, contractPromptSha256)) {
    return current;
  }
  if (current) {
    onStream?.({ kind: "system_note", message: "Restarting Cora's Pi runtime with the selected model, mode, or execution policy." });
    await stopSession(runId, current);
  }
  const generation = (GENERATIONS.get(runId) ?? 0) + 1;
  GENERATIONS.set(runId, generation);
  const plan = await createCodaraPiLaunchPlan({
    provider,
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
  });
  const client = new PiRpcClient(plan, {
    requestTimeoutMs: 120_000,
    shutdownGraceMs: 2_000,
  });
  const state = await client.start();
  const reportedSessionId = typeof state.sessionId === "string" && state.sessionId
    ? state.sessionId
    : sessionId;
  const session: PiBackendSession = {
    client,
    plan,
    provider,
    model,
    thinking,
    mode,
    chatMode: input.chat.mode,
    executionPolicy,
    sessionId: reportedSessionId,
    generation,
    interrupted: false,
    contractPromptSha256,
    settleActiveTurn: null,
  };
  SESSIONS.set(runId, session);
  onStream?.({
    kind: "system_note",
    message: `Cora Pi session ready · ${provider}/${model} · ${thinking} · ${executionPolicy}${plan.frontierAdmissionArtifactSha256 ? " · exact-state admission cache hit" : ""}`,
  });
  return session;
}

async function waitForSettled(settled: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cora's Pi turn timed out.")), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  try {
    session = await ensureSession(input, onStream);
    const generation = session.generation;
    session.interrupted = false;
    const turn = new PiTurnAccumulator(onStream);
    let contractDriftDetected = false;
    let contractBlockerOutput: string | null = null;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    session.settleActiveTurn = settle;
    unsubscribe = session.client.onEvent((event) => {
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
        turnAborted: true,
      };
    }
    if (!restartContext?.promptAccepted) await input.onPromptAccepted?.();
    await waitForSettled(settled, PI_TURN_TIMEOUT_MS);
    if (session.interrupted || GENERATIONS.get(runId) !== generation) {
      return {
        decision: buildTalkReplyDecision("Cora's Pi turn was interrupted."),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        turnAborted: true,
      };
    }

    const accumulated = turn.result();
    const cumulativeUsage = {
      inputTokens: (restartContext?.inputTokens ?? 0) + accumulated.usage.inputTokens,
      outputTokens: (restartContext?.outputTokens ?? 0) + accumulated.usage.outputTokens,
      cacheReadTokens: (restartContext?.cacheReadTokens ?? 0) + accumulated.usage.cacheReadTokens,
    };
    if (contractDriftDetected && session.executionPolicy === "frontier") {
      const restartCount = restartContext?.count ?? 0;
      if (restartCount >= MAX_FRONTIER_CONTRACT_RESTARTS) {
        const notice = `Cora Frontier detected more than ${MAX_FRONTIER_CONTRACT_RESTARTS} contract revisions during one turn and stopped to avoid an unstable re-admission loop.`;
        return {
          decision: buildTalkReplyDecision(notice),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          newSessionUuid: session.sessionId,
          ...cumulativeUsage,
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
      });
    }
    let finalText = accumulated.finalText;
    if (!finalText) {
      const last = asRecord(await session.client.request({ type: "get_last_assistant_text" }));
      if (typeof last?.text === "string") finalText = last.text.trim();
    }
    if (accumulated.failure) {
      return {
        decision: buildTalkReplyDecision(finalText || `Cora Pi backend error: ${accumulated.failure}`),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid: session.sessionId,
        ...cumulativeUsage,
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
    const executes = input.chat.mode === "auto" || input.chat.mode === "execute";
    return {
      decision: contractBlocked
        ? buildTalkReplyDecision(reply)
        : executes
        ? buildExecuteDecisionFromToolCalls(accumulated.successfulToolCalls, reply)
        : buildTalkReplyDecision(reply),
      decisionAlreadyApplied: !contractBlocked && executes
        ? executeDecisionWasAppliedDuringTurn(accumulated.successfulToolCalls)
        : undefined,
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      newSessionUuid: session.sessionId,
      ...cumulativeUsage,
      notice: contractBlocked ? "Cora Frontier found a machine-validated contract blocker; repository mutation remained locked." : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = session?.client.diagnostics().stderr.trim();
    const detail = diagnostic ? `${message}\n${diagnostic}` : message;
    onStream?.({ kind: "error", message: detail });
    return {
      decision: buildTalkReplyDecision(`Cora Pi backend error: ${detail}`),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
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
    const session = SESSIONS.get(runId);
    if (!session) return;
    session.interrupted = true;
    GENERATIONS.set(runId, (GENERATIONS.get(runId) ?? 0) + 1);
    session.settleActiveTurn?.();
    void session.client.abort().catch(() => undefined);
  },
} satisfies SparkAgentBackend;
