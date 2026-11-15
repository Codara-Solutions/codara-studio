// window.spark.agentBoard: the renderer side of src/main/agent-board.ts (the
// rail's Agents view). Kept out of index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type { TerminalAgentActivity } from "@shared/agent-board";
import { subscribeSignal } from "../subscribe";

export const agentBoardApi = {
  /** Every user pane hosting an agent, as main's terminal notifier sees it. */
  activity: (): Promise<TerminalAgentActivity[]> => ipcRenderer.invoke("agentBoard:activity"),
  /** Fires, coalesced, when a pane's state, tool, prompt or message changed. */
  onChanged: subscribeSignal("agent-board:changed"),
};
