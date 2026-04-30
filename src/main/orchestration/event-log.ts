import { BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SparkEvent } from "@shared/types";
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

function broadcast(event: SparkEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("orchestration:event", event);
    }
  }
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
