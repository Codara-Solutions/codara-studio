import type { CoraExecutionPolicy, RunState } from "@shared/types";
import {
  DEFAULT_CORA_EXECUTION_POLICY,
  normalizeCoraExecutionPolicy,
} from "@shared/cora-execution-policy";

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
 * runs carry it, and non-UI callers (frontier smoke scripts, automations) set
 * it deliberately. Frontier is never derived because it additionally requires
 * a discovered verification manifest and the frontier-gate extension, so it
 * stays an explicit opt-in.
 */
export function effectiveRunExecutionPolicy(run: RunState): CoraExecutionPolicy {
  // Only the Pi backend honors the policy. CC/Codex persist the field but
  // ignore it, so clamp them to the default rather than letting a derived
  // deep widen their verification budget.
  if ((run.chatBackend ?? "pi") !== "pi") return DEFAULT_CORA_EXECUTION_POLICY;
  const pinned = normalizeCoraExecutionPolicy(run.coraExecutionPolicy);
  if (pinned === "frontier") return "frontier";
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
