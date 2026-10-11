import { BrowserWindow } from "electron";
import type { AppState } from "@shared/types";
import { setAllowedRoots } from "./fs-sandbox";
import { workspaceAllowedRoots } from "./workspace-state-edits";

// Tell every renderer about a state the main process just saved, after
// widening the fs sandbox to match it. Callers save through updateState first.
export function publishState(state: AppState): void {
  setAllowedRoots(workspaceAllowedRoots(state));
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send("state:changed", state);
    } catch {
      // A renderer may close between enumeration and send.
    }
  }
}
