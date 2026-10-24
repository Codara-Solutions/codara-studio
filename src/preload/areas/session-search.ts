// window.spark.sessionSearch: the renderer side of
// src/main/session-search/service.ts (the local index of agent transcripts).

import { ipcRenderer } from "electron";
import type {
  SessionSearchRequest,
  SessionSearchResult,
  SessionSearchStatus,
  SessionTranscript,
} from "@shared/session-search";

export const sessionSearchApi = {
  /** `load` reads the index's numbers when they are not known yet (Settings). */
  status: (load = false): Promise<SessionSearchStatus> => ipcRenderer.invoke("sessionSearch:status", load),
  search: (request: SessionSearchRequest): Promise<SessionSearchResult> =>
    ipcRenderer.invoke("sessionSearch:search", request),
  /** Brings the index up to date when it is stale; `force` always does. */
  refresh: (force = false): Promise<SessionSearchStatus> => ipcRenderer.invoke("sessionSearch:refresh", force),
  transcript: (key: string): Promise<SessionTranscript | null> => ipcRenderer.invoke("sessionSearch:transcript", key),
  reveal: (key: string): Promise<boolean> => ipcRenderer.invoke("sessionSearch:reveal", key),
  rebuild: (): Promise<SessionSearchStatus> => ipcRenderer.invoke("sessionSearch:rebuild"),
  deleteIndex: (): Promise<SessionSearchStatus> => ipcRenderer.invoke("sessionSearch:delete"),
  dismissIntro: (): Promise<SessionSearchStatus> => ipcRenderer.invoke("sessionSearch:dismiss-intro"),
  onStatus: (handler: (status: SessionSearchStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: SessionSearchStatus) => handler(status);
    ipcRenderer.on("sessionSearch:status", listener);
    return () => ipcRenderer.off("sessionSearch:status", listener);
  },
};
