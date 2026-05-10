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

  // We create the <webview> imperatively rather than declaring it in JSX
  // so we can avoid React's "Unknown HTML tag" warnings and get tighter
  // control over event listener lifetimes.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    if (!url) return; // empty url -> empty state, do not create the element

    // Reuse the existing element if we already have one for this BrowserPane;
    // otherwise create a fresh <webview>. This lets us swap URLs through
    // loadURL() instead of re-creating the embedder, which is much faster.
    let webview = webviewRef.current;
    if (!webview) {
      webview = document.createElement("webview") as WebviewElement;
      // Sandboxed safety: keep contextIsolation on for the embedded site.
      webview.setAttribute("webpreferences", "contextIsolation=yes");
      webview.setAttribute("allowpopups", "true");
      webview.style.width = "100%";
      webview.style.height = "100%";
      webview.style.border = "0";
      webview.style.background = "white";
      webview.src = url;
      host.appendChild(webview);
      webviewRef.current = webview;

      const onDomReady = () => {
        setDomReady(true);
        setCanGoBack(webview!.canGoBack?.() ?? false);
        setCanGoForward(webview!.canGoForward?.() ?? false);
        setCurrentUrl(webview!.getURL?.() ?? url);
        setError(null);
      };
      const onDidNavigate = (e: { url: string }) => {
        setCurrentUrl(e.url);
        setCanGoBack(webview!.canGoBack?.() ?? false);
        setCanGoForward(webview!.canGoForward?.() ?? false);
        setError(null);
        if (e.url) onUrlChange(e.url);
      };
      const onDidNavigateInPage = (e: { url: string; isMainFrame: boolean }) => {
        if (!e.isMainFrame) return;
        setCurrentUrl(e.url);
        setCanGoBack(webview!.canGoBack?.() ?? false);
        setCanGoForward(webview!.canGoForward?.() ?? false);
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

      webview.addEventListener("dom-ready", onDomReady);
      webview.addEventListener("did-navigate", onDidNavigate);
      webview.addEventListener("did-navigate-in-page", onDidNavigateInPage);
      webview.addEventListener("did-fail-load", onDidFailLoad);
    }

    // If the parent's url prop changed for an already-mounted webview,
    // navigate to the new URL.
    if (webview.getURL && webview.getURL() && webview.getURL() !== url) {
      try {
        webview.loadURL?.(url);
      } catch {
        webview.src = url;
      }
    }

    return () => {
      // Intentional: do NOT remove the webview here. We want it to survive
      // visibility toggles. Cleanup happens when the BrowserPane unmounts
      // entirely (the host div drops, taking the child <webview> with it).
    };
  }, [url, onUrlChange]);

  useImperativeHandle(
    ref,
    (): BrowserPaneHandle => ({
      reload: () => webviewRef.current?.reload?.(),
      goBack: () => webviewRef.current?.goBack?.(),
      goForward: () => webviewRef.current?.goForward?.(),
      loadURL: (next: string) => {
        try {
          webviewRef.current?.loadURL?.(next);
        } catch {
          if (webviewRef.current) webviewRef.current.src = next;
        }
      },
      getURL: () => webviewRef.current?.getURL?.() ?? currentUrl ?? url,
      openDevTools: () => webviewRef.current?.openDevTools?.(),
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
        onReload={() => webviewRef.current?.reload?.()}
        onBack={() => webviewRef.current?.goBack?.()}
        onForward={() => webviewRef.current?.goForward?.()}
        onOpenDevTools={() => webviewRef.current?.openDevTools?.()}
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
