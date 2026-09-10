import type { NotifyEvent } from "@shared/types";
import type { RemotePhoneNotification } from "./rpc";

export function phoneNotificationFromTerminalEvent(
  event: NotifyEvent,
): RemotePhoneNotification | null {
  if (event.target.type !== "terminal") return null;
  const kind = event.kind === "terminal.agent.needs-input" ? "blocked"
    : event.kind === "terminal.agent.done" ? "completed"
      : event.kind === "terminal.agent.failed" ? "failed" : null;
  if (!kind) return null;
  return {
    id: event.id,
    kind,
    title: event.title,
    body: event.body.replace(/ Click to (?:jump to|inspect) the terminal\.$/, ""),
    workspaceId: event.target.workspaceId,
    ...(event.workspaceName ? { workspaceName: event.workspaceName } : {}),
    terminalPaneId: event.target.paneId,
    createdAt: event.createdAt,
  };
}
