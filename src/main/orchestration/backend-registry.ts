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
