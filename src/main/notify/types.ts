// The notify pipeline's wire types live in @shared/types (the renderer
// consumes them too); re-exported here so main-side producers can import
// everything notification-shaped from src/main/notify.
export type {
  NavigationTarget,
  NotificationCenterEntry,
  NotificationCenterSummary,
  NotifyEvent,
  NotifyKind,
  UiAttentionSnapshot,
} from "@shared/types";

// Everything publish() needs from a producer; id/createdAt are stamped at
// publish time.
export type PublishInput = Omit<
  import("@shared/types").NotifyEvent,
  "id" | "createdAt"
>;
