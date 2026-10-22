// Cora's task list in the app: the store under <codara home>/cos/, the verify
// gate it starts, the IPC channels the rail reads and the change broadcast.
// ipc.ts registers the channels once, so this area never edits that file
// beyond one call. Agents change the list through the codara_task_* tools
// (preview-tools/cos-tasks.ts). The renderer side is window.spark.cosTasks
// (src/preload/areas/cos-tasks.ts).

import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { app, webContents } from "electron";

import type { TaskSummary, TaskSummaryChange } from "@shared/cos-tasks";
import { isRemotePath } from "@shared/remote";
import { WORKFLOW_DEFAULTS } from "@shared/workflow";
import { resolveBundledResourcePath } from "../bundled-resources";
import { codaraHome } from "../codara-home";
import { logMain } from "../file-log";
import type { IpcHandle } from "../ipc";
import { loadState } from "../storage";
import { provideCosService } from "./service";
import { createTaskStore, isTaskWorkspaceId, type TaskStore } from "./task-store";
import { createCommandRunner, runVerifyGate, stopRunningChecks, workspaceBaseBranch, type CommandRunner } from "./verify-gate";

export const COS_TASKS_CHANGED_CHANNEL = "cosTasks:changed";

let store: TaskStore | null = null;
let commandRunner: CommandRunner | null = null;

function broadcast(change: TaskSummaryChange): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      contents.send(COS_TASKS_CHANGED_CHANNEL, change);
    } catch {
      // A renderer may close between enumeration and send.
    }
  }
}

function cosRoot(): string {
  return join(codaraHome(), "cos");
}

async function workspaceById(workspaceId: string) {
  const state = await loadState().catch(() => null);
  return state?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

function taskStore(): TaskStore {
  if (store) return store;
  store = createTaskStore({
    root: cosRoot(),
    workspaceName: async (workspaceId) => (await workspaceById(workspaceId))?.name ?? null,
  });
  store.onChange((workspaceId) => {
    void store
      ?.summary(workspaceId)
      .then((summary) => broadcast({ workspaceId, summary }))
      .catch(() => undefined);
  });
  return store;
}

// The same wrapper and machine-wide slots workflow agents use, so a gate run
// cannot starve the desktop or run beside another heavy build.
function gateCommandRunner(): CommandRunner {
  if (commandRunner) return commandRunner;
  const bin = process.platform === "win32" ? null : join(resolveBundledResourcePath("orchestration", "bin"), "codara-heavy");
  commandRunner = createCommandRunner(
    bin && existsSync(bin)
      ? {
          bin,
          env: {
            CODARA_HEAVY_LOCK_DIR: join(os.tmpdir(), "codara-heavy-locks"),
            CODARA_HEAVY_SLOTS: String(WORKFLOW_DEFAULTS.heavySlots),
            CODARA_HEAVY_MEMORY_MAX: `${Math.round(WORKFLOW_DEFAULTS.heavyMemoryMaxBytes / (1024 * 1024))}M`,
          },
        }
      : null,
  );
  return commandRunner;
}

// One gate per task: a newer verify run cancels the older one, whose result
// would be stale anyway and whose checks would only hold the heavy slot.
const runningGates = new Map<string, { runId: string; abort: AbortController }>();

function startVerify(workspaceId: string, taskId: string, runId: string): void {
  const key = `${workspaceId}/${taskId}`;
  const current = runningGates.get(key);
  if (current?.runId === runId) return;
  current?.abort.abort();
  const abort = new AbortController();
  runningGates.set(key, { runId, abort });
  void (async () => {
    const list = await taskStore().read(workspaceId);
    const task = list.tasks.find((candidate) => candidate.id === taskId);
    const workspace = await workspaceById(workspaceId);
    // The task's own worktree when it names one; else the workspace's folder.
    // An SSH workspace's folder is not on this machine.
    const local = (folder: string | null | undefined) => (folder && !isRemotePath(folder) ? folder : null);
    const workspaceDir = local(workspace?.cwd);
    const cwd = local(task?.assignee?.worktree) ?? workspaceDir;
    const result = await runVerifyGate({
      store: taskStore(),
      workspaceId,
      taskId,
      runId,
      cwd,
      workspaceDir,
      baseBranch: workspaceBaseBranch(workspace),
      runCommand: gateCommandRunner(),
      signal: abort.signal,
    });
    logMain("cos", `verify ${workspaceId} ${taskId} ${runId}: ${result?.state ?? "cancelled"}`);
  })()
    .catch(async (error) => {
      logMain("cos", `verify ${workspaceId} ${taskId} ${runId} failed: ${String(error)}`);
      // Left alone, the task would sit in verifying until the next restart.
      await taskStore()
        .finishVerify(workspaceId, taskId, {
          runId,
          evidence: [],
          blocked: "The verify gate itself failed before it could check anything; Codara's log has the error.",
        })
        .catch(() => undefined);
    })
    .finally(() => {
      if (runningGates.get(key)?.runId === runId) runningGates.delete(key);
    });
}

provideCosService({
  store: taskStore,
  workspaceName: async (workspaceId) => (await workspaceById(workspaceId))?.name ?? null,
  startVerify,
});

async function listedWorkspaceIds(): Promise<string[]> {
  const entries = await fs.readdir(cosRoot(), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && isTaskWorkspaceId(entry.name)).map((entry) => entry.name);
}

async function summaries(): Promise<Record<string, TaskSummary>> {
  const out: Record<string, TaskSummary> = {};
  for (const workspaceId of await listedWorkspaceIds()) {
    const summary = await taskStore()
      .summary(workspaceId)
      .catch(() => null);
    if (summary) out[workspaceId] = summary;
  }
  return out;
}

// A gate the app quit in the middle of never recorded its result, so its
// task would sit in verifying for good. Each one runs again from the start.
async function resumeInterruptedVerifies(): Promise<void> {
  for (const workspaceId of await listedWorkspaceIds()) {
    const list = await taskStore()
      .read(workspaceId)
      .catch(() => null);
    for (const task of list?.tasks ?? []) {
      if (task.state === "verifying" && task.verify && !task.verify.endedAt) startVerify(workspaceId, task.id, task.verify.runId);
    }
  }
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerCosTasksIpc(handle: IpcHandle): void {
  taskStore();
  handle("cosTasks:summaries", (): Promise<Record<string, TaskSummary>> => summaries());
  // A check left running after quit would hold the heavy slot the gate
  // resumed at the next boot then waits for.
  app.on("will-quit", stopRunningChecks);
  void resumeInterruptedVerifies().catch(() => undefined);
}
