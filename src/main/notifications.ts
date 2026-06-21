import { app, BrowserWindow, Notification } from "electron";
import { makeId } from "@shared/ids";
import type {
  InAppNotificationPayload,
  InAppNotificationTone,
  NotificationChannelsPref,
  NotificationSoundKind,
  RunStatus,
  RuntimeState,
  SparkEvent,
  TerminalAgentStatePayload,
  TerminalAgentTarget,
} from "@shared/types";
import { subscribeToEvents } from "./orchestration/event-log";
import { loadPreferences } from "./preferences-store";

// Four-channel notification system: one place that decides whether an
// alert fires, and four parallel transports that physically deliver it.
//
// The 3-rule policy from quick wins gates every alert BEFORE any channel
// is consulted, so channel toggles can never turn on noise the policy
// already suppressed:
//
//   1. Always alert when an agent gets stuck waiting for input.
//      (run.status transitions to "blocked")
//   2. Alert on completion only if the user is not looking at it.
//      (run.status transitions to "complete" / "failed" AND the main
//       window is not focused OR the active workspace is different)
//   3. Never alert when the state has not actually changed.
//      (we remember the last status we alerted on per run; same status
//       again is a no-op)
//
// Once an alert passes the policy, we fan it out across the four
// channels gated by the user's NotificationChannelsPref:
//
//   - inApp   → renderer toast via "notification:in-app"
//   - native  → Electron Notification (OS-level)
//   - sound   → renderer plays a short audio clip via "notification:sound"
//   - osCues  → macOS dock badge / Windows taskbar flash

// Per-run status we last alerted the user about. Drives rule 3 (no-change
// suppression) — without this, a run that flaps between "blocked" and
// "blocked" because of two consecutive worker failures would alert
// twice.
const lastAlertedStatus = new Map<string, RunStatus>();

// Terminal-completion dedup guard (Bug 1). Once a run has alerted a terminal
// completion (complete / failed), a later "blocked" for the SAME run is
// suppressed — it is almost always a loom co-blocked-sibling re-emit or a
// settle race firing after the user was already told the run finished, ~2 min
// later with nothing actually happening. We only re-arm (allow a fresh blocked
// alert) once the run is observed passing back through an active/working state
// (running / planning / reviewing), i.e. real new work began. A run id lives in
// this set iff its most recent alert was a terminal completion and no active
// transition has been seen since.
const alertedTerminalCompletion = new Set<string>();

// Statuses that count as "real new activity" for the dedup guards. paused/idle
// are intentionally excluded: a paused run (manager question via askHumanQuestion
// → pauseRun) is a quiescent wait, not resumed work, so it must NOT re-arm the
// blocked alert. Mirrors the per-pane "working" re-arm in terminal-agent-notify.
function isActiveStatus(status: RunStatus): boolean {
  return status === "running" || status === "planning" || status === "reviewing";
}

// Unseen alert counter. macOS dock badges and Windows taskbar flashes
// stay set until the user focuses Spark, at which point we clear both.
// Storing the count lets us roll up "2 chats need you" into a single
// badge instead of overwriting it on every alert.
let unseenAlertCount = 0;

// Main window reference, injected by index.ts after createWindow(). The
// notifier needs access to webContents for renderer-side channels and to
// the BrowserWindow itself for OS cues (flashFrame). We keep a getter
// so a future renderer crash + recreate works without restarting the
// notifier.
let getMainWindow: () => BrowserWindow | null = () => null;

export function setMainWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindow = getter;
}

// ── Quick-win compatibility surface.
//
// The earlier 3-rule notifier exposed registerMainWindow + setActiveRunId +
// notifyRunStateTransition; ipc.ts / index.ts / run-store.ts still call them.
// We bridge those names onto the four-channel infrastructure so the upstream
// callers don't need to know it was rewired:
//   - registerMainWindow → setMainWindowGetter + attachFocusClear
//   - setActiveRunId     → tab-aware suppression input (rule 2)
//   - notifyRunStateTransition → no-op shim; subscribeToEvents already
//     handles status transitions for us, so the run-store dynamic import
//     becomes a benign duplicate signal.
let activeRunId: string | null = null;

export function setActiveRunId(id: string | null): void {
  activeRunId = id;
}

function getActiveRunId(): string | null {
  return activeRunId;
}

export function registerMainWindow(win: BrowserWindow): void {
  setMainWindowGetter(() => win);
  attachFocusClear(win);
}

export function notifyRunStateTransition(
  _run: import("@shared/types").RunState,
  _prev: import("@shared/types").RunState["status"] | null,
  _next: import("@shared/types").RunState["status"],
): void {
  // Intentional no-op. The subscribeToEvents path in startNotifications()
  // already handles run.status_updated. Kept so run-store.ts's dynamic
  // import doesn't fail; a follow-up can drop the run-store call entirely.
}

// Resolve the renderer-facing transport. Channels that go through the
// renderer (inApp toast + sound clip) need a live BrowserWindow.
function activeWindow(): BrowserWindow | null {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) return win;
  // Fallback: any focused window. In single-window Spark this is rarely
  // needed, but the dual-window settings surface used to live here.
  const all = BrowserWindow.getAllWindows();
  for (const candidate of all) {
    if (!candidate.isDestroyed()) return candidate;
  }
  return null;
}

// Whether the user is currently looking at the chat that needs them.
// Rule 2 ("don't alert on complete if you're already watching") consults
// this — without it, finishing a run you have on screen would still ping
// you, which the herdr learning explicitly calls out as bad UX.
//
// Tab-aware: focused window alone isn't enough. Spark can be focused on a
// DIFFERENT chat than the one that finished, in which case the alert is
// still useful. We only suppress when focus + the renderer-reported active
// run id both match the run that emitted the event.
function isUserWatching(runId: string): boolean {
  const win = activeWindow();
  if (!win) return false;
  if (!win.isFocused()) return false;
  const active = getActiveRunId();
  return active === runId;
}

// Drive the four channels for a single alert, gated by per-channel
// preferences. Each channel is best-effort: a thrown error in one must
// not break the others, since the user has no recourse if (e.g.) the
// renderer is mid-reload and the toast send blows up.
function fanout(
  channels: NotificationChannelsPref,
  alert: {
    kind: "blocked" | "complete";
    // Colour intent for the in-app toast. Decoupled from kind so a "blocked"
    // needs-you reads amber (warning) while a genuine failure reads red
    // (danger); see InAppNotificationTone.
    tone?: InAppNotificationTone;
    title: string;
    body: string;
    runId?: string;
    workspaceId?: string;
    soundKind: NotificationSoundKind;
    // Terminal-agent alerts carry a navigation target instead of a runId.
    // The toast click (renderer) and native-notification click (here) both
    // route to the terminal tab + pane that raised the alert.
    terminal?: TerminalAgentTarget;
    onNativeClick?: () => void;
  },
): void {
  const win = activeWindow();
  const payload: InAppNotificationPayload = {
    id: makeId("toast"),
    kind: alert.kind,
    tone: alert.tone,
    title: alert.title,
    body: alert.body,
    runId: alert.runId,
    workspaceId: alert.workspaceId,
    createdAt: new Date().toISOString(),
    terminal: alert.terminal,
  };

  if (channels.inApp && win) {
    try {
      win.webContents.send("notification:in-app", payload);
    } catch (err) {
      console.warn("[notifications] in-app send failed:", err);
    }
  }

  if (channels.native) {
    try {
      // Electron's Notification is only available when the OS supports
      // notifications. Notification.isSupported() returns false on rare
      // headless boxes; gating prevents an exception there.
      if (Notification.isSupported()) {
        const n = new Notification({
          title: alert.title,
          body: alert.body,
          // No silent flag — the OS picks the system sound for the kind
          // of notification. Our embedded sound clip is a SEPARATE
          // channel toggled independently.
        });
        if (alert.onNativeClick) {
          n.on("click", () => {
            try {
              alert.onNativeClick?.();
            } catch (err) {
              console.warn("[notifications] native click handler failed:", err);
            }
          });
        }
        n.show();
      }
    } catch (err) {
      console.warn("[notifications] native fire failed:", err);
    }
  }

  if (channels.sound && win) {
    try {
      win.webContents.send("notification:sound", { kind: alert.soundKind });
    } catch (err) {
      console.warn("[notifications] sound send failed:", err);
    }
  }

  if (channels.osCues) {
    unseenAlertCount += 1;
    try {
      if (process.platform === "darwin") {
        // setBadgeCount lives on the app object on macOS. On other
        // platforms it silently no-ops — we still call it because
        // Electron's typings allow it everywhere; the guard above
        // pins it to macOS.
        app.setBadgeCount(unseenAlertCount);
      } else if (process.platform === "win32" && win) {
        // flashFrame draws attention without focusing the window.
        // Clears on focus, in the listener we attach in start().
        win.flashFrame(true);
      }
    } catch (err) {
      console.warn("[notifications] OS-cue fire failed:", err);
    }
  }
}

// Clear OS cues when the user comes back to Spark. macOS badge → 0,
// Windows taskbar flash → off. We don't touch the seen flag for runs
// here — that lives in run-store and is set by the renderer when the
// user opens a chat. Focus just means "the user noticed Spark"; the
// per-chat seen flag is finer-grained.
function attachFocusClear(win: BrowserWindow): void {
  win.on("focus", () => {
    unseenAlertCount = 0;
    try {
      if (process.platform === "darwin") {
        app.setBadgeCount(0);
      } else if (process.platform === "win32") {
        win.flashFrame(false);
      }
    } catch {
      /* clearing is best-effort */
    }
  });
}

// Map a run-store event to an alert, or null if the event doesn't trip
// the policy. The function deliberately doesn't read preferences itself
// — fanout() does that — so this stays a pure decision function and is
// trivial to verify by reading the rules above.
function policyDecision(event: SparkEvent): {
  kind: "blocked" | "complete";
  tone: InAppNotificationTone;
  title: string;
  body: string;
  runId: string;
  workspaceId?: string;
  soundKind: NotificationSoundKind;
} | null {
  // We only care about run-level status transitions. Worker events fire
  // many times per run and would create noise; the manager's run-status
  // updates are the canonical "user-visible state changed" signal.
  if (event.type !== "run.status_updated") return null;

  const payload = event.payload as
    | { status?: unknown; previousStatus?: unknown }
    | undefined;
  const status = typeof payload?.status === "string" ? (payload.status as RunStatus) : undefined;
  const prevStatus =
    typeof payload?.previousStatus === "string"
      ? (payload.previousStatus as RunStatus)
      : undefined;
  if (!status) return null;

  const runId = event.runId;
  if (!runId) return null;

  // Rule 3: no-change suppression. The manager occasionally re-sends the
  // same status as part of a state reconcile; skipping the duplicate
  // keeps the notification stream meaningful.
  if (prevStatus === status) return null;
  if (lastAlertedStatus.get(runId) === status) return null;

  // When a run transitions back into an active state (running / planning /
  // reviewing / paused / idle), clear the cached alert status so a future
  // re-entry into the same terminal state DOES alert. Otherwise a run that
  // flaps blocked → running → blocked would only alert on the first
  // blocked, which masks the user from a real second stall.
  if (
    status === "running" ||
    status === "planning" ||
    status === "reviewing" ||
    status === "paused" ||
    status === "idle"
  ) {
    lastAlertedStatus.delete(runId);
    // Re-arm the terminal-completion guard ONLY on genuine active work
    // (running / planning / reviewing). A bare paused/idle is a quiescent
    // wait — not the "real new activity" that should let a post-completion
    // blocked alert through (Bug 1).
    if (isActiveStatus(status)) {
      alertedTerminalCompletion.delete(runId);
    }
    return null;
  }

  const workspaceId = event.workspaceId;

  if (status === "blocked") {
    // Bug 1 — terminal-completion dedup. If we already told the user this run
    // finished (complete/failed) and no active work has happened since, swallow
    // the blocked alert: it is the loom co-blocked-sibling re-emit / settle race
    // firing minutes later with nothing actually new. The guard is cleared the
    // moment the run re-enters an active state (see above), so a real second
    // stall after resumed work still alerts.
    if (alertedTerminalCompletion.has(runId)) {
      return null;
    }
    // Rule 1: always alert when an agent gets stuck. Even if the user is
    // staring at the chat, surface the "needs you" cue — the renderer
    // toast manager dedupes when the chat is already open by suppressing
    // the OS cues there; this main-process policy alerts unconditionally
    // because the user might be in a different workspace.
    lastAlertedStatus.set(runId, status);
    return {
      kind: "blocked",
      // Bug 2 — a blocked run is the agent asking for you, not a failure;
      // colour it amber (warning), not red.
      tone: "warning",
      title: "Spark — needs you",
      body: event.message?.trim() || "A run is blocked and needs your attention.",
      runId,
      workspaceId,
      soundKind: "needs-you",
    };
  }

  if (status === "complete" || status === "failed") {
    // Rule 2: don't fire on completion if the user is already looking.
    // isUserWatching() is the cheapest possible check (one isFocused()
    // call). When unfocused, fire — they delegated and walked away, the
    // whole point of Spark is to ping them when work is done.
    if (isUserWatching(runId)) {
      // Still mark the status so we don't fire later when the same run
      // re-emits the same status during a state replay.
      lastAlertedStatus.set(runId, status);
      // Even when the toast is suppressed (user watching), arm the dedup
      // guard: the user has seen the terminal state, so a later co-blocked
      // re-emit should still be swallowed until real new work happens.
      alertedTerminalCompletion.add(runId);
      return null;
    }
    lastAlertedStatus.set(runId, status);
    // Bug 1 — remember this run reached a terminal completion so a later
    // blocked re-emit is suppressed until active work resumes.
    alertedTerminalCompletion.add(runId);
    const ok = status === "complete";
    return {
      kind: "complete",
      // Bug 2 — only a genuine failure is red (danger); a clean finish is
      // green (success).
      tone: ok ? "success" : "danger",
      title: ok ? "Spark — done" : "Spark — failed",
      body:
        event.message?.trim() ||
        (ok
          ? "A run just finished while you were away."
          : "A run failed while you were away."),
      runId,
      workspaceId,
      soundKind: "done",
    };
  }

  return null;
}

let started = false;

// Subscribe to run-store events and route each through the policy +
// fanout. Idempotent — repeat calls are no-ops, so wiring this from
// index.ts is safe even if app.whenReady() fires twice (which Electron
// doesn't, but defensive coding is cheap).
export function startNotifications(): void {
  if (started) return;
  started = true;

  // Wire the focus listener on whichever window is current. If a new
  // window is created later (settings surface used to do this), we'd
  // attach there too — but Spark is single-window now, so one is fine.
  const initialWin = activeWindow();
  if (initialWin) attachFocusClear(initialWin);

  subscribeToEvents((event) => {
    void handleEvent(event).catch((err) => {
      console.warn("[notifications] handler threw:", err);
    });
  });
}

async function handleEvent(event: SparkEvent): Promise<void> {
  const decision = policyDecision(event);
  if (!decision) return;

  const prefs = await loadPreferences();
  const channels = prefs.notificationChannels;
  // If every channel is off, the user has effectively disabled
  // notifications — short-circuit so we don't pay the unseenAlertCount
  // increment or any IPC sends.
  if (!channels.inApp && !channels.native && !channels.sound && !channels.osCues) {
    return;
  }

  fanout(channels, decision);
}

// Test-surface escape hatch. Allows the headless eval / a future unit
// test to clear remembered state between runs without restarting the
// process. Not exported on the IPC surface — main-process use only.
export function _resetNotificationStateForTests(): void {
  lastAlertedStatus.clear();
  alertedTerminalCompletion.clear();
  unseenAlertCount = 0;
}

// Mark that the user has explicitly seen / opened a run, allowing the
// notifier to alert again the next time it transitions into the same
// terminal status. Reserved for the future "seen flag" rollup work; not
// currently wired but exported so callers don't have to reach into the
// module's private state.
export function markRunSeen(runId: string): void {
  lastAlertedStatus.delete(runId);
  // Opening the run is an explicit acknowledgement, so drop the dedup guard
  // too — the next genuine blocked/needs-you for this run should alert.
  alertedTerminalCompletion.delete(runId);
}

// ── Terminal-agent alerts ────────────────────────────────────────────────
//
// Fired by src/main/terminal-agent-notify.ts when a claude/codex/cursor CLI
// the user ran in a normal terminal pane finishes its turn or stops to ask
// for permission. The caller has already applied the visibility policy
// (suppress when the user is looking at that exact terminal tab in a focused
// window) — this function only does the channel-gated delivery, reusing the
// same four channels as run alerts. Clicking either surface (in-app toast or
// native notification) routes back to the terminal pane: the toast handles
// it renderer-side via the payload's `terminal` target; the native click is
// handled here by focusing the window and sending "terminal-agent:focus".
export async function fireTerminalAgentAlert(alert: {
  kind: "blocked" | "complete";
  // Colour intent (Bug 2). When a terminal agent stops to ask for input the
  // caller passes "warning" (amber); "complete" finishes pass "success".
  // Optional so a caller that doesn't classify falls back to the kind-derived
  // tone renderer-side.
  tone?: InAppNotificationTone;
  title: string;
  body: string;
  target: TerminalAgentTarget;
  soundKind: NotificationSoundKind;
}): Promise<void> {
  // Persistent attention marker for the workspace rail — sent BEFORE the
  // channel gate on purpose: even with every notification channel muted,
  // the rail dot should still record that a terminal wants the user.
  try {
    getMainWindow()?.webContents.send("terminal-agent:attention", {
      target: alert.target,
      kind: alert.kind,
    });
  } catch {
    /* best-effort */
  }
  const prefs = await loadPreferences();
  const channels = prefs.notificationChannels;
  if (!channels.inApp && !channels.native && !channels.sound && !channels.osCues) {
    return;
  }
  fanout(channels, {
    kind: alert.kind,
    tone: alert.tone,
    title: alert.title,
    body: alert.body,
    workspaceId: alert.target.workspaceId,
    soundKind: alert.soundKind,
    terminal: alert.target,
    onNativeClick: () => focusTerminalTarget(alert.target),
  });
}

// Focus-independent live-state push for the terminal-agent worker chip. Sent
// by terminal-agent-notify.ts on every turn-boundary transition it detects on
// the RAW pty stream, SEPARATE from fireTerminalAgentAlert (the toast/rail dot)
// and — crucially — NOT gated by the suppress-while-watching policy: the chip
// must reflect "working → ready" even while the pane is hidden, which is the
// one case the renderer's visible-buffer poller can't cover (it's frozen). We
// reuse the same window getter the attention send uses (getMainWindow) so the
// channel reaches the renderer through the live main window. Pure send — no
// preference gate, no channel fanout; the chip is not a notification.
export function emitTerminalAgentState(payload: {
  workspaceId: string;
  tabId: string;
  paneId: string;
  runtime: "claude" | "codex" | "cursor" | null;
  state: RuntimeState;
}): void {
  try {
    const wire: TerminalAgentStatePayload = {
      workspaceId: payload.workspaceId,
      tabId: payload.tabId,
      paneId: payload.paneId,
      runtime: payload.runtime,
      state: payload.state,
    };
    getMainWindow()?.webContents.send("terminal-agent:state", wire);
  } catch {
    /* best-effort: chip update is non-critical */
  }
}

function focusTerminalTarget(target: TerminalAgentTarget): void {
  const win = activeWindow();
  if (!win) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("terminal-agent:focus", target);
  } catch (err) {
    console.warn("[notifications] terminal focus routing failed:", err);
  }
}

