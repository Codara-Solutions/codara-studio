import type { InAppNotificationTone } from "@shared/types";

// Renderer-local toast feedback, i.e. a card that answers a keypress the user
// just made. It is deliberately NOT a NotifyEvent from the main process: that
// pipeline suppresses anything whose target is already on screen (the
// suppress-while-watching policy), which is exactly the situation whenever a
// chord acts on the surface the user is looking at.
//
// ToastHost listens for this event and renders it as a plain, non-clickable
// card on the usual auto-dismiss timer. Nothing is persisted to the
// notification center — there is nothing to come back to later.
export function emitLocalToast(
  title: string,
  body = "",
  tone: InAppNotificationTone = "success",
): void {
  window.dispatchEvent(
    new CustomEvent("spark:local-toast", { detail: { title, body, tone } }),
  );
}
