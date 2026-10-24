// The session index thread. It owns the SQLite index (session-index.ts), so
// the main process never parses a transcript, holds index pages in its heap,
// or blocks on a write. Built to out/main/session-index-worker.js beside the
// main bundle (see electron.vite.config.ts) and started from source text by
// service.ts with a capped heap.
//
// On Linux the thread lowers its own scheduling priority: nice values are
// per thread there, so the rest of the app keeps its own. Everywhere, a pass
// works in short slices with rests between them (Pacer), and a background
// pass waits while main reports the computer on battery or busy.

import { setPriority } from "node:os";
import { parentPort } from "node:worker_threads";

import type { SessionSearchAgent } from "@shared/session-search";
import {
  SessionIndex,
  type IndexPacer,
  type IndexSearchInput,
  type SessionSourceRoot,
} from "./session-index";

export type IndexPace = "background" | "interactive";

export type SessionIndexJob =
  | { id: number; type: "open"; dbPath: string; platform: string }
  | { id: number; type: "sync"; roots: SessionSourceRoot[]; agents: SessionSearchAgent[]; pace: IndexPace }
  | { id: number; type: "search"; input: IndexSearchInput }
  | { id: number; type: "stats" }
  | { id: number; type: "session"; key: string }
  | { id: number; type: "transcript"; key: string; limit: number }
  | { id: number; type: "remove" }
  | { id: number; type: "close" };

export type SessionIndexControl =
  | { type: "pace"; pace: IndexPace }
  | { type: "pause"; paused: boolean }
  | { type: "abort" };

export type SessionIndexMessage =
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string; aborted?: boolean }
  | { type: "progress"; filesTotal: number; filesDone: number };

/** Work and rest per slice, in ms: about a third of one core in the background. */
export const PACE_SLICES: Readonly<Record<IndexPace, { workMs: number; restMs: number }>> = {
  background: { workMs: 20, restMs: 40 },
  interactive: { workMs: 40, restMs: 15 },
};

export class PassAborted extends Error {
  constructor() {
    super("The indexing pass was stopped.");
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Pacer implements IndexPacer {
  pace: IndexPace;
  paused = false;
  aborted = false;
  private sliceStart = performance.now();

  constructor(pace: IndexPace) {
    this.pace = pace;
  }

  async checkpoint(): Promise<void> {
    if (this.aborted) throw new PassAborted();
    const { workMs, restMs } = PACE_SLICES[this.pace];
    if (performance.now() - this.sliceStart >= workMs) {
      await sleep(restMs);
      this.sliceStart = performance.now();
    }
    // Only a background pass waits out a pause; one the user asked for runs.
    while (this.paused && this.pace === "background" && !this.aborted) await sleep(1_000);
    if (this.aborted) throw new PassAborted();
  }
}

function lowerOwnPriority(): void {
  if (process.platform !== "linux") return;
  try {
    // 0 is the calling thread on Linux, not the process.
    setPriority(0, 19);
  } catch {
    // Not permitted here; the pacing still applies.
  }
}

function startThread(): void {
  const port = parentPort;
  if (!port) return;
  lowerOwnPriority();
  let index: SessionIndex | null = null;
  let pacer: Pacer | null = null;
  let running: Promise<unknown> | null = null;
  const post = (message: SessionIndexMessage) => port.postMessage(message);
  const requireIndex = (): SessionIndex => {
    if (!index) throw new Error("The session index is not open.");
    return index;
  };

  const run = async (job: SessionIndexJob): Promise<unknown> => {
    switch (job.type) {
      case "open":
        index?.close();
        index = await SessionIndex.open(job.dbPath, job.platform);
        return requireIndex().stats();
      case "sync": {
        const current = requireIndex();
        if (pacer) throw new Error("A pass is already running.");
        pacer = new Pacer(job.pace);
        running = current.sync(job.roots, new Set(job.agents), pacer, (progress) =>
          post({ type: "progress", ...progress }),
        );
        try {
          return await running;
        } finally {
          pacer = null;
          running = null;
        }
      }
      case "search":
        return requireIndex().search(job.input);
      case "stats":
        return requireIndex().stats();
      case "session":
        return requireIndex().session(job.key);
      case "transcript":
        return requireIndex().transcript(job.key, job.limit);
      case "remove": {
        // Let a running pass reach its next checkpoint and roll back first.
        if (pacer) pacer.aborted = true;
        await running?.catch(() => undefined);
        const path = index?.dbPath ?? null;
        index?.close();
        index = null;
        if (path) await SessionIndex.removeFiles(path);
        return null;
      }
      case "close":
        if (pacer) pacer.aborted = true;
        await running?.catch(() => undefined);
        index?.close();
        index = null;
        return null;
    }
  };

  port.on("message", (message: SessionIndexJob | SessionIndexControl) => {
    if (message.type === "pace") {
      if (pacer) pacer.pace = message.pace;
      return;
    }
    if (message.type === "pause") {
      if (pacer) pacer.paused = message.paused;
      return;
    }
    if (message.type === "abort") {
      if (pacer) pacer.aborted = true;
      return;
    }
    const job = message;
    run(job).then(
      (value) => post({ type: "reply", id: job.id, ok: true, value }),
      (err: unknown) =>
        post({
          type: "reply",
          id: job.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          aborted: err instanceof PassAborted,
        }),
    );
  });
}

startThread();
