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

let registered = false;

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
    send(mainWindow, {
      kind: "update-available",
      payload: { version: info.version, releaseDate: info.releaseDate },
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
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
    send(mainWindow, {
      kind: "error",
      payload: { message: err?.message ?? String(err) },
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      // checkForUpdates rejects when no publish target is configured. Don't
      // crash main — surface the error to the renderer where the banner can
      // dismiss it.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[auto-updater] checkForUpdates failed:", message);
      send(mainWindow, { kind: "error", payload: { message } });
    });
  }, INITIAL_CHECK_DELAY_MS);
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
