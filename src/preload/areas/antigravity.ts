// window.spark.antigravity: the renderer side of src/main/antigravity-cli.ts
// (whether the user's own `agy` is installed). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

export const antigravityApi = {
  /** Whether agy is installed; `fresh` skips the short cache of a miss. */
  status: (fresh = false): Promise<{ installed: boolean; onPath: boolean; dir: string | null }> =>
    ipcRenderer.invoke("antigravity:status", fresh),
  /**
   * True for the one pane per app run that may reopen agy's latest conversation; `take` false only checks.
   * `named` are the conversations other panes reopen by id, which this one must not reopen too.
   */
  claimContinue: (paneId: string, take = true, named: string[] = [], cwd: string | null = null): Promise<boolean> =>
    ipcRenderer.invoke("antigravity:claim-continue", paneId, take, named, cwd),

  releaseContinue: (paneId: string): Promise<void> => ipcRenderer.invoke("antigravity:release-continue", paneId),
  runsInPane: (paneId: string): Promise<boolean> => ipcRenderer.invoke("antigravity:runs-in-pane", paneId),
  /** The conversations a running agy works in now (agy marks them not fully idle). */
  liveConversations: (): Promise<string[]> => ipcRenderer.invoke("antigravity:live-conversations"),
};
