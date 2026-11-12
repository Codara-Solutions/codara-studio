// window.spark.devUpdate: a dev build's "Studio is N changes behind main"
// line (src/main/dev-update-hint.ts). Always null in a packaged build.

import { ipcRenderer } from "electron";

import type { DevUpdateHint } from "@shared/dev-update-hint";

export const devUpdateApi = {
  /** Read again now; null when there is nothing to say. */
  status: (): Promise<DevUpdateHint | null> => ipcRenderer.invoke("devUpdate:status"),
  onChanged: (handler: (hint: DevUpdateHint | null) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, hint: DevUpdateHint | null) => handler(hint);
    ipcRenderer.on("devUpdate:changed", listener);
    return () => ipcRenderer.off("devUpdate:changed", listener);
  },
};
