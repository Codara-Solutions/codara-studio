// window.spark.featureTips: the renderer side of src/main/feature-tips.ts
// (what this person used and which tips they saw, kept on this computer).

import { ipcRenderer } from "electron";
import type { FeatureTipOutcome, FeatureTipsBoot, FeatureTipsState } from "@shared/feature-tips";

export const featureTipsApi = {
  load: (): Promise<FeatureTipsBoot> => ipcRenderer.invoke("feature-tips:load"),
  recordUse: (ids: string[]): Promise<FeatureTipsState> => ipcRenderer.invoke("feature-tips:record-use", ids),
  tipShown: (id: string): Promise<FeatureTipsState> => ipcRenderer.invoke("feature-tips:tip-shown", id),
  tipOutcome: (id: string, outcome: FeatureTipOutcome): Promise<FeatureTipsState> =>
    ipcRenderer.invoke("feature-tips:tip-outcome", id, outcome),
  setEnabled: (enabled: boolean): Promise<FeatureTipsState> => ipcRenderer.invoke("feature-tips:set-enabled", enabled),
  reset: (): Promise<FeatureTipsState> => ipcRenderer.invoke("feature-tips:reset"),
  onChanged: (handler: (state: FeatureTipsState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: FeatureTipsState) => handler(state);
    ipcRenderer.on("feature-tips:changed", listener);
    return () => ipcRenderer.off("feature-tips:changed", listener);
  },
};
