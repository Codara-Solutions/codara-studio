// One subscription to main's agent CLI update state, shared by the worker
// picker and Settings (src/main/agent-cli-updates/). Null in a launch without
// the service (test launches) or before the first read.

import { useSyncExternalStore } from "react";

import type { AgentCliToolId, AgentCliToolStatus, AgentCliUpdatesSnapshot } from "@shared/agent-cli-updates";

import { changedAgentCliTools } from "./agent-cli-text";

let snapshot: AgentCliUpdatesSnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function publish(next: AgentCliUpdatesSnapshot | null): void {
  if (!next) return;
  // A refusal stops being news once the tool moved on (an automatic update ran).
  for (const id of changedAgentCliTools(snapshot, next)) {
    const request = requests.get(id);
    if (request?.error && !request.pending) requests.set(id, IDLE_REQUEST);
  }
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

// Requests in flight from this window, and the last refusal per tool: a
// button or mark stays disabled from the click until main answers.
const requests = new Map<AgentCliToolId, { pending: boolean; error: string | null }>();
const IDLE_REQUEST = { pending: false, error: null } as const;

function setRequest(id: AgentCliToolId, state: { pending: boolean; error: string | null }): void {
  requests.set(id, state);
  for (const listener of listeners) listener();
}

export function useAgentCliRequest(id: AgentCliToolId): { pending: boolean; error: string | null } {
  return useSyncExternalStore(subscribe, () => requests.get(id) ?? IDLE_REQUEST);
}

/** Update now, or as soon as the tool's sessions end. Resolves with an error message, or null. */
export async function requestAgentCliUpdate(id: AgentCliToolId): Promise<string | null> {
  if (requests.get(id)?.pending) return null;
  setRequest(id, { pending: true, error: null });
  try {
    publish(await window.spark.agentCliUpdates.update(id));
    setRequest(id, { pending: false, error: null });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(error);
    setRequest(id, { pending: false, error: message });
    return message;
  }
}

export async function cancelAgentCliUpdate(id: AgentCliToolId): Promise<void> {
  publish(await window.spark.agentCliUpdates.cancel(id).catch(() => null));
}

export async function checkAgentCliUpdates(): Promise<void> {
  publish(await window.spark.agentCliUpdates.check().catch(() => null));
}

export { UPDATE_IN_PROGRESS, agentCliMark, agentCliVersionLine } from "./agent-cli-text";
