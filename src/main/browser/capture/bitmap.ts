// Raw RGBA bitmaps for the capture features that compose or compare images
// (before/after diffs, the side-by-side sizes sheet, recordings). Pure
// TypeScript with no Electron, so the same code runs in unit suites; the
// app converts to and from PNG and JPEG with nativeImage (codec.ts).

import type { Rect, Size } from "../screenshot";

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

export function createBitmap(width: number, height: number, fill: Rgba = [255, 255, 255, 255]): Bitmap {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width: w, height: h, data };
}

export function cropBitmap(source: Bitmap, rect: Rect): Bitmap {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(source.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(source.height, Math.ceil(rect.y + rect.height));
  const out = createBitmap(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  for (let y = y0; y < y1; y += 1) {
    const from = (y * source.width + x0) * 4;
    out.data.set(source.data.subarray(from, from + (x1 - x0) * 4), (y - y0) * out.width * 4);
  }
  return out;
}

/** Copy `source` onto `target` with its top-left corner at (x, y), clipped to the target. */
export function blit(target: Bitmap, source: Bitmap, x: number, y: number): void {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const skipX = left - Math.round(x);
  const skipY = top - Math.round(y);
  const width = Math.min(source.width - skipX, target.width - left);
  if (width <= 0) return;
  for (let row = skipY; row < source.height && top + row - skipY < target.height; row += 1) {
    const from = (row * source.width + skipX) * 4;
    target.data.set(source.data.subarray(from, from + width * 4), ((top + row - skipY) * target.width + left) * 4);
  }
}

export function fillRect(target: Bitmap, rect: Rect, color: Rgba): void {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(target.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(target.height, Math.round(rect.y + rect.height));
  const alpha = color[3] / 255;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * target.width + x) * 4;
      target.data[i] = Math.round(color[0] * alpha + target.data[i] * (1 - alpha));
      target.data[i + 1] = Math.round(color[1] * alpha + target.data[i + 1] * (1 - alpha));
      target.data[i + 2] = Math.round(color[2] * alpha + target.data[i + 2] * (1 - alpha));
      target.data[i + 3] = 255;
    }
  }
}

export function strokeRect(target: Bitmap, rect: Rect, color: Rgba, thickness = 2): void {
  const t = Math.max(1, Math.round(thickness));
  fillRect(target, { x: rect.x, y: rect.y, width: rect.width, height: t }, color);
  fillRect(target, { x: rect.x, y: rect.y + rect.height - t, width: rect.width, height: t }, color);
  fillRect(target, { x: rect.x, y: rect.y, width: t, height: rect.height }, color);
  fillRect(target, { x: rect.x + rect.width - t, y: rect.y, width: t, height: rect.height }, color);
}

/**
 * Resample to `size`. Shrinking averages every source pixel a target pixel
 * covers, so thin text and borders fade instead of vanishing; growing
 * repeats pixels.
 */
export function scaleBitmap(source: Bitmap, size: Size): Bitmap {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  if (width === source.width && height === source.height) return { width, height, data: source.data.slice() };
  const out = createBitmap(width, height);
  const sx = source.width / width;
  const sy = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(source.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(source.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let i = (yy * source.width + x0) * 4;
        for (let xx = x0; xx < x1; xx += 1, i += 4) {
          r += source.data[i];
          g += source.data[i + 1];
          b += source.data[i + 2];
          a += source.data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** A fitted size that keeps the aspect ratio and stays within the bounds. */
export function fitSize(size: Size, max: { width?: number | null; height?: number | null }): Size {
  let scale = 1;
  if (max.width && size.width > max.width) scale = Math.min(scale, max.width / size.width);
  if (max.height && size.height > max.height) scale = Math.min(scale, max.height / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

// A 5x7 pixel font for labels drawn into composed images. Lowercase letters
// draw as capitals, except x, which reads as "by" in sizes like 390x844.
const GLYPHS: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
  "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
};

function glyph(char: string): readonly string[] {
  return GLYPHS[char] ?? GLYPHS[char.toUpperCase()] ?? GLYPHS["?"];
}

/** Pixel width of `text` drawn at `scale` (each font pixel becomes scale x scale). */
export function textWidth(text: string, scale = 2): number {
  return text.length ? text.length * 6 * scale - scale : 0;
}

export const TEXT_HEIGHT = 7;

/** Draw `text` with its top-left corner at (x, y); returns the drawn width. */
export function drawText(target: Bitmap, text: string, x: number, y: number, color: Rgba, scale = 2): number {
  let cursor = Math.round(x);
  for (const char of text) {
    const rows = glyph(char);
    for (let row = 0; row < rows.length; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (rows[row][col] === "#") fillRect(target, { x: cursor + col * scale, y: y + row * scale, width: scale, height: scale }, color);
      }
    }
    cursor += 6 * scale;
  }
  return textWidth(text, scale);
}
