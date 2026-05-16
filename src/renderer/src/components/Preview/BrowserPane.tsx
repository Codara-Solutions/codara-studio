import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import AddressBar, { type AddressBarHandle } from "./AddressBar";

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
type WebviewMethods = {
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  openDevTools: () => void;
  closeDevTools: () => void;
};

type WebviewElement = HTMLElement &
  Partial<WebviewMethods> & {
    src: string;
    addEventListener: (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: (e: any) => void,
    ) => void;
    removeEventListener: (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: (e: any) => void,
    ) => void;
  };

export interface BrowserPaneHandle {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  loadURL: (url: string) => void;
  getURL: () => string;
  openDevTools: () => void;
  focusAddressBar: () => void;
}

interface Props {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
}

const BrowserPane = forwardRef<BrowserPaneHandle, Props>(function BrowserPane(
  { url, visible, onUrlChange },
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

  // `domReady` mirrored into a ref so the navigation effect below can gate
  // on it without taking it as a dependency (which would re-run that effect
  // every time readiness flips). Listeners read the ref; the state copy
  // exists only to drive the loading-overlay render.
  const domReadyRef = useRef(false);
  // `onUrlChange` is a fresh closure on every parent render. We funnel it
  // through a ref so the create-once effect doesn't list it as a dependency
  // (and therefore doesn't tear down + rebuild the webview when the parent
  // re-renders for unrelated reasons).
  const onUrlChangeRef = useRef(onUrlChange);
  useEffect(() => {
    onUrlChangeRef.current = onUrlChange;
  }, [onUrlChange]);

  // The latest url prop, readable from the create-once listeners (which are
  // attached before any navigation and would otherwise capture the initial
  // url forever).
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

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
  useEffect(() => {
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
      webview.setAttribute("webpreferences", "contextIsolation=yes");
      webview.setAttribute("allowpopups", "true");
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

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-navigate", onDidNavigate);
    wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    wv.addEventListener("did-fail-load", onDidFailLoad);

    return () => {
      // Detach our listeners; intentionally do NOT remove the webview
      // element itself. We want it to survive visibility toggles — the
      // element is dropped when the host div unmounts with the component.
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-navigate", onDidNavigate);
      wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
      wv.removeEventListener("did-fail-load", onDidFailLoad);
    };
  }, [hasUrl]);

  // ── Navigate when the parent's `url` prop changes. Kept separate from
  // the create-once effect so readiness (tracked via domReadyRef, not a
  // dependency) doesn't retrigger element creation. Calling getURL /
  // loadURL before dom-ready throws and crashes the renderer, so we bail
  // until the ref says the webview is attached.
  useEffect(() => {
    if (!url) return;
    const webview = webviewRef.current;
    if (!webview) return; // not created yet — src attribute carries the initial url
    if (!domReadyRef.current) return; // wait for dom-ready before touching methods
    try {
      const live = webview.getURL?.() ?? "";
      if (live && live !== url) {
        webview.loadURL?.(url);
      }
    } catch {
      // Webview detached between checks (very rare); fall back to src.
      webview.src = url;
    }
  }, [url, domReady]);

  useImperativeHandle(
    ref,
    (): BrowserPaneHandle => ({
      reload: () => {
        try {
          webviewRef.current?.reload?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      goBack: () => {
        try {
          webviewRef.current?.goBack?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      goForward: () => {
        try {
          webviewRef.current?.goForward?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      loadURL: (next: string) => {
        try {
          webviewRef.current?.loadURL?.(next);
        } catch {
          if (webviewRef.current) webviewRef.current.src = next;
        }
      },
      getURL: () => {
        try {
          return webviewRef.current?.getURL?.() ?? currentUrl ?? url;
        } catch {
          return currentUrl ?? url;
        }
      },
      openDevTools: () => {
        try {
          webviewRef.current?.openDevTools?.();
        } catch {
          /* webview not yet dom-ready */
        }
      },
      focusAddressBar: () => addressRef.current?.focus(),
    }),
    [currentUrl, url],
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
        onSubmit={(next) => {
          if (!next) return;
          if (webviewRef.current?.loadURL) {
            try {
              webviewRef.current.loadURL(next);
            } catch {
              if (webviewRef.current) webviewRef.current.src = next;
            }
          }
          onUrlChange(next);
        }}
        onReload={() => {
          try { webviewRef.current?.reload?.(); } catch { /* not dom-ready */ }
        }}
        onBack={() => {
          try { webviewRef.current?.goBack?.(); } catch { /* not dom-ready */ }
        }}
        onForward={() => {
          try { webviewRef.current?.goForward?.(); } catch { /* not dom-ready */ }
        }}
        onOpenDevTools={() => {
          try { webviewRef.current?.openDevTools?.(); } catch { /* not dom-ready */ }
        }}
        onOpenExternal={(target) => {
          if (target) void window.spark.openExternal?.(target);
        }}
      />
      {error ? (
        <div
          style={{
            flex: "0 0 auto",
            padding: "6px 12px",
            background: "color-mix(in oklch, var(--danger) 12%, transparent)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          {error}
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
        }}
      >
        {!url ? <EmptyState /> : null}
        {url && !domReady && !error ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              pointerEvents: "none",
            }}
          >
            Loading…
          </div>
        ) : null}
      </div>
    </div>
  );
});

function EmptyState() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color: "var(--muted)",
        background: "var(--bg)",
        padding: 32,
        textAlign: "center",
      }}
    >
      <div style={{ color: "var(--ink)", fontSize: 14, fontWeight: 600 }}>
        Nothing to preview yet
      </div>
      <div style={{ fontSize: 12, maxWidth: 360, lineHeight: 1.5 }}>
        Type a URL above, or open the Ports dropdown to jump straight to your
        running dev server. Detected URLs from your terminal will auto-open a
        preview tab here.
      </div>
    </div>
  );
}

export default BrowserPane;
