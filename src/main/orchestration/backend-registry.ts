// Cora manager backend registry.
//
// Single source of truth for the backends a chat's `chatBackend` field can
// resolve to. Adding a new backend later is one new file + one entry here.
//
// Today: Claude Code (Claude Agent SDK sessions), Codex (app-server JSON-RPC),
// and Pi (the bundled subscription harness, the default). All three expose
// the same SparkAgentBackend interface so the dispatch in run-store doesn't
// change as implementations evolve.

import type { ChatBackendKind } from "@shared/types";
import { claudeBackend } from "./claude-backend";
import { codexBackend } from "./codex-backend";
import { piBackend } from "./pi-backend";
import type { SparkAgentBackend } from "./spark-agent-backend";

const REGISTRY: Record<ChatBackendKind, SparkAgentBackend> = {
  claude: claudeBackend,
  codex: codexBackend,
  pi: piBackend,
};

export function getBackend(kind: ChatBackendKind): SparkAgentBackend {
  const backend = REGISTRY[kind];
  if (!backend) throw new Error(`Unknown Cora manager backend: ${kind}`);
  return backend;
}

export function listBackends(): readonly SparkAgentBackend[] {
  return Object.values(REGISTRY);
}

// End every provider runtime that may still be associated with a run. We fan
// out across the complete registry rather than trusting the run's current
// backend field: a chat can switch providers, and an older provider session may
// still be finishing asynchronous teardown. Each backend is best-effort and
// independent so one broken disposer cannot strand the others.
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
