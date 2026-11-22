// window.spark.agentHibernation: the renderer side of src/main/agent-hibernation.ts
// (stopping idle agent terminals). Kept out of index.ts so its owner adds
// calls here only.

import { ipcRenderer } from "electron";

import type {
  AgentHibernationPolicy,
  AgentHibernationRequest,
  AgentHibernationResult,
  AgentRestoredAsleepPane,
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
  /** A pane restored asleep at launch: main records it as sleeping. */
  restoredAsleep: (pane: AgentRestoredAsleepPane): Promise<boolean> =>
    ipcRenderer.invoke("agentHibernation:restoredAsleep", pane),
  /** The user showed or touched these panes: their idle clock starts over. */
  touched: (paneIds: string[]): void => ipcRenderer.send("agentHibernation:touched", paneIds),
  /** One line for main.log about a pane the renderer did not nominate. */
  log: (line: string): void => ipcRenderer.send("agentHibernation:log", line),
};
