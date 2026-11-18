// window.spark.agentCliUpdates: whether Claude Code, Codex and Grok are up to
// date, the Update button, and Pi's pinned version
// (src/main/agent-cli-updates/). Every read is null in a launch without the
// service (test launches).

import { ipcRenderer } from "electron";

import type { AgentCliToolId, AgentCliUpdatesSnapshot } from "@shared/agent-cli-updates";
import { subscribe } from "../subscribe";

export const agentCliUpdatesApi = {
  status: (): Promise<AgentCliUpdatesSnapshot | null> => ipcRenderer.invoke("agentCliUpdates:status"),
  /** Read every tool and the newest versions again. */
  check: (): Promise<AgentCliUpdatesSnapshot | null> => ipcRenderer.invoke("agentCliUpdates:check"),
  /** Update now, or as soon as the tool's sessions end. */
  update: (tool: AgentCliToolId): Promise<AgentCliUpdatesSnapshot> => ipcRenderer.invoke("agentCliUpdates:update", tool),
  /** Stop waiting to update the tool. */
  cancel: (tool: AgentCliToolId): Promise<AgentCliUpdatesSnapshot | null> => ipcRenderer.invoke("agentCliUpdates:cancel", tool),
  onChanged: subscribe<AgentCliUpdatesSnapshot>("agentCliUpdates:changed"),
};
