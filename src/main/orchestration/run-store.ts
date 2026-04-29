import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CreateRunInput, RunArtifactPaths, RunState, SparkEvent } from "@shared/types";
import { appendEvent, eventsPath, listEvents, runDir, runsRoot } from "./event-log";

const RUN_FILE = "run.json";

export async function createRun(input: CreateRunInput): Promise<RunState> {
  const now = new Date().toISOString();
  const run: RunState = {
    id: makeId("run"),
    workspaceId: input.workspaceId,
    title: input.title?.trim() || `Test run - ${input.workspaceName}`,
    status: "idle",
    artifactDir: "",
    createdAt: now,
    updatedAt: now,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
  };
  run.artifactDir = runDir(run.id);

  await saveRun(run);
  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "run.created",
    message: "Test run created",
    payload: {
      title: run.title,
      cwd: input.cwd,
      workspaceName: input.workspaceName,
      artifactDir: run.artifactDir,
    },
  });

  return run;
}

export async function getRun(runId: string): Promise<RunState | null> {
  try {
    const raw = await fs.readFile(runPath(runId), "utf8");
    return JSON.parse(raw) as RunState;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listRuns(workspaceId?: string): Promise<RunState[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsRoot());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const runs = await Promise.all(names.map((name) => getRun(name)));
  return runs
    .filter((run): run is RunState => Boolean(run))
    .filter((run) => !workspaceId || run.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRunArtifactPaths(runId: string): RunArtifactPaths {
  return {
    runDir: runDir(runId),
    runJson: runPath(runId),
    eventsJsonl: eventsPath(runId),
  };
}

export async function appendTestEvent(runId: string, message?: string): Promise<SparkEvent> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const event = await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "test.event",
    message: message?.trim() || "Test event appended",
    payload: {
      count: (await listEvents(run.id)).length + 1,
      runStatus: run.status,
    },
  });

  run.updatedAt = event.timestamp;
  await saveRun(run);
  return event;
}

async function saveRun(run: RunState): Promise<void> {
  await fs.mkdir(runDir(run.id), { recursive: true });
  const path = runPath(run.id);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await fs.rename(tmp, path);
}

function runPath(runId: string): string {
  return join(runDir(runId), RUN_FILE);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
