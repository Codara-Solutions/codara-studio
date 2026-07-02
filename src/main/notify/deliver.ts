import { BrowserWindow, Notification } from "electron";
import type {
  NavigationTarget,
  NotificationChannelsPref,
  NotifyEvent,
  TerminalAgentAttentionPayload,
} from "@shared/types";

// The four delivery transports for an alert the policy let through, gated by
// the user's per-channel preferences. Each channel is best-effort: a thrown
// error in one must not break the others.
//
//   - inApp   → renderer toast via "notification:in-app"
//   - native  → Electron Notification; click focuses the window and routes
//               the event's NavigationTarget through "notify:focus"
//   - sound   → renderer chime via "notification:sound"
//   - osCues  → Windows taskbar flash (cleared on focus). The macOS dock
//               badge is owned by center-store (unread count), not here.

let getMainWindow: () => BrowserWindow | null = () => null;

export function registerDeliveryWindow(win: BrowserWindow): void {
  getMainWindow = () => win;
  win.on("focus", () => {
    if (process.platform === "win32") {
      try {
        win.flashFrame(false);
      } catch {
        /* clearing is best-effort */
      }
    }
  });
}

export function activeWindow(): BrowserWindow | null {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) return win;
  for (const candidate of BrowserWindow.getAllWindows()) {
    if (!candidate.isDestroyed()) return candidate;
  }
  return null;
}

export function focusTarget(target: NavigationTarget): void {
  const win = activeWindow();
  if (!win) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("notify:focus", target);
  } catch (err) {
    console.warn("[notify] focus routing failed:", err);
  }
}

export function deliver(event: NotifyEvent, channels: NotificationChannelsPref): void {
  const win = activeWindow();

  // Persistent attention marker for the workspace rail — sent before the
  // channel gates on purpose: even with every channel muted, the rail dot
  // should record that a terminal wants the user.
  if (event.target.type === "terminal") {
    try {
      const payload: TerminalAgentAttentionPayload = {
        target: event.target,
        kind: event.kind === "terminal.agent.needs-input" ? "blocked" : "complete",
      };
      win?.webContents.send("terminal-agent:attention", payload);
    } catch {
      /* best-effort */
    }
  }

  if (channels.inApp && win) {
    try {
      win.webContents.send("notification:in-app", event);
    } catch (err) {
      console.warn("[notify] in-app send failed:", err);
    }
  }

  if (channels.native) {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: event.title, body: event.body });
        n.on("click", () => focusTarget(event.target));
        n.show();
      }
    } catch (err) {
      console.warn("[notify] native fire failed:", err);
    }
  }

  if (channels.sound && win) {
    try {
      win.webContents.send("notification:sound", { kind: event.soundKind });
    } catch (err) {
      console.warn("[notify] sound send failed:", err);
    }
  }

  if (channels.osCues && process.platform === "win32" && win) {
    try {
      win.flashFrame(true);
    } catch (err) {
      console.warn("[notify] OS-cue fire failed:", err);
    }
  }
}
