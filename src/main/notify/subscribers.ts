import type { NotifyEvent } from "@shared/types";

const listeners = new Set<(event: NotifyEvent) => void | Promise<void>>();

export function subscribeDeliveredNotifications(
  listener: (event: NotifyEvent) => void | Promise<void>,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called only after policy accepts delivery, so mirrors share its dedupe and DND rules. */
export function publishDeliveredNotification(event: NotifyEvent): void {
  for (const listener of [...listeners]) {
    try {
      void Promise.resolve(listener(event)).catch((error) => {
        console.warn("[notify] subscriber failed:", error);
      });
    } catch (error) {
      console.warn("[notify] subscriber failed:", error);
    }
  }
}
