import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { isFreshPartition } from "@shared/browser-partition";
import { holdPreviewCapturePaint, withPreviewCapturePaint } from "./capturePaint";
import AgentPresence from "./agent-presence/AgentPresence";
import PageDialogOverlay from "./PageDialogOverlay";
import AddressBar, { type AddressBarHandle } from "./AddressBar";
import CaptureActions from "./capture/CaptureActions";
import ResponsiveView from "./capture/ResponsiveView";
import PointPicker, { type PickedElement } from "./point/PointPicker";
import PointComposer from "./point/PointComposer";
import CommentOverlay from "./point/CommentOverlay";
import type { RunInPage } from "./point/pageScripts";
import "./point/point.css";
import { GlobeIcon } from "../icons";
import { MoonIcon } from "../Terminal/AgentSleepControls";
import { browserFullScreen, setBrowserFullScreen, stepBrowserFullScreen, useBrowserFullScreen } from "./fullScreen";
import {
  forgetBrowserTab,
  isTabAsleep,
  noteBrowserTab,
  noteTabPage,
  noteTabVisible,
  setTabSnapshot,
  takeWakeUrl,
  useBrowserTab,
  wakeTab,
} from "./tabs-memory/browserTabs";
import type { PointInspection } from "@shared/point-format";
import { formatTabReference } from "@shared/point-format";
import { useOptionalSelectionRouting } from "../../routing/SelectionRoutingContext";

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
  focusContent: () => void;
  // Surface area used by the spark-preview MCP bridge. None of these throw
  // when the webview isn't yet dom-ready — they reject with a descriptive
  // error the bridge can forward to the calling sub-agent.
  isReady: () => boolean;
  executeJavaScript: (code: string) => Promise<unknown>;
  capturePngDataUrl: () => Promise<string>;
  // Keeps a background guest rendering frames until release runs, for
  // measurements that need paints (Core Web Vitals, INP).
  holdPaint: () => { background: boolean; release: () => void };
  // The guest webContents id, used by the main-side computer-use executor to
  // drive trusted input against this exact <webview>. Null until dom-ready.
  getWebContentsId: () => number | null;
  // Resize the webview element (and therefore the guest viewport) to explicit
  // CSS pixels. Returns the applied size.
  resizeViewport: (width: number, height: number) => { width: number; height: number };
}

interface Props {
  /**
   * The id agents pass as tabId. Page dialogs open over this tab, picks and
   * comments name it, and a recording started from the toolbar is named
   * after it.
   */
  tabId?: string;
  url: string;
  // A logged-out tab's own temporary partition; fixed for the webview's life.
  partition?: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  // Fires once the guest is dom-ready and its webContents id is known, so the
  // host can announce the tab to main (wiring console capture early).
  onReady?: (webContentsId: number) => void;
  // Where a recording or pick details started from this pane are saved.
  workspaceId?: string | null;
}

type PointMode = "pick" | "compose" | "comment";

const BrowserPane = forwardRef<BrowserPaneHandle, Props>(function BrowserPane(
  { tabId, url, partition, visible, onUrlChange, onReady, workspaceId = null },
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
  const [responsive, setResponsive] = useState(false);
  const [pointMode, setPointMode] = useState<PointMode | null>(null);
  const [picked, setPicked] = useState<PickedElement[]>([]);
  const [inspection, setInspection] = useState<PointInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [pointNotice, setPointNotice] = useState<string | null>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const routing = useOptionalSelectionRouting();
  const tabRecord = useBrowserTab(tabId);
  const asleep = Boolean(tabRecord?.asleep);
  const fullScreen = useBrowserFullScreen(tabId);

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
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

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
    if (!preloadReady || asleep) return;
    const host = containerRef.current;
    if (!host) return;
    if (!urlRef.current) return; // empty url -> empty state, do not create the element

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
      // Taken only when a new page is made: a tab woken before its old page
      // was removed keeps that page, and the agent's navigate loads the URL.
      const wakeUrl = tabIdRef.current ? takeWakeUrl(tabIdRef.current) : null;
      // The tab's url follows at once, or a later run of this effect or the
      // url effect below would load the old page back.
      if (wakeUrl) {
        urlRef.current = wakeUrl;
        onUrlChangeRef.current(wakeUrl);
      }
      const initialUrl = wakeUrl ?? urlRef.current;
      if (!initialUrl) return; // empty url -> empty state, do not create the element
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
      // Must be set before the first navigation; Electron ignores a later
      // change. Any other name could be a `persist:` one that writes to disk.
      if (isFreshPartition(partition)) webview.setAttribute("partition", partition);
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
      if (tabIdRef.current && e.url) noteTabPage(tabIdRef.current, { url: e.url });
    };
    const onTitle = (e: { title?: string }) => {
      if (tabIdRef.current) noteTabPage(tabIdRef.current, { title: e.title ?? "" });
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
      setPointMode(null);
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

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-navigate", onDidNavigate);
    wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    wv.addEventListener("did-fail-load", onDidFailLoad);
    wv.addEventListener("render-process-gone", onRenderProcessGone);
    wv.addEventListener("page-title-updated", onTitle);

    return () => {
      // Detach our listeners; intentionally do NOT remove the webview
      // element itself. We want it to survive visibility toggles — the
      // element is dropped when the host div unmounts with the component.
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-navigate", onDidNavigate);
      wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      wv.removeEventListener("did-fail-load", onDidFailLoad);
      wv.removeEventListener("render-process-gone", onRenderProcessGone);
      wv.removeEventListener("page-title-updated", onTitle);
    };
  }, [hasUrl, preloadReady, inspectorPreloadUrl, asleep]);

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

  // Page scripts for the picker and comments. Failures stay inside the page
  // and come back as a value: a rejected executeJavaScript logs a main-process
  // stack per call, and the picker calls on every pointer move.
  const runInPage = useCallback<RunInPage>(
    async (code) => {
      const wv = getLiveWebview();
      if (!wv?.executeJavaScript) throw new Error("The page is still loading.");
      const wrapped = `(async () => { try { return { ok: true, value: await (${code}\n) }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } })()`;
      const outcome = (await wv.executeJavaScript(wrapped, false)) as { ok: boolean; value?: unknown; error?: string } | null;
      if (!outcome?.ok) throw new Error(outcome?.error ?? "The page did not answer.");
      return outcome.value;
    },
    [getLiveWebview],
  );

  const capturePage = useCallback(async (): Promise<string> => {
    const wv = getLiveWebview();
    if (!wv || !wv.capturePage) throw new Error("preview tab is not ready");
    return withPreviewCapturePaint(wv, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let img: CapturedImage | undefined;
        try {
          img = await Promise.race([
            wv.capturePage?.(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("capture timed out")), 4_000);
            }),
          ]);
        } catch (err) {
          throw new Error(`preview screenshot failed: ${(err as Error)?.message || String(err)}`);
        } finally {
          clearTimeout(timer);
        }
        const size = img?.getSize?.();
        const dataUrl = size?.width && size?.height ? img?.toDataURL?.() : "";
        if (dataUrl && dataUrl.length > 256) return dataUrl;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 120));
      }
      throw new Error("preview screenshot unavailable: the browser returned an empty frame. Check navigation with codara_preview_snapshot before retrying.");
    });
  }, [getLiveWebview]);

  const startPointing = useCallback(
    (mode: "pick" | "comment") => {
      if (!getLiveWebview()) return;
      // Picking and commenting work on the main page, which the responsive
      // view hides under frames laid out at other sizes.
      setResponsive(false);
      setPointNotice(null);
      setPointMode((current) => {
        if (current === mode || (mode === "pick" && current === "compose")) return null;
        if (mode === "pick") {
          setPicked([]);
          setInspection(null);
          setInspectError(null);
        }
        return mode;
      });
    },
    [getLiveWebview],
  );

  const stopPointing = useCallback(() => {
    setPointMode(null);
    setPicked([]);
    setInspection(null);
    setInspectError(null);
  }, []);

  // A finished pick is described by main (styles, rules, source files,
  // crops) through the same inspection the agent tool uses.
  const inspectPicked = useCallback(
    async (selection: PickedElement[]) => {
      if (!selection.length) return;
      setPointMode("compose");
      if (!tabId || !workspaceId) {
        setInspectError("This browser tab is not in an open workspace.");
        return;
      }
      setInspectLoading(true);
      setInspectError(null);
      try {
        const result = await window.spark.point.inspect({ workspaceId, tabId, selectors: selection.map((item) => item.ref), crops: "data" });
        setInspection(result);
      } catch (err) {
        setInspectError(err instanceof Error ? err.message : String(err));
      } finally {
        setInspectLoading(false);
      }
    },
    [tabId, workspaceId],
  );

  const removePicked = useCallback((ref: string) => {
    setPicked((list) => list.filter((item) => item.ref !== ref));
    setInspection((current) => current ? { ...current, elements: current.elements.filter((element) => element.ref !== ref) } : current);
  }, []);

  const finishPointing = useCallback((outcome: { message: string }) => {
    stopPointing();
    setPointNotice(outcome.message);
  }, [stopPointing]);

  useEffect(() => {
    if (!pointNotice) return;
    const timer = setTimeout(() => setPointNotice(null), 3200);
    return () => clearTimeout(timer);
  }, [pointNotice]);

  // The Mod+Shift+E / Mod+Shift+X shortcuts name the tab they are for.
  useEffect(() => {
    if (!tabId) return;
    const onPoint = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; mode?: "pick" | "comment" }>).detail;
      if (detail?.tabId === tabId && (detail.mode === "pick" || detail.mode === "comment")) startPointing(detail.mode);
    };
    window.addEventListener("spark:browser-point", onPoint);
    return () => window.removeEventListener("spark:browser-point", onPoint);
  }, [startPointing, tabId]);

  useEffect(() => {
    if (!visible && pointMode) stopPointing();
  }, [pointMode, stopPointing, visible]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const measure = () => setHostSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const copyTabReference = useCallback(
    async (detail: "id" | "full") => {
      if (!tabId) return;
      let title = "";
      try {
        title = getLiveWebview()?.getTitle?.() ?? "";
      } catch {
        /* not dom-ready */
      }
      const text = detail === "id"
        ? tabId
        : formatTabReference({ tabId, url: currentUrl || urlRef.current, title, session: routing?.tabSession(tabId) ?? null });
      await window.spark.clipboard.writeText(text);
      setPointNotice(detail === "id" ? `Copied ${tabId}` : `Copied ${tabId} with its URL and session`);
    },
    [currentUrl, getLiveWebview, routing, tabId],
  );

  // The tabs and memory view knows every tab, whether it is on screen and,
  // through these, when it was last seen.
  const isolated = isFreshPartition(partition);
  useEffect(() => {
    if (!tabId) return;
    noteBrowserTab(tabId, { workspaceId, url: urlRef.current, isolated });
  }, [isolated, tabId, workspaceId]);
  useEffect(() => {
    if (!tabId) return;
    return () => forgetBrowserTab(tabId);
  }, [tabId]);
  useEffect(() => {
    if (tabId) noteTabVisible(tabId, visible);
  }, [tabId, visible]);

  // A sleeping tab loads again as soon as it is on screen, as a discarded
  // tab does in a browser.
  useEffect(() => {
    if (tabId && visible && asleep) wakeTab(tabId);
  }, [asleep, tabId, visible]);

  // Going to sleep: keep a small picture of the page, then remove the
  // webview, which ends its renderer process. Waking re-creates it (the
  // create effect above) at the tab's current URL.
  useEffect(() => {
    if (!asleep || !tabId) return;
    const wv = webviewRef.current;
    if (!wv) return;
    let cancelled = false;
    void (async () => {
      // Removing the webview while capturePage still runs on it fails in
      // the guest view manager; the capture has its own time limit.
      const picture = await capturePage().then(shrinkSnapshot).catch(() => null);
      if (cancelled || !isTabAsleep(tabId)) return;
      if (picture) setTabSnapshot(tabId, picture);
      if (webviewRef.current === wv) webviewRef.current = null;
      domReadyRef.current = false;
      setDomReady(false);
      setCanGoBack(false);
      setCanGoForward(false);
      setPointMode(null);
      setResponsive(false);
      wv.remove();
    })();
    return () => {
      cancelled = true;
    };
  }, [asleep, capturePage, tabId]);

  // Full screen. Esc leaves (a page's own use of Esc does not stop it), F11
  // steps to the whole display and back; a tab that leaves the screen leaves
  // full screen too.
  const fullScreenOn = fullScreen !== "off";
  useEffect(() => {
    if (!fullScreenOn || !tabId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      setBrowserFullScreen(tabId, "off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreenOn, tabId]);
  useEffect(() => {
    if (!tabId || visible) return;
    if (fullScreenOn) setBrowserFullScreen(tabId, "off");
  }, [fullScreenOn, tabId, visible]);
  useEffect(() => {
    if (!tabId) return;
    return () => {
      if (browserFullScreen().tabId === tabId) setBrowserFullScreen(tabId, "off");
    };
  }, [tabId]);

  // F11 and F12 from the shortcut table name the tab they are for.
  useEffect(() => {
    if (!tabId) return;
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; action?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      if (detail.action === "fullScreen") stepBrowserFullScreen(tabId, "F11");
      if (detail.action === "devTools") {
        try {
          getLiveWebview()?.openDevTools?.();
        } catch {
          /* not dom-ready */
        }
      }
    };
    window.addEventListener("spark:browser-action", onAction);
    return () => window.removeEventListener("spark:browser-action", onAction);
  }, [getLiveWebview, tabId]);

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
      focusContent: () => {
        const wv = getLiveWebview();
        if (!wv) throw new Error("preview tab is not ready");
        wv.focus();
      },
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
      holdPaint: () => {
        const wv = getLiveWebview();
        if (!wv) throw new Error("preview tab is not ready");
        const hold = holdPreviewCapturePaint(wv);
        return { background: hold.changed, release: hold.release };
      },
      capturePngDataUrl: capturePage,
    }),
    [capturePage, currentUrl, getLiveWebview, url, visible],
  );

  return (
    <div
      data-browser-pane
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
        pointing={pointMode === "pick" || pointMode === "compose"}
        commenting={pointMode === "comment"}
        tabId={tabId ?? null}
        workspaceId={workspaceId}
        responsive={responsive}
        fullScreen={fullScreen !== "off"}
        onToggleResponsive={() => {
          if (!responsive) stopPointing();
          setResponsive(!responsive);
        }}
        onToggleFullScreen={() => {
          if (tabId) stepBrowserFullScreen(tabId, "button");
        }}
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
        onTogglePoint={() => startPointing("pick")}
        onToggleComment={() => startPointing("comment")}
        onCopyTabId={(detail) => void copyTabReference(detail)}
        recordTool={
          <CaptureActions
            url={asleep ? "" : currentUrl || url}
            visible={visible}
            tabId={tabId}
            workspaceId={workspaceId}
            getWebview={getLiveWebview}
          />
        }
      />
      {isFreshPartition(partition) ? (
        <div
          data-preview-isolated
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 12px",
            background: "var(--panel)",
            color: "var(--muted)",
            fontSize: 11,
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <span className="spark-eyebrow" style={{ color: "var(--ink)", flex: "0 0 auto" }}>
            Logged out
          </span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Temporary session, separate from your other tabs. Nothing it stores is kept.
          </span>
        </div>
      ) : null}
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
        {url && !domReady && !error && !asleep ? (
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
        {asleep && tabId ? (
          <SleepingView
            snapshot={tabRecord?.snapshot ?? null}
            title={tabRecord?.title || currentUrl || url}
            onWake={() => wakeTab(tabId)}
          />
        ) : null}
        {fullScreen !== "off" ? <FullScreenHint mode={fullScreen} /> : null}
        <AgentPresence tabId={tabId} visible={visible} pageRef={webviewRef} />
        <PageDialogOverlay tabId={tabId} />
        {responsive && visible && url ? (
          <ResponsiveView
            url={currentUrl || url}
            onNavigate={(next) => {
              const wv = getLiveWebview();
              if (!wv?.loadURL) return;
              try {
                if (wv.getURL?.() !== next) wv.loadURL(next);
              } catch {
                /* webview not dom-ready */
              }
            }}
            onClose={() => setResponsive(false)}
          />
        ) : null}
        {pointMode === "pick" || pointMode === "compose" ? (
          <PointPicker
            run={runInPage}
            mode={pointMode === "pick" ? "pick" : "passive"}
            selection={picked}
            onSelectionChange={setPicked}
            onFinish={(selection) => void inspectPicked(selection)}
            onCancel={stopPointing}
          />
        ) : null}
        {pointMode === "compose" && tabId ? (
          <PointComposer
            tabId={tabId}
            workspaceId={workspaceId}
            inspection={inspection}
            loading={inspectLoading}
            error={inspectError}
            anchor={picked[0] ? {
              left: picked[0].info.rect.x / (picked[0].info.scale || 1),
              top: picked[0].info.rect.y / (picked[0].info.scale || 1),
              width: picked[0].info.rect.width / (picked[0].info.scale || 1),
              height: picked[0].info.rect.height / (picked[0].info.scale || 1),
            } : null}
            hostSize={hostSize}
            onRemove={removePicked}
            onAddMore={() => setPointMode("pick")}
            onClose={stopPointing}
            onDone={finishPointing}
          />
        ) : null}
        {pointMode === "comment" && tabId ? (
          <CommentOverlay
            tabId={tabId}
            workspaceId={workspaceId}
            run={runInPage}
            capture={capturePage}
            onClose={stopPointing}
            onDone={finishPointing}
          />
        ) : null}
        {pointNotice ? (
          <div className="cp-toast spark-glass--strong spark-overlay-surface" role="status" data-testid="point-notice">
            <span className="cp-toast__dot" aria-hidden />
            {pointNotice}
          </div>
        ) : null}
      </div>
    </div>
  );
});

// A small JPEG of the page for its sleeping view: the full capture is a
// device-pixel PNG, kept in memory for as long as the tab sleeps.
async function shrinkSnapshot(dataUrl: string): Promise<string | null> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, 960 / Math.max(1, image.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function SleepingView({ snapshot, title, onWake }: { snapshot: string | null; title: string; onWake: () => void }) {
  return (
    <div className="bp-asleep" data-testid="preview-asleep" onClick={onWake}>
      {snapshot ? <img className="bp-asleep__picture" src={snapshot} alt="" /> : null}
      <div className="bp-asleep__card">
        <span className="bp-asleep__title">
          <MoonIcon size={13} /> This tab is asleep
        </span>
        <span>
          Its page was closed to free memory. {title ? <>Wake it to load <strong>{title}</strong> again.</> : "Wake it to load the page again."}
        </span>
        <button type="button" className="spark-btn" onClick={onWake}>
          Wake
        </button>
      </div>
    </div>
  );
}

function FullScreenHint({ mode }: { mode: "window" | "display" }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    const timer = setTimeout(() => setGone(true), 3500);
    return () => clearTimeout(timer);
  }, [mode]);
  return (
    <div className={`bp-fs-hint${gone ? " is-gone" : ""}`} role="status" data-testid="preview-fullscreen-hint">
      {mode === "window" ? (
        <>
          Full screen · <span className="spark-kbd">Esc</span> to leave · <span className="spark-kbd">F11</span> for the whole display
        </>
      ) : (
        <>
          <span className="spark-kbd">Esc</span> to leave full screen
        </>
      )}
    </div>
  );
}

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
        Type a URL, or a port such as 3000 for a local server. Links your
        terminals print open in a browser tab here.
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

export default BrowserPane;
