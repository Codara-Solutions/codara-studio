import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isShown } from "../find/find-router";
import { registerZoomTarget } from "./zoom-router";
import { clampZoom, stepZoom, wheelPixels, wheelZoomFactor, type ZoomAction } from "./zoom-math";

// One zoom behaviour for every file viewer: Ctrl+wheel and pinch zoom at the
// pointer, Ctrl+= / Ctrl+- / Ctrl+0 while focus is inside the viewer (routed
// by zoom-router.ts), and the toolbar's minus, percent, plus and fit. The
// viewer turns `zoom` into pixels its own way (CSS zoom, a pdf.js scale, an
// image's size); this hook keeps the number, and the scroll position so the
// point under the pointer stays put.

export interface ViewerZoomOptions {
  /** Focus anywhere inside it sends the zoom keys to this viewer. */
  rootRef: RefObject<HTMLElement>;
  /** The scrolling box: it takes Ctrl+wheel, and its offsets follow the zoom. */
  scrollerRef: RefObject<HTMLElement>;
  /**
   * The element that grows with the zoom, when it is not the scroller's whole
   * content (an image centred in a larger box). The point under the pointer
   * is kept as a fraction of this box.
   */
  contentRef?: RefObject<HTMLElement>;
  min: number;
  max: number;
  /**
   * "smooth" follows every wheel event; "steps" moves one zoom step per wheel
   * notch, for viewers whose redraw is costly (pdf.js repaints every page).
   */
  wheel?: "smooth" | "steps";
  /** The zoom "fit" stands for. While fitted, the zoom follows it (pane resizes). */
  fitZoom?: number;
  /** False until the scroller is mounted (still loading, an error). */
  enabled?: boolean;
}

export interface ViewerZoom {
  /** The zoom the content shows at. */
  zoom: number;
  /** Showing at fitZoom, and following it. */
  fitted: boolean;
  zoomTo: (next: number, anchor?: { x: number; y: number }) => void;
  fit: () => void;
  apply: (action: ZoomAction) => void;
}

const STEP_PIXELS = 50;

export function useViewerZoom({
  rootRef,
  scrollerRef,
  contentRef,
  min,
  max,
  wheel = "smooth",
  fitZoom = 1,
  enabled = true,
}: ViewerZoomOptions): ViewerZoom {
  const [state, setState] = useState({ zoom: fitZoom, fitted: true });
  const zoom = state.fitted ? fitZoom : state.zoom;

  // Several wheel events can land before React renders; each must build on
  // the one before, not on the last rendered zoom.
  const requested = useRef(zoom);
  const rendered = useRef(zoom);
  const anchor = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const wheelCarry = useRef(0);
  const latest = useRef({ min, max, fitZoom, enabled, wheel, fitted: state.fitted });
  latest.current = { min, max, fitZoom, enabled, wheel, fitted: state.fitted };

  // The zoomed content's box, in the scroller's visible coordinates.
  const contentBox = useCallback((scroller: HTMLElement) => {
    const content = contentRef?.current;
    if (!content) {
      return { left: -scroller.scrollLeft, top: -scroller.scrollTop, width: scroller.scrollWidth, height: scroller.scrollHeight };
    }
    const outer = scroller.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    return { left: inner.left - outer.left, top: inner.top - outer.top, width: inner.width, height: inner.height };
  }, [contentRef]);

  useLayoutEffect(() => {
    const previous = rendered.current;
    rendered.current = zoom;
    requested.current = zoom;
    const point = anchor.current;
    anchor.current = null;
    const scroller = scrollerRef.current;
    if (!point || !scroller || previous === zoom) return;
    const box = contentBox(scroller);
    scroller.scrollLeft += box.left + point.fx * box.width - point.x;
    scroller.scrollTop += box.top + point.fy * box.height - point.y;
  }, [zoom, scrollerRef, contentBox]);

  // Remembers which content point sits under `point` (the scroller's centre
  // by default) before the zoom changes the layout.
  const pin = useCallback(
    (point?: { x: number; y: number }) => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        anchor.current = null;
        return;
      }
      const at = point ?? { x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 };
      const box = contentBox(scroller);
      anchor.current = {
        ...at,
        fx: box.width > 0 ? (at.x - box.left) / box.width : 0,
        fy: box.height > 0 ? (at.y - box.top) / box.height : 0,
      };
    },
    [scrollerRef, contentBox],
  );

  const zoomTo = useCallback(
    (next: number, point?: { x: number; y: number }) => {
      const { min, max, fitZoom } = latest.current;
      const clamped = clampZoom(next, min, max);
      if (Math.abs(clamped - requested.current) < 1e-4) return;
      // Zooming back to the fit level snaps to fit, so it follows the pane
      // again and a double-click toggles from there.
      const fitted = Math.abs(clamped - fitZoom) <= fitZoom * 0.01;
      requested.current = fitted ? fitZoom : clamped;
      // Pinned once per render: events later in the same frame still see
      // the old layout, and the first pin already holds the content point.
      if (!anchor.current) pin(point);
      setState({ zoom: requested.current, fitted });
    },
    [pin],
  );

  const fit = useCallback(() => {
    if (latest.current.fitted && requested.current === latest.current.fitZoom) return;
    requested.current = latest.current.fitZoom;
    if (!anchor.current) pin();
    setState({ zoom: latest.current.fitZoom, fitted: true });
  }, [pin]);

  const apply = useCallback(
    (action: ZoomAction) => {
      const { min, max } = latest.current;
      if (action === "reset") fit();
      else zoomTo(stepZoom(requested.current, action === "in" ? 1 : -1, min, max));
    },
    [fit, zoomTo],
  );

  useEffect(
    () =>
      registerZoomTarget({
        root: () => rootRef.current,
        eligible: () => latest.current.enabled && isShown(rootRef.current),
        zoom: apply,
      }),
    [rootRef, apply],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      // Chromium would otherwise scroll, and a pinch must never reach the page zoom.
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const pixels = wheelPixels(event.deltaY, event.deltaMode);
      if (latest.current.wheel === "smooth") {
        zoomTo(requested.current * wheelZoomFactor(pixels), point);
        return;
      }
      if (Math.sign(pixels) !== Math.sign(wheelCarry.current)) wheelCarry.current = 0;
      wheelCarry.current += pixels;
      if (Math.abs(wheelCarry.current) < STEP_PIXELS) return;
      wheelCarry.current = 0;
      const { min, max } = latest.current;
      zoomTo(stepZoom(requested.current, pixels < 0 ? 1 : -1, min, max), point);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [enabled, scrollerRef, zoomTo]);

  return { zoom, fitted: state.fitted, zoomTo, fit, apply };
}
