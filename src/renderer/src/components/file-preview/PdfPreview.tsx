import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
// Legacy build required: the modern build assumes Uint8Array.prototype.toHex
// (Chromium 140+), but Electron 32 ships Chromium 128 — every document load
// died with "a.toHex is not a function" while computing the fingerprint.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
// Vite bundles the worker as a same-origin asset, so `script-src 'self'`
// (which worker-src falls back to) covers it — no CDN, no CSP exception.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { DockablePaneBar } from "../../tabs/dockChromeSlot";
import FindBar from "../find/FindBar";
import { usePdfFind } from "./usePdfFind";
import { useViewerZoom } from "../zoom/useViewerZoom";
import ZoomControl from "../zoom/ZoomControl";
import "./pdf-text-layer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

interface Props {
  path: string;
  // Bumps when the file changes on disk — triggers a re-load.
  mtimeMs: number;
  toolbarAction?: ReactNode;
  forceLocalToolbar?: boolean;
}

// Scrollable, lazily-rendered pdf.js viewer. Document bytes arrive over IPC
// (fetch()/XHR cannot read file:// URLs from either the dev http origin or
// the packaged file origin); pages render to canvases only when scrolled
// near the viewport so 1000-page documents stay cheap. Each rendered page
// also gets pdf.js's text layer, which makes its text findable (Ctrl+F) and
// selectable.
export default function PdfPreview({ path, mtimeMs, toolbarAction, forceLocalToolbar }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Page 1 at scale 1: its width gives the fit-width base scale, and its size
  // stands in for every page not drawn yet, so a zoom keeps the page under
  // the pointer where it was.
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const baseWidth = baseSize?.w ?? null;
  const [containerWidth, setContainerWidth] = useState(0);
  const findHostRef = useRef<HTMLDivElement>(null);

  // One text extraction per page, shared by find (which needs every page)
  // and the text layers (which need the pages on screen).
  const textCache = useRef<{ doc: PDFDocumentProxy | null; pages: Map<number, Promise<PdfTextContent>> }>({
    doc: null,
    pages: new Map(),
  });
  const getTextContent = useCallback(
    (pageNumber: number): Promise<PdfTextContent> => {
      if (!doc) return Promise.reject(new Error("No document"));
      if (textCache.current.doc !== doc) textCache.current = { doc, pages: new Map() };
      let content = textCache.current.pages.get(pageNumber);
      if (!content) {
        content = doc.getPage(pageNumber).then((page) => page.getTextContent());
        textCache.current.pages.set(pageNumber, content);
      }
      return content;
    },
    [doc],
  );
  const find = usePdfFind({ doc, hostRef: findHostRef, scrollerRef: containerRef, getTextContent });
  // 1 is the page width fitted to the pane; pdf.js repaints every page on a
  // change, so the wheel moves in steps.
  const { zoom, controls } = useViewerZoom({
    rootRef,
    scrollerRef: containerRef,
    min: 0.5,
    max: 3,
    wheel: "steps",
    enabled: doc !== null && baseWidth !== null,
  });

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
        const firstViewport = first.getViewport({ scale: 1 });
        setBaseSize({ w: firstViewport.width, h: firstViewport.height });
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

  // The scroller mounts with the document (a loading message stands in until
  // then), so the observer attaches once there is one.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc, baseWidth]);

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

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <DockablePaneBar forceLocal={forceLocalToolbar}>
        <span style={{ fontFamily: "var(--font-mono)", marginRight: "auto", whiteSpace: "nowrap" }}>
          {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
        </span>
        <ZoomControl {...controls} fitTitle="Fit width" />
        {toolbarAction}
      </DockablePaneBar>
      <div ref={findHostRef} className="codara-find-host" onKeyDown={find.onKeyDown}>
        <div
          ref={containerRef}
          className="codara-find-scroller"
          // Focusable so a click inside makes Ctrl+F find in this document.
          tabIndex={-1}
          style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 24px", display: "grid", gap: 16 }}
        >
          {/* Pages wait for the pane's width, so the first pages are not
              drawn once at a guessed size and again right after. */}
          {containerWidth > 0 &&
            Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage
                key={i + 1}
                doc={doc}
                pageNumber={i + 1}
                scale={scale}
                placeholder={{ w: baseSize!.w * scale, h: baseSize!.h * scale }}
                scrollerRef={containerRef}
                getTextContent={getTextContent}
                onTextLayer={find.onTextLayer}
              />
            ))}
        </div>
        {find.bar && <FindBar {...find.bar} />}
      </div>
    </div>
  );
}

// One page: a fixed-size placeholder that holds a drawn canvas, and the text
// layer over it, only while the page is near the viewport
// (IntersectionObserver on the scroller, 600px lookahead). A page that moves
// far off screen lets its canvas and text layer go, so a long document keeps
// only a few pages in memory. A zoom resizes every page at once (the last
// drawing stretched to fit) and redraws only the pages near the viewport once
// the zoom settles, into a new canvas that replaces the old one when done, so
// the page being read never goes blank and a burst of wheel steps costs one
// drawing per page on screen.
const REDRAW_DELAY_MS = 120;
const LOOKAHEAD = "600px";

function PdfPage({
  doc,
  pageNumber,
  scale,
  placeholder,
  scrollerRef,
  getTextContent,
  onTextLayer,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  placeholder: { w: number; h: number };
  scrollerRef: RefObject<HTMLDivElement | null>;
  getTextContent: (pageNumber: number) => Promise<PdfTextContent>;
  onTextLayer: (pageNumber: number, divs: HTMLElement[] | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(pageNumber <= 2);
  // The page's own size at scale 1, once known.
  const [unit, setUnit] = useState<{ w: number; h: number } | null>(null);
  const [drawScale, setDrawScale] = useState(scale);
  // What the canvas on screen was drawn from; null when there is none.
  const drawn = useRef<{ doc: PDFDocumentProxy; scale: number } | null>(null);
  const draws = useRef(0);
  // Whether find holds this page's text layer. Kept across redraws, so a
  // redraw replaces the layer find sees instead of dropping it first.
  const reported = useRef(false);
  const textSource = useRef({ getTextContent, onTextLayer });
  textSource.current = { getTextContent, onTextLayer };

  useEffect(() => {
    if (scale === drawScale) return;
    const timer = window.setTimeout(() => setDrawScale(scale), REDRAW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [scale, drawScale]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // The scroller is the root so the lookahead applies to it: with the
    // window as root its clipping would ignore the margin.
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setNear(last.isIntersecting);
      },
      { root: scrollerRef.current, rootMargin: LOOKAHEAD },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollerRef]);

  useEffect(
    () => () => {
      if (reported.current) textSource.current.onTextLayer(pageNumber, null);
      reported.current = false;
    },
    [pageNumber],
  );

  useEffect(() => {
    if (!near) {
      // Far off screen: free the canvas memory now rather than at garbage
      // collection, and drop the text layer (find reads text without it).
      const old = canvasHostRef.current?.firstElementChild;
      if (old instanceof HTMLCanvasElement) {
        old.width = 0;
        old.height = 0;
      }
      canvasHostRef.current?.replaceChildren();
      layerRef.current?.replaceChildren();
      if (reported.current) textSource.current.onTextLayer(pageNumber, null);
      reported.current = false;
      drawn.current = null;
      return;
    }
    if (drawn.current?.doc === doc && drawn.current.scale === drawScale) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    void (async () => {
      try {
        const page: PDFPageProxy = await doc.getPage(pageNumber);
        if (cancelled) return;
        const one = page.getViewport({ scale: 1 });
        setUnit({ w: one.width, h: one.height });
        const viewport = page.getViewport({ scale: drawScale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.cssText = "width:100%;height:100%;display:block";
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTask = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await renderTask.promise;
        renderTask = null;
        if (cancelled) return;
        const old = canvasHostRef.current?.firstElementChild;
        canvasHostRef.current?.replaceChildren(canvas);
        if (old instanceof HTMLCanvasElement) {
          old.width = 0;
          old.height = 0;
        }
        drawn.current = { doc, scale: drawScale };
        draws.current += 1;
        // Lets tests check that a zoom redraws only the pages on screen.
        if (hostRef.current) hostRef.current.dataset.pdfDraws = String(draws.current);
        const layer = layerRef.current;
        if (!layer) return;
        const content = await textSource.current.getTextContent(pageNumber);
        if (cancelled) return;
        if (reported.current) textSource.current.onTextLayer(pageNumber, null);
        reported.current = false;
        layer.replaceChildren();
        textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
        await textLayer.render();
        if (cancelled) return;
        reported.current = true;
        textSource.current.onTextLayer(pageNumber, textLayer.textDivs);
      } catch {
        // A cancelled render throws RenderingCancelled; the next one takes over.
      }
    })();
    return () => {
      cancelled = true;
      // Stops pdf.js drawing into a canvas nobody will show.
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [near, doc, pageNumber, drawScale]);

  const box = unit ? { w: unit.w * scale, h: unit.h * scale } : placeholder;
  return (
    <div
      ref={hostRef}
      data-pdf-page={pageNumber}
      style={{
        position: "relative",
        // The text layer sizes its runs from these (see pdf-text-layer.css),
        // so it follows the zoom before the page is redrawn.
        ["--total-scale-factor" as string]: scale,
        ["--scale-round-x" as string]: "1px",
        ["--scale-round-y" as string]: "1px",
        justifySelf: "center",
        width: box.w,
        height: box.h,
        background: "#fff",
        borderRadius: 2,
        boxShadow: "0 2px 14px rgba(0,0,0,0.4)",
        overflow: "hidden",
      }}
    >
      <div ref={canvasHostRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={layerRef} className="codara-pdf-text-layer" />
    </div>
  );
}
