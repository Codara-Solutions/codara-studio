// window.spark.keepAwake: the renderer side of src/main/keep-awake/. The mode
// and the lid option are ordinary preferences (keepAwakeMode,
// keepAwakeLidClosed) written through window.spark.preferences; this area
// only reads what main is doing about them.

import { ipcRenderer } from "electron";

import type { KeepAwakeStatus } from "@shared/keep-awake";
import { subscribe } from "../subscribe";

export const keepAwakeApi = {
  /** The current status, re-read now. null before main has started it. */
  status: (): Promise<KeepAwakeStatus | null> => ipcRenderer.invoke("keepAwake:status"),
  onChanged: subscribe<KeepAwakeStatus>("keepAwake:changed"),
};
