// Overnight run queue (SCAFFOLD).
//
// An in-memory queue of autopilot runs backed by a single JSON file under
// sparkHome(). The user enqueues StartAutopilotInput payloads (typically from
// the renderer Queue panel via the `queue:*` IPC handlers) and burnDown()
// drains them serially, or k-at-a-time when `concurrency > 1`, by calling the
// existing startAutopilot(input) from ./run-store.
//
// This is the compiling subset described in docs/overnight-queue-PLAN.md. The
// real overnight scheduler — durable cron firing, crash-recovery of in-flight
// items, and run-completion-driven concurrency — lands with the daemon split.
// The explicit TODOs in burnDown() mark exactly where the stubs are.
//
// The queue model types (RunQueueState / QueuedRun / EnqueueRunInput /
// QueuedRunStatus) live in @shared/types so the renderer Queue panel, preload
// bridge, and IPC layer all share one definition.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  EnqueueRunInput,
  QueuedRun,
  RunQueueState,
  RunStatus,
  StartAutopilotInput,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { writeFileAtomic } from "../fs-atomic";
import { sparkHome } from "../spark-home";
import { subscribeToEvents } from "./event-log";
import { getRun, startAutopilot } from "./run-store";

// File name for the persisted queue, kept directly under sparkHome() next to
// spark-state.json / spark-settings.json (NOT under runs/, which is per-run).
const QUEUE_FILE = "run-queue.json";

function defaultQueueState(): RunQueueState {
  return {
    id: makeId("queue"),
    concurrency: 1,
    running: false,
    items: [],
  };
}

function queuePath(): string {
  return join(sparkHome(), QUEUE_FILE);
}

async function persist(state: RunQueueState): Promise<void> {
  await fs.mkdir(sparkHome(), { recursive: true });
  await writeFileAtomic(queuePath(), `${JSON.stringify(state, null, 2)}\n`);
  void emitQueueUpdated();
}

// Broadcast a queue-changed event so the renderer's Queue panel live-refreshes.
// Uses the run event bus with no runId (so nothing is journaled); the panel
// filters on event.type. Best-effort — a missed push just delays a refresh.
async function emitQueueUpdated(): Promise<void> {
  try {
    const { appendEvent } = await import("./event-log");
    await appendEvent({ workspaceId: "", type: "queue.updated" });
  } catch {
    /* best effort */
  }
}

// Derive a human-facing title for the Queue panel from the launch payload when
// the caller didn't supply one. Mirrors run-store's chatTitleFromInput
// fallback chain (plan title -> first line of the note -> workspace) so a
// queued item reads the same as the run it will become.
function titleFromInput(input: EnqueueRunInput): string {
  const explicit = input.title?.trim();
  if (explicit) return explicit;
  const planTitle = input.input.planTitle?.trim();
  if (planTitle) return planTitle;
  const note = input.input.initialUserNote?.trim().replace(/\s+/g, " ");
  if (note) return note.length <= 60 ? note : `${note.slice(0, 57)}...`;
  return input.input.workspaceName;
}

// Serialize every load-mutate-persist cycle. persist() atomicizes a single
// write, but the read-modify-write spanning loadQueue→mutate→persist is not
// atomic: two near-simultaneous mutations both load the same snapshot and the
// second persist clobbers the first (a completion reverts an item to "running"
// with its watcher already gone; an interleaved enqueue is dropped from disk).
// Routing every cycle through this promise-chain mutex makes them sequential.
//
// REENTRANCY: the lock must be acquired exactly once per logical operation.
// Public functions are thin locked wrappers; internal call sites that already
// run under the lock (burnDown's per-cycle blocks) use the *Inner unlocked
// implementations instead so the chain never waits on itself (which would
// deadlock). burnDown does NOT hold the lock across its whole drain — each
// discrete cycle re-acquires it, so a long startAutopilot await between cycles
// can't block enqueue/dequeue.
let queueOp: Promise<unknown> = Promise.resolve();
function withQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queueOp.then(fn, fn);
  queueOp = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Read the queue from disk, returning a fresh default ({ concurrency: 1,
 * running: false, items: [] }) when the file is missing. Any other read/parse
 * failure propagates so callers can surface a corrupt-queue error rather than
 * silently dropping queued work.
 */
export async function loadQueue(): Promise<RunQueueState> {
  try {
    const raw = await fs.readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw) as RunQueueState;
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error(`Corrupt run queue state (missing items array): ${queuePath()}`);
    }
    return { ...defaultQueueState(), ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultQueueState();
    }
    throw err;
  }
}

/** Read-only accessor for the current persisted queue. */
export async function getQueue(): Promise<RunQueueState> {
  return loadQueue();
}

/**
 * Append a new run to the queue with status 'queued' and persist. Does NOT
 * start draining — call burnDown() (or let the scheduler call it) to run it.
 * Returns the newly created QueuedRun.
 */
export async function enqueue(input: EnqueueRunInput): Promise<QueuedRun> {
  return withQueue(async () => {
    const state = await loadQueue();
    const item: QueuedRun = {
      id: makeId("queued"),
      title: titleFromInput(input),
      status: "queued",
      input: input.input,
      enqueuedAt: new Date().toISOString(),
    };
    state.items.push(item);
    await persist(state);
    return item;
  });
}

/**
 * Remove a still-'queued' item by id and persist. Items already running or in
 * a terminal state are left untouched (a queued-only guard keeps dequeue from
 * yanking an in-flight run out from under burnDown()). Returns the updated
 * queue snapshot.
 */
export async function dequeue(id: string): Promise<RunQueueState> {
  return withQueue(async () => {
    const state = await loadQueue();
    state.items = state.items.filter((item) => !(item.id === id && item.status === "queued"));
    await persist(state);
    return state;
  });
}

/**
 * Set how many items burnDown() may run concurrently. Clamped to >= 1 and
 * floored so a fractional value can't wedge the driver. Persists and returns
 * the updated state.
 */
export async function setConcurrency(n: number): Promise<RunQueueState> {
  return withQueue(async () => {
    const state = await loadQueue();
    state.concurrency = Math.max(1, Math.floor(n));
    await persist(state);
    return state;
  });
}

function countRunning(state: RunQueueState): number {
  return state.items.filter((item) => item.status === "running").length;
}

function nextQueued(state: RunQueueState): QueuedRun | undefined {
  return state.items.find((item) => item.status === "queued");
}

// Re-entrancy guard for burnDown within this process. (A durable cross-process
// lock is the daemon split's job; in-app, every trigger funnels through here.)
let burnDownInFlight = false;

// Run statuses that free a queue slot. paused/blocked are deliberately NOT
// terminal — a run waiting on the user keeps occupying its slot (you walked
// away and it needs you; piling more runs on top wouldn't help).
const TERMINAL_RUN_STATUS: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "complete",
  "failed",
  "cancelled",
]);

// runIds that already have a completion watcher (avoid double-subscribing).
const watchedRuns = new Set<string>();

// Subscribe to the run event bus and finalize a queue item only once its run
// actually reaches a terminal state — THIS is what makes `concurrency` real.
// startAutopilot resolves at run-*creation*, long before completion, so without
// this the cap would be a no-op. On a terminal run we mark the item done/failed,
// free the slot, and re-drain.
function watchCompletion(itemId: string, runId: string): void {
  if (watchedRuns.has(runId)) return;
  watchedRuns.add(runId);
  const unsubscribe = subscribeToEvents((event) => {
    if (event.runId !== runId) return;
    void (async () => {
      const run = await getRun(runId).catch(() => null);
      if (!run || !TERMINAL_RUN_STATUS.has(run.status)) return;
      unsubscribe();
      watchedRuns.delete(runId);
      await transition(itemId, (item) => {
        if (item.status !== "running") return;
        item.status = run.status === "complete" ? "done" : "failed";
        if (run.status !== "complete") item.error = `run ${run.status}`;
        item.finishedAt = new Date().toISOString();
      });
      // A slot just freed — advance the queue.
      void burnDown().catch((err: unknown) =>
        console.error("[queue] re-drain after completion failed:", err),
      );
    })();
  });
}

/**
 * k-at-a-time driver. While a slot is free (running items < concurrency) and a
 * 'queued' item exists, claim it, launch it via startAutopilot, stamp its runId,
 * and leave it 'running' until its run reaches a terminal state — watchCompletion
 * frees the slot and re-drains then. Returns the queue snapshot after the launch
 * pass (runs may still be in flight).
 */
export async function burnDown(): Promise<RunQueueState> {
  if (burnDownInFlight) return loadQueue();
  burnDownInFlight = true;

  try {
    await withQueue(async () => {
      const opening = await loadQueue();
      opening.running = true;
      await persist(opening);
    });

    // Launch loop: re-load each iteration so concurrent enqueue/dequeue and the
    // status transitions written below are observed rather than clobbered. Each
    // discrete cycle runs under the queue lock; startAutopilot is awaited
    // OUTSIDE the lock so a slow launch can't block enqueue/dequeue.
    for (;;) {
      // Claim the next queued slot as one locked cycle. Returns the claimed item
      // (so we have its id after releasing the lock) or null when the loop ends.
      const claimedItem = await withQueue(async () => {
        const state = await loadQueue();
        if (countRunning(state) >= state.concurrency) return null;
        const item = nextQueued(state);
        if (!item) return null;

        item.status = "running";
        item.startedAt = new Date().toISOString();
        await persist(state);
        return item;
      });
      if (!claimedItem) break;

      try {
        const run = await startAutopilot(claimedItem.input);
        // Stamp the runId but keep status 'running' — watchCompletion flips it
        // to done/failed when the run actually finishes.
        await transition(claimedItem.id, (claimed) => {
          claimed.runId = run.id;
        });
        watchCompletion(claimedItem.id, run.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await transition(claimedItem.id, (claimed) => {
          claimed.status = "failed";
          claimed.error = message;
          claimed.finishedAt = new Date().toISOString();
        });
      }
    }

    return await withQueue(async () => {
      const closing = await loadQueue();
      closing.running = countRunning(closing) > 0;
      await persist(closing);
      return closing;
    });
  } finally {
    burnDownInFlight = false;
  }
}

/**
 * On boot, items left 'running' belong to runs whose in-process completion
 * watcher died with the previous session. Reset them to 'queued' so the work
 * resumes, then kick a drain. (Duplicate-run risk is acceptable for the in-app
 * version; durable in-flight ownership is the daemon split's job.)
 */
export async function resumeQueue(): Promise<void> {
  await withQueue(async () => {
    const state = await loadQueue();
    let changed = false;
    for (const item of state.items) {
      if (item.status === "running") {
        item.status = "queued";
        delete item.startedAt;
        delete item.runId;
        changed = true;
      }
    }
    if (changed) await persist(state);
  });
  void burnDown().catch((err: unknown) => console.error("[queue] resume drain failed:", err));
}

/**
 * Re-load the queue, apply `mutate` to the item with `id` (if it still
 * exists), and persist. Keeps each status transition a fresh
 * read-modify-write so an interleaved enqueue/dequeue is not lost.
 */
async function transition(id: string, mutate: (item: QueuedRun) => void): Promise<void> {
  await withQueue(() => transitionInner(id, mutate));
}

// Unlocked load-mutate-persist cycle. Callers that already hold the queue lock
// (burnDown's per-cycle blocks run inside withQueue) call this directly to avoid
// re-acquiring the chain and deadlocking on themselves.
async function transitionInner(id: string, mutate: (item: QueuedRun) => void): Promise<void> {
  const state = await loadQueue();
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  mutate(item);
  await persist(state);
}
