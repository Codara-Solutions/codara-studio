// The two ways code reports a feature use to the feature tips tracker
// (FeatureTipsHost). Kept free of React and of the catalog so any module,
// the keyboard dispatcher included, can import it for nothing.

import { COMMAND_RAN_EVENT, FEATURE_USED_EVENT } from "@shared/feature-tip-events";

/**
 * Records that the feature with this catalog id was used. Never throws: a
 * feature's own code calls it inline, and a missing tracker (a unit test's
 * stub window, a page without the host) must not break that feature.
 */
export function recordFeatureUse(id: string): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent(FEATURE_USED_EVENT, { detail: { id } }));
  } catch {
    /* the tip tracker is best-effort */
  }
}

/** Called by the keyboard dispatcher after a command's handler ran. */
export function noteCommandRan(id: string): void {
  window.dispatchEvent(new CustomEvent(COMMAND_RAN_EVENT, { detail: { id } }));
}
