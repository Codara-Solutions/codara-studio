// Standing terminals: the interactive agent panes `codara_spawn_terminals`
// opens for the user to drive. run-store applies the decision; this module
// builds each pane's launch command and the labels that describe the batch.

import { normalizeCodexModelId } from "@shared/model-catalog";
import { getProvider } from "../providers";
import type { SpawnOpts } from "../providers/types";

export type StandingTerminalRuntime = "claude" | "codex" | "grok" | "pi";

// Effort levels accepted by the current Claude and Codex CLIs for standing
// interactive terminals. GPT-5.6 adds Max as a first-class quality setting;
// both providers receive the explicit choice instead of silently ignoring it.
// Pi takes all of them as `--thinking` levels.
const STANDING_TERMINAL_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Build the launch command for a standing interactive terminal: a plain
// claude/codex session the user drives. Like buildLaunchCommandLine, but
// without the worker-task wiring, since these are not Cora workers.
//
// The CLI-specific argv is produced by the runtime's `CliProvider`
// (see src/main/providers/) so adding a new CLI later only requires a new
// provider file. Pi has no provider: it is not a Cora worker runtime, and a
// pane runs it as the + menu does, the user's own `pi` with their own
// settings, adding only the model and thinking level asked for.
export function buildStandingTerminalCommand(
  runtime: StandingTerminalRuntime,
  model?: string,
  effort?: string,
): string {
  let effectiveEffort: SpawnOpts["effort"];
  if (effort && STANDING_TERMINAL_EFFORTS.has(effort)) {
    effectiveEffort = effort as SpawnOpts["effort"];
  }

  let effectiveModel = model?.trim() || undefined;
  if (runtime === "codex" && effectiveModel) {
    effectiveModel = normalizeCodexModelId(effectiveModel);
  }

  if (runtime === "pi") {
    const args = [
      ...(effectiveModel ? ["--model", effectiveModel] : []),
      ...(effectiveEffort ? ["--thinking", effectiveEffort] : []),
    ];
    return ["pi", ...args.map((arg) => quoteShellArg(arg))].join(" ");
  }

  const provider = getProvider(runtime);
  const providerArgs = provider.buildArgs({
    cwd: "",
    model: effectiveModel,
    effort: effectiveEffort,
  });

  const head = provider.binaryName;
  const tail = providerArgs.map((arg) => quoteShellArg(arg));
  return [head, ...tail].join(" ");
}

function runtimeLabel(runtime: string): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "grok") return "Grok";
  if (runtime === "pi") return "Pi";
  return "Claude";
}

export function standingTerminalTitle(runtime: StandingTerminalRuntime, model?: string): string {
  const base = runtimeLabel(runtime);
  return model ? `${base} ${model}` : base;
}

// One-line chat confirmation for a spawn_terminals decision, e.g. "Opened 2
// Claude and 1 Codex standing terminals ...". Counts by runtime so the user
// gets concrete acknowledgement that the request landed.
export function describeSpawnedTerminals(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label = runtimeLabel(terminal.runtime);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${n} ${label}`);
  const list =
    parts.length <= 1
      ? parts.join("")
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const noun = terminals.length === 1 ? "terminal" : "terminals";
  return `Opened ${list} standing ${noun} in the workbench, yours to prompt and drive directly.`;
}

export function spawnedTerminalsTitle(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label = runtimeLabel(terminal.runtime);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${label} x${n}`);
  if (parts.length === 0) return "Agent terminals";
  return `${parts.join(" + ")} terminals`;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}
