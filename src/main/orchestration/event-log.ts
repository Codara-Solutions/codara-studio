import { BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SparkEvent } from "@shared/types";
import { FANOUT_EVENT } from "@shared/types";
import { makeId } from "@shared/ids";
import { sparkHome } from "../spark-home";

const RUNS_DIR = "runs";
const EVENTS_FILE = "events.jsonl";
const EVENT_VERSION = 1;

export interface AppendEventInput {
  /** Reserved for atomic multi-event commits that need to link event ids. */
  id?: string;
  timestamp?: string;
  workspaceId: string;
  runId?: string;
  stepId?: string;
  workerTaskId?: string;
  attemptId?: string;
  sparkCallId?: string;
  type: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export function runsRoot(): string {
  return join(sparkHome(), RUNS_DIR);
}

export function runDir(runId: string): string {
  return join(runsRoot(), runId);
}

export function eventsPath(runId: string): string {
  return join(runDir(runId), EVENTS_FILE);
}

interface RunJournalState {
  highWater: number;
  needsLeadingNewline: boolean;
}

// A run's append, fsync-visible journal order, and live broadcast order are one
// serialized stream. Keeping the queue here (rather than only in run-store)
// covers direct appendEvent callers and commit-generated event batches alike.
const runAppendQueues = new Map<string, Promise<void>>();
const runJournalStates = new Map<string, RunJournalState>();

// Token-cadence stream events (chat.assistant_block) arrive tens-to-hundreds of
// times a second. Appending each one individually costs a mkdir + appendFile and
// a webContents.send per window per token. appendBufferedEvent parks them in a
// per-run buffer that is drained as ONE appendEvents batch — one file append,
// one IPC message — every STREAM_FLUSH_INTERVAL_MS.
const STREAM_FLUSH_INTERVAL_MS = 50;
// Hard ceiling so a burst that outruns the timer cannot grow the buffer without
// bound (or produce a single multi-megabyte append).
const MAX_BUFFERED_EVENTS = 256;

interface PendingBuffer {
  inputs: AppendEventInput[];
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingBuffers = new Map<string, PendingBuffer>();

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function readJournalState(runId: string): Promise<RunJournalState> {
  try {
    const raw = await fs.readFile(eventsPath(runId), "utf8");
    let journalPosition = 0;
    let highWater = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      journalPosition += 1;
      highWater = Math.max(highWater, journalPosition);
      try {
        const parsed = JSON.parse(line) as { sequence?: unknown };
        if (validSequence(parsed.sequence)) highWater = Math.max(highWater, parsed.sequence);
      } catch {
        // A malformed historical line still occupies a journal position. It is
        // skipped by listEvents, but new events must advance past it.
      }
    }
    return {
      highWater,
      needsLeadingNewline: raw.length > 0 && !/[\r\n]$/.test(raw),
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { highWater: 0, needsLeadingNewline: false };
    }
    throw err;
  }
}

function createEvent(input: AppendEventInput, sequence?: number): SparkEvent {
  const { id, timestamp, ...eventInput } = input;
  return {
    id: id ?? makeId("evt"),
    timestamp: timestamp ?? new Date().toISOString(),
    eventVersion: EVENT_VERSION,
    sequence,
    ...eventInput,
  };
}

/**
 * Claim this run's next append-queue slot and persist `inputs` in it.
 *
 * The slot is claimed synchronously (runAppendQueues is updated before the
 * first await), so callers that need a strict ordering between two appends only
 * have to call this in the right order — they do not have to await the first.
 */
function enqueueAppend(runId: string, inputs: AppendEventInput[]): Promise<SparkEvent[]> {
  let appended: SparkEvent[] = [];
  const previous = runAppendQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* an earlier failed append must not wedge this run's journal */
    })
    .then(async () => {
      const state = runJournalStates.get(runId) ?? (await readJournalState(runId));
      const events = inputs.map((input, index) =>
        createEvent(input, state.highWater + index + 1),
      );
      const prefix = state.needsLeadingNewline ? "\n" : "";
      const journalText = `${prefix}${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

      await fs.mkdir(runDir(runId), { recursive: true });
      await fs.appendFile(eventsPath(runId), journalText, "utf8");

      // Advance the sequence cache only after persistence succeeds. Broadcast is
      // deliberately after the write and remains inside the same queue slot, so
      // subscribers observe the exact durable journal order.
      state.highWater += events.length;
      state.needsLeadingNewline = false;
      runJournalStates.set(runId, state);
      appended = events;
      broadcast(events);
    });

  runAppendQueues.set(runId, next);
  return next
    .finally(() => {
      if (runAppendQueues.get(runId) === next) runAppendQueues.delete(runId);
    })
    .then(() => appended);
}

/**
 * Drain this run's buffered stream events onto the append queue. The queue slot
 * is claimed synchronously, so a caller that invokes this before claiming its
 * own slot is guaranteed the buffered events land first.
 */
function drainBuffer(runId: string): Promise<SparkEvent[]> {
  const buffer = pendingBuffers.get(runId);
  if (!buffer) return Promise.resolve([]);
  if (buffer.timer) clearTimeout(buffer.timer);
  pendingBuffers.delete(runId);
  if (buffer.inputs.length === 0) return Promise.resolve([]);
  return enqueueAppend(runId, buffer.inputs);
}

/**
 * Append one same-run event batch atomically with respect to all other appends.
 * The batch form lets run-store persist a domain event and its canonical
 * lifecycle event without a concurrent direct append slipping between them.
 */
export async function appendEvents(inputs: AppendEventInput[]): Promise<SparkEvent[]> {
  if (inputs.length === 0) return [];
  const runId = inputs[0].runId;
  if (inputs.some((input) => input.runId !== runId)) {
    throw new Error("appendEvents requires every event in a batch to share one runId");
  }

  // Events without a runId have no journal and therefore no per-run sequence;
  // they remain live broadcast-only, in caller order.
  if (!runId) {
    const events = inputs.map((input) => createEvent(input));
    for (const event of events) broadcast([event]);
    return events;
  }

  // Anything buffered for this run was emitted before this event, so it has to
  // reach the journal first. Claiming its slot here (synchronously, before ours)
  // is what preserves emission order across the buffered/unbuffered split.
  void drainBuffer(runId).catch((err) => {
    console.warn(`[spark] flushing buffered events for run ${runId} failed:`, err);
  });

  return enqueueAppend(runId, inputs);
}

export async function appendEvent(input: AppendEventInput): Promise<SparkEvent> {
  const [event] = await appendEvents([input]);
  return event;
}

/**
 * Append a high-frequency stream event without paying a file append and an IPC
 * send per event. The event is buffered and written as part of the run's next
 * batch — within STREAM_FLUSH_INTERVAL_MS, or immediately ahead of the next
 * ordinary appendEvent(s) call on the same run, whichever comes first.
 *
 * Fire-and-forget by design: the caller gets no SparkEvent back because the
 * sequence number is only assigned at flush time.
 */
export function appendBufferedEvent(input: AppendEventInput): void {
  const runId = input.runId;
  // No journal, no batching to do — an unrouted event is broadcast-only anyway.
  if (!runId) {
    void appendEvents([input]).catch((err) => {
      console.warn("[spark] broadcasting an unrouted stream event failed:", err);
    });
    return;
  }

  let buffer = pendingBuffers.get(runId);
  if (!buffer) {
    buffer = { inputs: [], timer: null };
    pendingBuffers.set(runId, buffer);
  }
  buffer.inputs.push(input);

  if (buffer.inputs.length >= MAX_BUFFERED_EVENTS) {
    void drainBuffer(runId).catch((err) => {
      console.warn(`[spark] flushing buffered events for run ${runId} failed:`, err);
    });
    return;
  }
  // Timer runs from the FIRST buffered event, so latency to the renderer is
  // bounded by the interval rather than restarting with every new token.
  if (!buffer.timer) {
    buffer.timer = setTimeout(() => {
      void drainBuffer(runId).catch((err) => {
        console.warn(`[spark] flushing buffered events for run ${runId} failed:`, err);
      });
    }, STREAM_FLUSH_INTERVAL_MS);
  }
}

/**
 * Force buffered stream events to disk now. Called for one run when its manager
 * turn ends, and for every run on shutdown, so a quit inside the flush window
 * cannot drop the tail of a stream.
 */
export async function flushBufferedEvents(runId?: string): Promise<void> {
  const runIds = runId ? [runId] : [...pendingBuffers.keys()];
  await Promise.all(
    runIds.map((id) =>
      drainBuffer(id).catch((err) => {
        console.warn(`[spark] flushing buffered events for run ${id} failed:`, err);
      }),
    ),
  );
}

// --- Fan-out event helpers --------------------------------------------------
// Thin typed wrappers around appendEvent for the first-class parallel fan-out
// path. They only format a human message + payload and delegate to appendEvent
// (which persists to events.jsonl and broadcasts); no other logic. run-store.ts
// calls these instead of writing the literal `type` strings, so the event names
// stay centralized here + in FANOUT_EVENT (src/shared/types.ts) and remain
// greppable.

// Emitted once at the launch site (behind an autopilot guard) when
// hasConcreteParallelScope forces pickAutopilotTasks to collapse a would-be
// parallel batch to a single serial task.
export async function appendFanOutDowngradedEvent(input: {
  workspaceId: string;
  runId: string;
  stepId?: string;
  workerTaskId: string;
  taskTitle: string;
  reason: "no_concrete_scope";
}): Promise<SparkEvent> {
  return appendEvent({
    workspaceId: input.workspaceId,
    runId: input.runId,
    stepId: input.stepId,
    workerTaskId: input.workerTaskId,
    type: FANOUT_EVENT.downgradedToSerial,
    message: `Fan-out downgraded to serial: "${input.taskTitle}" has no concrete write scope`,
    payload: {
      taskTitle: input.taskTitle,
      reason: input.reason,
      workerTaskId: input.workerTaskId,
    },
  });
}

// Emitted when deriveDownstreamScopesFromFilesChanged overwrites empty /
// broad-glob allowedPaths on downstream tasks with the concrete paths taken from
// completed workers' real filesChanged.
export async function appendWriteScopesDerivedEvent(input: {
  workspaceId: string;
  runId: string;
  derived: Array<{ taskTitle: string; from: string[]; to: string[] }>;
  sourceTaskTitles: string[];
}): Promise<SparkEvent> {
  const count = input.derived.length;
  return appendEvent({
    workspaceId: input.workspaceId,
    runId: input.runId,
    type: FANOUT_EVENT.writeScopesDerived,
    message: `Derived concrete write scopes for ${count} downstream task${
      count === 1 ? "" : "s"
    } from real filesChanged`,
    payload: {
      count,
      derived: input.derived,
      sourceTaskTitles: input.sourceTaskTitles,
    },
  });
}

// Emitted when run-store deterministically synthesizes the forced worker_batch
// from a seeded FanOutDirective (one parallel worker per target file).
export async function appendFanOutDirectiveForcedEvent(input: {
  workspaceId: string;
  runId: string;
  targetCount: number;
  origin: string;
}): Promise<SparkEvent> {
  return appendEvent({
    workspaceId: input.workspaceId,
    runId: input.runId,
    type: FANOUT_EVENT.directiveForced,
    message: `Fan-out directive forced ${input.targetCount} parallel worker${
      input.targetCount === 1 ? "" : "s"
    } (origin: ${input.origin})`,
    payload: {
      targetCount: input.targetCount,
      origin: input.origin,
    },
  });
}

// Emitted when the orchestrator detects that a previously-verified ("green")
// claim has regressed under a later worker and rolls the workspace back to the
// pre-worker snapshot that predated the regressing change. Surfaced loudly so
// the user can see the self-heal happen in the timeline.
export const REGRESSION_REVERT_EVENT_TYPE = "autopilot.regression_reverted";

export async function appendRegressionRevertEvent(input: {
  workspaceId: string;
  runId: string;
  stepId?: string;
  workerTaskId?: string;
  attemptId?: string;
  claim: string;
  restoredSha: string;
}): Promise<SparkEvent> {
  const { workspaceId, runId, stepId, workerTaskId, attemptId, claim, restoredSha } = input;
  return appendEvent({
    workspaceId,
    runId,
    stepId,
    workerTaskId,
    attemptId,
    type: REGRESSION_REVERT_EVENT_TYPE,
    message: `Reverted a regression: a previously-verified claim failed again — restored the pre-worker snapshot ("${claim}")`,
    payload: { claim, restoredSha },
  });
}

export async function listEvents(runId: string): Promise<SparkEvent[]> {
  try {
    const raw = await fs.readFile(eventsPath(runId), "utf8");
    const events: SparkEvent[] = [];
    let journalPosition = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      journalPosition += 1;
      try {
        const event = JSON.parse(line) as SparkEvent;
        // Legacy lines are normalized only in memory. Their deterministic
        // synthetic sequence is their non-empty JSONL position; the file is
        // never rewritten and no historical transition is rebroadcast.
        if (!validSequence(event.sequence)) event.sequence = journalPosition;
        events.push(event);
      } catch (parseErr) {
        console.warn(`[spark] skipping unparsable event line for run ${runId}:`, parseErr);
      }
    }
    return events;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Main-process subscribers used by the headless eval entry point. The
// renderer subscribes via the IPC fan-out below; the headless runner has no
// renderer and instead listens here so it can react to envelope_prepared
// (spawn the worker pty) and run.* terminal events without polling the
// run-store. Subscribers are best-effort: a throwing handler must not break
// the fan-out for the next subscriber.
const mainSubscribers = new Set<(event: SparkEvent) => void>();

export function subscribeToEvents(handler: (event: SparkEvent) => void): () => void {
  mainSubscribers.add(handler);
  return () => {
    mainSubscribers.delete(handler);
  };
}

// Main-process subscribers keep their one-event-per-call contract. Renderers get
// a batch of more than one event as a single IPC message on
// "orchestration:events-batch"; the preload wrapper fans it back out to the same
// per-event callbacks, in order, so no renderer code has to know about batching.
function broadcast(events: SparkEvent[]): void {
  if (events.length === 0) return;
  for (const event of events) {
    for (const handler of mainSubscribers) {
      try {
        handler(event);
      } catch (err) {
        console.warn("[spark] event subscriber threw:", err);
      }
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    if (events.length === 1) {
      win.webContents.send("orchestration:event", events[0]);
    } else {
      win.webContents.send("orchestration:events-batch", events);
    }
  }
}
