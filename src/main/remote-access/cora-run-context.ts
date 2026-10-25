/**
 * The context-window gauge Studio's composer pill shows, computed host-side so
 * a remote client's percentage can never drift from the desktop's.
 *
 * This lives outside production.ts, and free of Electron, for one reason: the
 * arithmetic is the whole contract. A source-shape assertion over the
 * projection cannot tell a correct denominator from a swapped ternary, so the
 * byte-contract test bundles this module and runs the real table instead.
 */

import { autoCompactLimitTokens } from "@shared/context-compaction";
import { contextWindowForModel } from "@shared/context-window";
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

/** The inputs a Pi session's limit is priced from, besides its model. */
export interface RemoteCoraRunContextLimits {
  /** AppSettings.coraAutoCompactPercent; null or absent is Auto. */
  percent?: number | null;
  /** The CODARA_PI_COMPACT_AT_TOKENS developer override, when set. */
  overrideTokens?: number | null;
}

// Exactly the four modes askManagerBackend dispatches today,
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
 * Denominator: the limit that turn's session compacts at, priced exactly as
 * the desktop pill's live reading is (pi-turn.ts): the model's window (the one
 * the turn reported, else the catalogue's) with the user's percentage, or the
 * 256k default capped below Pi's own trigger on Auto.
 *
 * Undefined when no turn reported usage — a remote client then shows no gauge,
 * exactly as it would against an older Studio.
 */
export function remoteCoraRunContext(
  run: RemoteCoraRunContextSource,
  limits: RemoteCoraRunContextLimits = {},
): RemoteCoraRunContextGauge | undefined {
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
      const windowTokens =
        typeof entry.contextWindowTokens === "number" && entry.contextWindowTokens > 0
          ? entry.contextWindowTokens
          : contextWindowForModel(entry.model).tokens;
      return {
        usedTokens: Math.floor(reported),
        budgetTokens: autoCompactLimitTokens({
          contextWindowTokens: windowTokens,
          percent: limits.percent,
          overrideTokens: limits.overrideTokens,
        }),
      };
    }
  }
  return undefined;
}
