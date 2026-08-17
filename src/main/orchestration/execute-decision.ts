// Execute-mode decision synthesis, shared by every Cora manager backend.
//
// The manager's spark_* MCP tool calls execute live as the turn runs; at turn
// end this module folds what actually happened into one SparkManagerDecision —
// the shape the run-store pipeline knows how to apply (open standing
// terminals, spawn workers, ask user, mark complete). Extracted from the
// retired Claude Code manager backend when Pi became the only manager runtime:
// pi-backend still settles every execute/auto turn through these two
// functions.

import type {
  SparkManagerDecision,
  SparkManagerQuestionOption,
  SparkManagerTaskDecision,
} from "./manager-protocol";
import { buildSpawnTerminalsDecisionFromToolCalls } from "./cli-terminal-decision";
import { buildTalkReplyDecision } from "./agent-backend";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Convert the spark_* tool calls the manager made this turn into a
 * SparkManagerDecision — the shape the rest of the run-store pipeline already
 * knows how to apply (open standing terminals, spawn workers, ask user, mark
 * complete).
 *
 * Lookup order: spawn_terminals > complete > spawn_workers > ask_user.
 * Everything else is treated as conversational and produces a chatReply
 * (which usually means the model did something unexpected — the prompt + tool
 * whitelist make this branch unlikely in practice).
 */
export function buildExecuteDecisionFromToolCalls(
  toolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>,
  chatReply: string,
): SparkManagerDecision {
  // Tool name matching tolerates BOTH the MCP-prefixed form
  // (`mcp__codara-studio__codara_spawn_workers`) and the bare name
  // (`codara_spawn_workers`) — providers differ on whether the prefix
  // survives to the surfaced tool name.
  const matches = (call: { toolName: string }, sparkName: string): boolean =>
    call.toolName === sparkName ||
    call.toolName === `mcp__codara-studio__${sparkName}`;

  // Standing terminal requests are decisions, not workers. The MCP handler
  // validates and acknowledges the request; applying this decision is what
  // emits spark.spawn_terminals and opens one persistent split-grid tab. It
  // wins even if a model redundantly calls codara_complete afterwards.
  const terminalDecision = buildSpawnTerminalsDecisionFromToolCalls(
    toolCalls,
    chatReply,
  );
  if (terminalDecision) return terminalDecision;

  // codara_complete wins when present, even alongside codara_spawn_workers.
  // The manager's MCP tool calls executed IN ORDER as the turn ran:
  // spawn_workers fired early (and was already handled by handleOrchestratorSpawnWorkers
  // when it arrived — workers are already created, launched, and possibly
  // accepted), and codara_complete fired at the end as the manager's final
  // intent. If we returned `run_workers` here, applySparkManagerDecision
  // would re-create the same workers as phantom tasks on top of an already-
  // completed run (status="created", never launched), producing the "0/1
  // worker, marked DONE" UI bug. Checking complete first respects the
  // manager's actual closing decision; spawn was already dispatched live.
  const completeCall = toolCalls.find((c) => matches(c, "codara_complete"));
  if (completeCall) {
    const input = isRecord(completeCall.input) ? completeCall.input : {};
    const summary =
      typeof input.summary === "string" && input.summary.trim()
        ? input.summary.trim()
        : chatReply || "Done.";
    return {
      status: "complete",
      summary,
      steps: [],
      tasks: [],
      chatReply: chatReply || summary,
    };
  }

  const spawnCall = toolCalls.find((c) => matches(c, "codara_spawn_workers"));
  if (spawnCall) {
    const input = isRecord(spawnCall.input) ? spawnCall.input : {};
    const workers = Array.isArray(input.workers) ? input.workers : [];
    const tasks: SparkManagerTaskDecision[] = workers
      .map((w) => coerceWorkerSpec(w))
      .filter((t): t is SparkManagerTaskDecision => t !== null);
    return {
      status: "run_workers",
      summary:
        chatReply ||
        `Spawning ${tasks.length} worker${tasks.length === 1 ? "" : "s"}.`,
      steps: [],
      tasks,
      chatReply: chatReply || undefined,
    };
  }

  const askCall = toolCalls.find((c) => matches(c, "codara_ask_user"));
  if (askCall) {
    const input = isRecord(askCall.input) ? askCall.input : {};
    const question = typeof input.question === "string" ? input.question : "";
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    const questionOptions: SparkManagerQuestionOption[] = rawOptions
      .map((opt, idx) => coerceQuestionOption(opt, idx))
      .filter((o): o is SparkManagerQuestionOption => o !== null);
    // The MCP call already ran through the main-process question policy and, for
    // a real blocker, waited for the linked answer before this provider turn
    // resumed. Re-emitting ask_user here would post the same question a second
    // time after the user had answered it. Treat the settled tool call as the
    // turn's conversational outcome unless a later spawn/complete call won above.
    return {
      status: "complete",
      summary: chatReply || question || "Cora resolved a manager question.",
      steps: [],
      tasks: [],
      chatReply: chatReply || undefined,
    };
  }

  // No actionable tool call — surface whatever the model said as a normal
  // chat reply. Happens when the model decided the user's message was a pure
  // read-only question and answered in prose, OR (the bug case) when it
  // refused to delegate despite the prompt. Either way the user sees the
  // reply and can retry or rephrase.
  return buildTalkReplyDecision(
    chatReply || "Cora finished the turn without spawning workers.",
  );
}

/** Whether the winning execute-mode tool was fully handled by its live MCP
 * RPC. spawn_terminals is the exception: its RPC validates the request and the
 * synthesized decision performs the UI mutation. */
export function executeDecisionWasAppliedDuringTurn(
  toolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>,
): boolean {
  const matches = (name: string, expected: string): boolean =>
    name === expected || name === `mcp__codara-studio__${expected}`;
  if (toolCalls.some((call) => matches(call.toolName, "codara_spawn_terminals"))) {
    return false;
  }
  return toolCalls.some((call) =>
    matches(call.toolName, "codara_complete") ||
    matches(call.toolName, "codara_spawn_workers") ||
    matches(call.toolName, "codara_ask_user"),
  );
}

function coerceWorkerSpec(raw: unknown): SparkManagerTaskDecision | null {
  if (!isRecord(raw)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title || !description) return null;
  const runtimePreference =
    raw.runtimePreference === "codex" || raw.runtimePreference === "claude"
      ? raw.runtimePreference
      : "claude";
  const modelHint =
    typeof raw.modelHint === "string" && raw.modelHint.trim()
      ? raw.modelHint.trim()
      : undefined;
  const effortHint =
    typeof raw.effortHint === "string" &&
    ["minimal", "low", "medium", "high", "xhigh", "max"].includes(raw.effortHint)
      ? (raw.effortHint as SparkManagerTaskDecision["effortHint"])
      : undefined;
  const allowedPaths = Array.isArray(raw.allowedPaths)
    ? raw.allowedPaths.filter((p): p is string => typeof p === "string")
    : [];
  const forbiddenPaths = Array.isArray(raw.forbiddenPaths)
    ? raw.forbiddenPaths.filter((p): p is string => typeof p === "string")
    : [];
  const expectedOutputs = Array.isArray(raw.expectedOutputs)
    ? raw.expectedOutputs.filter((p): p is string => typeof p === "string")
    : [];
  const verificationCommands = Array.isArray(raw.verificationCommands)
    ? raw.verificationCommands.filter((p): p is string => typeof p === "string")
    : [];
  const taskClass =
    typeof raw.taskClass === "string" &&
    ["skeleton", "feature", "leaf", "verifier"].includes(raw.taskClass)
      ? (raw.taskClass as SparkManagerTaskDecision["taskClass"])
      : undefined;
  return {
    title,
    description,
    runtimePreference,
    modelHint,
    effortHint,
    allowedPaths,
    forbiddenPaths,
    expectedOutputs,
    verificationCommands,
    canRunParallel: allowedPaths.length > 0,
    conflictsWith: [],
    taskClass,
  };
}

function coerceQuestionOption(
  raw: unknown,
  index: number,
): SparkManagerQuestionOption | null {
  if (!isRecord(raw)) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `opt-${index}`,
    label,
    description:
      typeof raw.description === "string" ? raw.description : label,
    answer:
      typeof raw.answer === "string" && raw.answer.trim() ? raw.answer : label,
    recommended: raw.recommended === true,
  };
}
