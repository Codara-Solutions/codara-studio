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

/**
 * One Ctrl+wheel event in a viewer that zooms in steps (the PDF, which
 * renders each level). A mouse notch is one step. A pinch's small deltas add
 * up, as the scale they stand for, until they reach the next step, and the
 * rest carries on. Returns the new carry and the level to go to, if any.
 */
export function wheelStep(
  carry: number,
  pixels: number,
  zoom: number,
  min: number,
  max: number,
): { carry: number; next: number | null } {
  const direction = pixels < 0 ? 1 : -1;
  if (Math.abs(pixels) >= 50) return { carry: 0, next: stepZoom(zoom, direction, min, max) };
  const amount = -pixels / 100;
  const total = Math.sign(amount) === Math.sign(carry) ? carry + amount : amount;
  const next = stepZoom(zoom, direction, min, max);
  const need = Math.abs(Math.log(next / zoom));
  if (need < 1e-6) return { carry: 0, next: null };
  if (Math.abs(total) < need) return { carry: total, next: null };
  return { carry: total - direction * need, next };
}

export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
