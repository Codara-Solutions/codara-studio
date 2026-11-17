// The numbers every zoomable viewer shares: the steps Ctrl+= / Ctrl+- and
// the toolbar buttons walk, how far one Ctrl+wheel tick or pinch event
// zooms, and how a level reads. Pure, so scripts/test-viewer-zoom.cjs runs it
// without a DOM.

export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export type ZoomAction = "in" | "out" | "reset";

export function clampZoom(zoom: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, zoom));
}

/** The next step past `zoom` in a direction, kept within [min, max]. */
export function stepZoom(zoom: number, direction: 1 | -1, min: number, max: number): number {
  const steps = [min, ...ZOOM_STEPS.filter((step) => step > min && step < max), max];
  const next =
    direction > 0
      ? steps.find((step) => step > zoom + 0.001)
      : [...steps].reverse().find((step) => step < zoom - 0.001);
  return clampZoom(next ?? zoom, min, max);
}

/** A wheel event's vertical delta in pixels, whatever unit it came in. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 40;
  if (deltaMode === 2) return deltaY * 800;
  return deltaY;
}

/**
 * The factor one Ctrl+wheel event zooms by. A pinch on a touchpad arrives as
 * a stream of small Ctrl+wheel deltas sized so exp(-delta / 100) is the
 * pinch's own scale; a mouse wheel notch is ~100px at once, which that
 * formula would turn into a 2.7x jump, so a large delta counts as one fixed
 * notch instead.
 */
export function wheelZoomFactor(pixels: number): number {
  const amount = Math.abs(pixels) < 50 ? pixels / 100 : Math.sign(pixels) * 0.2;
  return Math.exp(-amount);
}

export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
