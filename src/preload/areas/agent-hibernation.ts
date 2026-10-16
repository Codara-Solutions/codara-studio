// window.spark.agentHibernation: the renderer side of src/main/agent-hibernation.ts
// (stopping idle agent terminals in background workspaces). Kept out of
// index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type {
  AgentHibernationPolicy,
  AgentHibernationRequest,
  AgentHibernationResult,
  AgentSleepingPane,
} from "@shared/agent-hibernation";

export const agentHibernationApi = {
  /** The idle period (0 = off) and how often to look for candidates. */
  policy: (): Promise<AgentHibernationPolicy> => ipcRenderer.invoke("agentHibernation:policy"),
  /** Ask main to stop one idle agent pane. Main re-checks everything itself. */
  hibernate: (request: AgentHibernationRequest): Promise<AgentHibernationResult> =>
    ipcRenderer.invoke("agentHibernation:hibernate", request),
  /**
   * Whether this pane's agent sleeps, for a pane that mounts (a remount, a
   * reloaded window), with the output to show: the pane's newest output for
   * a fresh (empty) view, else only what the view never received.
   */
  sleepingPane: (paneId: string, options: { freshView: boolean }): Promise<AgentSleepingPane | null> =>
    ipcRenderer.invoke("agentHibernation:sleepingPane", paneId, options),
};
