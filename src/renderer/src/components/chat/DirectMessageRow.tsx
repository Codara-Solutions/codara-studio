import { USER_BUBBLE_STYLE } from "./ChatConversation";
import Markdown from "./Markdown";
import type { WorkerRow } from "./worker-view";

/**
 * A message in a direct turn's work. Only the user's messages are bubbles;
 * Studio's own word to the worker (a report it asked again for) is a quiet
 * note, labelled as the worker view labels it.
 */
export default function DirectMessageRow({ row }: { row: Extract<WorkerRow, { kind: "message" }> }) {
  if (row.from === "cora") {
    return (
      <div className="cora-direct-turn__note" data-worker-message="cora" style={{ fontSize: 12, color: "var(--muted)" }}>
        <span style={{ fontWeight: 600 }}>Codara: </span>
        {row.text}
      </div>
    );
  }
  return (
    <div data-worker-message="user" style={{ alignSelf: "flex-end", maxWidth: "80%", ...USER_BUBBLE_STYLE }}>
      <Markdown text={row.text} />
    </div>
  );
}
