import { useEffect, useRef, useState } from "react";
// Legacy build required: the modern build assumes Uint8Array.prototype.toHex
// (Chromium 140+), but Electron 32 ships Chromium 128 — every document load
// died with "a.toHex is not a function" while computing the fingerprint.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
// Vite bundles the worker as a same-origin asset, so `script-src 'self'`
// (which worker-src falls back to) covers it — no CDN, no CSP exception.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { DockablePaneBar } from "../../tabs/dockChromeSlot";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Props {
  path: string;
  // Bumps when the file changes on disk — triggers a re-load.
  mtimeMs: number;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];

// Scrollable, lazily-rendered pdf.js viewer. Document bytes arrive over IPC
// (fetch()/XHR cannot read file:// URLs from either the dev http origin or
// the packaged file origin); pages render to canvases only when scrolled
// near the viewport so 1000-page documents stay cheap.
export default function PdfPreview({ path, mtimeMs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Width of page 1 at scale 1, used to compute the fit-width base scale.
  const [baseWidth, setBaseWidth] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    setDoc(null);
    setError(null);
    void (async () => {
      try {
        const bytes = await window.spark.fs.readFileBytes(path);
        // pdf.js takes ownership of the buffer it is handed — copy so the
        // IPC-delivered array stays untouched.
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const pdf = await task.promise;
        if (cancelled) return; // task.destroy() in cleanup tears the doc down
        const first = await pdf.getPage(1);
        if (cancelled) return;
        setBaseWidth(first.getViewport({ scale: 1 }).width);
        setDoc(pdf);
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
      // Destroying the loading task also destroys the document + worker.
      if (task) void task.destroy().catch(() => undefined);
    };
  }, [path, mtimeMs]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (error) {
    return (
      <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
        <div className="spark-eyebrow" style={{ marginBottom: 6, color: "var(--danger)" }}>
          PDF error
        </div>
        {error}
      </div>
    );
  }
  if (!doc || baseWidth === null) {
    return <div style={{ margin: "auto", color: "var(--muted)", fontSize: 12 }}>Loading PDF…</div>;
  }

  // Fit the page width into the container (minus padding), scaled by zoom.
  const fitScale = containerWidth > 0 ? Math.max(0.1, (containerWidth - 48) / baseWidth) : 1;
  const scale = fitScale * zoom;

  const zoomOut = () => {
    setZoom((z) => [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0]);
  };
  const zoomIn = () => {
    setZoom((z) => ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <DockablePaneBar>
        <span style={{ fontFamily: "var(--font-mono)", marginRight: "auto", whiteSpace: "nowrap" }}>
          {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
        </span>
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
          title="Fit width"
        >
          Fit
        </button>
      </DockablePaneBar>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 24px", display: "grid", gap: 16 }}
      >
        {Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={`${i + 1}@${scale.toFixed(3)}`} doc={doc} pageNumber={i + 1} scale={scale} />
        ))}
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
  flex: "0 0 auto",
  // Docked, these live in the chrome band's pointer-none slot; each control
  // re-enables the pointer for itself.
  pointerEvents: "auto",
};

// One page: a fixed-size placeholder that swaps in a rendered canvas when
// scrolled near the viewport (IntersectionObserver, 600px lookahead).
function PdfPage({ doc, pageNumber, scale }: { doc: PDFDocumentProxy; pageNumber: number; scale: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: null, rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    void (async () => {
      try {
        page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        setSize({ w: viewport.width, h: viewport.height });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
      } catch {
        // Render races (scale change mid-render) throw RenderingCancelled;
        // the replacement keyed instance takes over.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, doc, pageNumber, scale]);

  return (
    <div
      ref={hostRef}
      style={{
        justifySelf: "center",
        width: size?.w,
        height: size?.h,
        minHeight: size ? undefined : 240,
        minWidth: size ? undefined : 200,
        background: "#fff",
        borderRadius: 2,
        boxShadow: "0 2px 14px rgba(0,0,0,0.4)",
        overflow: "hidden",
      }}
    >
      {visible && (
        <canvas ref={canvasRef} style={{ width: size?.w, height: size?.h, display: "block" }} />
      )}
    </div>
  );
}
