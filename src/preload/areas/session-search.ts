// window.spark.sessionSearch: the renderer side of
// src/main/session-search/service.ts (the local index of agent transcripts).

import { ipcRenderer } from "electron";
import type {
  SessionLabel,
  SessionPreview,
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
  preview: (key: string): Promise<SessionPreview | null> => ipcRenderer.invoke("sessionSearch:preview", key),
  /** Names or pins a session; a null name goes back to its own title. */
  setLabel: (key: string, patch: { name?: string | null; pinned?: boolean }): Promise<SessionLabel | null> =>
    ipcRenderer.invoke("sessionSearch:set-label", key, patch),
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
