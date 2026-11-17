import { promises as fs } from "node:fs";
import { BrowserWindow } from "electron";

import {
  WORKER_FEED_LIMITS,
  boundToolInput,
  boundToolOutput,
  clipText,
  parseWorkerFeed,
  type WorkerFeedRecord,
  type WorkerFeedSnapshot,
  type WorkerFeedUpdate,
} from "@shared/worker-feed";

// The writer side of a worker's feed (src/shared/worker-feed.ts). One writer
// per running Pi worker attempt: it appends each record to feed.jsonl, keeps
// the records in memory so a reader of a live worker never races the file,
// and pushes every change to the renderer. Writes are queued, so the file
// always holds whole records in the order they happened.

export const WORKER_FEED_CHANNEL = "orchestration:workerFeed";

export interface WorkerFeedWriter {
  tool(id: unknown, name: unknown, input: unknown): void;
  result(id: unknown, output: string, isError: boolean): void;
  textDelta(delta: string): void;
  /** Ends the streaming assistant message, if any, as one text record. */
  endMessage(): void;
  steer(text: string, from: "user" | "cora"): void;
  note(text: string, tone: "info" | "error"): void;
  snapshot(): WorkerFeedSnapshot;
  /** Settles the streaming message, waits for the file and leaves the live set. */
  close(): Promise<void>;
}

export interface WorkerFeedWriterOptions {
  runId: string;
  attemptId: string;
  path: string;
  publish?: (update: WorkerFeedUpdate) => void;
  maxBytes?: number;
  /** How often a streaming message is pushed at most. 0 pushes every delta. */
  partialIntervalMs?: number;
  now?: () => Date;
}

const liveFeeds = new Map<string, WorkerFeedWriter>();

export function liveWorkerFeedSnapshot(attemptId: string): WorkerFeedSnapshot | null {
  return liveFeeds.get(attemptId)?.snapshot() ?? null;
}

export function publishWorkerFeedUpdate(update: WorkerFeedUpdate): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(WORKER_FEED_CHANNEL, update);
  }
}

/** A finished attempt's feed from disk; null when it never kept one. */
export async function readWorkerFeedFile(path: string): Promise<WorkerFeedRecord[] | null> {
  let size: number;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    return null;
  }
  // The writer keeps the file under its cap; anything far past it was not
  // written by this code, so only its tail is read.
  const limit = WORKER_FEED_LIMITS.maxBytes * 2;
  if (size <= limit) return parseWorkerFeed(await fs.readFile(path, "utf8"));
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    await handle.read(buffer, 0, limit, size - limit);
    const text = buffer.toString("utf8");
    return parseWorkerFeed(text.slice(text.indexOf("\n") + 1));
  } finally {
    await handle.close();
  }
}

export function createWorkerFeedWriter(options: WorkerFeedWriterOptions): WorkerFeedWriter {
  const { runId, attemptId, path } = options;
  const publish = options.publish ?? publishWorkerFeedUpdate;
  const maxBytes = options.maxBytes ?? WORKER_FEED_LIMITS.maxBytes;
  const partialIntervalMs = options.partialIntervalMs ?? 120;
  const now = options.now ?? (() => new Date());

  let records: Array<{ record: WorkerFeedRecord; bytes: number }> = [];
  let bytes = 0;
  let elided = 0;
  let sequence = 0;
  let partial: { id: string; text: string } | null = null;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  // A relaunch of the same attempt starts a new session, so it starts a new feed.
  let queue: Promise<void> = fs.writeFile(path, "", "utf8").catch(() => undefined);

  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(() => undefined);
  };
  const send = (update: Omit<WorkerFeedUpdate, "runId" | "attemptId">) => {
    try {
      publish({ runId, attemptId, ...update });
    } catch {
      // A renderer going away must not end the worker's session.
    }
  };
  const nextId = () => `${(sequence += 1).toString(36)}`;
  const at = () => now().toISOString();

  const compact = () => {
    let kept = 0;
    let start = records.length;
    while (start > 0 && kept + records[start - 1].bytes <= maxBytes / 2) {
      start -= 1;
      kept += records[start].bytes;
    }
    const dropped = records.slice(0, start).filter((entry) => entry.record.k !== "elided").length;
    elided += dropped;
    const marker: WorkerFeedRecord = { k: "elided", id: nextId(), at: at(), count: elided };
    const markerLine = `${JSON.stringify(marker)}\n`;
    records = [
      { record: marker, bytes: Buffer.byteLength(markerLine) },
      ...records.slice(start).filter((entry) => entry.record.k !== "elided"),
    ];
    bytes = records.reduce((sum, entry) => sum + entry.bytes, 0);
    const text = records.map((entry) => JSON.stringify(entry.record)).join("\n") + "\n";
    const temp = `${path}.${process.pid}.tmp`;
    enqueue(async () => {
      await fs.writeFile(temp, text, "utf8");
      await fs.rename(temp, path);
    });
    send({ reset: true });
  };

  const append = (record: WorkerFeedRecord) => {
    if (closed) return;
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    records.push({ record, bytes: size });
    bytes += size;
    if (bytes > maxBytes) {
      compact();
      return;
    }
    enqueue(() => fs.appendFile(path, line, "utf8"));
    send({ records: [record] });
  };

  const flushPartial = () => {
    if (partialTimer) {
      clearTimeout(partialTimer);
      partialTimer = null;
    }
    if (partial) send({ partial });
  };

  const endMessage = () => {
    if (partialTimer) {
      clearTimeout(partialTimer);
      partialTimer = null;
    }
    const message = partial;
    partial = null;
    if (!message) return;
    if (message.text.trim()) {
      append({ k: "text", id: message.id, at: at(), text: clipText(message.text, WORKER_FEED_LIMITS.textChars) });
    }
    send({ partial: null });
  };

  const writer: WorkerFeedWriter = {
    tool(id, name, input) {
      endMessage();
      const bounded = boundToolInput(input);
      append({
        k: "tool",
        id: typeof id === "string" && id ? id : `call-${nextId()}`,
        at: at(),
        name: typeof name === "string" && name ? name : "tool",
        ...(bounded !== undefined ? { input: bounded } : {}),
      });
    },
    result(id, output, isError) {
      if (typeof id !== "string" || !id) return;
      append({ k: "result", id, at: at(), output: boundToolOutput(output), ...(isError ? { error: true as const } : {}) });
    },
    textDelta(delta) {
      if (closed || !delta) return;
      if (!partial) partial = { id: nextId(), text: "" };
      // Past the cap the rest of the message only reaches the terminal log.
      if (partial.text.length >= WORKER_FEED_LIMITS.textChars) return;
      partial.text += delta;
      if (partialIntervalMs <= 0) {
        flushPartial();
      } else if (!partialTimer) {
        partialTimer = setTimeout(flushPartial, partialIntervalMs);
      }
    },
    endMessage,
    steer(text, from) {
      const trimmed = text.trim();
      if (!trimmed) return;
      endMessage();
      append({ k: "steer", id: nextId(), at: at(), text: clipText(trimmed, WORKER_FEED_LIMITS.steerChars), from });
    },
    note(text, tone) {
      const trimmed = text.trim();
      if (!trimmed) return;
      append({ k: "note", id: nextId(), at: at(), text: clipText(trimmed, WORKER_FEED_LIMITS.noteChars), tone });
    },
    snapshot() {
      return {
        available: true,
        live: !closed,
        records: records.map((entry) => entry.record),
        partial: partial ? { ...partial } : null,
      };
    },
    async close() {
      if (closed) return;
      endMessage();
      closed = true;
      if (liveFeeds.get(attemptId) === writer) liveFeeds.delete(attemptId);
      await queue;
      send({ ended: true });
    },
  };
  liveFeeds.set(attemptId, writer);
  return writer;
}
