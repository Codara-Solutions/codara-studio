import { BrowserWindow } from "electron";
import type { AppState } from "@shared/types";
import { setAllowedRoots } from "./fs-sandbox";
import { noteCenterWorkspaces } from "./notify/center-store";
import { workspaceAllowedRoots } from "./workspace-state-edits";

// Tell every renderer about a state the main process just saved, after
// widening the fs sandbox to match it, and let the notification center drop
// rows of a workspace that is gone. Callers save through updateState first.
export function publishState(state: AppState): void {
  setAllowedRoots(workspaceAllowedRoots(state));
  void noteCenterWorkspaces(state.workspaces.map((w) => w.id)).catch(() => undefined);
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
