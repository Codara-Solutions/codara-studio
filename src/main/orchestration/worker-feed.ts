import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { BrowserWindow } from "electron";

import { redactPastedSecrets } from "./pasted-secrets";

import {
  WORKER_ACTIVITY_CHANNEL,
  WORKER_FEED_LIMITS,
  boundToolInput,
  boundToolOutput,
  clipText,
  parseWorkerFeed,
  workerActivityTarget,
  type WorkerActivity,
  type WorkerActivityStep,
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
  /** `call` is the provider's tool call id, which pairs the call with its result. */
  tool(call: unknown, name: unknown, input: unknown): void;
  result(call: unknown, output: string, isError: boolean): void;
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
  /** Where activity changes go; the renderer's windows by default. */
  publishActivity?: (activity: WorkerActivity) => void;
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

// What each live worker is doing now, for the chat's agents rail: one small
// entry per live feed, read once when a chat opens and pushed on each change.
// The rail never reads feeds, so a chat with ten workers costs ten of these
// and no subscription per worker.
const liveActivity = new Map<string, WorkerActivity>();
let activitySeq = 0;

export function publishWorkerActivity(activity: WorkerActivity): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(WORKER_ACTIVITY_CHANNEL, activity);
  }
}

/** The live workers' current steps in one run. */
export function readWorkerActivity(runId: string): WorkerActivity[] {
  return [...liveActivity.values()].filter((activity) => activity.runId === runId);
}

// Non-blocking, so a FIFO the worker left at the feed's path cannot hold a
// file-system thread; only a regular file is then read.
const READ_SAFE = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** A finished attempt's feed from disk; null when it never kept one. */
export async function readWorkerFeedFile(path: string): Promise<WorkerFeedRecord[] | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, READ_SAFE);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    // The writer keeps the file near its cap; anything far past it was not
    // written by this code, so only its tail is read.
    const length = Math.min(stat.size, WORKER_FEED_LIMITS.maxBytes * 2);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return parseWorkerFeed(length < stat.size ? text.slice(text.indexOf("\n") + 1) : text);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// The attempt directory is writable by the worker itself (an automation
// worker's fence includes it), so the writer never follows a link it may have
// planted there: it creates its files fresh, refusing an existing one or a link.
const CREATE_FRESH =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

export function createWorkerFeedWriter(options: WorkerFeedWriterOptions): WorkerFeedWriter {
  const { runId, attemptId, path } = options;
  const publish = options.publish ?? publishWorkerFeedUpdate;
  const publishActivity = options.publishActivity ?? publishWorkerActivity;
  const maxBytes = options.maxBytes ?? WORKER_FEED_LIMITS.maxBytes;
  const partialIntervalMs = options.partialIntervalMs ?? 120;
  const now = options.now ?? (() => new Date());

  let records: Array<{ record: WorkerFeedRecord; bytes: number }> = [];
  let bytes = 0;
  let elided = 0;
  let sequence = 0;
  // Ids carry the session, so a relaunch of the same attempt never reuses one
  // a renderer still holds from the session before.
  const session = now().getTime().toString(36);
  let partial: { id: string; text: string } | null = null;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  // Null when the file could not be created: the feed then lives in memory only.
  let file: FileHandle | null = null;
  // A relaunch of the same attempt starts a new session, so it starts a new
  // feed, and drops a temp file a crash left between write and rename.
  let queue: Promise<void> = (async () => {
    const prefix = `${basename(path)}.`;
    const stale = await fs.readdir(dirname(path)).catch(() => [] as string[]);
    await Promise.all(
      stale
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => fs.rm(join(dirname(path), name), { force: true }).catch(() => undefined)),
    );
    await fs.rm(path, { force: true });
    file = await fs.open(path, CREATE_FRESH, 0o600);
  })().catch(() => undefined);

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
  const nextId = () => `${session}-${(sequence += 1).toString(36)}`;
  let step: WorkerActivityStep | null = null;
  let activityAt = "";
  let shown: WorkerActivity | null = null;
  // Set once close() starts: nothing after that is a step any more.
  let closing = false;
  const openCalls = new Map<string, WorkerActivityStep>();
  // Only a change is pushed: a tool call, a reply starting, the turn going
  // back to thinking, or the end. Text deltas never are.
  const setStep = (next: WorkerActivityStep | null) => {
    if (activityAt && JSON.stringify(next) === JSON.stringify(step)) return;
    step = next;
    activityAt = now().toISOString();
    const activity: WorkerActivity = { runId, attemptId, seq: (activitySeq += 1), at: activityAt, step };
    // A relaunch of the attempt has its own writer: ending this one never
    // drops the entry the newer one set, nor tells the renderer it ended.
    if (!step && liveActivity.has(attemptId) && liveActivity.get(attemptId) !== shown) {
      shown = null;
      return;
    }
    if (step) liveActivity.set(attemptId, activity);
    else if (liveActivity.get(attemptId) === shown) liveActivity.delete(attemptId);
    shown = step ? activity : null;
    try {
      publishActivity(activity);
    } catch {
      // A renderer going away must not end the worker's session.
    }
  };
  const at = () => now().toISOString();

  const rewrite = () => {
    const text = records.map((entry) => JSON.stringify(entry.record)).join("\n") + "\n";
    enqueue(async () => {
      const temp = `${path}.${randomUUID()}.tmp`;
      let next: FileHandle | null = null;
      try {
        next = await fs.open(temp, CREATE_FRESH, 0o600);
        await next.writeFile(text, "utf8");
        // Closed first: Windows refuses to replace a file that is still open.
        await file?.close().catch(() => undefined);
        file = null;
        await fs.rename(temp, path);
        file = next;
      } catch {
        // Appends go on into the old, longer file; the next time the feed
        // outgrows its cap tries the rewrite again. Reopened without creating
        // or following anything, so a path the worker replaced is left alone.
        await next?.close().catch(() => undefined);
        await fs.rm(temp, { force: true }).catch(() => undefined);
        if (!file) {
          file = await fs
            .open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
            .catch(() => null);
        }
      }
    });
    send({ reset: true });
  };

  const compact = () => {
    let kept = 0;
    let start = records.length;
    // The newest record always stays, even one larger than the budget.
    while (start > 0 && (start === records.length || kept + records[start - 1].bytes <= maxBytes / 2)) {
      start -= 1;
      kept += records[start].bytes;
    }
    // Counted in steps the reader would see: a result belongs to its call.
    elided += records
      .slice(0, start)
      .filter((entry) => entry.record.k !== "elided" && entry.record.k !== "result").length;
    const marker: WorkerFeedRecord = { k: "elided", id: nextId(), at: at(), count: elided };
    const markerLine = `${JSON.stringify(marker)}\n`;
    records = [
      { record: marker, bytes: Buffer.byteLength(markerLine) },
      ...records.slice(start).filter((entry) => entry.record.k !== "elided"),
    ];
    bytes = records.reduce((sum, entry) => sum + entry.bytes, 0);
    rewrite();
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
    enqueue(async () => {
      await file?.write(line);
    });
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
    if (!closing) setStep([...openCalls.values()].pop() ?? { kind: "thinking" });
    if (message.text.trim()) {
      append({ k: "text", id: message.id, at: at(), text: clipText(message.text, WORKER_FEED_LIMITS.textChars) });
    }
    send({ partial: null });
  };

  const writer: WorkerFeedWriter = {
    tool(call, name, input) {
      endMessage();
      const bounded = boundToolInput(input);
      append({
        k: "tool",
        id: nextId(),
        at: at(),
        ...(typeof call === "string" && call ? { call: clipText(call, 200) } : {}),
        name: typeof name === "string" && name ? clipText(name, 200) : "tool",
        ...(bounded !== undefined ? { input: bounded } : {}),
      });
      if (closing) return;
      const found = workerActivityTarget(input);
      const target = found ? redactPastedSecrets(runId, found) : undefined;
      const toolStep: WorkerActivityStep = {
        kind: "tool",
        tool: typeof name === "string" && name ? clipText(name, 200) : "tool",
        ...(target ? { target } : {}),
      };
      // Calls can overlap: the rail shows the newest one still open, and
      // goes back to thinking only once none is.
      if (typeof call === "string" && call) {
        openCalls.delete(call);
        openCalls.set(call, toolStep);
      }
      setStep(toolStep);
    },
    result(call, output, isError) {
      if (typeof call !== "string" || !call) return;
      append({
        k: "result",
        id: nextId(),
        at: at(),
        call: clipText(call, 200),
        output: boundToolOutput(output),
        ...(isError ? { error: true as const } : {}),
      });
      if (closing) return;
      openCalls.delete(call);
      const stillOpen = [...openCalls.values()].pop();
      setStep(stillOpen ?? { kind: "thinking" });
    },
    textDelta(delta) {
      if (closed || !delta) return;
      if (!partial) {
        partial = { id: nextId(), text: "" };
        if (!closing) setStep({ kind: "reply" });
      }
      // Past the cap the rest of the message only reaches the terminal log.
      if (partial.text.length >= WORKER_FEED_LIMITS.textChars) return;
      partial.text = clipText(partial.text + delta, WORKER_FEED_LIMITS.textChars);
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
      closing = true;
      endMessage();
      closed = true;
      // Readers keep the live copy until the file holds everything in it.
      await queue;
      await file?.close().catch(() => undefined);
      file = null;
      if (liveFeeds.get(attemptId) === writer) liveFeeds.delete(attemptId);
      setStep(null);
      send({ ended: true });
    },
  };
  liveFeeds.set(attemptId, writer);
  send({ reset: true });
  setStep({ kind: "starting" });
  return writer;
}
