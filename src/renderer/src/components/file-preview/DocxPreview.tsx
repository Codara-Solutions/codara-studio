import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderAsync } from "docx-preview";
import { DockablePaneBar } from "../../tabs/dockChromeSlot";
import FindBar from "../find/FindBar";
import { useDomFind } from "../find/useDomFind";
import { useViewerZoom } from "../zoom/useViewerZoom";
import ZoomControl from "../zoom/ZoomControl";

interface Props {
  path: string;
  // Bumps when the file changes on disk — triggers a re-render.
  mtimeMs: number;
  toolbarAction?: ReactNode;
  forceLocalToolbar?: boolean;
}

// Word-document viewer. docx-preview renders the OOXML package straight into
// a host <div> as real DOM (one element tree per page, incl. headers/footers),
// so — unlike the pdf.js viewer — there's no canvas and no incremental
// per-page render: `renderAsync` builds the whole document once. Zoom uses
// the CSS `zoom` property (Chromium-only, fine since this is Electron) rather
// than `transform: scale`, so the scroll container's layout height tracks the
// zoomed size instead of reserving the unscaled box.
export default function DocxPreview({ path, mtimeMs, toolbarAction, forceLocalToolbar }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Natural width of the rendered page, used to center it in the scroller.
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const findHostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useDomFind({
    hostRef: findHostRef,
    contentRef: hostRef,
    scrollerRef: scrollRef,
    enabled: error === null,
    label: "Find in document",
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageWidth(null);
    const host = hostRef.current;
    if (host) host.replaceChildren();
    void (async () => {
      try {
        const bytes = await window.spark.fs.readFileBytes(path);
        if (cancelled || !host) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer]);
        await renderAsync(blob, host, undefined, {
          inWrapper: true,
          // Embed media as data URLs instead of object URLs — simpler
          // lifecycle, no blob-URL leak to track across re-renders.
          useBase64URL: true,
          ignoreLastRenderedPageBreak: false,
        });
        if (cancelled) return;
        const page = host.querySelector<HTMLElement>(".docx");
        setPageWidth(page ? page.getBoundingClientRect().width : host.scrollWidth);
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error)?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mtimeMs]);

  const { zoom, apply, fit } = useViewerZoom({
    rootRef,
    scrollerRef: scrollRef,
    contentRef: hostRef,
    min: 0.5,
    max: 3,
    enabled: error === null,
  });

  if (error) {
    return (
      <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
        <div className="spark-eyebrow" style={{ marginBottom: 6, color: "var(--danger)" }}>
          Document error
        </div>
        {error}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <DockablePaneBar forceLocal={forceLocalToolbar}>
        {loading && <span style={{ marginRight: "auto", whiteSpace: "nowrap" }}>Loading document…</span>}
        <ZoomControl
          zoom={zoom}
          onZoomOut={() => apply("out")}
          onZoomIn={() => apply("in")}
          onFit={fit}
          fitLabel="100%"
          fitTitle="Reset zoom"
        />
        {toolbarAction}
      </DockablePaneBar>
      <div ref={findHostRef} className="codara-find-host" onKeyDown={find.onKeyDown}>
        <div
          ref={scrollRef}
          className="codara-find-scroller"
          // Focusable so a click inside makes Ctrl+F find in this document.
          tabIndex={-1}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "16px 24px",
            background: "var(--bg)",
          }}
        >
          <div
            style={{
              width: pageWidth ?? undefined,
              margin: "0 auto",
              zoom,
            }}
          >
            <div ref={hostRef} />
          </div>
        </div>
        {find.bar && <FindBar {...find.bar} />}
      </div>
    </div>
  );
}
