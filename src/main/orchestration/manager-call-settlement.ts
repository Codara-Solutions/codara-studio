import type {
  HumanRunMessage,
  RunMessageDeliveryState,
  RunState,
  SparkCall,
} from "@shared/types";
import {
  codaraCompleteReceiptForCall,
  codaraCompleteReceiptKey,
} from "./manager-application-receipts";

export type ManagerCallApplicationProof =
  | {
      kind: "structured-decision-applied";
      /** Caller sets this only after applySparkManagerDecision returns. */
      applicationReady: true;
    }
  | {
      kind: "decision-already-applied";
      /** Exact proof boundary returned by a live orchestration-tool backend. */
      decisionAlreadyApplied: true;
    }
  | {
      kind: "durable-effects-applied";
      /** Exact application-outbox key persisted on this SparkCall. */
      receiptKey: string;
    };

export interface AppliedManagerCallSettlementInput {
  callId: string;
  conversationEpoch: number;
  applicationProof: ManagerCallApplicationProof;
  managerResumeClaimId?: string;
  managerRecoveryClaimId?: string;
  /** Frozen from the accepted recovery before decision application can
   * normalize away its record. */
  managerRecoveryClaimedAccountProfileId?: string;
}

const DELIVERY_RANK: Record<RunMessageDeliveryState, number> = {
  queued: 0,
  submitted: 1,
  acknowledged: 2,
  cancelled: 3,
};

function applicationProofIsReady(
  proof: ManagerCallApplicationProof,
  call: SparkCall,
): boolean {
  if (proof.kind === "structured-decision-applied") {
    return proof.applicationReady === true;
  }
  if (proof.kind === "decision-already-applied") {
    return proof.decisionAlreadyApplied === true;
  }
  const receipt = codaraCompleteReceiptForCall(call);
  return (
    proof.kind === "durable-effects-applied" &&
    proof.receiptKey === codaraCompleteReceiptKey(call.id) &&
    receipt?.key === proof.receiptKey &&
    receipt.state === "effects_applied"
  );
}

function callUsedAccount(call: SparkCall, accountProfileId: string): boolean {
  return (
    call.accountProfileId === accountProfileId ||
    call.nativeClaudeProfileId === accountProfileId ||
    call.nativeCodexProfileId === accountProfileId
  );
}

/**
 * Mutate one run snapshot across the manager-call success boundary.
 *
 * The application proof is intentionally caller-side: this foundational seam
 * does not claim to recover a crash inside decision application. Once the
 * caller has crossed that boundary, however, every delivery/call/claim field
 * below becomes visible together in the one commit that owns this mutator.
 */
export function applyAtomicManagerCallSettlement(
  draft: RunState,
  input: AppliedManagerCallSettlementInput,
  timestamp: string,
): boolean {
  if ((draft.conversationEpoch ?? 0) !== input.conversationEpoch) return false;

  const call = draft.sparkCalls.find(
    (entry) =>
      entry.id === input.callId &&
      (entry.conversationEpoch ?? 0) === input.conversationEpoch,
  );
  if (!call || call.status !== "started" || call.completedAt) return false;
  if (!applicationProofIsReady(input.applicationProof, call)) return false;

  // Claim identity is part of call ownership. Equality includes undefined so
  // a caller cannot accidentally complete a claimed recovery as an ordinary
  // turn and strand its durable token.
  if (call.managerResumeClaimId !== input.managerResumeClaimId) return false;
  if (call.managerRecoveryClaimId !== input.managerRecoveryClaimId) return false;

  if (input.managerResumeClaimId) {
    const pending = draft.pendingManagerResume;
    if (
      pending &&
      (pending.state !== "launching" ||
        pending.launchClaimId !== input.managerResumeClaimId ||
        pending.managerMode !== call.mode)
    ) {
      return false;
    }
  }

  if (input.managerRecoveryClaimId) {
    const recovery = draft.managerTurnRecovery;
    if (
      recovery &&
      (recovery.state !== "resuming" ||
        recovery.resumeClaimId !== input.managerRecoveryClaimId ||
        recovery.conversationEpoch !== input.conversationEpoch ||
        recovery.managerMode !== call.mode ||
        (recovery.resumeAccountProfileId !== undefined &&
          !callUsedAccount(call, recovery.resumeAccountProfileId)) ||
        (input.managerRecoveryClaimedAccountProfileId !== undefined &&
          recovery.resumeAccountProfileId !==
            input.managerRecoveryClaimedAccountProfileId))
    ) {
      return false;
    }
    if (
      input.managerRecoveryClaimedAccountProfileId !== undefined &&
      !callUsedAccount(call, input.managerRecoveryClaimedAccountProfileId)
    ) {
      return false;
    }
  }

  // The SparkCall's frozen id list is the authority. Validate every link
  // before mutating any row, then touch no same-call message omitted from it.
  const inputMessageIds = new Set(call.inputMessageIds ?? []);
  const linkedMessages: HumanRunMessage[] = [];
  for (const messageId of inputMessageIds) {
    const matches = draft.humanMessages.filter((entry) => entry.id === messageId);
    const message = matches[0];
    if (
      matches.length !== 1 ||
      !message ||
      message.author !== "user" ||
      (message.conversationEpoch ?? 0) !== input.conversationEpoch ||
      message.backendTurnId !== call.id
    ) {
      return false;
    }
    linkedMessages.push(message);
  }

  for (const message of linkedMessages) {
    const current = message.deliveryState ?? "queued";
    if (
      current !== "cancelled" &&
      DELIVERY_RANK[current] < DELIVERY_RANK.acknowledged
    ) {
      message.deliveryState = "acknowledged";
    }
  }

  call.status = "completed";
  call.completedAt = timestamp;
  if (input.managerResumeClaimId) delete draft.pendingManagerResume;
  if (input.managerRecoveryClaimId) delete draft.managerTurnRecovery;
  return true;
}
