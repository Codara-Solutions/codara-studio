interface ToolResult { content?: Array<Record<string, unknown>>; isError?: boolean }

/** A bounded follow-up prevents a draft write from silently ending the turn. */
export function createWhiteboardReviewGuard() {
  let pendingRevision: number | null = null;
  let reminders = 0;
  let completionBlocks = 0;
  return {
    reset() { pendingRevision = null; reminders = 0; completionBlocks = 0; },
    observe(name: string, result: ToolResult) {
      if (result.isError) return;
      if (!["codara_whiteboard_update", "codara_whiteboard_arrange", "codara_whiteboard_review"].includes(name)) return;
      for (const block of result.content ?? []) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        try {
          const value = JSON.parse(block.text);
          if (!value.ok || !("whiteboard" in value)) continue;
          const board = value.whiteboard;
          if (!board || board.review?.revision === board.revision) pendingRevision = null;
          else if (typeof board.revision === "number") pendingRevision = board.revision;
        } catch { /* Other text blocks do not carry board state. */ }
      }
    },
    completionBlock() {
      if (pendingRevision === null || reminders >= 2 || completionBlocks >= 2) return null;
      completionBlocks += 1;
      return "The whiteboard is still a draft. Inspect its rendered image, correct issues, and review the current revision before completing. If verification is unavailable, disclose that limitation and leave the board as a draft.";
    },
    followUp() {
      if (pendingRevision === null || reminders >= 2) return null;
      reminders += 1;
      return `Whiteboard revision ${pendingRevision} is still a draft. Read the current board, inspect its rendered image with codara_whiteboard_inspect, fix issues, and call codara_whiteboard_review for the final revision. If capture or verification is unavailable, state that the board remains a draft and name the limitation; do not retry failed capture repeatedly. This follow-up is bounded.`;
    },
  };
}
