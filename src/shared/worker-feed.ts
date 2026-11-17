// A worker's own conversation, as data: the tool calls it made, what it wrote
// back, and the messages it was sent while it ran. Main keeps one feed per Pi
// worker attempt (feed.jsonl beside its stdout.log, one record per line) and
// streams new records to the renderer, which draws them with the same rows as
// Cora's own turns. The terminal and its log keep their text copy; this is the
// structured one.

/** The file name of an attempt's feed, in the attempt's own directory. */
export const WORKER_FEED_FILE = "feed.jsonl";

// Every record has its own id, unique within the attempt, so a renderer can
// merge pushes and re-reads by it. A tool call's provider id goes in `call`:
// some providers repeat one ("call_0") for every call.
export type WorkerFeedRecord =
  /** A tool call started. `input` is bounded by boundToolInput. */
  | { k: "tool"; id: string; at: string; call?: string; name: string; input?: unknown }
  /** The result of the latest call with this `call` id that has none yet. */
  | { k: "result"; id: string; at: string; call: string; output: string; error?: true }
  /** One finished assistant message. */
  | { k: "text"; id: string; at: string; text: string }
  /** A message the worker was sent while it ran: by the user, or by Codara (a report reminder). */
  | { k: "steer"; id: string; at: string; text: string; from: "user" | "cora" }
  /** Something about the session rather than from the model: a provider error, a retry, a compaction. */
  | { k: "note"; id: string; at: string; text: string; tone: "info" | "error" }
  /** The feed outgrew its cap and this many earlier steps (calls, replies, messages, notes) were dropped. Always first when present. */
  | { k: "elided"; id: string; at: string; count: number };

export interface WorkerFeedSnapshot {
  /**
   * False when the attempt never kept a feed: an attempt from before feeds
   * existed, or a worker that runs in a plain terminal. The view then falls
   * back to the brief, the report and the raw terminal output.
   */
  available: boolean;
  /** The worker session is running and new records may still arrive. */
  live: boolean;
  records: WorkerFeedRecord[];
  /** The assistant message streaming right now; it becomes a text record when it ends. */
  partial: { id: string; text: string } | null;
}

/** Pushed on the `orchestration:workerFeed` channel. */
export interface WorkerFeedUpdate {
  runId: string;
  attemptId: string;
  records?: WorkerFeedRecord[];
  /** Present when the streaming message changed; null when it ended or was dropped. */
  partial?: { id: string; text: string } | null;
  /** The feed was rewritten (it outgrew its cap, or a new session started): read it again instead of appending. */
  reset?: true;
  /** The worker session ended. */
  ended?: true;
}

export const WORKER_FEED_LIMITS = {
  /** Past this the writer drops the oldest records down to half of it. */
  maxBytes: 1024 * 1024,
  textChars: 20_000,
  outputHeadChars: 3_000,
  outputTailChars: 1_000,
  inputStringChars: 4_000,
  inputJsonChars: 16_000,
  inputArrayItems: 50,
  inputDepth: 5,
  steerChars: 8_000,
  noteChars: 2_000,
} as const;

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A tool result kept head and tail, since a failing command's cause is usually
 * at the end of its output.
 */
export function boundToolOutput(text: string): string {
  const { outputHeadChars: head, outputTailChars: tail } = WORKER_FEED_LIMITS;
  if (text.length <= head + tail + 80) return text;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${dropped.toLocaleString("en-US")} characters not kept …\n${text.slice(-tail)}`;
}

/**
 * Tool arguments with every string, array and nesting level capped, so an
 * edit's old and new text survive for the change preview while a whole-file
 * write cannot grow the feed by megabytes. JSON-safe by construction.
 */
export function boundToolInput(value: unknown): unknown {
  try {
    const bounded = boundValue(value, WORKER_FEED_LIMITS.inputStringChars, 0);
    if ((JSON.stringify(bounded) ?? "").length <= WORKER_FEED_LIMITS.inputJsonChars) return bounded;
    const tighter = boundValue(value, 400, 0);
    const tighterJson = JSON.stringify(tighter) ?? "";
    if (tighterJson.length <= WORKER_FEED_LIMITS.inputJsonChars) return tighter;
    // Wide rather than long: many fields or items. The call's shape is lost but its text is kept.
    return clipText(tighterJson, WORKER_FEED_LIMITS.inputJsonChars);
  } catch {
    // A getter that throws, or a BigInt: the call is kept without its input.
    return undefined;
  }
}

function boundValue(value: unknown, maxString: number, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipText(value, maxString);
  if (typeof value !== "object") return value === undefined ? undefined : String(value);
  if (depth >= WORKER_FEED_LIMITS.inputDepth) return "…";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, WORKER_FEED_LIMITS.inputArrayItems)
      .map((item) => boundValue(item, maxString, depth + 1));
    if (value.length > items.length) items.push(`… ${value.length - items.length} more`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const bounded = boundValue(item, maxString, depth + 1);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

export function isWorkerFeedRecord(value: unknown): value is WorkerFeedRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.at !== "string") return false;
  switch (record.k) {
    case "tool":
      return typeof record.name === "string";
    case "result":
      return typeof record.call === "string" && typeof record.output === "string";
    case "text":
      return typeof record.text === "string";
    case "steer":
      return typeof record.text === "string" && (record.from === "user" || record.from === "cora");
    case "note":
      return typeof record.text === "string" && (record.tone === "info" || record.tone === "error");
    case "elided":
      return typeof record.count === "number";
    default:
      return false;
  }
}

/**
 * Records from a feed file. A line that does not parse is skipped: the last
 * one can be half written when Studio quit mid-append.
 */
export function parseWorkerFeed(text: string): WorkerFeedRecord[] {
  const records: WorkerFeedRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isWorkerFeedRecord(value)) records.push(value);
    } catch {
      // A torn line.
    }
  }
  return records;
}

export function workerFeedRecordKey(record: WorkerFeedRecord): string {
  return `${record.k}:${record.id}`;
}

/** Appends the records not already present, in order. */
export function mergeWorkerFeedRecords(
  existing: readonly WorkerFeedRecord[],
  incoming: readonly WorkerFeedRecord[],
): WorkerFeedRecord[] {
  if (incoming.length === 0) return existing as WorkerFeedRecord[];
  const seen = new Set(existing.map(workerFeedRecordKey));
  const merged = existing.slice();
  for (const record of incoming) {
    const key = workerFeedRecordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged;
}

/** One thing to draw, in the order it happened. Tool entries carry their result. */
export type WorkerFeedEntry =
  | { kind: "text"; id: string; at: string; text: string; streaming?: true }
  | {
      kind: "tool";
      id: string;
      at: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      output?: string;
      isError?: boolean;
    }
  | { kind: "steer"; id: string; at: string; text: string; from: "user" | "cora" }
  | { kind: "note"; id: string; at: string; text: string; tone: "info" | "error" }
  | { kind: "elided"; id: string; at: string; count: number };

export function foldWorkerFeed(
  feed: Pick<WorkerFeedSnapshot, "records" | "partial">,
): WorkerFeedEntry[] {
  const entries: WorkerFeedEntry[] = [];
  // Calls still waiting for a result, by provider call id, oldest first.
  const open = new Map<string, Array<Extract<WorkerFeedEntry, { kind: "tool" }>>>();
  for (const record of feed.records) {
    switch (record.k) {
      case "tool": {
        const entry: Extract<WorkerFeedEntry, { kind: "tool" }> = {
          kind: "tool",
          id: `tool:${record.id}`,
          at: record.at,
          toolUseId: record.id,
          toolName: record.name,
          input: record.input,
        };
        if (record.call) open.set(record.call, [...(open.get(record.call) ?? []), entry]);
        entries.push(entry);
        break;
      }
      case "result": {
        // The latest open call with that id: a provider that repeats ids runs
        // its calls one at a time. A result whose call was dropped with the
        // oldest records has nothing to attach to.
        const waiting = open.get(record.call);
        const tool = waiting?.pop();
        if (!tool) break;
        tool.output = record.output;
        if (record.error) tool.isError = true;
        break;
      }
      case "text":
        if (record.text.trim()) entries.push({ kind: "text", id: `text:${record.id}`, at: record.at, text: record.text });
        break;
      case "steer":
        entries.push({ kind: "steer", id: `steer:${record.id}`, at: record.at, text: record.text, from: record.from });
        break;
      case "note":
        entries.push({ kind: "note", id: `note:${record.id}`, at: record.at, text: record.text, tone: record.tone });
        break;
      case "elided":
        entries.push({ kind: "elided", id: `elided:${record.id}`, at: record.at, count: record.count });
        break;
    }
  }
  const partial = feed.partial;
  // A late partial update can arrive after the record it turned into.
  const settled = partial && feed.records.some((record) => record.k === "text" && record.id === partial.id);
  if (partial && partial.text.trim() && !settled) {
    const last = feed.records[feed.records.length - 1];
    entries.push({
      kind: "text",
      id: `text:${partial.id}`,
      at: last?.at ?? new Date(0).toISOString(),
      text: partial.text,
      streaming: true,
    });
  }
  return entries;
}

/**
 * What a live worker is doing right now, in a few words: the chat's agents
 * rail shows it for every running worker at once. The main process keeps one
 * per live feed and pushes it only when it changes, so the renderer never
 * holds a feed per worker to know this.
 */
export type WorkerActivityStep =
  | { kind: "tool"; tool: string; target?: string }
  | { kind: "reply" }
  | { kind: "thinking" };

export interface WorkerActivity {
  runId: string;
  attemptId: string;
  /** Rises with every change across all workers: the newer of two copies wins. */
  seq: number;
  at: string;
  /** Null once the worker's session ended. */
  step: WorkerActivityStep | null;
}

export const WORKER_ACTIVITY_CHANNEL = "orchestration:workerActivity";

const ACTIVITY_TARGET_KEYS = ["path", "file_path", "filePath", "filename", "notebook_path", "command", "pattern", "query", "url"];
const ACTIVITY_PATH_KEYS = new Set(["path", "file_path", "filePath", "filename", "notebook_path"]);

/**
 * The one thing a tool call acts on, short: a file's name, a command, a search
 * or a page. Only these few fields leave the main process, never the input.
 */
export function workerActivityTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  for (const key of ACTIVITY_TARGET_KEYS) {
    const candidate = value[key];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const flat = candidate.replace(/\s+/g, " ").trim();
    const text = ACTIVITY_PATH_KEYS.has(key) ? flat.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? flat : flat;
    return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
  }
  return undefined;
}
