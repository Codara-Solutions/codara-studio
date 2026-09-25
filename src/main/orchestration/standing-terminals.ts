// Standing terminals: the interactive agent panes `codara_spawn_terminals`
// opens for the user to drive. run-store applies the decision; this module
// builds each pane's launch command and the labels that describe the batch.

import { normalizeCodexModelId } from "@shared/model-catalog";
import { getProvider } from "../providers";
import type { SpawnOpts } from "../providers/types";

// Effort levels accepted by the current Claude and Codex CLIs for standing
// interactive terminals. GPT-5.6 adds Max as a first-class quality setting;
// both providers receive the explicit choice instead of silently ignoring it.
const STANDING_TERMINAL_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Build the launch command for a standing interactive terminal: a plain
// claude/codex session the user drives. Like buildLaunchCommandLine, but
// without the worker-task wiring, since these are not Cora workers.
//
// The CLI-specific argv is produced by the runtime's `CliProvider`
// (see src/main/providers/) so adding a new CLI later only requires a new
// provider file.
export function buildStandingTerminalCommand(
  runtime: "claude" | "codex" | "grok",
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

export function standingTerminalTitle(runtime: "claude" | "codex" | "grok", model?: string): string {
  const base = runtime === "codex" ? "Codex" : runtime === "grok" ? "Grok" : "Claude";
  return model ? `${base} ${model}` : base;
}

// One-line chat confirmation for a spawn_terminals decision, e.g. "Opened 2
// Claude and 1 Codex standing terminals ...". Counts by runtime (claude,
// codex) so the user gets concrete acknowledgement that the request landed.
export function describeSpawnedTerminals(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label =
      terminal.runtime === "codex" ? "Codex" : terminal.runtime === "grok" ? "Grok" : "Claude";
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
    const label =
      terminal.runtime === "codex" ? "Codex" : terminal.runtime === "grok" ? "Grok" : "Claude";
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
