import { createHash } from "node:crypto";

const CURSOR_VERSION = "m1";
const CURSOR_PATTERN = /^m1\.([0-9a-z]+)\.(e|[0-9a-z]+)\.([A-Za-z0-9_-]{43})$/;

export const CORA_MESSAGE_CURSOR_MAX_LENGTH = 128;

export interface CoraRunMessageDelta {
  afterCursor: string;
  windowStartId: string | null;
  windowEndId: string | null;
  windowCount: number;
}

export interface CoraRunMessageWindowProjection<TMessage extends { id: string }> {
  messages: TMessage[];
  cursor: string;
  delta?: CoraRunMessageDelta & { messages: TMessage[] };
}

export interface ProjectCoraRunMessageWindowInput<TSource, TMessage extends { id: string }> {
  runId: string;
  conversationEpoch: number;
  sourceMessages: readonly TSource[];
  projectMessage: (source: TSource) => TMessage;
  afterCursor?: string;
  maxCount: number;
  maxBytes: number;
}

interface ProjectedEntry<TMessage> {
  sourceIndex: number;
  message: TMessage;
}

interface ProjectedWindow<TMessage> {
  entries: ProjectedEntry<TMessage>[];
  messages: TMessage[];
}

/**
 * Builds the bounded message suffix used by cora.get and, when the caller
 * proves it owns the immediately preceding append-only prefix, the smaller
 * append payload. Cursors are stateless: the digest binds the run, rewind
 * epoch, anchor, and exact prior bounded wire window.
 */
export function projectCoraRunMessageWindow<TSource, TMessage extends { id: string }>(
  input: ProjectCoraRunMessageWindowInput<TSource, TMessage>,
): CoraRunMessageWindowProjection<TMessage> {
  assertProjectionInput(input);
  const current = projectWindow(input, input.sourceMessages.length);
  const currentAnchorIndex = input.sourceMessages.length - 1;
  const cursor = buildCursor(input, currentAnchorIndex);
  const result: CoraRunMessageWindowProjection<TMessage> = {
    messages: current.messages,
    cursor,
  };

  const anchorIndex = validateCursor(input, input.afterCursor);
  if (anchorIndex === null) return result;

  const appended = current.entries
    .filter((entry) => entry.sourceIndex > anchorIndex)
    .map((entry) => entry.message);
  result.delta = {
    afterCursor: input.afterCursor!,
    windowStartId: current.messages[0]?.id ?? null,
    windowEndId: current.messages.at(-1)?.id ?? null,
    windowCount: current.messages.length,
    messages: appended,
  };
  return result;
}

function projectWindow<TSource, TMessage extends { id: string }>(
  input: ProjectCoraRunMessageWindowInput<TSource, TMessage>,
  endExclusive: number,
): ProjectedWindow<TMessage> {
  const entries: ProjectedEntry<TMessage>[] = [];
  let usedBytes = 2;
  for (
    let sourceIndex = endExclusive - 1;
    sourceIndex >= 0 && entries.length < input.maxCount;
    sourceIndex -= 1
  ) {
    const message = input.projectMessage(input.sourceMessages[sourceIndex]);
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (usedBytes + bytes > input.maxBytes) break;
    entries.push({ sourceIndex, message });
    usedBytes += bytes;
  }
  entries.reverse();
  return {
    entries,
    messages: entries.map((entry) => entry.message),
  };
}

function validateCursor<TSource, TMessage extends { id: string }>(
  input: ProjectCoraRunMessageWindowInput<TSource, TMessage>,
  cursor: string | undefined,
): number | null {
  if (!cursor || cursor.length > CORA_MESSAGE_CURSOR_MAX_LENGTH) return null;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) return null;
  const epoch = parseBase36SafeInteger(match[1]);
  const anchorIndex = match[2] === "e" ? -1 : parseBase36SafeInteger(match[2]);
  if (
    epoch === null ||
    epoch !== input.conversationEpoch ||
    anchorIndex === null ||
    anchorIndex < -1 ||
    anchorIndex >= input.sourceMessages.length
  ) {
    return null;
  }
  return buildCursor(input, anchorIndex) === cursor ? anchorIndex : null;
}

function buildCursor<TSource, TMessage extends { id: string }>(
  input: ProjectCoraRunMessageWindowInput<TSource, TMessage>,
  anchorIndex: number,
): string {
  const priorWindow = projectWindow(input, anchorIndex + 1);
  const digest = createHash("sha256");
  digest.update(
    JSON.stringify({
      version: CURSOR_VERSION,
      runId: input.runId,
      conversationEpoch: input.conversationEpoch,
      anchorIndex,
    }),
  );
  for (const message of priorWindow.messages) {
    const serialized = JSON.stringify(message);
    digest.update(`${Buffer.byteLength(serialized, "utf8")}:`);
    digest.update(serialized);
  }
  const anchor = anchorIndex < 0 ? "e" : anchorIndex.toString(36);
  return [
    CURSOR_VERSION,
    input.conversationEpoch.toString(36),
    anchor,
    digest.digest("base64url"),
  ].join(".");
}

function parseBase36SafeInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 36);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed.toString(36) !== value
  ) {
    return null;
  }
  return parsed;
}

function assertProjectionInput<TSource, TMessage extends { id: string }>(
  input: ProjectCoraRunMessageWindowInput<TSource, TMessage>,
): void {
  if (!input.runId) throw new TypeError("runId must not be empty.");
  if (!Number.isSafeInteger(input.conversationEpoch) || input.conversationEpoch < 0) {
    throw new TypeError("conversationEpoch must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.maxCount) || input.maxCount < 0) {
    throw new TypeError("maxCount must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 2) {
    throw new TypeError("maxBytes must be a safe integer of at least 2.");
  }
}
