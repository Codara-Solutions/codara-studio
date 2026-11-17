import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { isShown } from "../find/find-router";
import { registerZoomTarget } from "./zoom-router";
import { clampZoom, stepZoom, wheelPixels, wheelStep, wheelZoomFactor, type ZoomAction } from "./zoom-math";

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
  /** `snap` lets a level within 1% of fit fall back to fit (wheel and pinch). */
  zoomTo: (next: number, anchor?: { x: number; y: number }, snap?: boolean) => void;
  fit: () => void;
  apply: (action: ZoomAction) => void;
  /** Handlers for ZoomControl; each leaves focus in the viewer. */
  controls: { zoom: number; onZoomOut: () => void; onZoomIn: () => void; onFit: () => void };
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

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

  // A pin whose zoom never showed (a tiny pinch that snapped back to fit)
  // must not move the view on a later zoom, after the user has scrolled.
  useLayoutEffect(() => {
    anchor.current = null;
  });

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
    (next: number, point?: { x: number; y: number }, snap = false) => {
      const { min, max, fitZoom } = latest.current;
      const clamped = clampZoom(next, min, max);
      if (Math.abs(clamped - requested.current) < 1e-4) return;
      // Wheeling back to about the fit level snaps to fit, so it follows the
      // pane again and a double-click toggles from there. `requested` keeps
      // the exact level, so a slow pinch's small steps still add up.
      const fitted = Math.abs(clamped - fitZoom) <= fitZoom * (snap ? 0.01 : 1e-4);
      requested.current = clamped;
      const shown = fitted ? fitZoom : clamped;
      // Pinned once per render: events later in the same frame still see
      // the old layout, and the first pin already holds the content point.
      // Only a zoom that changes what shows is pinned.
      if (!anchor.current && shown !== rendered.current) pin(point);
      setState({ zoom: shown, fitted });
    },
    [pin],
  );

  const fit = useCallback(() => {
    if (latest.current.fitted && requested.current === latest.current.fitZoom) return;
    requested.current = latest.current.fitZoom;
    wheelCarry.current = 0;
    if (!anchor.current && rendered.current !== latest.current.fitZoom) pin();
    setState({ zoom: latest.current.fitZoom, fitted: true });
  }, [pin]);

  const apply = useCallback(
    (action: ZoomAction) => {
      const { min, max, fitted, fitZoom } = latest.current;
      // From the level on screen: a pinch can leave `requested` a hair off it.
      const from = fitted ? fitZoom : requested.current;
      wheelCarry.current = 0;
      if (action === "reset") fit();
      else zoomTo(stepZoom(from, action === "in" ? 1 : -1, min, max));
    },
    [fit, zoomTo],
  );

  // A docked toolbar sits outside the viewer, and a click on it would take
  // focus there, so the next zoom key would zoom the window instead.
  const controls = useMemo(() => {
    const thenFocus = (action: ZoomAction) => () => {
      apply(action);
      const root = rootRef.current;
      if (root && !root.contains(document.activeElement)) scrollerRef.current?.focus({ preventScroll: true });
    };
    return { onZoomOut: thenFocus("out"), onZoomIn: thenFocus("in"), onFit: thenFocus("reset") };
  }, [apply, rootRef, scrollerRef]);

  useEffect(
    () =>
      registerZoomTarget({
        root: () => rootRef.current,
        eligible: () => latest.current.enabled && isShown(rootRef.current),
        zoom: apply,
      }),
    [rootRef, apply],
  );

  // On the root, which outlives a viewer's scroller (a spreadsheet remounts
  // its list per sheet); only wheels over the scroller count.
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const onWheel = (event: WheelEvent) => {
      const scroller = scrollerRef.current;
      // Ctrl+wheel everywhere (a pinch arrives as one), Cmd+wheel on macOS.
      if (!(event.ctrlKey || (IS_MAC && event.metaKey)) || !scroller || !scroller.contains(event.target as Node)) return;
      // Chromium would otherwise scroll, and a pinch must never reach the
      // page zoom; preventDefault needs the listener to be non-passive.
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const pixels = wheelPixels(event.deltaY, event.deltaMode);
      if (latest.current.wheel === "smooth") {
        zoomTo(requested.current * wheelZoomFactor(pixels), point, true);
        return;
      }
      const { min, max } = latest.current;
      const step = wheelStep(wheelCarry.current, pixels, requested.current, min, max);
      wheelCarry.current = step.carry;
      if (step.next !== null) zoomTo(step.next, point);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [enabled, rootRef, scrollerRef, zoomTo]);

  return { zoom, fitted: state.fitted, zoomTo, fit, apply, controls: { zoom, ...controls } };
}
