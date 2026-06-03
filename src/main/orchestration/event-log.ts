import { BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SparkEvent } from "@shared/types";
import { FANOUT_EVENT } from "@shared/types";
import { makeId } from "@shared/ids";
import { sparkHome } from "../spark-home";

const RUNS_DIR = "runs";
const EVENTS_FILE = "events.jsonl";

export interface AppendEventInput {
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

export async function appendEvent(input: AppendEventInput): Promise<SparkEvent> {
  const { timestamp, ...eventInput } = input;
  const event: SparkEvent = {
    id: makeId("evt"),
    timestamp: timestamp ?? new Date().toISOString(),
    ...eventInput,
  };

  if (event.runId) {
    await fs.mkdir(runDir(event.runId), { recursive: true });
    await fs.appendFile(eventsPath(event.runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  broadcast(event);
  return event;
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
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SparkEvent);
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

function broadcast(event: SparkEvent): void {
  for (const handler of mainSubscribers) {
    try {
      handler(event);
    } catch (err) {
      console.warn("[spark] event subscriber threw:", err);
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("orchestration:event", event);
    }
  }
}
