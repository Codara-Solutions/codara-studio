import type { SparkEvent } from "./types";

// Event types main sends to windows without journaling them (event-log's
// broadcastLiveEvent). They change no run state, so a listener that refetches
// runs or run details on any event must skip them: a running command emits
// one up to four times a second for as long as it runs.
const LIVE_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(["chat.tool_progress"]);

export function isLiveOnlyEvent(event: Pick<SparkEvent, "type">): boolean {
  return LIVE_ONLY_EVENT_TYPES.has(event.type);
}
