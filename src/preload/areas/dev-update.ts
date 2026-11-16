// window.spark.devUpdate: a dev build's "Studio is N changes behind main"
// line (src/main/dev-update-hint.ts). Always null in a packaged build.

import { ipcRenderer } from "electron";

import type { DevUpdateHint } from "@shared/dev-update-hint";
import { subscribe } from "../subscribe";

export const devUpdateApi = {
  /** Read again now; null when there is nothing to say. */
  status: (): Promise<DevUpdateHint | null> => ipcRenderer.invoke("devUpdate:status"),
  onChanged: subscribe<DevUpdateHint | null>("devUpdate:changed"),
};
