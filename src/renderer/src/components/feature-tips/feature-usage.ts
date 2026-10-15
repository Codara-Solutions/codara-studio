// The two ways code reports a feature use to the feature tips tracker
// (FeatureTipsHost). Kept free of React and of the catalog so any module,
// the keyboard dispatcher included, can import it for nothing.

import { COMMAND_RAN_EVENT, FEATURE_USED_EVENT } from "@shared/feature-tip-events";

/** Records that the feature with this catalog id was used. */
export function recordFeatureUse(id: string): void {
  window.dispatchEvent(new CustomEvent(FEATURE_USED_EVENT, { detail: { id } }));
}

/** Called by the keyboard dispatcher after a command's handler ran. */
export function noteCommandRan(id: string): void {
  window.dispatchEvent(new CustomEvent(COMMAND_RAN_EVENT, { detail: { id } }));
}
