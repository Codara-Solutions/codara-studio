// How the agent's cursor travels: a short, slightly curved, eased path from
// where it last was to where the next action lands, like a hand moving a
// mouse. Pure math, so the harness tests the real numbers.

export interface Point {
  x: number;
  y: number;
}

export const GLIDE_MIN_MS = 250;
export const GLIDE_MAX_MS = 450;
// Past this distance (CSS pixels) a glide takes the longest time.
const GLIDE_FAR_PX = 900;
// The curve bows out by this share of the distance, up to BOW_MAX_PX.
const BOW_SHARE = 0.12;
const BOW_MAX_PX = 48;
// Shorter than this is not a move worth animating.
const STILL_PX = 2;

export function glideDistance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** 0 when the cursor is already there; otherwise 250 to 450 ms, longer for farther targets. */
export function glideDuration(from: Point, to: Point): number {
  const distance = glideDistance(from, to);
  if (distance < STILL_PX) return 0;
  const share = Math.min(1, distance / GLIDE_FAR_PX);
  return Math.round(GLIDE_MIN_MS + (GLIDE_MAX_MS - GLIDE_MIN_MS) * Math.sqrt(share));
}

/** Slow start, quick middle, soft landing. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/**
 * The quadratic Bezier control point: the midpoint pushed sideways, always to
 * the same side of the direction of travel, as a wrist arcs.
 */
export function glideControl(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (distance < STILL_PX) return mid;
  const bow = Math.min(BOW_MAX_PX, distance * BOW_SHARE);
  return { x: mid.x + (dy / distance) * bow, y: mid.y - (dx / distance) * bow };
}

/** Where the cursor is at progress t (0 to 1, before easing). */
export function glidePoint(from: Point, to: Point, t: number, control: Point = glideControl(from, to)): Point {
  const e = easeInOutCubic(t);
  const a = (1 - e) ** 2;
  const b = 2 * (1 - e) * e;
  const c = e ** 2;
  return { x: a * from.x + b * control.x + c * to.x, y: a * from.y + b * control.y + c * to.y };
}
