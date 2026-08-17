// Provider registry.
//
// Single source of truth for the CLI providers Codara knows about.
//
//   1. Create `src/main/providers/<id>.ts` that exports a `CliProvider`
//      (see types.ts for the contract).
//   2. Add it to `PROVIDERS` below.
//
// Codara must NOT silently fall back when a caller asks for an unknown
// provider id — the lookup throws so the bug surfaces immediately instead
// of a worker spawning under the wrong runtime.

import type { AgentRuntimeKind } from "@shared/types";

import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";

import type { CliProvider } from "./types";

type OrchestrationCliProvider = CliProvider & { id: AgentRuntimeKind };

const PROVIDERS: readonly CliProvider[] = [claudeProvider, codexProvider];

function isOrchestrationProvider(
  provider: CliProvider,
): provider is OrchestrationCliProvider {
  return provider.id === "claude" || provider.id === "codex";
}

/**
 * Return only providers supported by Cora orchestration.
 */
export function listProviders(): readonly OrchestrationCliProvider[] {
  return PROVIDERS.filter(isOrchestrationProvider);
}

/**
 * Look up a provider by its stable id (`AgentRuntimeKind`). Throws when
 * the id doesn't match any registered provider — callers that handle an
 * id they don't recognize should explicitly catch + degrade.
 */
export function getProvider(id: AgentRuntimeKind): CliProvider {
  const provider = listProviders().find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown CLI provider id: ${id}`);
  }
  return provider;
}

export type { CliProvider, SpawnOpts, ResumeOpts } from "./types";
