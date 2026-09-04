import { BrowserWindow, Notification } from "electron";
import type {
  NavigationTarget,
  NotificationChannelsPref,
  NotifyEvent,
  TerminalAgentAttentionPayload,
} from "@shared/types";
import { revealWindow } from "../e2e-background";
import { logMain } from "../file-log";

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
//
// inApp and native are the same alert shown two ways, so they never fire
// together — that duplicate (one toast inside the app, one in the OS notif
// center) is exactly what we avoid. They split on window focus: when Codara
// Studio is the focused foreground window the user sees the in-app toast, so
// that's the alert; when it is minimized or in the background the toast would
// go unseen, so the native OS notification takes over. See isAppFocused().

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

// True when the given window is the focused foreground window — i.e. the user
// is actually looking at Codara Studio and would see an in-app toast. A
// minimized window is never focused, and neither is one sitting behind another
// app, so this is precisely the "in the app now" vs "away, notify me" split.
function isAppFocused(win: BrowserWindow | null): boolean {
  return !!win && !win.isMinimized() && win.isFocused();
}

export function focusTarget(target: NavigationTarget): void {
  const win = activeWindow();
  if (!win) return;
  try {
    revealWindow(win);
    win.webContents.send("notify:focus", target);
  } catch (err) {
    console.warn("[notify] focus routing failed:", err);
  }
}

// Persistent terminal attention is separate from intrusive delivery. The
// notify policy calls this even for DND-muted unread events, so muting sound /
// toasts never makes a background permission prompt impossible to find.
export function signalTerminalAttention(event: NotifyEvent): void {
  if (event.target.type !== "terminal") return;
  try {
    const payload: TerminalAgentAttentionPayload = {
      target: event.target,
      kind:
        event.kind === "terminal.agent.needs-input" ||
        event.kind === "terminal.agent.failed"
          ? "blocked"
          : "complete",
    };
    activeWindow()?.webContents.send("terminal-agent:attention", payload);
  } catch {
    /* best-effort */
  }
}

export function deliver(event: NotifyEvent, channels: NotificationChannelsPref): void {
  const win = activeWindow();

  const appFocused = isAppFocused(win);

  // Which transports actually fire — a sound with no toast and no OS
  // notification (window unfocused + native off) is otherwise indistinguishable
  // from a phantom chime after the fact.
  logMain(
    "notify",
    `channels id=${event.id} focused=${appFocused} toast=${channels.inApp && !!win && appFocused} native=${channels.native && (!appFocused || !channels.inApp)} sound=${channels.sound && !!win && !event.silent} osCues=${channels.osCues}`,
  );

  // In-app toast: only when the window is focused, so it can actually be seen.
  // When Codara Studio is minimized or backgrounded the toast would just stack
  // unseen, and the native channel covers that case instead.
  if (channels.inApp && win && appFocused) {
    try {
      win.webContents.send("notification:in-app", event);
    } catch (err) {
      console.warn("[notify] in-app send failed:", err);
    }
  }

  // Native OS notification: the away-fallback. Fire it whenever the in-app
  // toast is NOT the alert — either the window isn't focused (minimized /
  // backgrounded), or the in-app channel is turned off — so enabling both
  // channels never produces the double notification.
  if (channels.native && (!appFocused || !channels.inApp)) {
    try {
      if (Notification.isSupported()) {
        // macOS has a subtitle line for the workspace; elsewhere it rides on
        // the title so the origin is never lost in a one-line banner.
        const n = new Notification(
          process.platform === "darwin"
            ? {
                title: event.title,
                body: event.body,
                ...(event.workspaceName ? { subtitle: event.workspaceName } : {}),
              }
            : {
                title: event.workspaceName
                  ? `${event.title} · ${event.workspaceName}`
                  : event.title,
                body: event.body,
              },
        );
        n.on("click", () => focusTarget(event.target));
        n.show();
      }
    } catch (err) {
      console.warn("[notify] native fire failed:", err);
    }
  }

  // event.silent suppresses only the chime — informational alerts still get
  // their toast, bell entry and OS cue.
  if (channels.sound && win && !event.silent) {
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
