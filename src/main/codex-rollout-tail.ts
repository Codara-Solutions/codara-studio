import { promises as fs } from "node:fs";

// Turn boundaries Codex writes to its session file (rollout-*.jsonl). The
// session file is Codex's own record of every turn, so it is an exact signal
// that needs no config change: `task_complete` carries the turn id and the
// final agent message, and `turn_aborted` marks a turn the user interrupted.
// codex-session-tracker.ts finds which file a pane's Codex process holds.

export type CodexRolloutEvent =
  | { type: "task_started"; turnId: string | null; at: number }
  | { type: "task_complete"; turnId: string | null; at: number; lastAgentMessage: string | null }
  | { type: "turn_aborted"; turnId: string | null; at: number };

const EVENT_TYPES = new Set(["task_started", "task_complete", "turn_aborted"]);

// One rollout line can hold a whole tool output. Only lines that can be one of
// the events above are parsed; everything else is skipped by a substring test.
export function parseCodexRolloutLine(line: string): CodexRolloutEvent | null {
  if (!line.includes("\"event_msg\"")) return null;
  if (!/"(?:task_started|task_complete|turn_aborted)"/.test(line)) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { type?: unknown; timestamp?: unknown; payload?: unknown };
  if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") return null;
  const payload = record.payload as Record<string, unknown>;
  const type = payload.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
  const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : Date.now();
  if (type === "task_complete") {
    const message = payload.last_agent_message;
    return {
      type,
      turnId,
      at,
      lastAgentMessage: typeof message === "string" && message.trim() ? message : null,
    };
  }
  return { type: type as "task_started" | "turn_aborted", turnId, at };
}

// How far back the first read looks. A turn can finish between Codex opening
// its session file and the tracker reporting it; events in this window that
// predate the caller's cutoff are dropped by the caller.
const INITIAL_LOOKBACK_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

export class CodexRolloutTail {
  private offset: number | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private reading = false;

  constructor(readonly path: string) {}

  async poll(): Promise<CodexRolloutEvent[]> {
    if (this.reading) return [];
    this.reading = true;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.path, "r");
      const { size } = await handle.stat();
      let skipFirstLine = false;
      if (this.offset === null) {
        this.offset = Math.max(0, size - INITIAL_LOOKBACK_BYTES);
        skipFirstLine = this.offset > 0;
      }
      if (size < this.offset) {
        // Replaced or truncated: start over at the new end.
        this.offset = size;
        this.partial = Buffer.alloc(0);
        return [];
      }
      if (size === this.offset) return [];
      const length = Math.min(size - this.offset, MAX_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      let data = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
      if (skipFirstLine) {
        const newline = data.indexOf(0x0a);
        data = newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1);
      }
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        this.partial = data.length > MAX_READ_BYTES ? Buffer.alloc(0) : data;
        return [];
      }
      const complete = data.subarray(0, lastNewline).toString("utf8");
      const rest = data.subarray(lastNewline + 1);
      // A line longer than the read cap is a tool output, never an event.
      this.partial = rest.length > MAX_READ_BYTES ? Buffer.alloc(0) : Buffer.from(rest);
      const events: CodexRolloutEvent[] = [];
      for (const line of complete.split("\n")) {
        const event = parseCodexRolloutLine(line);
        if (event) events.push(event);
      }
      return events;
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => undefined);
      this.reading = false;
    }
  }
}
