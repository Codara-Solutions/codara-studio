// Cora manager backend registry.
//
// Single source of truth for the backends a chat's `chatBackend` field can
// resolve to. Adding a new backend later is one new file + one entry here.
//
// Today: OpenRouter (real), Claude Code (scaffold → OpenRouter passthrough),
// Codex (scaffold → OpenRouter passthrough). The scaffolds expose the same
// SparkAgentBackend interface so the dispatch in run-store doesn't change
// when the real PTY-driven implementations land.

import type { ChatBackendKind } from "@shared/types";
import { openRouterBackend } from "./openrouter-backend";
import { claudeBackend } from "./claude-backend";
import { codexBackend } from "./codex-backend";
import { piBackend } from "./pi-backend";
import type { SparkAgentBackend } from "./spark-agent-backend";

const REGISTRY: Record<ChatBackendKind, SparkAgentBackend> = {
  openrouter: openRouterBackend,
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
