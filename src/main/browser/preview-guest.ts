// The <webview> guest a preview call addresses. The renderer's registry owns
// "which tab" (an explicit tabId, the run's own tab, the caller pane's tab);
// main proves the id it answers with is a real guest of the trusted window
// before anything drives it.

import { webContents, type WebContents } from "electron";

import { isTrustedPreviewGuest } from "../main-window-trust";
import { requestPreviewOp } from "../preview-bridge";
import { bindPreviewTabGuest } from "./preview-cdp";

export interface PreviewGuestInfo {
  webContentsId: number;
  tabId: string;
  workspaceId?: string | null;
  url: string | null;
  viewport: { width: number; height: number } | null;
  devicePixelRatio: number;
}

export async function resolvePreviewGuest(
  params: Record<string, unknown>,
  focus = false,
): Promise<{ wc: WebContents; info: PreviewGuestInfo }> {
  const tabId = typeof params.tabId === "string" ? params.tabId : null;
  // Forward the caller's run identity: without an explicit tabId the renderer
  // scopes its pick to the tabs that run owns, so trusted-input ops resolve the
  // same guest the DOM ops would, never the user's own preview tab. A caller
  // with no run is scoped the same way by the pane it runs in.
  const runId = typeof params.runId === "string" ? params.runId : null;
  const info = (await requestPreviewOp("get_web_contents_id", {
    tabId,
    runId,
    workspaceId: params.workspaceId,
    callerPaneId: params.callerPaneId,
    focus,
  })) as PreviewGuestInfo;
  const wcId = info?.webContentsId;
  if (typeof wcId !== "number") {
    throw new Error("preview tab is not ready (no web contents id yet)");
  }
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) {
    throw new Error("preview tab web contents is gone; reopen the preview tab and retry");
  }
  // The webContentsId arrives over the preview bridge, whose response is only
  // correlated by reqId. Even though that response channel is now sender-gated,
  // NEVER drive CDP / executeJavaScript / DOM.setFileInputFiles against an id we
  // have not proven is a real <webview> guest of the trusted main window: that
  // is the difference between "steer the agent's preview tab" and "attach the
  // DevTools protocol to an arbitrary webContents and push local file paths into
  // a file input". Reject anything that is not a genuine preview guest.
  if (!isTrustedPreviewGuest(wc)) {
    throw new Error("preview target is not a preview guest of this window");
  }
  if (typeof info.tabId === "string" && info.tabId) bindPreviewTabGuest(info.tabId, wc);
  return { wc, info };
}
