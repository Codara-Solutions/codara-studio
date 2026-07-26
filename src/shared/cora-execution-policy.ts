import type { CoraExecutionPolicy } from "./types";

// Storage-level helpers only. The policy is no longer user-selectable, so the
// labels/descriptions that fed the composer picker are gone; the effective
// policy for a run is derived in main by effectiveRunExecutionPolicy.
export const DEFAULT_CORA_EXECUTION_POLICY: CoraExecutionPolicy = "fast";

export function normalizeCoraExecutionPolicy(value: unknown): CoraExecutionPolicy {
  return value === "deep" || value === "frontier" ? value : DEFAULT_CORA_EXECUTION_POLICY;
}
