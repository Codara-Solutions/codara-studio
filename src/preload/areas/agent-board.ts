// window.spark.agentBoard: the renderer side of src/main/agent-board.ts (the
// rail's Agents view). Kept out of index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type { TerminalAgentActivity } from "@shared/agent-board";

export const agentBoardApi = {
  /** Every user pane hosting an agent, as main's terminal notifier sees it. */
  activity: (): Promise<TerminalAgentActivity[]> => ipcRenderer.invoke("agentBoard:activity"),
  /** Fires, coalesced, when a pane's state, tool, prompt or message changed. */
  onChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on("agent-board:changed", wrapped);
    return () => ipcRenderer.removeListener("agent-board:changed", wrapped);
  },
};
