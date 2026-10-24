import type { NotificationViewSnapshot } from "@shared/types";

// The surface on screen, as far as notifications care: the visible run, the
// selected terminal pane and the automation whose page is open. The matching
// rule lives in @shared/notify-center so the main-process store applies the
// same one when it marks rows read.
export type ActiveNotificationView = NotificationViewSnapshot;

export { isTargetViewed as isNotificationTargetViewed } from "@shared/notify-center";

// A stable string for a view, so a caller can act once per real change
// instead of once per re-render that rebuilt an equal object.
export function notificationViewKey(view: ActiveNotificationView): string {
  const t = view.terminal;
  const a = view.automation;
  return [
    view.workspaceId ?? "",
    view.visibleRunId ?? "",
    t ? `${t.workspaceId}/${t.tabId}/${t.paneId}` : "",
    a ? `${a.workspaceId}/${a.jobId}` : "",
  ].join("|");
}
