import type { PendingConversationRewind } from "@shared/types";

export interface ConversationRewindRequestIdentity {
  messagePointer: number;
  messageId?: string;
  checkpointId?: string;
  checkpointIndex?: number;
  scope: "chat" | "chat+code";
}

export interface ConversationRewindTransaction {
  oldEpoch: number;
  newEpoch: number;
  pointer: number;
  checkpointIndex?: number;
  resuming: boolean;
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

/** Resolve a fresh rewind or resume the exact durable transaction that crossed
 * its epoch barrier before a restart. A resumed transaction never advances the
 * epoch again and cannot be redirected to a different transcript/code target. */
export function resolveConversationRewindTransaction(input: {
  conversationEpoch: number;
  messageCount: number;
  pending?: PendingConversationRewind;
  request: ConversationRewindRequestIdentity;
}): ConversationRewindTransaction {
  const { pending, request } = input;
  if (!pending) {
    const pointer = Math.max(0, Math.min(request.messagePointer, input.messageCount));
    return {
      oldEpoch: input.conversationEpoch,
      newEpoch: input.conversationEpoch + 1,
      pointer,
      checkpointIndex: request.checkpointIndex,
      resuming: false,
    };
  }

  if (input.conversationEpoch !== pending.newEpoch) {
    throw new Error(
      `Conversation rewind epoch mismatch: expected ${pending.newEpoch}, found ${input.conversationEpoch}.`,
    );
  }
  if (
    request.messagePointer !== pending.messagePointer ||
    !sameOptional(request.messageId, pending.messageId) ||
    !sameOptional(request.checkpointId, pending.checkpointId) ||
    request.scope !== pending.scope
  ) {
    throw new Error("A different conversation rewind is already pending for this run.");
  }
  if (pending.messagePointer < 0 || pending.messagePointer > input.messageCount) {
    throw new Error("Pending conversation rewind points outside the retained transcript.");
  }

  return {
    oldEpoch: pending.oldEpoch,
    newEpoch: pending.newEpoch,
    pointer: pending.messagePointer,
    checkpointIndex: pending.checkpointIndex,
    resuming: true,
  };
}
