/**
 * The context-window gauge Studio's composer pill shows, computed host-side so
 * a remote client's percentage can never drift from the desktop's.
 *
 * This lives outside production.ts, and free of Electron, for one reason: the
 * arithmetic is the whole contract. A source-shape assertion over the
 * projection cannot tell a correct denominator from a swapped ternary, so the
 * byte-contract test bundles this module and runs the real table instead.
 */

import { DEFAULT_PI_COMPACT_AT_TOKENS } from "@shared/context-compaction";
import type { SparkCall } from "@shared/types";

/** Occupancy and the ceiling it is measured against, both in context tokens. */
export interface RemoteCoraRunContextGauge {
  usedTokens: number;
  budgetTokens: number;
}

/** Exactly the run fields the gauge reads; RunState satisfies it structurally. */
export interface RemoteCoraRunContextSource {
  sparkCalls: readonly SparkCall[];
}

// Exactly the four modes askManagerBackend dispatches today (SparkManagerMode),
// every one of them a turn on the manager's OWN conversational session — so the
// occupancy they report is this chat's occupancy. The remaining SparkCall.mode
// members are legacy and never written. A mode that runs against a separate
// session must never be added here: its numbers describe a different context
// window, and the gauge would silently start measuring the wrong conversation.
const MANAGER_TURN_MODES = new Set<SparkCall["mode"]>([
  "plan_analysis",
  "chat",
  "step_planning",
  "worker_result_review",
]);

/**
 * Numerator: `promptTokens ?? promptTokenEstimate` of the newest manager turn
 * that reported either — the provider's own count when there is one, Studio's
 * estimate when the backend reported none. Same preference RunsView's context
 * readout uses.
 *
 * Denominator: Cora's visible 256k product target, exactly matching the
 * desktop ContextPill. Provider-specific safety ceilings remain operational
 * details for auto-compaction; using one here while labelling the desktop
 * gauge 256k made identical usage render as two different percentages.
 *
 * Undefined when no turn reported usage — a remote client then shows no gauge,
 * exactly as it would against an older Studio.
 */
export function remoteCoraRunContext(
  run: RemoteCoraRunContextSource,
): RemoteCoraRunContextGauge | undefined {
  let usedTokens: number | undefined;
  for (let index = run.sparkCalls.length - 1; index >= 0; index -= 1) {
    const entry = run.sparkCalls[index];
    // The auto-compaction summarize call runs against the OUTGOING session, so
    // what it reports is the full pre-compaction transcript. Counting it would
    // pin the gauge near 100% for the entire window between a compaction
    // landing and the next real turn — precisely when the user most needs to
    // see that the chat just got its room back.
    if (entry.purpose === "compaction") continue;
    if (!MANAGER_TURN_MODES.has(entry.mode)) continue;
    const reported = entry.promptTokens ?? entry.promptTokenEstimate;
    if (
      typeof reported === "number" &&
      Number.isFinite(reported) &&
      reported > 0
    ) {
      usedTokens = Math.floor(reported);
      break;
    }
  }
  if (usedTokens === undefined) return undefined;
  return { usedTokens, budgetTokens: DEFAULT_PI_COMPACT_AT_TOKENS };
}
