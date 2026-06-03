import { BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SparkEvent } from "@shared/types";
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
