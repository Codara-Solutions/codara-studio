import { BrowserWindow, Notification } from "electron";
import type {
  NavigationTarget,
  NotificationChannelsPref,
  NotificationSoundKind,
  NotifyEvent,
  TerminalAgentAttentionPayload,
} from "@shared/types";
import { E2E_BACKGROUND, revealWindow } from "../e2e-background";
import { logMain } from "../file-log";
import { createNotificationRetainer } from "./native-retain";

// The four delivery transports for an alert the policy let through, gated by
// the user's per-channel preferences. Each channel is best-effort: a thrown
// error in one must not break the others.
//
//   - inApp   → renderer toast via "notification:in-app"
//   - native  → Electron Notification; click focuses the window and routes
//               the event's NavigationTarget through "notify:focus". Each
//               one stays held (native-retain.ts) until the OS is done with
//               it, or its click would never arrive
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
let toastActivationHandled = false;

export function registerDeliveryWindow(win: BrowserWindow): void {
  getMainWindow = () => win;
  // A toast clicked in the Action Center after its Notification was let go
  // (past the retainer's cap, or raised by an earlier run) reaches only this
  // callback, and a plain click carries no id to route by, so bringing the
  // window forward is all it can do. A held toast also gets its own click.
  if (process.platform === "win32" && !E2E_BACKGROUND && !toastActivationHandled) {
    toastActivationHandled = true;
    try {
      Notification.handleActivation(() => {
        const target = activeWindow();
        if (target) revealWindow(target);
      });
    } catch (err) {
      console.warn("[notify] toast activation handler failed:", err);
    }
  }
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

// entryId is the center row the alert landed in. The renderer marks it read
// once the target opened, as a click on the row itself does.
export function focusTarget(target: NavigationTarget, entryId?: string): void {
  const win = activeWindow();
  if (!win) return;
  try {
    revealWindow(win);
    win.webContents.send("notify:focus", target, entryId);
  } catch (err) {
    console.warn("[notify] focus routing failed:", err);
  }
}

const retainedNotifications = createNotificationRetainer<Notification>();

interface E2eNativeNotification {
  id: string;
  title: string;
  body: string;
  target: NavigationTarget;
  notification: WeakRef<Notification>;
}

// The e2e seam: a test app builds and wires every notification exactly as a
// real one but never shows it, and lists it here so a spec can fire its click
// from main. The reference is weak so the list cannot keep alive a
// notification the retainer let go.
function recordForE2e(event: NotifyEvent, notification: Notification): void {
  const host = globalThis as { __codaraNativeNotifications?: E2eNativeNotification[] };
  (host.__codaraNativeNotifications ??= []).push({
    id: event.id,
    title: notification.title,
    body: notification.body,
    target: event.target,
    notification: new WeakRef(notification),
  });
}

function showNative(event: NotifyEvent): void {
  if (!E2E_BACKGROUND && !Notification.isSupported()) return;
  // macOS has a subtitle line for the workspace; elsewhere it rides on
  // the title so the origin is never lost in a one-line banner.
  const notification = new Notification(
    process.platform === "darwin"
      ? {
          title: event.title,
          body: event.body,
          ...(event.workspaceName ? { subtitle: event.workspaceName } : {}),
        }
      : {
          title: event.workspaceName ? `${event.title} · ${event.workspaceName}` : event.title,
          body: event.body,
        },
  );
  retainedNotifications.hold(notification, () => focusTarget(event.target, event.id));
  // An e2e app is never focused, so every alert it raised would become a
  // real OS notification on the desktop of whoever ran the suite.
  if (E2E_BACKGROUND) {
    recordForE2e(event, notification);
    return;
  }
  notification.show();
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

// Several panes can finish in the same second (a split of agents fed one
// prompt each). One chime says "look"; a stack of them is noise, so a chime
// inside this window of the previous one of the same kind is dropped. A
// different kind (a prompt right after a finish) still sounds, since it asks
// for something else. The toast and the native notification for each event
// still fire.
const SOUND_BURST_MS = 1_500;
const lastSoundAt = new Map<NotificationSoundKind, number>();

export function deliver(event: NotifyEvent, channels: NotificationChannelsPref): void {
  const win = activeWindow();

  const appFocused = isAppFocused(win);
  const now = Date.now();
  const soundInBurst = now - (lastSoundAt.get(event.soundKind) ?? 0) < SOUND_BURST_MS;

  // Which transports actually fire — a sound with no toast and no OS
  // notification (window unfocused + native off) is otherwise indistinguishable
  // from a phantom chime after the fact.
  logMain(
    "notify",
    `channels id=${event.id} focused=${appFocused} toast=${channels.inApp && !!win && appFocused} native=${channels.native && (!appFocused || !channels.inApp)} sound=${channels.sound && !!win && !event.silent && !soundInBurst} osCues=${channels.osCues}`,
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
      showNative(event);
    } catch (err) {
      console.warn("[notify] native fire failed:", err);
    }
  }

  // event.silent suppresses only the chime — informational alerts still get
  // their toast, bell entry and OS cue.
  if (channels.sound && win && !event.silent && !soundInBurst) {
    lastSoundAt.set(event.soundKind, now);
    try {
      win.webContents.send("notification:sound", { kind: event.soundKind });
    } catch (err) {
      console.warn("[notify] sound send failed:", err);
    }
  }

  if (channels.osCues && !E2E_BACKGROUND && process.platform === "win32" && win) {
    try {
      win.flashFrame(true);
    } catch (err) {
      console.warn("[notify] OS-cue fire failed:", err);
    }
  }
}
