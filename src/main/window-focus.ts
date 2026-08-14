import { app, BrowserWindow, type WebContents } from "electron";
import { E2E_BACKGROUND, revealWindow } from "./e2e-background";

/**
 * Bring Studio back in front of the browser once a sign-in that sent the user
 * out to one has finished. Without this the user is left staring at a browser
 * tab and has to find Studio and reopen Settings by hand.
 *
 * macOS will not raise a background application from a window-level focus call
 * alone, so the app-level steal is required there; on the other platforms
 * showing and focusing the window is enough.
 */
export function focusStudioWindow(owner?: WebContents | null): void {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) return;
  const preferred =
    owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null;
  const target =
    preferred && !preferred.isDestroyed()
      ? preferred
      : windows.find((window) => window.isVisible() && !window.isMinimized()) ?? windows[0];
  if (!target) return;
  try {
    revealWindow(target);
    if (process.platform === "darwin" && !E2E_BACKGROUND) app.focus({ steal: true });
  } catch {
    // A window torn down between the lookup and the call is not worth failing
    // an otherwise completed sign-in over.
  }
}
