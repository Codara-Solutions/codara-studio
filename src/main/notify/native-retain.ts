// Keeps every shown native notification reachable until the OS is done with
// it. Electron reports a click only to a live Notification object: once V8
// collects the object, its destructor detaches it from the OS notification,
// which stays on screen (in a libnotify history, the Windows Action Center or
// the macOS Notification Center) with a click that goes nowhere. A local that
// falls out of scope right after show() is collected long before anyone
// clicks it.
//
// A notification is let go when it is clicked, when it fails, or when the OS
// closes it. A Windows toast that timed out is the exception: it moved to the
// Action Center, where it can still be clicked. The cap bounds a long session
// of alerts nobody clicks; past it the oldest is withdrawn from the OS, since
// an entry that cannot be opened is worse than a missing one.

export const NATIVE_NOTIFICATION_CAP = 50;

export interface HeldNotification {
  on(event: "click", listener: () => void): unknown;
  on(event: "close", listener: (details?: { reason?: string }) => void): unknown;
  on(event: "failed", listener: () => void): unknown;
  close(): void;
}

export interface NotificationRetainer<T extends HeldNotification> {
  hold(notification: T, onClick: () => void): void;
  held(): readonly T[];
}

export function createNotificationRetainer<T extends HeldNotification>(options: {
  cap?: number;
  platform?: NodeJS.Platform;
} = {}): NotificationRetainer<T> {
  const cap = Math.max(1, options.cap ?? NATIVE_NOTIFICATION_CAP);
  const platform = options.platform ?? process.platform;
  const live = new Set<T>();

  return {
    hold(notification, onClick) {
      notification.on("click", () => {
        live.delete(notification);
        onClick();
      });
      notification.on("close", (details) => {
        if (platform === "win32" && details?.reason === "timedOut") return;
        live.delete(notification);
      });
      notification.on("failed", () => {
        live.delete(notification);
      });
      live.add(notification);
      for (const oldest of live) {
        if (live.size <= cap) break;
        live.delete(oldest);
        try {
          oldest.close();
        } catch {
          /* already gone from the OS */
        }
      }
    },
    held: () => [...live],
  };
}
