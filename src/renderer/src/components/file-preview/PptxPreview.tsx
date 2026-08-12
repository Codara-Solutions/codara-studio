import { useCallback, useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";

interface Props {
  path: string;
  // Bumps when the file changes on disk — triggers a re-render.
  mtimeMs: number;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];

// Width every slide is rendered at, in CSS px. pptx-preview scales a deck to
// exactly `viewPort.width` (scale = viewPort.width / deck width) and bakes the
// result into inline pixel geometry, so re-fitting to the pane would mean
// re-parsing the whole OOXML package. Rendering once at a fixed width and
// scaling the result with CSS `zoom` (same trick as DocxPreview) keeps pane
// resizes and zoom clicks free of a re-parse.
const BASE_WIDTH = 1280;

// pptx-preview's "destroy" event bus is MODULE-global and preview() emits on it
// before every render, disposing the echarts instances behind EVERY mounted
// deck's charts — not just its own. Two decks at once is ordinary once a
// preview can be docked beside a terminal, so:
//   - unmount only emits destroy() when it is the last deck (otherwise closing
//     one deck blanks the charts of the one left open), and
//   - a deck whose charts were disposed by someone else's render re-renders
//     itself the next time the pointer enters it. Recovery is deliberately
//     lazy: eagerly re-rendering both decks would ping-pong forever, since each
//     recovery render disposes the other deck's charts again.
let liveDecks = 0;
let renderGeneration = 0;

export default function PptxPreview({ path, mtimeMs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [slideCount, setSlideCount] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  // Bumped to force the render effect to re-run when this deck's charts were
  // disposed by another deck's render.
  const [recoverNonce, setRecoverNonce] = useState(0);
  const renderedGeneration = useRef(0);

  useEffect(() => {
    liveDecks += 1;
    return () => {
      liveDecks -= 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    setLoading(true);
    setError(null);
    // A recovery re-render rebuilds identical DOM, so the scroll offset is
    // still meaningful — restore it rather than snapping the user to slide 1.
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    let previewer: ReturnType<typeof init> | null = null;
    void (async () => {
      try {
        const bytes = await window.spark.fs.readFileBytes(path);
        if (cancelled) return;
        // JSZip needs the exact bytes: hand over the underlying buffer when the
        // view already spans it, and only copy when it does not.
        const buffer =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? (bytes.buffer as ArrayBuffer)
            : (bytes.slice().buffer as ArrayBuffer);
        host.replaceChildren();
        previewer = init(host, { width: BASE_WIDTH, mode: "list" });
        await previewer.preview(buffer);
        if (cancelled) return;
        renderGeneration += 1;
        renderedGeneration.current = renderGeneration;
        setSlideCount(previewer.slideCount);
        if (scrollRef.current && scrollTop > 0) scrollRef.current.scrollTop = scrollTop;
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error)?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Only the last deck standing may fire the global destroy (see above).
      if (previewer && liveDecks <= 1) previewer.destroy();
    };
  }, [path, mtimeMs, recoverNonce]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Charts are the only thing a foreign render can break. echarts stamps its
  // host element with `_echarts_instance_` (it renders slides charts as SVG,
  // not canvas), so a deck holding no charts marks itself current and never
  // pays for a re-render.
  const recoverCharts = useCallback(() => {
    if (renderGeneration <= renderedGeneration.current) return;
    if (!hostRef.current?.querySelector("[_echarts_instance_]")) {
      renderedGeneration.current = renderGeneration;
      return;
    }
    setRecoverNonce((n) => n + 1);
  }, []);

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
          Presentation error
        </div>
        {error}
      </div>
    );
  }

  // Fit the deck into the pane (minus padding), scaled by the zoom step.
  const fitScale = containerWidth > 0 ? Math.max(0.1, (containerWidth - 48) / BASE_WIDTH) : 1;

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
        <span style={{ marginRight: "auto" }}>
          {loading ? "Loading presentation…" : slideCount > 0 ? `${slideCount} slides` : ""}
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
          title="Fit to width"
        >
          Fit
        </button>
      </div>
      <div
        ref={scrollRef}
        onPointerEnter={recoverCharts}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "16px 24px",
          background: "var(--bg)",
        }}
      >
        <div style={{ width: BASE_WIDTH, margin: "0 auto", zoom: fitScale * zoom }}>
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
