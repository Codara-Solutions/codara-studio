import { app, BrowserWindow } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

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
  | "error";

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
  // Dev mode: electron-updater throws because it can't find dev-app-update.yml
  // and would spam the console with "ENOENT: ... app-update.yml". We log once
  // and bail — nothing about the dev workflow benefits from running it.
  if (!app.isPackaged) {
    console.log("[auto-updater] skipped in dev");
    return;
  }

  // Guard against accidental double-registration (e.g. a second
  // createWindow() on macOS reactivation). The autoUpdater itself is a
  // singleton so re-binding listeners would just produce duplicate IPC
  // messages.
  if (registered) return;
  registered = true;

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
  }, INITIAL_CHECK_DELAY_MS);

  // Fallback poll — see PERIODIC_CHECK_MS. unref-less on purpose: Electron's
  // main loop runs for the life of the app anyway.
  setInterval(() => {
    void safeCheck();
  }, PERIODIC_CHECK_MS);

  subscribeToReleasePush();
}

function safeCheck(): Promise<void> {
  return autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((err: unknown) => {
      // checkForUpdates rejects when no publish target is configured or the
      // feed is unreachable — a check-phase failure by definition. Log and
      // move on; don't crash main and don't alarm the user.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[auto-updater] checkForUpdates failed (ignored):", message);
    });
}

// ---------------------------------------------------------------------------
// Release push (SSE)
// ---------------------------------------------------------------------------
//
// A single long-lived fetch to the website's /api/events stream. We only care
// about one thing — "a release landed" — so the parser is deliberately tiny:
// any `event: release` frame triggers a check. Reconnects forever with capped
// backoff; the periodic poll covers any window where the stream is down.

let sseBackoffMs = 5_000;

function subscribeToReleasePush(): void {
  const controller = new AbortController();
  app.on("before-quit", () => controller.abort());

  const connect = async (): Promise<void> => {
    try {
      const res = await fetch(RELEASE_EVENTS_URL, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`stream responded ${res.status}`);
      sseBackoffMs = 5_000;
      console.log("[auto-updater] release push stream connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; we only inspect event names.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (/^event:\s*release$/m.test(frame)) {
            console.log("[auto-updater] release push received — checking");
            void safeCheck();
          } else if (/^event:\s*git-push$/m.test(frame)) {
            // A GitHub webhook reached the website: some watched remote just
            // gained commits. Fetch immediately so git triggers (and the
            // "teammate pushed" surfaces) react in seconds, not minutes.
            console.log("[auto-updater] git-push webhook event — nudging fetch");
            void import("./git-auto-fetch").then((m) => m.nudgeGitAutoFetchNow());
          }
        }
      }
      throw new Error("stream ended");
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-updater] release stream dropped (${message}); retrying in ${sseBackoffMs}ms`);
      setTimeout(() => void connect(), sseBackoffMs);
      sseBackoffMs = Math.min(sseBackoffMs * 2, 5 * 60 * 1000);
    }
  };

  void connect();
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
export function quitAndInstall(): void {
  if (!app.isPackaged) {
    console.log("[auto-updater] quitAndInstall ignored in dev");
    return;
  }
  autoUpdater.quitAndInstall();
}
