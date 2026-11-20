import type { WebContents } from "electron";

export interface MainWebContentsCleanup {
  clearUnresponsiveTimer(owner: WebContents): void;
  detachTerminals(owner: WebContents): void;
  disposeWatchers(owner: WebContents): void;
}

// When the window goes away under the app (a lost Wayland connection, for
// one), Electron destroys the BrowserWindow before its WebContents emits
// `destroyed`, and reading `win.webContents` then throws "Object has been
// destroyed". So this takes the WebContents itself, read by the caller while
// the window was alive, and never sees the window.
export function onMainWebContentsDestroyed(contents: WebContents, cleanup: MainWebContentsCleanup): void {
  contents.on("destroyed", () => {
    cleanup.clearUnresponsiveTimer(contents);
    // Renderer destruction can happen during workspace switches, reloads, or
    // crashes. Keep PTY processes alive so TerminalView can reattach when the
    // pane remounts; explicit pane close / app quit still kills them.
    cleanup.detachTerminals(contents);
    cleanup.disposeWatchers(contents);
  });
}
