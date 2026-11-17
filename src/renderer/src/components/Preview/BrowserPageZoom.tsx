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
// levels, the one in use is right. Two such tabs on screen at once (docked
// side by side) can only show one zoom, so whenever one applies its level
// (a zoom, a navigation, the pointer coming in) the other takes that level
// too and their chips agree. Loaded on its own (BrowserPane and HtmlPreview
// import it lazily), like the find bar.

const MIN = 0.25;
const MAX = 5;

interface Shown {
  site: () => string | null;
  adopt: (zoom: number) => void;
}
const onScreen = new Set<Shown>();

/**
 * Chromium's zoom key for a page: its session, and its host (or its scheme
 * when it has none, as file: pages).
 */
function siteOf(webview: Electron.WebviewTag | null): string | null {
  try {
    const url = new URL(webview?.getURL() ?? "");
    return `${webview?.getAttribute("partition") ?? ""} ${url.hostname || url.protocol}`;
  } catch {
    return null;
  }
}

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
  const self = useRef<Shown | null>(null);
  latest.current = { zoom, ready, shown };

  const visible = useCallback(
    () => latest.current.ready && latest.current.shown && isShown(rootRef.current),
    [rootRef],
  );

  const applyToPage = useCallback(() => {
    const webview = webviewRef.current;
    // A hidden tab (a background browser tab, an editor tab not in front)
    // would take its site's zoom from the tab on screen.
    if (!webview || !visible()) return;
    try {
      // Only a change is written: the observers fire often (every resize),
      // and a write the page does not need still reaches the guest.
      const factor = window.spark.view.getZoomFactor() * latest.current.zoom;
      if (Math.abs(webview.getZoomFactor() - factor) > 1e-4) webview.setZoomFactor(factor);
    } catch {
      // The guest is between loads; the next navigation applies it.
      return;
    }
    const site = siteOf(webview);
    if (!site) return;
    for (const other of onScreen) if (other !== self.current && other.site() === site) other.adopt(latest.current.zoom);
  }, [webviewRef, visible]);

  useEffect(() => {
    applyToPage();
  }, [ready, shown, zoom, applyToPage]);

  useEffect(() => {
    const entry: Shown = {
      site: () => (visible() ? siteOf(webviewRef.current) : null),
      // Taken at once, not at the next render: two panes shown together with
      // stale levels would otherwise keep handing each other the old one.
      adopt: (level) => {
        latest.current.zoom = level;
        setZoom(level);
      },
    };
    self.current = entry;
    onScreen.add(entry);
    return () => {
      onScreen.delete(entry);
      self.current = null;
    };
  }, [webviewRef, visible]);

  useEffect(() => {
    const webview = webviewRef.current;
    const root = rootRef.current;
    if (!webview || !root || !ready) return;
    // The window's zoom changes its CSS size, so a resize covers it; a pane
    // that comes back on screen (an editor tab brought to front) grows from
    // nothing, which the observer sees.
    webview.addEventListener("did-navigate", applyToPage);
    window.addEventListener("resize", applyToPage);
    const observer = new ResizeObserver(applyToPage);
    observer.observe(root);
    // An editor tab or a docked pane is hidden with visibility, which keeps
    // its size, and marked aria-hidden: watch that to reapply when shown.
    const surface = root.parentElement?.closest("[aria-hidden]");
    const watcher = new MutationObserver(applyToPage);
    if (surface) watcher.observe(surface, { attributes: true, attributeFilter: ["aria-hidden", "style"] });
    root.addEventListener("pointerenter", applyToPage);
    root.addEventListener("focusin", applyToPage);
    return () => {
      webview.removeEventListener("did-navigate", applyToPage);
      window.removeEventListener("resize", applyToPage);
      observer.disconnect();
      watcher.disconnect();
      root.removeEventListener("pointerenter", applyToPage);
      root.removeEventListener("focusin", applyToPage);
    };
  }, [webviewRef, rootRef, ready, applyToPage]);

  const act = useCallback(
    (action: ZoomAction) => {
      const current = latest.current.zoom;
      const next = action === "reset" ? 1 : stepZoom(current, action === "in" ? 1 : -1, MIN, MAX);
      latest.current.zoom = next;
      setZoom(next);
      const site = visible() ? siteOf(webviewRef.current) : null;
      if (!site) return;
      for (const other of onScreen) if (other !== self.current && other.site() === site) other.adopt(next);
    },
    [visible, webviewRef],
  );

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
