// One subscription to main's agent CLI update state, shared by the worker
// picker and Settings (src/main/agent-cli-updates/). Null in a launch without
// the service (test launches) or before the first read.

import { useSyncExternalStore } from "react";

import type { AgentCliToolId, AgentCliToolStatus, AgentCliUpdatesSnapshot } from "@shared/agent-cli-updates";

let snapshot: AgentCliUpdatesSnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function publish(next: AgentCliUpdatesSnapshot | null): void {
  if (!next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function start(): void {
  const api = window.spark?.agentCliUpdates;
  if (started || !api) return;
  started = true;
  void api.status().then(publish, () => undefined);
  api.onChanged(publish);
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentCliUpdates(): AgentCliUpdatesSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useAgentCliTool(id: AgentCliToolId): AgentCliToolStatus | null {
  return useAgentCliUpdates()?.tools.find((tool) => tool.id === id) ?? null;
}

/** Update now, or as soon as the tool's sessions end. Resolves with an error message, or null. */
export async function requestAgentCliUpdate(id: AgentCliToolId): Promise<string | null> {
  try {
    publish(await window.spark.agentCliUpdates.update(id));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(error);
  }
}

export async function cancelAgentCliUpdate(id: AgentCliToolId): Promise<void> {
  publish(await window.spark.agentCliUpdates.cancel(id).catch(() => null));
}

export async function checkAgentCliUpdates(): Promise<void> {
  publish(await window.spark.agentCliUpdates.check().catch(() => null));
}

export const UPDATE_IN_PROGRESS: ReadonlySet<AgentCliToolStatus["phase"]> = new Set(["updating", "verifying", "rolling-back"]);

/** The mark a worker row carries, or null when there is nothing to say. */
export function agentCliMark(tool: AgentCliToolStatus | null): {
  label: string;
  tone: "accent" | "muted" | "warn" | "danger";
  title: string;
  action: "update" | "settings" | null;
} | null {
  if (!tool || !tool.installed) return null;
  if (tool.id === "pi") {
    return tool.version ? { label: `Pinned ${tool.version}`, tone: "muted", title: `Pi ${tool.version}. Codara keeps Pi on the version it is tested with (${tool.pinnedVersion}).`, action: null } : null;
  }
  if (UPDATE_IN_PROGRESS.has(tool.phase)) {
    return { label: tool.phase === "rolling-back" ? "Restoring" : "Updating", tone: "muted", title: tool.message ?? "Updating…", action: null };
  }
  if (tool.phase === "waiting") return { label: "Waiting", tone: "muted", title: tool.message ?? "Waiting for sessions to end.", action: "settings" };
  if (tool.phase === "rolled-back") return { label: "Rolled back", tone: "warn", title: tool.message ?? "", action: "settings" };
  if (tool.phase === "failed") return { label: "Update failed", tone: "danger", title: tool.message ?? "", action: "settings" };
  if (!tool.updateAvailable) return null;
  const title = `${tool.label} ${tool.latestVersion} is out (you have ${tool.version}).`;
  return tool.canUpdate
    ? { label: "Update", tone: "accent", title: `${title} Update now.`, action: "update" }
    : { label: "Update", tone: "accent", title: `${title} Run: ${tool.manualCommand}`, action: "settings" };
}
