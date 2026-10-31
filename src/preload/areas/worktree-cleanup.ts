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
  WorktreeRailCleanupRequest,
  WorktreeRailCleanupResult,
  WorktreeRailOverview,
  WorktreeRemovalCheck,
  WorktreeSizeEvent,
} from "@shared/worktree-cleanup";
import type {
  WorktreeCleanupAgentResult,
  WorktreeCleanupApprovalAnswer,
  WorktreeCleanupApprovalRequest,
} from "@shared/worktree-cleanup-agent";

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
  /** Merge and folder state of each copy-branch workspace, and the worktrees made outside Codara, for the rail. */
  railStates: (): Promise<WorktreeRailOverview> => ipcRenderer.invoke("worktreeCleanup:railStates"),
  /** Clean up one copy-branch workspace from its rail row. */
  railCleanUp: (request: WorktreeRailCleanupRequest): Promise<WorktreeRailCleanupResult> =>
    ipcRenderer.invoke("worktreeCleanup:railCleanUp", request),
  onSize: (listener: (event: WorktreeSizeEvent) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: WorktreeSizeEvent): void => listener(payload);
    ipcRenderer.on("worktreeCleanup:size", wrapped);
    return () => ipcRenderer.removeListener("worktreeCleanup:size", wrapped);
  },
  /** An agent asks to remove worktrees (codara_worktree_cleanup); the user answers in the approval dialog. */
  onApproval: (listener: (request: WorktreeCleanupApprovalRequest) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: WorktreeCleanupApprovalRequest): void => listener(payload);
    ipcRenderer.on("worktreeCleanup:approval", wrapped);
    return () => ipcRenderer.removeListener("worktreeCleanup:approval", wrapped);
  },
  /** The request is no longer waited for (it timed out). */
  onApprovalClosed: (listener: (payload: { id: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { id: string }): void => listener(payload);
    ipcRenderer.on("worktreeCleanup:approvalClosed", wrapped);
    return () => ipcRenderer.removeListener("worktreeCleanup:approvalClosed", wrapped);
  },
  /** Resolves with what the removal did; null when the request expired. */
  answerApproval: (answer: WorktreeCleanupApprovalAnswer): Promise<WorktreeCleanupAgentResult | null> =>
    ipcRenderer.invoke("worktreeCleanup:approvalAnswer", answer),
};
