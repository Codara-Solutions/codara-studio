import type { BrowserWindow } from "electron";

/**
 * True when this process was launched by the e2e suite, which sets
 * SPARK_E2E_BACKGROUND for the whole run (playwright.config.ts assigns it once;
 * every spec passes `{ ...process.env }` through to electron.launch).
 *
 * Playwright drives the renderer over the Chrome debug protocol, so a visible
 * window buys the suite nothing — the page still loads, lays out and paints
 * while hidden, which is all that bounding boxes, computed styles and
 * synthetic input read from. What a visible window DOES buy is a window
 * grabbing the desktop away from whoever is using the machine, once per spec
 * file, thirty-odd times a run. So under this flag the window is rendered but
 * made invisible, and nothing ever pulls it back.
 *
 * Nothing outside a test ever sets it.
 */
export const E2E_BACKGROUND = process.env.SPARK_E2E_BACKGROUND === "1";

/**
 * Make a window invisible to the person at the machine while leaving it fully
 * alive for the test driving it.
 *
 * Three things had to be true at once, and only this combination gets all of
 * them. The window must COMPOSITE: a window that is never shown produces no
 * frames, which starves requestAnimationFrame and turns the suite into a
 * parade of timeouts (measured: 12 failures over 12.6 minutes, against 8 over
 * 8.6 for a visible one). It must not ACTIVATE: a plain show() grabs the
 * desktop once per spec file, thirty-odd times a run. And it must not be SEEN.
 *
 * Parking it off the edge of the desktop does not survive macOS, which
 * re-constrains the frame back onto the screen — measured: a window asked for
 * x = -2200 settled at x = 0, in full view. Zero opacity is applied by the
 * window server, downstream of Chromium's compositor, so the page keeps
 * painting at full rate into a surface nobody can see. Ignoring mouse events
 * on top of that means it cannot swallow a click meant for whatever is really
 * under it.
 */
export function hideWindowFromDesktop(target: BrowserWindow): void {
  target.setOpacity(0);
  target.setIgnoreMouseEvents(true);
  target.setSkipTaskbar(true);
  target.showInactive();
}

/**
 * Bring a window to the user's attention — show it if hidden, restore it if
 * minimized, and focus it.
 *
 * Every "pull the window forward" path in the app goes through here so there
 * is ONE place that can be switched off, rather than a reveal hiding in a
 * notification handler or a tray callback that a future test happens to
 * trigger. Under an e2e run it does nothing at all.
 */
export function revealWindow(target: BrowserWindow): void {
  if (E2E_BACKGROUND || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  target.focus();
}
