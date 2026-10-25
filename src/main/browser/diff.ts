// Before/after visual diffs. A baseline is a lossless capture saved under
// the workspace's data folder (never the repository), named per page and
// viewport, so it survives reloads, restarts and the agent's own session.
// A diff captures the same region again, compares the two pixel by pixel
// with a perceptual color distance, groups the changed pixels into boxes
// and draws them over a dimmed copy of the new capture.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { workspaceDataDir } from "../workspace-data";
import { blit, createBitmap, strokeRect, type Bitmap } from "./capture/bitmap";
import type { Rect, Size } from "./screenshot";

export interface DiffOptions {
  /** 0 to 1: how different two colors must be to count, as in pixelmatch. Default 0.1. */
  threshold?: number;
  /** Side of the grid cells changed pixels are grouped by, in image pixels. Default 16. */
  cell?: number;
  /** Areas never counted as changed (a scrollbar whose thumb fades in and out), in image pixels. */
  ignore?: Rect[];
}

export interface DiffRegion extends Rect {
  changedPixels: number;
}

export interface DiffResult {
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  /** Percent of pixels that changed, two decimals. */
  percent: number;
  sizeChanged: boolean;
  /** 1 where the pixel changed. */
  mask: Uint8Array;
  /** Changed areas, largest first. */
  regions: DiffRegion[];
}

// pixelmatch's YIQ distance: brightness weighs most, as it does for the eye.
const MAX_YIQ_DELTA = 35215;

function blendWhite(channel: number, alpha: number): number {
  return 255 + (channel - 255) * alpha;
}

function colorDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  const aa = a[i + 3] / 255;
  const ba = b[j + 3] / 255;
  const r1 = blendWhite(a[i], aa);
  const g1 = blendWhite(a[i + 1], aa);
  const b1 = blendWhite(a[i + 2], aa);
  const r2 = blendWhite(b[j], ba);
  const g2 = blendWhite(b[j + 1], ba);
  const b2 = blendWhite(b[j + 2], ba);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/**
 * Compare two bitmaps. Of different sizes, the area only one covers counts
 * as changed, so a page that grew shows its new part as a region.
 */
export function diffBitmaps(before: Bitmap, after: Bitmap, options: DiffOptions = {}): DiffResult {
  const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.1));
  const limit = MAX_YIQ_DELTA * threshold * threshold;
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const mask = new Uint8Array(width * height);
  const skip = new Uint8Array(width * height);
  for (const rect of options.ignore ?? []) {
    for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(height, Math.ceil(rect.y + rect.height)); y += 1) {
      skip.fill(1, y * width + Math.max(0, Math.floor(rect.x)), y * width + Math.min(width, Math.ceil(rect.x + rect.width)));
    }
  }
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (skip[y * width + x]) continue;
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      let differs: boolean;
      if (inBefore && inAfter) {
        differs = colorDelta(before.data, (y * before.width + x) * 4, after.data, (y * after.width + x) * 4) > limit;
      } else {
        differs = true;
      }
      if (differs) {
        mask[y * width + x] = 1;
        changed += 1;
      }
    }
  }
  const total = width * height;
  return {
    width,
    height,
    changedPixels: changed,
    totalPixels: total,
    percent: Math.round((changed / total) * 10_000) / 100,
    sizeChanged: before.width !== after.width || before.height !== after.height,
    mask,
    regions: changedRegions(mask, width, height, options.cell ?? 16),
  };
}

/**
 * Group changed pixels into boxes: mark grid cells holding a change, join
 * touching cells (diagonals too), and tighten each group's box to its
 * pixels. Cells keep the work linear in the image size.
 */
export function changedRegions(mask: Uint8Array, width: number, height: number, cell = 16): DiffRegion[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) counts[row + Math.floor(x / cell)] += 1;
    }
  }
  const group = new Int32Array(cols * rows).fill(-1);
  const regions: DiffRegion[] = [];
  const stack: number[] = [];
  for (let start = 0; start < counts.length; start += 1) {
    if (!counts[start] || group[start] !== -1) continue;
    const id = regions.length;
    let minCol = cols;
    let minRow = rows;
    let maxCol = -1;
    let maxRow = -1;
    let pixels = 0;
    group[start] = id;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop() as number;
      const c = index % cols;
      const r = (index - c) / cols;
      pixels += counts[index];
      minCol = Math.min(minCol, c);
      maxCol = Math.max(maxCol, c);
      minRow = Math.min(minRow, r);
      maxRow = Math.max(maxRow, r);
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const next = nr * cols + nc;
          if (counts[next] && group[next] === -1) {
            group[next] = id;
            stack.push(next);
          }
        }
      }
    }
    regions.push(tighten(mask, width, height, {
      x: minCol * cell,
      y: minRow * cell,
      width: Math.min(width, (maxCol + 1) * cell) - minCol * cell,
      height: Math.min(height, (maxRow + 1) * cell) - minRow * cell,
    }, pixels));
  }
  return regions.sort((a, b) => b.changedPixels - a.changedPixels || b.width * b.height - a.width * a.height);
}

function tighten(mask: Uint8Array, width: number, _height: number, box: Rect, pixels: number): DiffRegion {
  let left = box.x + box.width;
  let right = box.x - 1;
  let top = box.y + box.height;
  let bottom = box.y - 1;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, changedPixels: pixels };
}

const HIGHLIGHT = [235, 28, 92, 255] as const;

/**
 * The picture of a diff: the new capture faded to a light gray, changed
 * pixels in a strong magenta, and each region boxed.
 */
export function renderDiff(after: Bitmap, diff: DiffResult): Bitmap {
  const out = createBitmap(diff.width, diff.height, [255, 255, 255, 255]);
  blit(out, after, 0, 0);
  const data = out.data;
  for (let p = 0, i = 0; p < diff.mask.length; p += 1, i += 4) {
    if (diff.mask[p]) {
      data[i] = HIGHLIGHT[0];
      data[i + 1] = HIGHLIGHT[1];
      data[i + 2] = HIGHLIGHT[2];
    } else {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const faded = 255 - (255 - gray) * 0.35;
      data[i] = faded;
      data[i + 1] = faded;
      data[i + 2] = faded;
    }
    data[i + 3] = 255;
  }
  for (const region of diff.regions) {
    strokeRect(out, { x: region.x - 3, y: region.y - 3, width: region.width + 6, height: region.height + 6 }, HIGHLIGHT, 2);
  }
  return out;
}

// ── Baselines ────────────────────────────────────────────────────────────

export interface BaselineMeta {
  name: string;
  url: string;
  title: string;
  /** CSS pixels of the viewport when it was saved. */
  viewport: Size | null;
  imageSize: Size;
  /** How it was captured, reused by a diff that names it. */
  capture: { fullPage: boolean; selector: string | null; clip: Rect | null };
  savedAt: string;
}

export function baselineDir(workspaceId: string | null): string {
  return workspaceDataDir(workspaceId, "browser", "baselines");
}

/** A file-safe key; names differing only in case or punctuation share one. */
export function baselineKey(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (!key) throw new Error("A baseline name needs at least one letter or digit.");
  return key;
}

/** The default name: the page (host and path) and the viewport, plus what was captured. */
export function defaultBaselineName(input: {
  url: string;
  viewport: Size | null;
  fullPage?: boolean;
  selector?: string | null;
  clip?: Rect | null;
}): string {
  let page = input.url;
  try {
    const parsed = new URL(input.url);
    page = parsed.protocol === "file:" ? parsed.pathname.split("/").pop() || "file" : `${parsed.host}${parsed.pathname}`;
  } catch {
    /* a non-URL keeps its text */
  }
  const size = input.viewport ? `@${Math.round(input.viewport.width)}x${Math.round(input.viewport.height)}` : "";
  const what = input.fullPage
    ? "-full"
    : input.selector
      ? `-${input.selector}`
      : input.clip
        ? `-clip-${Math.round(input.clip.x)}-${Math.round(input.clip.y)}-${Math.round(input.clip.width)}x${Math.round(input.clip.height)}`
        : "";
  return `${page.replace(/\/+$/, "") || "page"}${size}${what}`;
}

export async function saveBaseline(workspaceId: string | null, meta: BaselineMeta, png: Buffer): Promise<{ path: string; key: string }> {
  const dir = baselineDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const key = baselineKey(meta.name);
  const path = join(dir, `${key}.png`);
  await fs.writeFile(path, png);
  await fs.writeFile(join(dir, `${key}.json`), JSON.stringify(meta, null, 2));
  return { path, key };
}

export async function loadBaseline(workspaceId: string | null, name: string): Promise<{ meta: BaselineMeta; png: Buffer; path: string } | null> {
  const dir = baselineDir(workspaceId);
  const key = baselineKey(name);
  const path = join(dir, `${key}.png`);
  try {
    const [png, raw] = await Promise.all([fs.readFile(path), fs.readFile(join(dir, `${key}.json`), "utf8")]);
    return { meta: JSON.parse(raw) as BaselineMeta, png, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listBaselines(workspaceId: string | null): Promise<BaselineMeta[]> {
  const dir = baselineDir(workspaceId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: BaselineMeta[] = [];
  for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
    try {
      metas.push(JSON.parse(await fs.readFile(join(dir, name), "utf8")) as BaselineMeta);
    } catch {
      /* a half-written pair is skipped */
    }
  }
  return metas;
}

export async function deleteBaseline(workspaceId: string | null, name: string): Promise<boolean> {
  const dir = baselineDir(workspaceId);
  const key = baselineKey(name);
  const existed = await fs.stat(join(dir, `${key}.png`)).then(() => true, () => false);
  await Promise.all([fs.rm(join(dir, `${key}.png`), { force: true }), fs.rm(join(dir, `${key}.json`), { force: true })]);
  return existed;
}
