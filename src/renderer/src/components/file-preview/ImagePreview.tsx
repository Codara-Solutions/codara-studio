import { useEffect, useRef, useState, type ReactNode } from "react";
import { DockablePaneBar } from "../../tabs/dockChromeSlot";
import { useViewerZoom } from "../zoom/useViewerZoom";
import ZoomControl from "../zoom/ZoomControl";

interface Props {
  src: string;
  alt: string;
  onError: () => void;
  toolbarAction?: ReactNode;
  forceLocalToolbar?: boolean;
}

// Subtle checkerboard so transparent images/SVGs read against something.
const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, color-mix(in oklab, var(--ink) 5%, transparent) 25%, transparent 25%)," +
    "linear-gradient(-45deg, color-mix(in oklab, var(--ink) 5%, transparent) 25%, transparent 25%)," +
    "linear-gradient(45deg, transparent 75%, color-mix(in oklab, var(--ink) 5%, transparent) 75%)," +
    "linear-gradient(-45deg, transparent 75%, color-mix(in oklab, var(--ink) 5%, transparent) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

const PADDING = 24;

// An image or SVG that fits the pane, never upscaled, until zoomed: Ctrl+wheel
// or pinch at the pointer, the zoom keys while focused, the toolbar, and a
// double-click that toggles fit and actual pixels. Once it is larger than the
// pane, dragging pans it.
export default function ImagePreview({ src, alt, onError, toolbarAction, forceLocalToolbar }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // A new file mounts a new viewer (FilePreview keys it on the path). The
  // same file changed on disk keeps its size, zoom and scroll until the new
  // image has loaded.

  const fitZoom =
    natural && viewport.w > 0
      ? Math.min(1, (viewport.w - PADDING * 2) / natural.w, (viewport.h - PADDING * 2) / natural.h)
      : 1;
  const safeFit = Math.max(0.01, fitZoom);
  const { zoom, fitted, zoomTo, fit, controls } = useViewerZoom({
    rootRef,
    scrollerRef,
    contentRef: imageRef,
    min: Math.min(0.1, safeFit),
    max: 16,
    fitZoom: safeFit,
    enabled: natural !== null,
  });

  const pannable =
    natural !== null && (natural.w * zoom + PADDING * 2 > viewport.w + 1 || natural.h * zoom + PADDING * 2 > viewport.h + 1);

  // A press on a scrollbar drags or pages the scrollbar, not the image.
  const onScrollbar = (event: { clientX: number; clientY: number }) => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const box = scroller.getBoundingClientRect();
    return event.clientX - box.left >= scroller.clientWidth || event.clientY - box.top >= scroller.clientHeight;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!pannable || !scroller || event.button !== 0 || onScrollbar(event)) return;
    drag.current = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const start = drag.current;
    if (!scroller || !start) return;
    // The button came up where no pointerup reached us.
    if ((event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }
    scroller.scrollLeft = start.left - (event.clientX - start.x);
    scroller.scrollTop = start.top - (event.clientY - start.y);
  };
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    const scroller = scrollerRef.current;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !natural || onScrollbar(event)) return;
    if (!fitted) {
      fit();
      return;
    }
    const box = scroller.getBoundingClientRect();
    // Exactly 100% (one image pixel per CSS pixel), even when fit is 99.5%. A small image already shows at
    // 100% when fitted, so there double-click doubles it instead of doing nothing.
    zoomTo(safeFit >= 0.999 ? 2 : 1, { x: event.clientX - box.left, y: event.clientY - box.top });
  };

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <DockablePaneBar forceLocal={forceLocalToolbar}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            marginRight: "auto",
            whiteSpace: "nowrap",
          }}
        >
          {natural ? `${natural.w} × ${natural.h}` : ""}
        </span>
        <ZoomControl
          {...controls}
          fitTitle="Fit to view (double-click the image toggles 100%, one image pixel per CSS pixel)"
        />
        {toolbarAction}
      </DockablePaneBar>
      <div
        ref={scrollerRef}
        data-image-viewport
        // Focusable (by click or Tab) so the zoom keys go to this image.
        tabIndex={0}
        role="group"
        aria-label={`Image ${alt}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={onDoubleClick}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflow: "auto",
          padding: PADDING,
          outline: "none",
          cursor: dragging ? "grabbing" : pannable ? "grab" : "default",
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            // An SVG without its own size lays out at the CSS default box.
            setNatural({ w: img.naturalWidth || 300, h: img.naturalHeight || 150 });
          }}
          onError={onError}
          style={{
            // Auto margins centre it while it fits and let it scroll from its
            // edge once it is larger than the pane.
            margin: "auto",
            flex: "0 0 auto",
            ...(natural
              ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: "none" }
              : { maxWidth: "100%", maxHeight: "100%" }),
            objectFit: "contain",
            borderRadius: 3,
            boxShadow: "0 2px 18px rgba(0,0,0,0.35)",
            userSelect: "none",
            // Zoomed far in, show the pixels rather than a blur.
            imageRendering: zoom * (window.devicePixelRatio || 1) >= 2 ? "pixelated" : "auto",
            ...CHECKER_BG,
          }}
        />
      </div>
    </div>
  );
}
