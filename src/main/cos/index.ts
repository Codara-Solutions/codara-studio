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
import { WORKFLOW_DEFAULTS } from "@shared/workflow";
import { resolveBundledResourcePath } from "../bundled-resources";
import { codaraHome } from "../codara-home";
import { logMain } from "../file-log";
import type { IpcHandle } from "../ipc";
import { loadState, onStateSaved } from "../storage";
import { provideCosService } from "./service";
import { createTaskStore, isTaskWorkspaceId, type TaskStore } from "./task-store";
import {
  createCommandRunner,
  createGateScheduler,
  createOriginRecords,
  recordAddedWorkspaces,
  resolveGateTarget,
  runVerifyGate,
  stopRunningChecks,
  type CommandRunner,
  type GateScheduler,
  type OriginRecords,
} from "./verify-gate";

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
    void summaryOf(workspaceId)
      .then((summary) => broadcast({ workspaceId, summary }))
      .catch(() => undefined);
  });
  return store;
}

let origins: OriginRecords | null = null;

function originRecords(): OriginRecords {
  origins ??= createOriginRecords(join(cosRoot(), "workspace-origins.json"));
  return origins;
}

// The rail's summary, with the origin URL waiting for the user's word when
// there is one.
async function summaryOf(workspaceId: string): Promise<TaskSummary | null> {
  const summary = await taskStore().summary(workspaceId);
  if (!summary) return null;
  const url = await originRecords()
    .pending(workspaceId)
    .catch(() => null);
  return url ? { ...summary, originToConfirm: url } : summary;
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

// One gate per task; leaving verifying or a newer run cancels it (see
// createGateScheduler).
let scheduler: GateScheduler | null = null;

function gateScheduler(): GateScheduler {
  if (scheduler) return scheduler;
  scheduler = createGateScheduler({
    store: taskStore(),
    log: (line) => logMain("cos", line),
    run: async ({ workspaceId, taskId, runId, signal }) => {
      const list = await taskStore().read(workspaceId);
      const task = list.tasks.find((candidate) => candidate.id === taskId);
      const state = await loadState().catch(() => null);
      const target = await resolveGateTarget(state?.workspaces ?? [], workspaceId, task?.assignee?.worktree);
      const result =
        "blocked" in target
          ? await taskStore().finishVerify(workspaceId, taskId, { runId, evidence: [], blocked: target.blocked })
          : await runVerifyGate({
              store: taskStore(),
              workspaceId,
              taskId,
              runId,
              ...target,
              origins: originRecords(),
              runCommand: gateCommandRunner(),
              signal,
            });
      logMain("cos", `verify ${workspaceId} ${taskId} ${runId}: ${result?.state ?? "cancelled"}`);
    },
  });
  return scheduler;
}

function startVerify(workspaceId: string, taskId: string, runId: string): void {
  gateScheduler().start(workspaceId, taskId, runId);
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
    const summary = await summaryOf(workspaceId).catch(() => null);
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
  // The user's click under the workspace in the rail (the trusted main
  // window; no agent tool reaches it). Only the URL the rail showed, while it
  // is still the one waiting, is recorded.
  handle("cosTasks:confirmOrigin", async (_event, workspaceId: unknown, url: unknown): Promise<boolean> => {
    if (typeof workspaceId !== "string" || !isTaskWorkspaceId(workspaceId) || typeof url !== "string") return false;
    const confirmed = await originRecords().confirm(workspaceId, url);
    if (confirmed) {
      logMain("cos", `origin of ${workspaceId} confirmed by the user: ${url}`);
      broadcast({ workspaceId, summary: await summaryOf(workspaceId) });
    }
    return confirmed;
  });
  // A check left running after quit would hold the heavy slot the gate
  // resumed at the next boot then waits for.
  app.on("will-quit", stopRunningChecks);
  const seen = loadState().then((state) => new Set(state.workspaces.map((workspace) => workspace.id)));
  let recording: Promise<void> = Promise.resolve();
  onStateSaved((state) => {
    recording = recording
      .then(() => seen)
      .then((ids) => recordAddedWorkspaces(state.workspaces, ids, originRecords()))
      .catch((error) => logMain("cos", `recording origin failed: ${String(error)}`));
  });
  void resumeInterruptedVerifies().catch(() => undefined);
}
