// window.spark.gitFix: the renderer side of src/main/git-fix-ipc.ts ("Fix
// with agent" in Source Control). Kept out of index.ts so its owner adds
// calls here only.

import { ipcRenderer } from "electron";

import type {
  GitFixAgentsAvailable,
  GitFixHookInfo,
  GitFixPrepareInput,
  GitFixPrepareResult,
} from "@shared/git-fix";

export const gitFixApi = {
  /** Reads the problem's context and builds the prompt the user reviews. */
  prepare: (input: GitFixPrepareInput): Promise<GitFixPrepareResult> => ipcRenderer.invoke("gitFix:prepare", input),
  /** The commit hooks installed in a repository. */
  hooks: (cwd: string): Promise<GitFixHookInfo> => ipcRenderer.invoke("gitFix:hooks", cwd),
  /** Which agent CLIs can start in a new terminal. */
  agents: (): Promise<GitFixAgentsAvailable> => ipcRenderer.invoke("gitFix:agents"),
};
