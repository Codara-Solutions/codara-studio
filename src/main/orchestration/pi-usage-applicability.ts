import type { PiUsageProfile, PiUsageWindow } from "@shared/types";

export type PiUsageWorkload =
  | { kind: "agent"; modelId: string }
  | { kind: "code_review" };

export interface PiUsageEvaluation {
  headroomPercent: number | null;
  limitReached: boolean;
  coverage: "complete" | "partial" | "unknown";
  relevantWindows: PiUsageWindow[];
}

function canonicalModelId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Evaluate only the quota windows that can actually constrain this workload.
 * Unknown model/metered mappings reduce confidence; they never become an
 * account-wide limit through label guessing.
 */
export function evaluateUsageForWorkload(
  profile: PiUsageProfile | undefined,
  workload: PiUsageWorkload,
): PiUsageEvaluation {
  if (!profile || profile.status !== "ok") {
    return {
      headroomPercent: null,
      limitReached: false,
      coverage: "unknown",
      relevantWindows: [],
    };
  }

  const relevantWindows: PiUsageWindow[] = [];
  let partial = false;
  const modelId =
    workload.kind === "agent" ? canonicalModelId(workload.modelId) : "";

  for (const window of profile.windows) {
    const scope = window.scope ?? { kind: "general" as const };
    if (scope.kind === "general") {
      relevantWindows.push(window);
      continue;
    }
    if (scope.kind === "code_review") {
      if (workload.kind === "code_review") relevantWindows.push(window);
      continue;
    }
    if (scope.kind === "model") {
      if (workload.kind !== "agent") continue;
      if (scope.modelId) {
        if (canonicalModelId(scope.modelId) === modelId) {
          relevantWindows.push(window);
        }
      } else {
        partial = true;
      }
      continue;
    }
    // Provider metered-feature identifiers are not model identifiers. Until
    // catalog metadata supplies an exact mapping, applying or ignoring them
    // with certainty would both be guesses.
    partial = true;
  }

  const finite = relevantWindows.filter(
    (window) =>
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent >= 0 &&
      window.remainingPercent <= 100,
  );
  const headroomPercent =
    finite.length > 0
      ? Math.min(...finite.map((window) => window.remainingPercent))
      : null;
  const windowLimitReached = finite.some(
    (window) => window.usedPercent >= 100 || window.remainingPercent <= 0,
  );
  const generalLimitReached =
    workload.kind === "agent" && profile.generalLimitReached === true;

  return {
    headroomPercent,
    limitReached: windowLimitReached || generalLimitReached,
    coverage:
      finite.length === 0 ? (partial ? "partial" : "unknown") : partial ? "partial" : "complete",
    relevantWindows: finite.map((window) => ({
      ...window,
      ...(window.scope ? { scope: { ...window.scope } } : {}),
    })),
  };
}
