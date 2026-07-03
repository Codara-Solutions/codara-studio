import type { RunState } from "@shared/types";
import type { PaneNode, Tab } from "../tabs/types";

// A live worker pane that the routing menu can address by paneId via
// pty.inject. Includes both Cora-orchestrated workers (which carry a
// runId pointing at the parent chat) and manually-launched claude/codex
// panes (no parent chat, label falls back to "Manual <Runtime>").

export interface OpenWorker {
  // The id we hand to pty.inject. For Cora workers this is the attemptId
  // (== pty session id); for manual panes it is the leaf paneId. Both are
  // registered with main as the same key, so the call site is uniform.
  injectId: string;
  runtime: "claude" | "codex" | "cursor" | "opencode";
  source: "spark" | "manual";
  // chat title (for "Claude · Fix login form") or undefined for manual.
  runLabel?: string;
}

function runtimeName(runtime: OpenWorker["runtime"]): string {
  switch (runtime) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
  }
}

export function workerMenuLabel(worker: OpenWorker): string {
  const name = runtimeName(worker.runtime);
  if (worker.source === "manual" || !worker.runLabel) {
    return `Manual ${name}`;
  }
  return `${name} · ${worker.runLabel}`;
}

function walkLeaves(node: PaneNode, out: OpenWorker[], runs: RunState[]): void {
  if (node.kind === "leaf") {
    const worker = node.worker;
    if (!worker) return;
    // Skip panes whose agent has exited — injecting raw prompt text would
    // land at the shell, not the CLI agent, and quietly corrupt the line.
    if (worker.agentRunning === false) return;
    const runtime = worker.runtime;
    if (runtime !== "claude" && runtime !== "codex" && runtime !== "cursor" && runtime !== "opencode") {
      return;
    }
    const runLabel =
      worker.source === "spark"
        ? runs.find((r) => r.id === worker.runId)?.title ?? undefined
        : undefined;
    out.push({
      injectId: worker.attemptId,
      runtime,
      source: worker.source,
      runLabel,
    });
    return;
  }
  walkLeaves(node.a, out, runs);
  walkLeaves(node.b, out, runs);
}

export function enumerateOpenWorkers(tabs: Tab[], runs: RunState[]): OpenWorker[] {
  const result: OpenWorker[] = [];
  for (const tab of tabs) {
    if (tab.kind === "terminal") walkLeaves(tab.root, result, runs);
  }
  // Stable ordering: Codara-owned panes first (they have richer context),
  // then manual panes; within each, group by runtime, then by label.
  result.sort((a, b) => {
    if (a.source !== b.source) return a.source === "spark" ? -1 : 1;
    if (a.runtime !== b.runtime) return a.runtime.localeCompare(b.runtime);
    return (a.runLabel ?? "").localeCompare(b.runLabel ?? "");
  });
  return result;
}
