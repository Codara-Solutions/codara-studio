// Provider registry.
//
// Single source of truth for the CLI providers Spark knows about. Adding a
// new coding CLI is a two-step process:
//
//   1. Create `src/main/providers/<id>.ts` that exports a `CliProvider`
//      (see types.ts for the contract).
//   2. Add it to `PROVIDERS` below. The order here is the order
//      detectAgentRuntimes returns runtimes in, which is also the order
//      they appear in the Settings > Agents picker.
//
// Spark must NOT silently fall back when a caller asks for an unknown
// provider id — the lookup throws so the bug surfaces immediately instead
// of a worker spawning under the wrong runtime.

import type { AgentRuntimeKind } from "@shared/types";

import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { cursorProvider } from "./cursor";

import type { CliProvider } from "./types";

const PROVIDERS: readonly CliProvider[] = [
  claudeProvider,
  codexProvider,
  cursorProvider,
];

/**
 * Return every provider the registry knows about, in the order Settings
 * and runtime diagnostics expect to render them.
 */
export function listProviders(): readonly CliProvider[] {
  return PROVIDERS;
}

/**
 * Look up a provider by its stable id (`AgentRuntimeKind`). Throws when
 * the id doesn't match any registered provider — callers that handle an
 * id they don't recognize should explicitly catch + degrade.
 */
export function getProvider(id: AgentRuntimeKind): CliProvider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown CLI provider id: ${id}`);
  }
  return provider;
}

/**
 * Same as `getProvider` but returns null instead of throwing. Use for
 * defensive code paths (settings migrations, manager decisions parsed
 * from untrusted JSON, etc.).
 */
export function tryGetProvider(id: string): CliProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export type { CliProvider, SpawnOpts, ResumeOpts } from "./types";
