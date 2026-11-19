// window.spark.chromeLink: the renderer side of src/main/browser/chrome/
// (connection state, pairing, shared tabs). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type { ChromeLinkState, ChromePresenceSettings, SeparateBrowserTool } from "@shared/chrome-link";
import { subscribe } from "../subscribe";

export const chromeLinkApi = {
  state: (): Promise<ChromeLinkState> => ipcRenderer.invoke("chromeLink:state"),
  approve: (id: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:approve", id),
  deny: (id: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:deny", id),
  /** Forget a paired browser; its token stops working. */
  disconnect: (linkId: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:disconnect", linkId),
  /** Let an agent the user stopped from the page use that tab again. */
  giveBack: (linkId: string, tabId: number, key: string): Promise<boolean> => ipcRenderer.invoke("chromeLink:giveBack", linkId, tabId, key),
  /**
   * The browser tools in the user's Claude Code and Codex configs that open a
   * separate Chrome; "Keep agents in your Chrome" turns them off in Codara.
   */
  separateBrowserTools: (): Promise<SeparateBrowserTool[]> => ipcRenderer.invoke("chromeLink:separateBrowserTools"),
  /** The folder for Load unpacked, copied into Codara's home the first time. */
  prepareExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:prepareExtension"),
  /** The same, and open the folder in the file manager. */
  revealExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:revealExtension"),
  /** The Firefox extension's folder for this version, assembled into Codara's home the first time. */
  prepareFirefoxExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:prepareFirefoxExtension"),
  /** The same, and open the folder in the file manager. */
  revealFirefoxExtension: (): Promise<string> => ipcRenderer.invoke("chromeLink:revealFirefoxExtension"),
  /**
   * The user pressed Update extension: copy the extension Codara ships into
   * its folder, and ask that connected browser's extension to reload itself.
   */
  updateExtension: (which: { linkId: string } | { extensionId: string }): Promise<void> => ipcRenderer.invoke("chromeLink:updateExtension", which),
  /** The agent's pointer and Stop pill, and the page-edge glow, on tabs of the user's browser. */
  setPresence: (patch: { overlay?: boolean; glow?: boolean }): Promise<ChromePresenceSettings> => ipcRenderer.invoke("chromeLink:setPresence", patch),
  onChanged: subscribe<ChromeLinkState>("chromeLink:changed"),
};
