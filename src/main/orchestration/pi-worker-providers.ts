// Worker assignability: which providers Cora may actually send workers to.
//
// Every autonomous Cora worker runs on the bundled Pi harness. A worker
// therefore needs a connected Pi SUBSCRIPTION for
// its provider, not a `claude` or `codex` binary on PATH. The runtimePreference
// the manager sets is a provider selector: claude means Anthropic, codex means
// OpenAI.
//
// AgentRuntimeDiagnostic.installed keeps its original meaning (the CLI binary
// resolves) because several surfaces genuinely govern the real binaries: the
// claude/codex manager chat backends, agent terminal sessions, and the MCP
// builtin installer that writes into the CLIs' own config. This module adds a
// SEPARATE signal for worker assignment rather than redefining that one.
//
// Nothing here can mutate credentials. The auth store is read through
// inspectPiAccountProfileAuthStore, which stats and parses the mode-600 files
// and never performs an OAuth refresh: a refresh would rotate the stored
// refresh token and sign the real app out.

import type {
  AgentRuntimeDiagnostic,
  PiSubscriptionProvider,
  WorkerRuntime,
} from "@shared/types";

import { detectAgentRuntimes } from "../agent-runtimes";
import { inspectPiAccountProfileAuthStore } from "./pi-account-auth-store";

/** The two autonomous runtimePreference values, and the provider each selects. */
export const PI_PROVIDER_FOR_WORKER_RUNTIME = {
  claude: "anthropic",
  codex: "openai-codex",
} as const satisfies Record<"claude" | "codex", PiSubscriptionProvider>;

export function piProviderForWorkerRuntime(
  runtime: WorkerRuntime,
): PiSubscriptionProvider | null {
  if (runtime === "claude" || runtime === "codex") {
    return PI_PROVIDER_FOR_WORKER_RUNTIME[runtime];
  }
  return null;
}

export interface PiProfileAuthStatusLike {
  provider: PiSubscriptionProvider;
  connected: boolean;
  expired: boolean;
  canRefresh?: boolean;
}

/**
 * One profile is usable when its credential is present and either unexpired or
 * refreshable. An expired-but-refreshable credential still launches: Pi
 * refreshes it itself at session start. This mirrors the predicate the
 * accounts surfaces already use (subscription-profile-projection and
 * agent-socket's account selection), so a provider cannot look assignable here
 * and unusable there.
 */
export function isUsablePiProfileStatus(status: PiProfileAuthStatusLike): boolean {
  return status.connected && (!status.expired || status.canRefresh === true);
}

/** The providers with at least one usable subscription profile. */
export function usablePiProviders(
  statuses: readonly PiProfileAuthStatusLike[],
): Set<PiSubscriptionProvider> {
  const usable = new Set<PiSubscriptionProvider>();
  for (const status of statuses) {
    if (isUsablePiProfileStatus(status)) usable.add(status.provider);
  }
  return usable;
}

/**
 * Stamp `workerAssignable` onto each diagnostic. Workers run on the Pi
 * harness, so assignability is the subscription, not an installed CLI.
 *
 * shell and manual are human-assisted escape hatches with no provider, so they
 * keep whatever `installed` already said about them.
 */
export function applyWorkerAssignability(
  diagnostics: readonly AgentRuntimeDiagnostic[],
  usableProviders: ReadonlySet<PiSubscriptionProvider>,
): AgentRuntimeDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const provider = piProviderForWorkerRuntime(diagnostic.kind as WorkerRuntime);
    if (provider === null) {
      return { ...diagnostic, workerAssignable: diagnostic.installed };
    }
    return {
      ...diagnostic,
      workerAssignable: usableProviders.has(provider),
    };
  });
}

/**
 * Diagnostics decorated for worker assignment. Read-only: it inspects stored
 * credential state and never refreshes, logs, or returns secret material.
 *
 * A failed auth read degrades to the historical CLI-presence behaviour rather
 * than reporting nothing assignable, because the latter would silently reroute
 * every worker in the run to `manual`.
 */
export async function detectWorkerAssignableRuntimes(): Promise<AgentRuntimeDiagnostic[]> {
  const diagnostics = await detectAgentRuntimes().catch(() => []);
  if (diagnostics.length === 0) return [];
  try {
    const inspection = await inspectPiAccountProfileAuthStore();
    return applyWorkerAssignability(
      diagnostics,
      usablePiProviders(inspection.statuses),
    );
  } catch {
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      workerAssignable: diagnostic.installed,
    }));
  }
}

/** True when Cora may assign a worker to this runtimePreference. */
export function isWorkerAssignable(
  diagnostics: readonly AgentRuntimeDiagnostic[],
  kind: WorkerRuntime,
): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.kind === kind && (diagnostic.workerAssignable ?? diagnostic.installed),
  );
}
