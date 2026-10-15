// window.spark.worktreeSetup: the renderer side of src/main/worktree-setup/
// (what a new worktree gets from the repository's .worktreeinclude and
// .codara/worktree.json, the running setups and their logs).

import { ipcRenderer } from "electron";

import type {
  WorktreeSetupFileDraft,
  WorktreeSetupLogChunk,
  WorktreeSetupPreview,
  WorktreeSetupStartError,
  WorktreeSetupStatus,
  WorktreeSetupSuggestion,
  WorktreeSetupWriteResult,
} from "@shared/worktree-setup";

export interface WorktreeSetupStartInput {
  sourceCwd: string;
  worktreePath: string;
  workspaceId?: string;
  workspaceName?: string;
  branch?: string;
  runCommands?: boolean;
  // The repository command fingerprint the create dialog showed; creating
  // with it approves that command for the repository.
  approveFingerprint?: string;
}

// Null when the repository configures nothing and the user has no command.
export type WorktreeSetupStartReply = WorktreeSetupStatus | null | WorktreeSetupStartError;

export const worktreeSetupApi = {
  /** `light` reads the two files only, without looking through the checkout. */
  preview: (sourceCwd: string, options: { light?: boolean } = {}): Promise<WorktreeSetupPreview> =>
    ipcRenderer.invoke("worktreeSetup:preview", { sourceCwd, ...(options.light ? { light: true } : {}) }),
  suggest: (sourceCwd: string): Promise<WorktreeSetupSuggestion> => ipcRenderer.invoke("worktreeSetup:suggest", { sourceCwd }),
  writeFiles: (draft: WorktreeSetupFileDraft): Promise<WorktreeSetupWriteResult> =>
    ipcRenderer.invoke("worktreeSetup:writeFiles", draft),
  start: (input: WorktreeSetupStartInput): Promise<WorktreeSetupStartReply> => ipcRenderer.invoke("worktreeSetup:start", input),
  /** By id, or by worktree path for a setup of an earlier session. */
  get: (id: string): Promise<WorktreeSetupStatus | null> => ipcRenderer.invoke("worktreeSetup:get", { id }),
  list: (): Promise<WorktreeSetupStatus[]> => ipcRenderer.invoke("worktreeSetup:list"),
  stop: (id: string): Promise<WorktreeSetupStatus | null> => ipcRenderer.invoke("worktreeSetup:stop", { id }),
  rerun: (id: string): Promise<WorktreeSetupStartReply> => ipcRenderer.invoke("worktreeSetup:rerun", { id }),
  /** Runs a command waiting for approval; `always` also allows it for the repository from now on. */
  approve: (
    id: string,
    fingerprint: string,
    always = false,
  ): Promise<WorktreeSetupStatus | WorktreeSetupStartError> =>
    ipcRenderer.invoke("worktreeSetup:approve", { id, fingerprint, always }),
  readLog: (id: string, from = 0): Promise<WorktreeSetupLogChunk | null> =>
    ipcRenderer.invoke("worktreeSetup:readLog", { id, from }),
  dismiss: (id: string): Promise<boolean> => ipcRenderer.invoke("worktreeSetup:dismiss", { id }),
  onChanged: (listener: (status: WorktreeSetupStatus) => void): (() => void) => {
    const wrapped = (_event: unknown, status: WorktreeSetupStatus): void => listener(status);
    ipcRenderer.on("worktreeSetup:changed", wrapped);
    return () => ipcRenderer.removeListener("worktreeSetup:changed", wrapped);
  },
};
