// window.spark.chromeLink: the renderer side of src/main/browser/chrome/
// (connection state, pairing, shared tabs). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type { ChromeLinkState } from "@shared/chrome-link";

export const chromeLinkApi = {
  state: (): Promise<ChromeLinkState> => ipcRenderer.invoke("chromeLink:state"),
  approve: (id: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:approve", id),
  deny: (id: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:deny", id),
  /** Forget a paired browser; its token stops working. */
  disconnect: (linkId: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:disconnect", linkId),
  /** Copy the extension into Codara's home and return the folder for Load unpacked. */
  prepareExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:prepareExtension"),
  /** The same, and open the folder in the file manager. */
  revealExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:revealExtension"),
  onChanged: (handler: (state: ChromeLinkState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ChromeLinkState) => handler(state);
    ipcRenderer.on("chromeLink:changed", listener);
    return () => ipcRenderer.off("chromeLink:changed", listener);
  },
};
