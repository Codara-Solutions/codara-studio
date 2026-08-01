import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import AddressBar, { type AddressBarHandle } from "./AddressBar";
import InspectorOverlay, { type InspectorPick } from "./InspectorOverlay";
import DrawOverlay from "./DrawOverlay";
import { GlobeIcon } from "../icons";
import type { SelectionPayload } from "../../routing/SelectionRoutingContext";
import { pathToFileUrl } from "../../lib/pathToFileUrl";

// BrowserPane wraps Electron's <webview> tag for preview tabs. We use
// <webview> over <iframe> because it sidesteps X-Frame-Options/CSP and
// gives us first-class Chromium controls — back/forward, reload, devtools,
// capturePage — that the agent can drive without a third-party headless
// browser.
//
// Caveats worth knowing about:
//   - <webview> is technically deprecated but still shipping; Electron
//     keeps the tag enabled when `webviewTag: true` is set on the main
//     BrowserWindow's webPreferences (we set it in src/main/index.ts).
//   - Methods like `loadURL`, `goBack`, `getURL` are only available after
//     `dom-ready`. We track readiness in state and gate the imperative
//     handle accordingly.
//   - The webview does not forward our React onClick events; navigation
//     state changes arrive via `did-navigate` / `did-navigate-in-page`,
//     which we listen for to update the address bar.

// Minimal typing for the bits of <webview> we touch. Electron's TS types
// for the tag aren't exported by default in the renderer.
type CapturedImage = {
  toDataURL: () => string;
  getSize: () => { width: number; height: number };
};

type WebviewMethods = {
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  reloadIgnoringCache: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  openDevTools: () => void;
  closeDevTools: () => void;
  send: (channel: string, ...args: unknown[]) => void;
  capturePage: () => Promise<CapturedImage>;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  getWebContentsId: () => number;
};

type WebviewElement = HTMLElement &
  Partial<WebviewMethods> & {
    src: string;
    // Electron's <webview> dispatches DOM-style single-arg events
    // (dom-ready, did-navigate, did-fail-load, …). The local override is
    // here only to keep call sites terse — the rest of the tag's API is
    // covered by HTMLElement.
    addEventListener: (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: (...args: any[]) => void,
    ) => void;
    removeEventListener: (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: (...args: any[]) => void,
    ) => void;
  };

export interface BrowserPaneHandle {
  // `ignoreCache: true` calls Chromium's `reloadIgnoringCache` (hard reload).
  // Default is the normal cache-respecting reload — existing callers stay
  // unchanged.
  reload: (opts?: { ignoreCache?: boolean }) => void;
  goBack: () => void;
  goForward: () => void;
  loadURL: (url: string) => void;
  getURL: () => string;
  getTitle: () => string;
  openDevTools: () => void;
  focusAddressBar: () => void;
  // Surface area used by the spark-preview MCP bridge. None of these throw
  // when the webview isn't yet dom-ready — they reject with a descriptive
  // error the bridge can forward to the calling sub-agent.
  isReady: () => boolean;
  executeJavaScript: (code: string) => Promise<unknown>;
  capturePngDataUrl: () => Promise<string>;
  // The guest webContents id, used by the main-side computer-use executor to
  // drive trusted input against this exact <webview>. Null until dom-ready.
  getWebContentsId: () => number | null;
  // Resize the webview element (and therefore the guest viewport) to explicit
  // CSS pixels. Returns the applied size.
  resizeViewport: (width: number, height: number) => { width: number; height: number };
}

interface Props {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  // Fires once the guest is dom-ready and its webContents id is known, so the
  // host can announce the tab to main (wiring console capture early).
  onReady?: (webContentsId: number) => void;
}

const BrowserPane = forwardRef<BrowserPaneHandle, Props>(function BrowserPane(
  { url, visible, onUrlChange, onReady },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const addressRef = useRef<AddressBarHandle | null>(null);
  const [domReady, setDomReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inspecting, setInspecting] = useState(false);
  const [inspectorPick, setInspectorPick] = useState<InspectorPick | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);

  // `domReady` mirrored into a ref so the navigation effect below can gate
  // on it without taking it as a dependency (which would re-run that effect
  // every time readiness flips). Listeners read the ref; the state copy
  // exists only to drive the loading-overlay render.
  const domReadyRef = useRef(false);
  // Electron logs a main-process GUEST_VIEW_MANAGER_CALL error before a
  // renderer-side try/catch can translate calls made against a detached or
  // exited guest. Resolve the current element through one fail-closed guard so
  // every imperative method avoids issuing that doomed IPC in the first place.
  const getLiveWebview = useCallback((): WebviewElement | null => {
    const host = containerRef.current;
    const webview = webviewRef.current;
    if (
      !host ||
      !webview ||
      !domReadyRef.current ||
      !webview.isConnected ||
      !host.contains(webview)
    ) {
      return null;
    }
    return webview;
  }, []);
  // `onUrlChange` is a fresh closure on every parent render. We funnel it
  // through a ref so the create-once effect doesn't list it as a dependency
  // (and therefore doesn't tear down + rebuild the webview when the parent
  // re-renders for unrelated reasons).
  const onUrlChangeRef = useRef(onUrlChange);
  useEffect(() => {
    onUrlChangeRef.current = onUrlChange;
  }, [onUrlChange]);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // The latest url prop, readable from the create-once listeners (which are
  // attached before any navigation and would otherwise capture the initial
  // url forever).
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  // Cache the inspector preload's file:// URL once at mount and feed it into
  // the webview's `preload` attribute. The path lives on disk under
  // out/preload/inspector-preload.js (electron-vite emits both preload
  // bundles via the same config). Without this the inspect button is inert.
  const [inspectorPreloadUrl, setInspectorPreloadUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.spark.app
      .inspectorPreloadUrl()
      .then((value) => {
        if (!cancelled) setInspectorPreloadUrl(value);
      })
      .catch(() => {
        if (!cancelled) setInspectorPreloadUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Create the <webview> (once) + attach listeners. The element itself
  // is built imperatively rather than via JSX to dodge React's "Unknown
  // HTML tag" warning, and is created at most once per host — it survives
  // url-value changes and visibility toggles. Listeners, by contrast, are
  // attached on each effect run and removed in cleanup so they never leak.
  //
  // The only dependency is `hasUrl` (url *presence*, not value): the effect
  // must NOT re-run on every url change or unrelated parent re-render —
  // navigation and readiness are handled by the separate effects below.
  // Reacting to the empty -> non-empty flip lets a pane that mounted with
  // no url still get its webview created when one finally arrives.
  const hasUrl = Boolean(url);
  // Wait for the inspector preload URL to resolve before creating the
  // webview. The IPC roundtrip is sub-millisecond after main is ready, and
  // gating here means we never end up with a webview that silently lacks
  // its inspector preload because the URL arrived after creation.
  const preloadReady = inspectorPreloadUrl !== null;
  useEffect(() => {
    if (!preloadReady) return;
    const host = containerRef.current;
    if (!host) return;
    const initialUrl = urlRef.current;
    if (!initialUrl) return; // empty url -> empty state, do not create the element

    // Reuse the existing element if it's still attached to *this* host. If
    // React unmounted+remounted us (StrictMode dev cycle, or tab close+
    // reopen), the old webview is now an orphan node — calling methods on
    // it throws "WebView must be attached to the DOM" before it has a
    // chance to fire dom-ready. Detect that and recreate.
    let webview = webviewRef.current;
    const orphaned = !!webview && !host.contains(webview);
    if (orphaned) {
      webviewRef.current = null;
      webview = null;
      domReadyRef.current = false;
      setDomReady(false);
    }

    if (!webview) {
      webview = document.createElement("webview") as WebviewElement;
      // Sandboxed safety: keep contextIsolation on for the embedded site.
      // backgroundThrottling=no keeps timers, animations, and websocket
      // heartbeats running at full speed when the preview tab is hidden
      // behind another Codara tab — without this, dev servers (Vite, webpack)
      // drop their HMR socket on Chromium's throttle and trigger a refresh
      // when the user comes back.
      webview.setAttribute(
        "webpreferences",
        "contextIsolation=yes,backgroundThrottling=no",
      );
      webview.setAttribute("allowpopups", "true");
      // The inspector preload runs inside the embedded page's renderer to
      // capture element picks and report back via `ipcRenderer.sendToHost`.
      // It listens silently until the host sends `spark:inspector:toggle`,
      // so attaching it unconditionally is safe.
      if (inspectorPreloadUrl) {
        webview.setAttribute("preload", inspectorPreloadUrl);
      }
      webview.style.width = "100%";
      webview.style.height = "100%";
      webview.style.border = "0";
      webview.style.background = "white";
      webview.src = initialUrl;
      host.appendChild(webview);
      webviewRef.current = webview;
    }

    const wv = webview;
    const onDomReady = () => {
      if (
        webviewRef.current !== wv ||
        !wv.isConnected ||
        !host.contains(wv)
      ) {
        return;
      }
      domReadyRef.current = true;
      setDomReady(true);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
      try {
        setCurrentUrl(wv.getURL?.() ?? urlRef.current);
      } catch {
        setCurrentUrl(urlRef.current);
      }
      setError(null);
      // Announce the guest webContents id so main can wire computer-use console
      // capture from first paint. Best-effort; fires again on every full load.
      try {
        const wcId = wv.getWebContentsId?.();
        if (typeof wcId === "number") onReadyRef.current?.(wcId);
      } catch {
        /* getWebContentsId throws before attach — ignore */
      }
    };
    const onDidNavigate = (e: { url: string }) => {
      setCurrentUrl(e.url);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
      setError(null);
      if (e.url) onUrlChangeRef.current(e.url);
    };
    const onDidNavigateInPage = (e: { url: string; isMainFrame: boolean }) => {
      if (!e.isMainFrame) return;
      setCurrentUrl(e.url);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
      // Persist main-frame in-page (SPA / pushState) navigations too, so a
      // reload or tab restore returns to where the user actually was rather
      // than the original entry URL.
      if (e.url) onUrlChangeRef.current(e.url);
    };
    const onDidFailLoad = (e: {
      errorCode: number;
      errorDescription: string;
      validatedURL: string;
      isMainFrame: boolean;
    }) => {
      if (!e.isMainFrame) return;
      // -3 ABORTED is fired when the user navigates before the previous
      // load finishes — not actually an error.
      if (e.errorCode === -3) return;
      setError(`${e.errorDescription} (${e.errorCode})`);
    };
    const onRenderProcessGone = (e: {
      details?: { reason?: string; exitCode?: number };
    }) => {
      if (webviewRef.current !== wv) return;
      domReadyRef.current = false;
      setDomReady(false);
      setCanGoBack(false);
      setCanGoForward(false);
      setInspecting(false);
      const reason = e.details?.reason?.trim();
      setError(
        reason
          ? `Preview renderer exited (${reason})`
          : "Preview renderer exited",
      );
    };

    // Host-shortcut forwarding for keystrokes while focus is inside the
    // <webview> lives in main + preload (search for `before-input-event`).
    // The webview tag does NOT emit that event itself, so a listener here
    // would be dead — the main process observes it on the guest's
    // webContents and pushes a synthetic KeyboardEvent up through the
    // preload onto `window`.

    // `ipc-message` is the channel the inspector preload uses to ship picks
    // back to the host via `sendToHost`. We only care about our two events
    // here; anything else from the embedded page is ignored.
    const onIpcMessage = (e: { channel: string; args: unknown[] }) => {
      if (e.channel === "spark:inspector:picked") {
        const payload = e.args?.[0] as InspectorPick | undefined;
        if (payload && typeof payload === "object") {
          setInspecting(false);
          setInspectorPick(payload);
        }
      } else if (e.channel === "spark:inspector:cancelled") {
        setInspecting(false);
      }
    };

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-navigate", onDidNavigate);
    wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    wv.addEventListener("did-fail-load", onDidFailLoad);
    wv.addEventListener("render-process-gone", onRenderProcessGone);
    wv.addEventListener("ipc-message", onIpcMessage);

    return () => {
      // Detach our listeners; intentionally do NOT remove the webview
      // element itself. We want it to survive visibility toggles — the
      // element is dropped when the host div unmounts with the component.
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-navigate", onDidNavigate);
      wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      wv.removeEventListener("did-fail-load", onDidFailLoad);
      wv.removeEventListener("render-process-gone", onRenderProcessGone);
      wv.removeEventListener("ipc-message", onIpcMessage);
    };
  }, [hasUrl, preloadReady, inspectorPreloadUrl]);

  // ── Navigate when the parent's `url` prop changes. Kept separate from
  // the create-once effect so readiness (tracked via domReadyRef, not a
  // dependency) doesn't retrigger element creation. Calling getURL /
  // loadURL before dom-ready throws and crashes the renderer, so we bail
  // until the ref says the webview is attached.
  useEffect(() => {
    if (!url) return;
    const webview = getLiveWebview();
    if (!webview) return; // not created yet — src attribute carries the initial url
    try {
      const live = webview.getURL?.() ?? "";
      if (live && live !== url) {
        webview.loadURL?.(url);
      }
    } catch {
      // Webview detached between checks (very rare); fall back to src.
      webview.src = url;
    }
  }, [url, domReady, getLiveWebview]);

  // Toggle inspect mode by signalling the webview's preload. Turning it on
  // also turns off draw mode so the two never compete for pointer events.
  const toggleInspect = useCallback(() => {
    const wv = getLiveWebview();
    if (!wv) return;
    setInspecting((prev) => {
      const next = !prev;
      try {
        wv.send?.("spark:inspector:toggle", next);
      } catch {
        /* webview not yet ready; user can retry */
      }
      if (next) {
        setDrawing(false);
        setInspectorPick(null);
      }
      return next;
    });
  }, [getLiveWebview]);

  // Toggle draw mode. We don't tell the webview about this — the canvas
  // sits on top of the embedded page and just intercepts pointer events.
  const toggleDraw = useCallback(() => {
    setDrawing((prev) => {
      const next = !prev;
      if (next) {
        setInspecting(false);
        try {
          getLiveWebview()?.send?.("spark:inspector:toggle", false);
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, [getLiveWebview]);

  // Compose an inspector pick + the user's note into a SelectionPayload.
  // The routing menu (opened by InspectorOverlay) decides where the payload
  // lands — chat composer, a new Codara chat, or an open CLI worker.
  const buildInspectorPayload = useCallback(
    (pick: InspectorPick, note: string): SelectionPayload => {
      const url = pick.url || currentUrl || urlRef.current;
      let pageHint = "";
      try {
        if (url) {
          const parsed = new URL(url);
          pageHint = parsed.pathname || url;
        }
      } catch {
        pageHint = url;
      }
      const selector = pick.selector ? ` (selector: '${pick.selector}'` : "";
      const text = pick.text ? `, text: '${pick.text.replace(/'/g, "\\'")}')` : selector ? ")" : "";
      const noteSuffix = note ? `: ${note}` : "";
      const message =
        `Regarding the <${pick.tagName}>` +
        (pageHint ? ` at ${pageHint}` : "") +
        `${selector}${text}${noteSuffix}`.replace(/^\s+/, "");
      return { source: "inspect", text: message };
    },
    [currentUrl],
  );

  // Capture the embedded page, composite the drawing canvas on top, write
  // the PNG to <tmp>/spark-drawings via the main process, and return a
  // SelectionPayload referencing the saved file. Worker prompts use the raw
  // absolute path so CLI agents can hand it directly to local image tools.
  // The routing menu (opened by DrawOverlay) picks the destination after
  // this resolves.
  const prepareDrawingPayload = useCallback(
    async (drawingDataUrl: string, note: string): Promise<SelectionPayload | null> => {
      const wv = getLiveWebview();
      if (!wv) return null;
      setDrawingBusy(true);
      try {
        const captured = await wv.capturePage?.();
        const pageDataUrl = captured?.toDataURL?.() ?? null;
        const composed = await composeDrawingOverScreenshot(pageDataUrl, drawingDataUrl);
        const savedPath = await window.spark.drawing.save({ dataUrl: composed });
        const fileUrl = pathToFileUrl(savedPath);
        const message =
          `See this annotated screenshot: "${savedPath}"` + (note ? ` - ${note}` : "");
        return {
          source: "draw",
          text: message,
          imagePath: savedPath,
          imageFileUrl: fileUrl,
        };
      } catch (err) {
        setError(`Could not save drawing: ${(err as Error).message}`);
        return null;
      } finally {
        setDrawingBusy(false);
      }
    },
    [getLiveWebview],
  );

  useImperativeHandle(
    ref,
    (): BrowserPaneHandle => ({
      reload: (opts) => {
        try {
          const wv = getLiveWebview();
          if (!wv) return;
          if (opts?.ignoreCache && wv.reloadIgnoringCache) {
            wv.reloadIgnoringCache();
          } else {
            wv.reload?.();
          }
        } catch {
          /* webview not yet dom-ready */
        }
      },
      goBack: () => {
        try {
          getLiveWebview()?.goBack?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      goForward: () => {
        try {
          getLiveWebview()?.goForward?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      loadURL: (next: string) => {
        try {
          const wv = getLiveWebview();
          if (!wv) return;
          wv.loadURL?.(next);
        } catch {
          const wv = getLiveWebview();
          if (wv) wv.src = next;
        }
      },
      getURL: () => {
        try {
          return getLiveWebview()?.getURL?.() ?? currentUrl ?? url;
        } catch {
          return currentUrl ?? url;
        }
      },
      openDevTools: () => {
        try {
          getLiveWebview()?.openDevTools?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      focusAddressBar: () => addressRef.current?.focus(),
      getTitle: () => {
        try {
          return getLiveWebview()?.getTitle?.() ?? "";
        } catch {
          return "";
        }
      },
      isReady: () => getLiveWebview() !== null,
      getWebContentsId: () => {
        try {
          const id = getLiveWebview()?.getWebContentsId?.();
          return typeof id === "number" ? id : null;
        } catch {
          return null;
        }
      },
      resizeViewport: (width: number, height: number) => {
        const wv = getLiveWebview();
        if (!wv) throw new Error("preview tab is not ready");
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        wv.style.width = `${w}px`;
        wv.style.height = `${h}px`;
        return { width: w, height: h };
      },
      executeJavaScript: async (code: string) => {
        const wv = getLiveWebview();
        if (!wv || !wv.executeJavaScript) {
          throw new Error("preview tab is not ready");
        }
        return wv.executeJavaScript(code, false);
      },
      capturePngDataUrl: async () => {
        const wv = getLiveWebview();
        if (!wv || !wv.capturePage) {
          throw new Error("preview tab is not ready");
        }
        // Hidden preview panes do not own a composited surface. Calling
        // capturePage anyway makes Electron reject GUEST_VIEW_MANAGER_CALL with
        // UnknownVizError before our renderer-side catch can translate it.
        if (!visible) {
          throw new Error(
            "preview screenshot unavailable: this preview tab is not visible, so the browser has no painted frame to capture. Bring the preview tab to the foreground, or verify with codara_preview_snapshot / codara_preview_evaluate (DOM) instead of retrying the screenshot.",
          );
        }
        // One capture attempt. A 0-size frame is Chromium telling us the guest
        // has no painted surface to read; a too-short data URL means the frame
        // came back empty. We distinguish the two so the fallback below — and
        // the agent — can react to the right cause.
        const attemptCapture = async (): Promise<{
          dataUrl: string;
          zeroSize: boolean;
          retryable: boolean;
          reason: string;
        }> => {
          let img: CapturedImage | undefined;
          try {
            img = await wv.capturePage?.();
          } catch (err) {
            return {
              dataUrl: "",
              zeroSize: false,
              retryable: false,
              reason: (err as Error)?.message || String(err),
            };
          }
          if (!img) {
            return {
              dataUrl: "",
              zeroSize: false,
              retryable: false,
              reason: "capturePage returned no image",
            };
          }
          const size = img.getSize?.();
          const zeroSize = Boolean(size && (size.width === 0 || size.height === 0));
          const dataUrl = zeroSize ? "" : img.toDataURL?.() ?? "";
          if (dataUrl && dataUrl.length > 256) {
            return { dataUrl, zeroSize: false, retryable: false, reason: "" };
          }
          return {
            dataUrl: "",
            zeroSize,
            retryable: true,
            reason: zeroSize
              ? "captured a 0-size frame (page not painted yet)"
              : "captured an empty frame",
          };
        };

        let result = await attemptCapture();
        if (result.dataUrl) return result.dataUrl;
        if (!result.retryable) {
          throw new Error(`preview screenshot failed: ${result.reason}`);
        }

        // A visible guest can briefly return a blank/0-size frame just after
        // navigation. Let it paint two frames and retry once. Hard compositor
        // rejections are not retried: doing so only duplicates Electron's
        // GUEST_VIEW_MANAGER_CALL error without making a surface appear.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        await new Promise((resolve) => setTimeout(resolve, 120));
        result = await attemptCapture();
        if (result.dataUrl) return result.dataUrl;

        // Fail fast and actionable: tell the agent exactly why and what to do
        // instead, so it pivots to DOM probes rather than burning round-trips
        // (and context window) re-shooting a tab that cannot paint.
        throw new Error(
          result.zeroSize
            ? "preview screenshot unavailable: this preview tab is not visible, so the browser produced no painted frame to capture (capturePage returned a 0-size image). Bring the preview tab to the foreground, or verify with codara_preview_snapshot / codara_preview_evaluate (DOM) instead of retrying the screenshot."
            : `preview screenshot failed: ${result.reason}`,
        );
      },
    }),
    [currentUrl, getLiveWebview, url, visible],
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <AddressBar
        ref={addressRef}
        url={currentUrl || url}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        inspecting={inspecting}
        drawing={drawing}
        onSubmit={(next) => {
          if (!next) return;
          const wv = getLiveWebview();
          if (wv?.loadURL) {
            try {
              wv.loadURL(next);
            } catch {
              const live = getLiveWebview();
              if (live) live.src = next;
            }
          }
          onUrlChange(next);
        }}
        onReload={({ ignoreCache }) => {
          const wv = getLiveWebview();
          if (!wv) return;
          try {
            if (ignoreCache && wv.reloadIgnoringCache) {
              wv.reloadIgnoringCache();
            } else {
              wv.reload?.();
            }
          } catch {
            /* webview not dom-ready */
          }
        }}
        onBack={() => {
          try { getLiveWebview()?.goBack?.(); } catch { /* not dom-ready */ }
        }}
        onForward={() => {
          try { getLiveWebview()?.goForward?.(); } catch { /* not dom-ready */ }
        }}
        onOpenDevTools={() => {
          try { getLiveWebview()?.openDevTools?.(); } catch { /* not dom-ready */ }
        }}
        onOpenExternal={(target) => {
          if (target) void window.spark.openInSystemBrowser?.(target);
        }}
        onToggleInspect={toggleInspect}
        onToggleDraw={toggleDraw}
      />
      {error ? (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            background: "var(--danger-soft)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            borderBottom: "1px solid var(--rule-soft)",
            // A thin danger edge carries the status; the band tint stays calm.
            boxShadow: "inset 3px 0 0 var(--danger)",
          }}
        >
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--danger)",
            }}
          />
          <span
            className="spark-eyebrow"
            style={{ color: "var(--danger)", flex: "0 0 auto" }}
          >
            Load failed
          </span>
          <span
            style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={error}
          >
            {error}
          </span>
        </div>
      ) : null}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          background: "white",
          position: "relative",
          // Recess the webview under the chrome: a 1px soft hairline along the
          // top edge makes the dark-chrome-to-white-page seam read as
          // intentional depth rather than a raw cut.
          boxShadow: "inset 0 1px 0 var(--rule-soft)",
        }}
      >
        {!url ? <EmptyState onFocusAddress={() => addressRef.current?.focus()} /> : null}
        {url && !domReady && !error ? (
          <>
            {/* Safari-style loading hairline: a 2px accent bar pinned to the
                top seam of the webview, shimmering left-to-right while the page
                loads. Replaces the centered pulsing "Loading" word. The
                shimmer animation collapses to a static bar under
                prefers-reduced-motion via the global reduced-motion rule. */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 2,
                zIndex: 1,
                pointerEvents: "none",
                background:
                  "linear-gradient(90deg, var(--accent-soft) 0%, var(--accent) 50%, var(--accent-soft) 100%)",
                backgroundSize: "220% 100%",
                animation: "spark-shimmer 1.1s linear infinite",
              }}
            />
            <div
              role="status"
              aria-label="Loading"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg)",
                pointerEvents: "none",
              }}
            >
              <span
                className="spark-eyebrow"
                style={{
                  color: "var(--muted)",
                  animation: "spark-pulse 1.4s ease-in-out infinite",
                }}
              >
                Loading
              </span>
            </div>
          </>
        ) : null}
        <DrawOverlay
          active={drawing}
          busy={drawingBusy}
          preparePayload={prepareDrawingPayload}
          onClose={() => setDrawing(false)}
        />
        {inspectorPick ? (
          <InspectorOverlay
            pick={inspectorPick}
            buildPayload={(note) => buildInspectorPayload(inspectorPick, note)}
            onCancel={() => setInspectorPick(null)}
          />
        ) : null}
      </div>
    </div>
  );
});

function EmptyState({ onFocusAddress }: { onFocusAddress: () => void }) {
  return (
    <div
      className="spark-empty"
      style={{
        position: "absolute",
        inset: 0,
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
      }}
    >
      {/* A quiet globe glyph anchors the empty state — the same security/scheme
          icon family used in the address pill, reading as "the web, nothing
          loaded yet". */}
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          borderRadius: "var(--radius-surface, 7px)",
          border: "1px solid var(--rule-soft)",
          background: "var(--panel)",
          color: "var(--muted)",
          boxShadow: "var(--lift-hi)",
        }}
      >
        <GlobeIcon size={20} />
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div className="spark-eyebrow">Browser</div>
        <div style={{ color: "var(--ink)", fontSize: 14, fontWeight: 600 }}>
          Nothing to show yet
        </div>
      </div>
      <div className="spark-empty__body" style={{ maxWidth: 360 }}>
        Type a URL or pick a dev-server port. Detected URLs from your terminal
        auto-open a browser tab here.
      </div>
      <button
        type="button"
        className="spark-btn"
        onClick={onFocusAddress}
        style={{ marginTop: 4 }}
      >
        Enter a URL
      </button>
    </div>
  );
}

// Composite the freehand drawing canvas onto a copy of the page screenshot.
// Both inputs are PNG data URLs; the output is a single PNG data URL sized
// to the screenshot. If the screenshot is missing (capturePage failed or
// returned nothing usable), we fall back to the drawing alone — better than
// dropping the user's annotation on the floor.
async function composeDrawingOverScreenshot(
  pageDataUrl: string | null,
  drawingDataUrl: string,
): Promise<string> {
  if (!pageDataUrl) return drawingDataUrl;
  const [pageImage, drawingImage] = await Promise.all([
    loadImage(pageDataUrl),
    loadImage(drawingDataUrl),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = pageImage.naturalWidth || pageImage.width;
  canvas.height = pageImage.naturalHeight || pageImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return pageDataUrl;
  ctx.drawImage(pageImage, 0, 0, canvas.width, canvas.height);
  // The drawing canvas is the same logical size as the visible page but
  // backed by a devicePixelRatio scale; drawing it stretched to the
  // screenshot dimensions keeps the strokes aligned with the captured pixels.
  ctx.drawImage(drawingImage, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

export default BrowserPane;
