import type { ChatBackendKind, CoraExecutionPolicy } from "./types";

export interface CoraExecutionPolicyProfile {
  id: CoraExecutionPolicy;
  label: string;
  shortLabel: string;
  description: string;
  badge: string;
  auditedStateReuse: boolean;
}

export const DEFAULT_CORA_EXECUTION_POLICY: CoraExecutionPolicy = "fast";

export const CORA_EXECUTION_POLICIES: readonly CoraExecutionPolicyProfile[] = [
  {
    id: "fast",
    label: "Fast",
    shortLabel: "Fast",
    description: "Direct Pi execution with proportionate inspection and verification.",
    badge: "Default",
    auditedStateReuse: false,
  },
  {
    id: "deep",
    label: "Deep",
    shortLabel: "Deep",
    description: "Map contracts and interactions first, then falsify the result before finishing.",
    badge: "Thorough",
    auditedStateReuse: false,
  },
  {
    id: "frontier",
    label: "Frontier",
    shortLabel: "Frontier",
    description: "Maximum bounded scrutiny with independent challenge and exact-state audit reuse.",
    badge: "Strongest",
    auditedStateReuse: true,
  },
] as const;

export function normalizeCoraExecutionPolicy(value: unknown): CoraExecutionPolicy {
  return value === "deep" || value === "frontier" ? value : DEFAULT_CORA_EXECUTION_POLICY;
}

export function effectiveCoraExecutionPolicy(
  backend: ChatBackendKind,
  value: unknown,
): CoraExecutionPolicy {
  return backend === "pi"
    ? normalizeCoraExecutionPolicy(value)
    : DEFAULT_CORA_EXECUTION_POLICY;
}

export function coraExecutionPolicyProfile(
  value: unknown,
): CoraExecutionPolicyProfile {
  const normalized = normalizeCoraExecutionPolicy(value);
  return CORA_EXECUTION_POLICIES.find((profile) => profile.id === normalized)!;
}
