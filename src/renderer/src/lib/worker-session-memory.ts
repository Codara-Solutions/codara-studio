import type {
  WorkerSessionMemoryScope,
  WorkerSessionRuntime,
} from "@shared/types";

export interface WorkerSessionMemoryDeleteOption {
  label: string;
  detail: string;
}

/**
 * Memory is broader than one transcript, so session deletion keeps it unless
 * the runtime has a well-defined, explicitly described scope. Grok manages
 * its optional global/workspace memory separately through /memory; deleting a
 * Grok chat must not silently turn into a Codex-wide purge.
 */
export function workerSessionMemoryDeleteOption(
  runtime: WorkerSessionRuntime,
): WorkerSessionMemoryDeleteOption | null {
  if (runtime === "claude") {
    return {
      label: "Also delete this Claude project's auto-memory",
      detail:
        "Also delete this Claude project's auto-memory. This affects every Claude session sharing that project memory.",
    };
  }
  if (runtime === "codex") {
    return {
      label: "Also delete ALL local Codex memories",
      detail:
        "Also delete ALL local Codex memories. This affects every Codex project and session on this machine.",
    };
  }
  return null;
}

export function workerSessionMemoryScope(
  runtime: WorkerSessionRuntime,
  selected: boolean,
): WorkerSessionMemoryScope {
  if (!selected) return "none";
  if (runtime === "claude") return "claude-project";
  if (runtime === "codex") return "codex-all";
  return "none";
}
