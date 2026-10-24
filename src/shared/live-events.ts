import type { SparkEvent } from "./types";

// Event types main sends to windows without journaling them (event-log's
// broadcastLiveEvent). They change no run state, so a listener that refetches
// runs or run details on any event must skip them: a running command emits
// one up to four times a second for as long as it runs.
const LIVE_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(["chat.tool_progress"]);

export function isLiveOnlyEvent(event: Pick<SparkEvent, "type">): boolean {
  return LIVE_ONLY_EVENT_TYPES.has(event.type);
}

// Journaled at token cadence while a Cora turn streams: run-store buffers one
// per text delta (appendBufferedEvent) and flushes them every 50 ms. They carry
// reply text for the chat timeline and never change the RunState that
// listRuns returns, so a listener that refetches runs on events skips them
// too. The turn's own state changes (prompt accepted, session, settle, tools)
// still arrive as events of their own.
const STREAM_TEXT_EVENT_TYPES: ReadonlySet<string> = new Set(["chat.assistant_block"]);

export function leavesRunListUnchanged(event: Pick<SparkEvent, "type">): boolean {
  return isLiveOnlyEvent(event) || STREAM_TEXT_EVENT_TYPES.has(event.type);
}
