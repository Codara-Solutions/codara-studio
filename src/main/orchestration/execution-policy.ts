import type { CoraExecutionPolicy, RunState } from "@shared/types";
import { normalizeCoraExecutionPolicy } from "@shared/cora-execution-policy";

/**
 * The single source of truth for a run's execution policy.
 *
 * Cora no longer exposes a policy picker: depth is derived from the manager's
 * own `taskComplexity` classification, so the user cannot pay for scrutiny the
 * work does not need or starve work that does. Every consumer (Pi system
 * prompt, Pi session identity, verifier round caps, the run-level verification
 * ceiling, the fast one-rework cap) must read the policy through here so they
 * cannot drift apart.
 *
 * `run.coraExecutionPolicy` survives as a pin, not a preference: pre-picker
 * runs carry it, and non-UI callers (automations) set it deliberately.
 */
export function effectiveRunExecutionPolicy(run: RunState): CoraExecutionPolicy {
  const pinned = normalizeCoraExecutionPolicy(run.coraExecutionPolicy);
  switch (run.taskComplexity) {
    case "complex":
      return "deep";
    case "trivial":
    case "standard":
      return "fast";
    default:
      // Not classified yet (turn 1) or a legacy run: honor whatever is stored.
      return pinned;
  }
}
