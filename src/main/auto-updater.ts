import { app, BrowserWindow } from "electron";
import { subscribeToEvents } from "./sse-client";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { E2E_BACKGROUND } from "./e2e-background";
import {
  createUpdateRestartGate,
  NO_LIVE_WORK,
  type LiveWork,
  type UpdateRestartReason,
} from "./quit-guard";

// Bridges electron-updater lifecycle into the renderer over a single
// IPC channel (`updater:event`). The renderer subscribes via
// `window.spark.updater.onEvent` and renders a banner state machine.
//
// We deliberately keep the surface tiny — every event ships {kind, payload}
// and the renderer is responsible for interpretation. That keeps the contract
// stable as electron-updater's event types evolve.

export type UpdaterEventKind =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error"
  // The update restart is waiting for agents to finish (payload.items names
  // them), was cancelled, or is starting now.
  | "restart-waiting"
  | "restart-cancelled"
  | "restart-starting";

export interface UpdaterEvent {
  kind: UpdaterEventKind;
  payload?: unknown;
}

// The kickoff is delayed slightly so the renderer has a chance to mount its
// listener before the first `checking-for-update` fires. Without this, the
// first poll happens before the banner is wired up and the renderer never
// sees the lifecycle for the initial check.
const INITIAL_CHECK_DELAY_MS = 4000;

// Steady-state re-check cadence. The SSE push below normally beats this by a
// wide margin; the interval is the fallback for machines whose stream is
// blocked by a proxy or that were asleep when the push fired.
const PERIODIC_CHECK_MS = 30 * 60 * 1000;

// The website server broadcasts a `release` event on this stream the moment
// a new version lands in the release bucket, so running apps learn about
// updates within seconds instead of waiting for the next poll.
const RELEASE_EVENTS_URL = "https://studio.codarasolutions.com/api/events";

let registered = false;
// Where lifecycle events go. Set even in dev builds, where no check runs, so
// the restart gate can still report to the chip.
let eventWindow: BrowserWindow | null = null;

// True once a check has actually FOUND an update (update-available fired).
// Errors before that point are check-phase failures — the update feed being
// unreachable. For this app that is the steady state, not an incident: the
// publish repo (Codara-Solutions/codara-studio) is private with no releases,
// so GitHub answers every feed request with 404 ("Please double check that
// your authentication token is correct…"), and offline machines fail with
// DNS/timeout errors. Surfacing those as a red banner on every launch trains
// the user to ignore the banner. Check-phase errors are logged to the console
// only; once an update HAS been found, download/install failures are real
// problems the user can act on, so those still get the banner.
let updateFound = false;

function send(window: BrowserWindow, event: UpdaterEvent): void {
  if (window.isDestroyed()) return;
  if (window.webContents.isDestroyed()) return;
  window.webContents.send("updater:event", event);
}

export function registerAutoUpdater(mainWindow: BrowserWindow): void {
  if (registered) return;
  registered = true;
  eventWindow = mainWindow;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    send(mainWindow, { kind: "checking-for-update" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    updateFound = true;
    send(mainWindow, {
      kind: "update-available",
      payload: { version: info.version, releaseDate: info.releaseDate },
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    updateFound = false;
    send(mainWindow, {
      kind: "update-not-available",
      payload: { version: info.version },
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    send(mainWindow, {
      kind: "download-progress",
      payload: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    send(mainWindow, {
      kind: "update-downloaded",
      payload: { version: info.version, releaseDate: info.releaseDate },
    });
  });

  autoUpdater.on("error", (err: Error) => {
    const message = err?.message ?? String(err);
    // Check-phase failure (feed unreachable — see `updateFound` note above):
    // console only, never a banner.
    if (!updateFound) {
      console.warn("[auto-updater] update check failed (ignored):", message);
      return;
    }
    send(mainWindow, { kind: "error", payload: { message } });
  });

  setTimeout(() => {
    void safeCheck();
    subscribeToReleasePush();
  }, INITIAL_CHECK_DELAY_MS);

  // Fallback poll — see PERIODIC_CHECK_MS. unref-less on purpose: Electron's
  // main loop runs for the life of the app anyway.
  setInterval(() => {
    void safeCheck();
  }, PERIODIC_CHECK_MS);

}

let pendingCheck: Promise<void> | null = null;
function safeCheck(): Promise<void> {
  if (pendingCheck) return pendingCheck;
  pendingCheck = autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((err: unknown) => {
      // checkForUpdates rejects when no publish target is configured or the
      // feed is unreachable — a check-phase failure by definition. Log and
      // move on; don't crash main and don't alarm the user.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[auto-updater] checkForUpdates failed (ignored):", message);
    }).finally(() => { pendingCheck = null; });
  return pendingCheck;
}

// ---------------------------------------------------------------------------
// Release push (SSE)
// ---------------------------------------------------------------------------
//
// A single long-lived fetch to the website's /api/events stream. We only care
// about one thing — "a release landed" — so the parser is deliberately tiny:
// any `event: release` frame triggers a check. Reconnects forever with capped
// backoff; the periodic poll covers any window where the stream is down.

function subscribeToReleasePush(): void {
  let platformVersion = app.getVersion();
  const stop = subscribeToEvents({
    url: RELEASE_EVENTS_URL,
    onEvent: (event) => {
      if (event.event === "resync") { void safeCheck(); return; }
      if (event.event !== "release") return;
      try {
        const data = JSON.parse(event.data);
        const version = data[process.platform === "darwin" ? "mac" : "win"]?.version;
        if (typeof version !== "string" || version === platformVersion) return;
        platformVersion = version;
        void safeCheck();
      } catch { /* Periodic checks reconcile malformed or missed events. */ }
    },
    onError: (message) => console.warn(`[auto-updater] ${message}; reconnecting`),
  });
  app.once("before-quit", stop);
}

// Manual "Check for updates" from the Settings › About panel. Unlike the
// background paths this reports its outcome to the caller so the button can
// show "you're up to date" — a result the passive banner deliberately hides.
export interface ManualCheckResult {
  status: "dev" | "checked" | "error";
  updateAvailable?: boolean;
  version?: string;
  message?: string;
}

export async function checkForUpdatesNow(): Promise<ManualCheckResult> {
  if (!app.isPackaged) return { status: "dev" };
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const available =
      info != null && result?.isUpdateAvailable !== undefined
        ? Boolean(result.isUpdateAvailable)
        : false;
    return { status: "checked", updateAvailable: available, version: info?.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}

// Invoked from the IPC handler when the renderer's "Restart and install"
// button is clicked. Wrapping in a function keeps the import of autoUpdater
// out of ipc.ts so the entire module loads lazily.
// The install MUST NOT call autoUpdater.quitAndInstall() directly: Squirrel
// closes every window and issues a quit, but index.ts's before-quit handler
// preventDefault()s the first quit to run its async cleanup — cancelling the
// install-quit and stranding a dead black window with the app still running.
// Instead the click REQUESTS the install and starts a normal quit; index.ts
// finishes its cleanup and then asks (isInstallRequested/performQuitAndInstall)
// whether to hand the process to Squirrel instead of plainly quitting.
//
// The click itself never cuts off an agent: while Cora or a terminal agent is
// in the middle of a turn the restart waits (the chip says for what) and
// starts by itself once they are done, unless the user picks Restart now.
let installRequested = false;
let installForced = false;
let liveWorkProbe: (() => LiveWork) | null = null;

function emit(event: UpdaterEvent): void {
  if (eventWindow) send(eventWindow, event);
}

const restartGate = createUpdateRestartGate({
  liveWork: () => liveWorkProbe?.() ?? NO_LIVE_WORK,
  install: (reason) => beginInstallQuit(reason),
  emit,
});

// index.ts owns the run store and the terminal notifier, so it supplies what
// counts as live work.
export function setUpdateRestartLiveWork(probe: () => LiveWork): void {
  liveWorkProbe = probe;
}

function beginInstallQuit(reason: UpdateRestartReason): void {
  if (!app.isPackaged) {
    // The e2e suite drives the gate in a dev build and reads the outcome here.
    if (E2E_BACKGROUND) {
      const log = ((globalThis as { __codaraUpdateRestarts?: string[] }).__codaraUpdateRestarts ??= []);
      log.push(reason);
    }
    console.log(`[auto-updater] quitAndInstall (${reason}) ignored in dev`);
    return;
  }
  installForced = reason === "forced";
  installRequested = true;
  app.quit();
}

export function quitAndInstall(): void {
  restartGate.request();
}

export function restartForUpdateNow(): void {
  restartGate.restartNow();
}

export function cancelUpdateRestart(): void {
  restartGate.cancel();
}

export function isInstallRequested(): boolean {
  return installRequested;
}

// Restart now already answered the quit guard's question.
export function isInstallForced(): boolean {
  return installRequested && installForced;
}

// The user kept working instead of restarting for the update. A request left
// set would turn their next plain quit into an install that relaunches the app;
// autoInstallOnAppQuit already applies the update on that quit without one.
export function cancelInstallRequest(): void {
  installRequested = false;
  installForced = false;
  emit({ kind: "restart-cancelled" });
}

// Called by index.ts at the END of quit cleanup (cleanQuit already true, so
// the quit Squirrel issues sails through before-quit). Silent install,
// relaunch when done: the app closes, applies the update, and reopens itself.
export function performQuitAndInstall(): void {
  autoUpdater.quitAndInstall(true, true);
}
