// window.spark.worktreeCleanup: the renderer side of
// src/main/worktree-cleanup/ (the worktree list, background sizes, the full
// check before a removal, and the removal). Kept out of index.ts so its owner
// adds calls here only.

import { ipcRenderer } from "electron";

import type {
  WorktreeCleanupRemoveRequest,
  WorktreeCleanupRemoveResult,
  WorktreeCleanupScan,
  WorktreeCleanupTarget,
  WorktreeRemovalCheck,
  WorktreeSizeEvent,
} from "@shared/worktree-cleanup";

export const worktreeCleanupApi = {
  scan: (): Promise<WorktreeCleanupScan> => ipcRenderer.invoke("worktreeCleanup:scan"),
  /** Queues size measurements for worktrees of the last scan; every id when none is given. */
  measure: (input: { ids?: string[]; force?: boolean } = {}): Promise<{ queued: number; pending: number }> =>
    ipcRenderer.invoke("worktreeCleanup:measure", input),
  stopMeasuring: (): Promise<void> => ipcRenderer.invoke("worktreeCleanup:stopMeasuring"),
  check: (targets: WorktreeCleanupTarget[]): Promise<WorktreeRemovalCheck[]> =>
    ipcRenderer.invoke("worktreeCleanup:check", targets),
  remove: (request: WorktreeCleanupRemoveRequest): Promise<WorktreeCleanupRemoveResult> =>
    ipcRenderer.invoke("worktreeCleanup:remove", request),
  onSize: (listener: (event: WorktreeSizeEvent) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: WorktreeSizeEvent): void => listener(payload);
    ipcRenderer.on("worktreeCleanup:size", wrapped);
    return () => ipcRenderer.removeListener("worktreeCleanup:size", wrapped);
  },
};
