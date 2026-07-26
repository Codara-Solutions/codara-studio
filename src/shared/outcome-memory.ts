export type MemoryVerificationStatus = "verified" | "mixed" | "unverified";

export interface MemoryVerifierObservation {
  taskId: string;
  attemptNumber: number;
  accepted: boolean;
  status: "verified" | "failed" | "unsure";
  claims: Array<{ verdict: string }>;
}

export interface OutcomeMemoryClassification {
  status: MemoryVerificationStatus;
  acceptedVerifierCount: number;
  verifiedClaimCount: number;
  failedClaimCount: number;
  reusable: boolean;
}

/**
 * Classify whether a prior run is safe to reuse as a positive recipe.
 *
 * Retries are reduced to the latest attempt for each verifier task, then only
 * verifier tasks accepted into the final run count. This prevents an early
 * failed retry from poisoning a corrected verifier while also preventing a
 * merely completed implementation from masquerading as independently proven.
 */
export function classifyOutcomeMemory(
  observations: readonly MemoryVerifierObservation[],
): OutcomeMemoryClassification {
  const latestByTask = new Map<string, MemoryVerifierObservation>();
  for (const observation of observations) {
    const previous = latestByTask.get(observation.taskId);
    if (!previous || observation.attemptNumber >= previous.attemptNumber) {
      latestByTask.set(observation.taskId, observation);
    }
  }
  const accepted = [...latestByTask.values()].filter((observation) => observation.accepted);
  let verifiedClaimCount = 0;
  let failedClaimCount = 0;
  for (const observation of accepted) {
    for (const claim of observation.claims) {
      if (claim.verdict === "verified") verifiedClaimCount += 1;
      else if (claim.verdict === "failed") failedClaimCount += 1;
    }
  }

  let status: MemoryVerificationStatus;
  if (accepted.length === 0) {
    status = "unverified";
  } else if (accepted.some((observation) => observation.status !== "verified")) {
    status = "mixed";
  } else {
    status = "verified";
  }
  return {
    status,
    acceptedVerifierCount: accepted.length,
    verifiedClaimCount,
    failedClaimCount,
    reusable: status === "verified",
  };
}
