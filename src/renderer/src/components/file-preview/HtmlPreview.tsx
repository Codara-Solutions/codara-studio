import { useCallback, useEffect, useRef, useState } from "react";
import { pathToFileUrl } from "../../lib/pathToFileUrl";
import { isRemotePath } from "@shared/remote";

// HtmlPreview — rendered view for .html/.htm files, hosted in an Electron
// <webview> so the page runs in its own guest process with its scripts and
// styles fully live, and relative assets (css/js/images next to the file)
// resolve through the file:// origin. An <iframe> can't do this from the
// dev renderer (http://localhost may not embed file:// documents), and
// srcdoc would break every relative asset path.
//
// Deliberately much smaller than Preview/BrowserPane: no address bar, no
// history, no MCP bridge — just the one file, a reload button, and DevTools.

// Electron's ambient DOM augmentation types createElement("webview") as
// WebviewTag, so no hand-rolled element type is needed here. The imperative
// methods (reload, loadURL, openDevTools) throw before dom-ready — callers
// below are gated on the domReady state.
type WebviewElement = Electron.WebviewTag;

interface Props {
  path: string;
  // mtime from the host's stat — bumps the cache-busting query param when the
  // file is replaced on disk (create/rename events; content writes don't
  // surface through fs:changed, that's what the Reload button is for).
  mtimeMs: number;
}

export default function HtmlPreview({ path, mtimeMs }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const [domReady, setDomReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remote = isRemotePath(path);
  const url = `${pathToFileUrl(path)}?t=${Math.round(mtimeMs)}`;

  // Create the <webview> imperatively (dodges React's unknown-tag warning),
  // once per mount — mode toggles in EditorPane unmount/remount this
  // component, so every return to Preview is a fresh load of the file.
  useEffect(() => {
    if (remote) return;
    const host = hostRef.current;
    if (!host) return;

    const webview = document.createElement("webview") as WebviewElement;
    // Same guest hardening as Preview/BrowserPane, minus popups and preload:
    // the page gets a plain isolated Chromium context and nothing else.
    webview.setAttribute("webpreferences", "contextIsolation=yes");
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.border = "0";
    webview.style.background = "#fff";

    const onDomReady = () => setDomReady(true);
    const onFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (!e.isMainFrame) return;
      // -3 ABORTED fires when a new load supersedes the previous one.
      if (e.errorCode === -3) return;
      setError(`${e.errorDescription} (${e.errorCode})`);
    };
    const onDidNavigate = () => setError(null);
    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("did-fail-load", onFailLoad);
    webview.addEventListener("did-navigate", onDidNavigate);

    webview.src = url;
    host.appendChild(webview);
    webviewRef.current = webview;

    return () => {
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-fail-load", onFailLoad);
      webview.removeEventListener("did-navigate", onDidNavigate);
      webview.remove();
      webviewRef.current = null;
      setDomReady(false);
    };
    // url intentionally excluded: the navigation effect below handles
    // post-mount url changes without tearing the guest down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, remote]);

  // mtime bump (file replaced on disk) → navigate the existing guest.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || wv.src === url) return;
    if (domReady && wv.loadURL) {
      void wv.loadURL(url).catch(() => undefined);
    } else {
      wv.src = url;
    }
  }, [url, domReady]);

  const handleReload = useCallback(() => {
    setError(null);
    webviewRef.current?.reloadIgnoringCache?.();
  }, []);

  if (remote) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 12, maxWidth: 340 }}>
          <div className="spark-eyebrow" style={{ marginBottom: 6 }}>
            Remote file
          </div>
          Rendered HTML preview needs a local file — remote pages can&apos;t load their linked
          assets. Use the Edit view to read the source.
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg)",
            }}
          >
            <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
              <div className="spark-eyebrow" style={{ marginBottom: 6, color: "var(--danger)" }}>
                Page failed to load
              </div>
              {error}
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          flex: "0 0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          padding: "0 6px",
          color: "var(--muted)",
          borderTop: "1px solid var(--rule-soft)",
          background: "var(--panel)",
        }}
      >
        <button
          type="button"
          onClick={handleReload}
          disabled={!domReady}
          title="Reload page"
          style={footerButton}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.openDevTools?.()}
          disabled={!domReady}
          title="Open DevTools for this page"
          style={footerButton}
        >
          DevTools
        </button>
      </div>
    </div>
  );
}

const footerButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 8px",
  background: "transparent",
  color: "var(--muted)",
  border: "1px solid var(--rule-soft)",
  borderRadius: 4,
  cursor: "default",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: 0.2,
};
