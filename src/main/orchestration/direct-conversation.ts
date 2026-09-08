import type { HumanRunMessage, RunState } from "@shared/types";
import { renderBundledManagerInput } from "./agent-backend";

// Direct turns use fresh worker sessions. Compact their durable dialogue before
// replay grows expensive, independently of Pi's single-session context ceiling.
export const DIRECT_REPLAY_COMPACT_CHARS = 48_000;

export function directConversationMessages(
  run: RunState,
  inputMessages: HumanRunMessage[] = [],
): HumanRunMessage[] {
  const selected = new Set(inputMessages.map((message) => message.id));
  const summaryIndex = run.compactionEpoch === (run.conversationEpoch ?? 0)
    ? run.humanMessages.findIndex((message) => message.id === run.compactionSummaryMessageId)
    : -1;
  return run.humanMessages.slice(Math.max(0, summaryIndex)).filter((message) =>
    !selected.has(message.id) &&
    (message.author === "user" || message.author === "spark") &&
    message.kind !== "assistant_stream" &&
    message.deliveryState !== "cancelled" &&
    message.deliveryState !== "queued" &&
    !message.resumeNote && !message.boardNote &&
    message.message.trim().length > 0,
  );
}

export function directConversationNeedsCompaction(run: RunState, inputMessages: HumanRunMessage[]): boolean {
  return directConversationMessages(run, inputMessages)
    .reduce((total, message) => total + message.message.length, 0) >= DIRECT_REPLAY_COMPACT_CHARS;
}

export function buildDirectTurnPrompt(run: RunState, inputMessages: HumanRunMessage[]): string {
  const current = renderBundledManagerInput(inputMessages);
  const history = directConversationMessages(run, inputMessages);
  if (history.length === 0) return current;
  return [
    "[CORA CONVERSATION CONTEXT: prior user requests and Cora replies. Apply later corrections to earlier requirements.]",
    ...history.map((message) => `${message.compaction ? "Continuation summary" : message.author === "user" ? "User" : "Cora"}: ${message.message.trim()}`),
    "[END CORA CONVERSATION CONTEXT]",
    "",
    "[CURRENT USER REQUEST]",
    current,
  ].join("\n\n");
}

export function directCompactionInput(run: RunState, instruction: string): string {
  return buildDirectTurnPrompt(run, [{
    id: "compaction-instruction", runId: run.id, author: "user", kind: "note",
    message: instruction, createdAt: run.updatedAt,
  }]);
}

export function directCompactionSnapshotStillCurrent(before: RunState, after: RunState): boolean {
  const ids = new Set(before.humanMessages.filter((message) => message.author === "user").map((message) => message.id));
  return !after.humanMessages.some((message) => message.author === "user" && !ids.has(message.id)) &&
    !after.workerAttempts.some((attempt) => ["preparing", "prompt_ready", "launching", "running", "finishing"].includes(attempt.status));
}
