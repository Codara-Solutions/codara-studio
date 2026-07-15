import type { HumanRunMessage, RunState } from "./types";

const NORMALIZE_DUPLICATE_MESSAGE_WINDOW_MS = 120_000;

/** Stable identity for local answer drafts. Removing a resolved question changes
 * the key too, so another surface answering it clears stale text immediately. */
export function runQuestionDraftScopeKey(
  runId: string | undefined,
  questionMessageId: string | undefined,
): string {
  return `${runId ?? ""}::${questionMessageId ?? ""}`;
}

function isQuestion(message: HumanRunMessage): boolean {
  return message.author === "spark" && message.kind === "question";
}

function isLinkedAnswer(message: HumanRunMessage): boolean {
  return (
    message.author === "user" &&
    message.kind === "answer" &&
    Boolean(message.answersMessageId?.trim())
  );
}

/**
 * Backfill old unlinked answer messages without guessing. An answer inherits a
 * question id only when exactly one earlier question is still unresolved at
 * that point in history. Notes never participate.
 */
export function inferLegacyRunAnswerLinks(
  messages: readonly HumanRunMessage[],
): HumanRunMessage[] {
  const unresolved = new Map<string, HumanRunMessage>();
  let changed = false;
  const normalized = messages.map((message) => {
    if (isQuestion(message)) {
      unresolved.set(message.id, message);
      return message;
    }
    if (message.author !== "user" || message.kind !== "answer") return message;

    const explicitQuestionId = message.answersMessageId?.trim();
    if (explicitQuestionId) {
      unresolved.delete(explicitQuestionId);
      return message;
    }
    if (unresolved.size !== 1) return message;

    const questionMessageId = unresolved.keys().next().value as string | undefined;
    if (!questionMessageId) return message;
    unresolved.delete(questionMessageId);
    changed = true;
    return { ...message, answersMessageId: questionMessageId };
  });
  return changed ? normalized : [...messages];
}

/** Narrow migration for the two old direct-Loom answer boxes that persisted a
 * user note instead of a linked answer. The caller enables this only for a
 * blocked, automation-owned direct run with no durable RPC blocker. Within that
 * state, one note is converted only when exactly one unresolved node question
 * exists in that question segment; ambiguous/general notes stay untouched. */
export function inferLegacyDirectLoomNoteAnswerLinks(
  messages: readonly HumanRunMessage[],
): HumanRunMessage[] {
  const normalized = [...messages];
  const unresolved = new Map<string, HumanRunMessage>();
  let segmentNoteIndexes: number[] = [];
  let changed = false;

  const flushSegment = (): void => {
    if (segmentNoteIndexes.length !== 1 || unresolved.size !== 1) {
      segmentNoteIndexes = [];
      return;
    }
    const question = unresolved.values().next().value as HumanRunMessage | undefined;
    const noteIndex = segmentNoteIndexes[0];
    const note = normalized[noteIndex];
    if (
      !question?.loomNodeId ||
      question.clientMessageId ||
      !note ||
      note.author !== "user" ||
      note.kind !== "note"
    ) {
      segmentNoteIndexes = [];
      return;
    }
    normalized[noteIndex] = {
      ...note,
      kind: "answer",
      answersMessageId: question.id,
    };
    unresolved.delete(question.id);
    segmentNoteIndexes = [];
    changed = true;
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index];
    if (isQuestion(message)) {
      flushSegment();
      unresolved.set(message.id, message);
      continue;
    }
    if (isLinkedAnswer(message)) {
      unresolved.delete(message.answersMessageId!.trim());
      continue;
    }
    if (message.author === "user" && message.kind === "note") {
      segmentNoteIndexes.push(index);
    }
  }
  flushSegment();
  return changed ? normalized : [...messages];
}

/**
 * Persisted-message normalization. Message text remains part of the signature,
 * but an answer's linked question id does too: two identical "Allow" answers
 * for different questions are distinct, while a repeated answer to one
 * question still collapses. Distinct client ids likewise keep re-posted
 * questions distinct.
 */
export function dedupeHumanRunMessages(
  messages: readonly HumanRunMessage[],
): HumanRunMessage[] {
  const deduped: HumanRunMessage[] = [];
  const byClientId = new Set<string>();
  const recentBySignature = new Map<string, { at: number }>();

  for (const message of messages) {
    const clientMessageId = message.clientMessageId?.trim();
    if (clientMessageId) {
      if (byClientId.has(clientMessageId)) continue;
      byClientId.add(clientMessageId);
    }

    const at = Date.parse(message.createdAt);
    const linkedIdentity =
      message.kind === "answer"
        ? message.answersMessageId?.trim() ?? ""
        : message.kind === "question"
          // Questions are identities, not prose. Distinct ids must survive even
          // when two Loom nodes ask byte-identical text at the same time.
          ? clientMessageId ?? message.id
          : "";
    const signature = [
      message.author,
      message.kind,
      message.message.replace(/\s+/g, " ").trim().toLowerCase(),
      linkedIdentity,
      message.intent ?? "",
      message.deliveryState ?? "",
      message.targetTurnId ?? "",
      message.backendTurnId ?? "",
      String(message.conversationEpoch ?? 0),
      (message.attachments ?? []).map((attachment) => attachment.id || attachment.path).join("|"),
    ].join("\u0000");
    const recent = recentBySignature.get(signature);
    if (
      recent &&
      Number.isFinite(at) &&
      Number.isFinite(recent.at) &&
      at - recent.at >= 0 &&
      at - recent.at <= NORMALIZE_DUPLICATE_MESSAGE_WINDOW_MS
    ) {
      recent.at = at;
      continue;
    }

    deduped.push(message);
    recentBySignature.set(signature, { at });
  }

  return deduped;
}

export function normalizeHumanRunQuestionMessages(
  messages: readonly HumanRunMessage[],
  options?: { migrateLegacyDirectLoomNotes?: boolean },
): HumanRunMessage[] {
  // Migrate the narrowly-scoped direct-Loom note sequence BEFORE prose-based
  // dedupe. Two successive legacy answers can both be "Allow"; until they gain
  // distinct answersMessageId values they look like duplicate notes and the
  // second answer is lost. General-chat/consent callers never enable this pass.
  const noteMigrated = options?.migrateLegacyDirectLoomNotes
    ? inferLegacyDirectLoomNoteAnswerLinks(messages)
    : [...messages];
  // Pre-dedupe legacy unlinked answer records before inference; otherwise a
  // duplicate unlinked answer can survive as a second, differently-linked row.
  const deduped = dedupeHumanRunMessages(noteMigrated);
  const linked = inferLegacyRunAnswerLinks(deduped);
  // Re-run identity-aware dedupe after links change the answer signature.
  return dedupeHumanRunMessages(linked);
}

/** Questions still unresolved after replaying exact linked answers in order. */
export function unresolvedRunQuestions(
  messages: readonly HumanRunMessage[],
): HumanRunMessage[] {
  const normalized = inferLegacyRunAnswerLinks(dedupeHumanRunMessages(messages));
  const unresolved = new Map<string, HumanRunMessage>();
  for (const message of normalized) {
    if (isQuestion(message)) {
      unresolved.set(message.id, message);
      continue;
    }
    if (isLinkedAnswer(message)) {
      unresolved.delete(message.answersMessageId!.trim());
    }
  }
  return [...unresolved.values()];
}

export function linkedAnswerForQuestion(
  messages: readonly HumanRunMessage[],
  questionMessageId: string,
): HumanRunMessage | null {
  const target = questionMessageId.trim();
  if (!target) return null;
  const normalized = inferLegacyRunAnswerLinks(dedupeHumanRunMessages(messages));
  return (
    normalized.find(
      (message) =>
        message.author === "user" &&
        message.kind === "answer" &&
        message.answersMessageId?.trim() === target,
    ) ?? null
  );
}

/**
 * Resolve the one question the UI should present. A durable blocker is
 * authoritative. Legacy runs fall back to their newest unresolved question,
 * but only while their persisted status says they are waiting for input.
 */
export function resolveOpenRunQuestion(run: RunState): HumanRunMessage | null {
  const unresolved = unresolvedRunQuestions(run.humanMessages);
  if (run.blockedOn) {
    return unresolved.find((message) => message.id === run.blockedOn?.questionMessageId) ?? null;
  }
  if (run.status !== "blocked") return null;
  return unresolved.at(-1) ?? null;
}

/** Resolve the exact still-open question owned by one direct-Loom node. Durable
 * live-RPC blockers may be unstamped, so their exact blocker id wins first. */
export function resolveOpenRunQuestionForLoomNode(
  run: RunState,
  loomNodeId: string | undefined,
): HumanRunMessage | null {
  if (run.status !== "blocked") return null;
  const unresolved = unresolvedRunQuestions(run.humanMessages);
  if (run.blockedOn) {
    const owned = unresolved.find((message) => message.id === run.blockedOn?.questionMessageId);
    if (owned && (!owned.loomNodeId || !loomNodeId || owned.loomNodeId === loomNodeId)) {
      return owned;
    }
    return null;
  }
  for (let index = unresolved.length - 1; index >= 0; index -= 1) {
    const message = unresolved[index];
    if (loomNodeId ? message.loomNodeId === loomNodeId : !message.loomNodeId) return message;
  }
  return loomNodeId ? null : unresolved.at(-1) ?? null;
}

/** Compatibility helper for old addRunMessage(kind="answer") callers. */
export function resolveSingleUnresolvedRunQuestion(run: RunState): HumanRunMessage | null {
  if (run.blockedOn) return resolveOpenRunQuestion(run);
  const unresolved = unresolvedRunQuestions(run.humanMessages);
  return unresolved.length === 1 ? unresolved[0] : null;
}
