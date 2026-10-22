// The task store and the app lookups the socket tools need, as the handlers
// in preview-tools/ reach them. index.ts provides them when main loads it,
// so those handlers never import Electron or the state file and stay
// loadable on their own (the unit suite bundles them).

import type { TaskStore } from "./task-store";

export interface CosService {
  store(): TaskStore;
  /** The workspace's name, or null when no such workspace exists any more. */
  workspaceName(workspaceId: string): Promise<string | null>;
  /** Starts the verify gate for a run the store just opened; never waits for it. */
  startVerify(workspaceId: string, taskId: string, runId: string): void;
}

let service: CosService | null = null;

export function provideCosService(next: CosService): void {
  service = next;
}

export function cosService(): CosService {
  if (!service) throw new Error("Codara's task list is not ready yet.");
  return service;
}
