// window.spark.antigravity: the renderer side of src/main/antigravity-cli.ts
// (whether the user's own `agy` is installed). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

export const antigravityApi = {
  /** Whether agy is installed; `fresh` skips the short cache of a miss. */
  status: (fresh = false): Promise<{ installed: boolean; onPath: boolean; dir: string | null }> =>
    ipcRenderer.invoke("antigravity:status", fresh),
  /** True for the one pane per app run that may reopen agy's latest conversation; `take` false only checks. */
  claimContinue: (paneId: string, take = true): Promise<boolean> =>
    ipcRenderer.invoke("antigravity:claim-continue", paneId, take),
  releaseContinue: (paneId: string): Promise<void> => ipcRenderer.invoke("antigravity:release-continue", paneId),
  runsInPane: (paneId: string): Promise<boolean> => ipcRenderer.invoke("antigravity:runs-in-pane", paneId),
};
