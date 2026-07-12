import type {
  SparkManagerDecision,
  SparkManagerTerminalRequest,
} from "./openrouter-manager";

interface CliManagerToolCall {
  toolName: string;
  input: unknown;
}

const MAX_STANDING_TERMINALS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesTool(call: CliManagerToolCall, name: string): boolean {
  return call.toolName === name || call.toolName === `mcp__codara-studio__${name}`;
}

/**
 * Convert a CLI manager's `codara_spawn_terminals` call into the same
 * decision OpenRouter emits. The run-store already owns command construction,
 * tab-grid creation, completion, and the user-facing confirmation.
 */
export function buildSpawnTerminalsDecisionFromToolCalls(
  toolCalls: CliManagerToolCall[],
  chatReply: string,
): SparkManagerDecision | null {
  const call = toolCalls.find((candidate) =>
    matchesTool(candidate, "codara_spawn_terminals"),
  );
  if (!call) return null;

  const input = isRecord(call.input) ? call.input : {};
  const terminals = normalizeCliTerminalRequests(input.terminals);
  if (terminals.length === 0) return null;

  const count = terminals.reduce((sum, terminal) => sum + terminal.count, 0);
  const summary =
    chatReply.trim() ||
    `Opening ${count} standing agent terminal${count === 1 ? "" : "s"}.`;
  return {
    status: "spawn_terminals",
    summary,
    chatReply: chatReply.trim() || undefined,
    terminals,
    steps: [],
    tasks: [],
  };
}

export function normalizeCliTerminalRequests(
  value: unknown,
): SparkManagerTerminalRequest[] {
  if (!Array.isArray(value)) return [];
  const terminals: SparkManagerTerminalRequest[] = [];
  let remaining = MAX_STANDING_TERMINALS;

  for (const item of value) {
    if (remaining <= 0 || !isRecord(item)) break;
    const runtime =
      item.runtime === "claude"
        ? "claude"
        : item.runtime === "codex"
          ? "codex"
          : null;
    if (!runtime) continue;

    const requested =
      typeof item.count === "number" && Number.isFinite(item.count)
        ? Math.floor(item.count)
        : 1;
    const count = Math.min(Math.max(requested, 1), remaining);
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const effort = typeof item.effort === "string" ? item.effort.trim() : "";
    terminals.push({
      runtime,
      count,
      model: model || undefined,
      effort: effort || undefined,
    });
    remaining -= count;
  }

  return terminals;
}
