import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

interface Props {
  path: string;
  // Bumps when the file changes on disk — triggers a re-render.
  mtimeMs: number;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];

// Word-document viewer. docx-preview renders the OOXML package straight into
// a host <div> as real DOM (one element tree per page, incl. headers/footers),
// so — unlike the pdf.js viewer — there's no canvas and no incremental
// per-page render: `renderAsync` builds the whole document once. Zoom uses
// the CSS `zoom` property (Chromium-only, fine since this is Electron) rather
// than `transform: scale`, so the scroll container's layout height tracks the
// zoomed size instead of reserving the unscaled box.
export default function DocxPreview({ path, mtimeMs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Natural width of the rendered page, used to center it in the scroller.
  const [pageWidth, setPageWidth] = useState<number | null>(null);

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

  const zoomOut = () => {
    setZoom((z) => [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0]);
  };
  const zoomIn = () => {
    setZoom((z) => ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  };

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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          padding: "0 10px",
          background: "var(--panel)",
          borderBottom: "1px solid var(--rule-soft)",
          color: "var(--muted)",
          fontSize: 11,
        }}
      >
        {loading && <span style={{ marginRight: "auto" }}>Loading document…</span>}
        <button type="button" className="spark-btn" style={zoomBtnStyle} onClick={zoomOut} title="Zoom out">
          −
        </button>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            minWidth: 42,
            textAlign: "center",
          }}
        >
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className="spark-btn" style={zoomBtnStyle} onClick={zoomIn} title="Zoom in">
          +
        </button>
        <button
          type="button"
          className="spark-btn"
          style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px" }}
          onClick={() => setZoom(1)}
          title="Reset zoom"
        >
          100%
        </button>
      </div>
      <div
        ref={scrollRef}
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
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 24,
  height: 22,
  padding: 0,
  fontSize: 13,
  lineHeight: 1,
};
