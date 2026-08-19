// Cora manager backend registry.
//
// Pi is the only manager runtime: the bundled subscription harness drives
// every chat. The registry shape survives (one file + one entry to add a
// backend) because run-store's dispatch goes through getBackend, but today it
// resolves every chat to piBackend. The retired Claude Code and Codex manager
// backends were deleted in 2026-08; persisted runs stamped with those
// backends migrate to "pi" in run-store's normalizeRun.

import type { ChatBackendKind } from "@shared/types";
import { piBackend } from "./pi-backend";
import type { AgentBackend } from "./agent-backend";

const REGISTRY: Record<ChatBackendKind, AgentBackend> = {
  pi: piBackend,
};

export function getBackend(kind: ChatBackendKind): AgentBackend {
  const backend = REGISTRY[kind];
  if (!backend) throw new Error(`Unknown Cora manager backend: ${kind}`);
  return backend;
}

export function listBackends(): readonly AgentBackend[] {
  return Object.values(REGISTRY);
}

// End every provider runtime that may still be associated with a run. We fan
// out across the complete registry rather than trusting the run's current
// backend field: an older provider session may still be finishing
// asynchronous teardown. Each backend is best-effort and independent so one
// broken disposer cannot strand the others.
export async function disposeManagerSessions(runId: string): Promise<void> {
  const backends = listBackends();
  for (const backend of backends) {
    try {
      backend.interruptChat?.(runId);
    } catch {
      // Continue to disposal, and continue through the remaining backends.
    }
  }
  await Promise.all(
    backends.map(async (backend) => {
      try {
        await backend.disposeChat?.(runId);
      } catch {
        // Provider process cleanup is best-effort. Deletion must still be able
        // to remove durable run state after every backend got an attempt.
      }
    }),
  );
}
