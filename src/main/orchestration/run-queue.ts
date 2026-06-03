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
  StartAutopilotInput,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { writeFileAtomic } from "../fs-atomic";
import { sparkHome } from "../spark-home";
import { startAutopilot } from "./run-store";

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

/**
 * Read the queue from disk, returning a fresh default ({ concurrency: 1,
 * running: false, items: [] }) when the file is missing. Any other read/parse
 * failure propagates so callers can surface a corrupt-queue error rather than
 * silently dropping queued work.
 */
export async function loadQueue(): Promise<RunQueueState> {
  try {
    const raw = await fs.readFile(queuePath(), "utf8");
    return JSON.parse(raw) as RunQueueState;
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
}

/**
 * Remove a still-'queued' item by id and persist. Items already running or in
 * a terminal state are left untouched (a queued-only guard keeps dequeue from
 * yanking an in-flight run out from under burnDown()). Returns the updated
 * queue snapshot.
 */
export async function dequeue(id: string): Promise<RunQueueState> {
  const state = await loadQueue();
  state.items = state.items.filter((item) => !(item.id === id && item.status === "queued"));
  await persist(state);
  return state;
}

/**
 * Set how many items burnDown() may run concurrently. Clamped to >= 1 and
 * floored so a fractional value can't wedge the driver. Persists and returns
 * the updated state.
 */
export async function setConcurrency(n: number): Promise<RunQueueState> {
  const state = await loadQueue();
  state.concurrency = Math.max(1, Math.floor(n));
  await persist(state);
  return state;
}

function countRunning(state: RunQueueState): number {
  return state.items.filter((item) => item.status === "running").length;
}

function nextQueued(state: RunQueueState): QueuedRun | undefined {
  return state.items.find((item) => item.status === "queued");
}

// Stubbed process-wide guard (TODO (c)). Module-level flag only protects
// against re-entrant burnDown() calls within this one process; it is NOT a
// real cross-process mutex and is racy across the read-modify-write cycles
// below. The daemon split should hold an OS file lock on run-queue.json.
let burnDownInFlight = false;

/**
 * Serial / k-at-a-time driver. While there is a 'queued' item AND the number
 * of 'running' items is below `concurrency`, claim the next queued item, mark
 * it 'running' + stamp startedAt, persist, then call startAutopilot(input).
 * On resolve the item becomes 'done' + runId, on reject 'failed' + error; the
 * state is re-loaded and persisted after each transition so a concurrent
 * enqueue/dequeue isn't clobbered. Loops until the queue is drained or the
 * concurrency ceiling is hit, then returns the final queue snapshot.
 *
 * TODO (a): real concurrency tracking. startAutopilot resolves once the
 *   RunState has been *created*, not once the run has *finished*, so awaiting
 *   it here does not actually bound in-flight work — a slot frees up almost
 *   immediately and `concurrency` becomes a no-op. The daemon split should
 *   instead subscribe to run-completion events (event-log.subscribeToEvents ->
 *   run.completed / run.failed) and only then free the slot + advance the
 *   queue. See docs/overnight-queue-PLAN.md.
 * TODO (b): crash-recovery / resume. Items left in 'running' after a crash are
 *   not reconciled on the next load; resuming in-flight items is deferred to
 *   the daemon split (which owns durable run ownership).
 * TODO (c): process-wide singleton / mutex guard — see `burnDownInFlight`
 *   above; it is a re-entrancy stub only, not a durable cross-process lock.
 */
export async function burnDown(): Promise<RunQueueState> {
  // TODO (c): stubbed singleton guard — re-entrancy only, not cross-process.
  if (burnDownInFlight) return loadQueue();
  burnDownInFlight = true;

  try {
    {
      const opening = await loadQueue();
      opening.running = true;
      await persist(opening);
    }

    // Drain loop: re-load each iteration so concurrent enqueue/dequeue and the
    // status transitions written below are observed rather than clobbered.
    for (;;) {
      const state = await loadQueue();
      if (countRunning(state) >= state.concurrency) break;
      const item = nextQueued(state);
      if (!item) break;

      item.status = "running";
      item.startedAt = new Date().toISOString();
      await persist(state);

      try {
        const run = await startAutopilot(item.input);
        await transition(item.id, (claimed) => {
          claimed.status = "done";
          claimed.runId = run.id;
          claimed.finishedAt = new Date().toISOString();
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await transition(item.id, (claimed) => {
          claimed.status = "failed";
          claimed.error = message;
          claimed.finishedAt = new Date().toISOString();
        });
      }
    }

    const closing = await loadQueue();
    closing.running = false;
    await persist(closing);
    return closing;
  } finally {
    burnDownInFlight = false;
  }
}

/**
 * Re-load the queue, apply `mutate` to the item with `id` (if it still
 * exists), and persist. Keeps each status transition a fresh
 * read-modify-write so an interleaved enqueue/dequeue is not lost.
 */
async function transition(id: string, mutate: (item: QueuedRun) => void): Promise<void> {
  const state = await loadQueue();
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  mutate(item);
  await persist(state);
}
