import { normalizeSearchQuery } from "./conversation-search";

// What a finished Cora turn keeps on screen and what it folds behind its
// "Worked for Ns" line. The rules follow T3 Code (github.com/pingdotgg/t3code,
// MIT, by Theo / Ping Labs): tool work and the narration between it fold, the
// answer stays. The code is Codara's own.

export type TurnFoldSegment =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: { toolName: string; isError?: boolean } }
  | { kind: "error" };

export interface SettledTurnFold<T> {
  /** Behind the fold until it is opened. Empty when the turn has nothing to fold. */
  hidden: T[];
  /** On screen while the fold is closed. */
  kept: T[];
}

/**
 * `answerBelow` says the durable final answer renders as its own message under
 * this turn. Without it, a closing text segment is the only answer the reader
 * has, so it stays. An error or a failed tool call always stays: a failure must
 * never need a click to be seen. A turn without a tool call has no work to fold.
 */
export function splitSettledTurn<T extends TurnFoldSegment>(
  segments: readonly T[],
  answerBelow: boolean,
): SettledTurnFold<T> {
  const lastIndex = segments.length - 1;
  const keepsClosingText = !answerBelow && segments[lastIndex]?.kind === "text";
  const stays = (segment: T, index: number) =>
    segment.kind === "error" ||
    (segment.kind === "tool" && segment.call.isError === true) ||
    (keepsClosingText && index === lastIndex);
  const hidden = segments.filter((segment, index) => !stays(segment, index));
  if (!hidden.some((segment) => segment.kind === "tool")) return { hidden: [], kept: [...segments] };
  return { hidden, kept: segments.filter(stays) };
}

/** Whether find's match lies behind the fold, over the same text find searches. */
export function foldHoldsMatch(hidden: readonly TurnFoldSegment[], query: string): boolean {
  const needle = normalizeSearchQuery(query);
  if (!needle) return false;
  return hidden.some((segment) => {
    if (segment.kind === "text") return segment.text.toLowerCase().includes(needle);
    if (segment.kind === "tool") return segment.call.toolName.toLowerCase().includes(needle);
    return false;
  });
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

/** T3 Code's limits for folding a long user message behind "Show full message". */
export function shouldCollapseUserMessage(text: string): boolean {
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}
