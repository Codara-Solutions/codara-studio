import type { NotifyEvent } from "@shared/types";
import type { RemotePhoneNotification } from "./rpc";

export function phoneNotificationFromGitEvent(event: NotifyEvent): RemotePhoneNotification | null {
  if (event.target.type !== "workspace" || event.target.panel !== "git") return null;
  if (event.kind !== "git.teammate-push" && event.kind !== "git.pull-request") return null;
  return {
    id: event.id,
    kind: "github",
    title: event.title,
    body: event.body,
    workspaceId: event.target.workspaceId,
    ...(event.workspaceName ? { workspaceName: event.workspaceName } : {}),
    sourceView: event.kind === "git.teammate-push" ? "history" : "queue",
    createdAt: event.createdAt,
  };
}
