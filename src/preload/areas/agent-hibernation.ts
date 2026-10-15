// window.spark.agentHibernation: the renderer side of src/main/agent-hibernation.ts
// (stopping idle agent terminals in background workspaces). Kept out of
// index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type {
  AgentHibernationPolicy,
  AgentHibernationRequest,
  AgentHibernationResult,
} from "@shared/agent-hibernation";

export const agentHibernationApi = {
  /** The idle period (0 = off) and how often to look for candidates. */
  policy: (): Promise<AgentHibernationPolicy> => ipcRenderer.invoke("agentHibernation:policy"),
  /** Ask main to stop one idle agent pane. Main re-checks everything itself. */
  hibernate: (request: AgentHibernationRequest): Promise<AgentHibernationResult> =>
    ipcRenderer.invoke("agentHibernation:hibernate", request),
};
