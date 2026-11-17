import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isShown } from "../find/find-router";
import { registerZoomTarget } from "../zoom/zoom-router";
import { stepZoom, zoomPercent, type ZoomAction } from "../zoom/zoom-math";

// A browser tab's own zoom, as in a browser: Ctrl+wheel and pinch in the page,
// Ctrl+= / Ctrl+- / Ctrl+0 with focus anywhere in the tab (the page, the
// address bar, the toolbar), and a chip with the level, which resets it, while
// the tab is not at 100%. The level belongs to the tab and stays across its navigations.
//
// Chromium keeps one zoom per site (all file:// pages count as one) for every
// tab in a session, and Electron sets every guest to the window's zoom when
// that changes. So the tab applies its level, on top of the window's zoom,
// again after each navigation and window zoom, and whenever it is shown or
// the pointer or focus comes into it: of two tabs on one site at different
// levels, the one in use is right. Loaded on its own (BrowserPane and
// HtmlPreview import it lazily), like the find bar.

const MIN = 0.25;
const MAX = 5;

export default function BrowserPageZoom({
  rootRef,
  webviewRef,
  ready,
  shown = true,
}: {
  rootRef: RefObject<HTMLElement>;
  webviewRef: RefObject<Electron.WebviewTag | null>;
  ready: boolean;
  /** The tab is on screen. */
  shown?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const latest = useRef({ zoom, ready, shown });
  latest.current = { zoom, ready, shown };

  const applyToPage = useCallback(() => {
    const webview = webviewRef.current;
    // A hidden tab would take its site's zoom from the tab on screen.
    if (!webview || !latest.current.ready || !latest.current.shown) return;
    try {
      webview.setZoomFactor(window.spark.view.getZoomFactor() * latest.current.zoom);
    } catch {
      // The guest is between loads; the next navigation applies it.
    }
  }, [webviewRef]);

  useEffect(() => {
    applyToPage();
  }, [ready, shown, zoom, applyToPage]);

  useEffect(() => {
    const webview = webviewRef.current;
    const root = rootRef.current;
    if (!webview || !root || !ready) return;
    // The window's zoom changes its CSS size, so a resize covers it.
    webview.addEventListener("did-navigate", applyToPage);
    window.addEventListener("resize", applyToPage);
    root.addEventListener("pointerenter", applyToPage);
    root.addEventListener("focusin", applyToPage);
    return () => {
      webview.removeEventListener("did-navigate", applyToPage);
      window.removeEventListener("resize", applyToPage);
      root.removeEventListener("pointerenter", applyToPage);
      root.removeEventListener("focusin", applyToPage);
    };
  }, [webviewRef, rootRef, ready, applyToPage]);

  const act = useCallback((action: ZoomAction) => {
    setZoom((current) => (action === "reset" ? 1 : stepZoom(current, action === "in" ? 1 : -1, MIN, MAX)));
  }, []);

  useEffect(
    () =>
      registerZoomTarget({
        root: () => rootRef.current,
        eligible: () => latest.current.ready && isShown(rootRef.current),
        zoom: act,
      }),
    [rootRef, act],
  );

  useEffect(
    () =>
      window.spark.view.onGuestWheelZoom((webContentsId, direction) => {
        let own: number | null = null;
        try {
          own = webviewRef.current?.getWebContentsId() ?? null;
        } catch {
          // Not attached yet: not this tab's page.
        }
        if (own === webContentsId) act(direction);
      }),
    [webviewRef, act],
  );

  if (Math.abs(zoom - 1) < 1e-3) return null;
  // One chip, as a browser's zoom badge: the address bar has no room for a
  // whole zoom row, and the keys and the wheel do the stepping.
  return (
    <button
      type="button"
      className="spark-btn"
      data-testid="page-zoom"
      onClick={() => {
        act("reset");
        // The chip goes away with the zoom; focus goes back to the page so
        // the zoom keys still reach this tab.
        webviewRef.current?.focus();
      }}
      title="Page zoom. Click to reset to 100%"
      aria-label={`Page zoom ${zoomPercent(zoom)}, reset`}
      style={{
        height: 22,
        padding: "0 7px",
        flex: "0 0 auto",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span data-testid="viewer-zoom-level">{zoomPercent(zoom)}</span>
    </button>
  );
}
