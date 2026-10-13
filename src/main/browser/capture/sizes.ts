// Several screen sizes side by side in one image. One tab is emulated at
// each size in turn (and in each color scheme asked for), captured, and put
// back as it was, so the cost is one renderer however many sizes there are.
// A Codara tab shows each size scaled into its own surface (surface.ts); a
// Chrome tab renders it beyond the visible viewport. Both work while the tab
// is in the background or the window is minimized.
//
// Emulation here is the protocol's own device metrics and media features;
// a tab's other emulation settings (network, CPU) are left alone.

import type { BrowserTarget } from "../targets";
import { blit, createBitmap, cropBitmap, drawText, scaleBitmap, strokeRect, TEXT_HEIGHT, textWidth, type Bitmap } from "./bitmap";
import type { BitmapCodec } from "./codec";
import { holdGuestPaint } from "./paint";
import { captureThroughSurface, surfaceBound, surfaceMetrics, viewInCapture, type SurfaceMetrics } from "./surface";

export interface SizePreset {
  name: string;
  width: number;
  height: number;
  /** Lay the page out like a phone or tablet browser (viewport meta, overlay scrollbars). */
  mobile?: boolean;
}

export type ColorScheme = "light" | "dark";

export const SIZE_PRESETS: readonly SizePreset[] = [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "tablet", width: 820, height: 1180, mobile: true },
  { name: "desktop", width: 1440, height: 900 },
];

export class SizesOptionError extends Error {}

const MIN_SIDE = 120;
const MAX_SIDE = 3840;

/** Sizes from tool arguments: preset names, "WIDTHxHEIGHT" text, or {name?, width, height, mobile?}. */
export function normalizeSizes(raw: unknown): SizePreset[] {
  if (raw === undefined || raw === null) return SIZE_PRESETS.map((preset) => ({ ...preset }));
  if (!Array.isArray(raw) || raw.length === 0) throw new SizesOptionError("sizes must be a non-empty list.");
  if (raw.length > 6) throw new SizesOptionError("Pass at most 6 sizes.");
  return raw.map((item): SizePreset => {
    if (typeof item === "string") {
      const preset = SIZE_PRESETS.find((candidate) => candidate.name === item.trim().toLowerCase());
      if (preset) return { ...preset };
      const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(item);
      if (match) return checked({ name: `${match[1]}x${match[2]}`, width: Number(match[1]), height: Number(match[2]) });
      throw new SizesOptionError(`Unknown size ${JSON.stringify(item)}: use phone, tablet, desktop or WIDTHxHEIGHT.`);
    }
    const value = item as Record<string, unknown> | null;
    if (!value || typeof value.width !== "number" || typeof value.height !== "number") {
      throw new SizesOptionError("A size object needs numeric width and height.");
    }
    return checked({
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 24) : `${value.width}x${value.height}`,
      width: value.width,
      height: value.height,
      mobile: typeof value.mobile === "boolean" ? value.mobile : value.width < 1024,
    });
  });
}

function checked(preset: SizePreset): SizePreset {
  for (const side of [preset.width, preset.height]) {
    if (!Number.isFinite(side) || side < MIN_SIDE || side > MAX_SIDE) {
      throw new SizesOptionError(`Each side must be between ${MIN_SIDE} and ${MAX_SIDE} CSS pixels.`);
    }
  }
  return { ...preset, width: Math.round(preset.width), height: Math.round(preset.height), mobile: preset.mobile ?? preset.width < 1024 };
}

/** null keeps the page's own scheme; "both" captures light then dark. */
export function normalizeSchemes(raw: unknown): Array<ColorScheme | null> {
  if (raw === undefined || raw === null) return [null];
  if (raw === "light" || raw === "dark") return [raw];
  if (raw === "both") return ["light", "dark"];
  throw new SizesOptionError('colorScheme must be "light", "dark" or "both".');
}

export interface SizeTile {
  name: string;
  width: number;
  height: number;
  colorScheme: ColorScheme | null;
  /** Where the tile sits in the sheet, in sheet pixels. */
  box: { x: number; y: number; width: number; height: number };
}

const queues = new Map<string, Promise<unknown>>();

/** One emulation at a time per tab: two callers interleaving would capture each other's sizes. */
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => {});
  return next;
}

const SETTLE_MS = 250;

async function captureAt(
  target: BrowserTarget,
  preset: SizePreset,
  scheme: ColorScheme | null,
  codec: BitmapCodec,
  surface: SurfaceMetrics | null,
): Promise<Bitmap> {
  const { session } = target;
  // Shrunk to fit the tab's surface; a size smaller than it is captured 1:1.
  const zoom = surface ? Math.min(1, surface.width / preset.width, surface.height / preset.height) : 1;
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: surface ? 0 : 1,
    mobile: preset.mobile === true,
    screenWidth: preset.width,
    screenHeight: preset.height,
    ...(surface ? { viewport: { x: 0, y: 0, width: preset.width, height: preset.height, scale: zoom } } : {}),
  });
  await session.send("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value: scheme ?? "" }],
  });
  // Layout and media-query listeners run asynchronously; timers keep
  // running in a background tab, animation frames do not.
  await target.evaluate("void document.documentElement.getBoundingClientRect()").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const scroll = await target
    .evaluate<{ x: number; y: number }>("({ x: scrollX, y: scrollY })")
    .catch(() => ({ x: 0, y: 0 }));
  if (surface) {
    const view = { x: scroll.x, y: scroll.y, width: preset.width, height: preset.height };
    const png = await withTimeout(
      captureThroughSurface(target, { ...preset }, view, zoom),
      20_000,
      `Capturing ${preset.name} timed out.`,
    );
    const image = codec.decode(png);
    return cropBitmap(image, viewInCapture(preset, zoom, surface.devicePixelRatio, image));
  }
  const shot = await withTimeout(
    session.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: scroll.x, y: scroll.y, width: preset.width, height: preset.height, scale: 1 },
    }),
    20_000,
    `Capturing ${preset.name} timed out.`,
  );
  const bitmap = codec.decode(Buffer.from(shot.data, "base64"));
  if (bitmap.width === preset.width && bitmap.height === preset.height) return bitmap;
  return scaleBitmap(bitmap, { width: preset.width, height: preset.height });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Capture every size in every scheme; the tab's emulation and scroll are restored even on failure. */
export function captureSizes(
  target: BrowserTarget,
  sizes: SizePreset[],
  schemes: Array<ColorScheme | null>,
  codec: BitmapCodec,
): Promise<Array<{ preset: SizePreset; scheme: ColorScheme | null; bitmap: Bitmap }>> {
  return serialized(target.session.key, async () => {
    const scroll = await target.evaluate<{ x: number; y: number }>("({ x: scrollX, y: scrollY })").catch(() => null);
    const surface = surfaceBound(target) ? await surfaceMetrics(target) : null;
    const shots: Array<{ preset: SizePreset; scheme: ColorScheme | null; bitmap: Bitmap }> = [];
    const releasePaint = await holdGuestPaint(target.session);
    try {
      for (const scheme of schemes) {
        for (const preset of sizes) shots.push({ preset, scheme, bitmap: await captureAt(target, preset, scheme, codec, surface) });
      }
    } finally {
      await target.session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await target.session.send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-color-scheme", value: "" }] }).catch(() => {});
      if (scroll) await target.evaluate(`scrollTo(${Number(scroll.x) || 0}, ${Number(scroll.y) || 0})`).catch(() => {});
      releasePaint();
    }
    return shots;
  });
}

const SHEET_BACKGROUND = [226, 229, 234, 255] as const;
const LABEL_COLOR = [32, 36, 42, 255] as const;
const FRAME_COLOR = [150, 156, 166, 255] as const;
const PADDING = 16;
const GAP = 16;
const LABEL_SCALE = 2;
const LABEL_BLOCK = TEXT_HEIGHT * LABEL_SCALE + 8;

/**
 * Lay the shots out as a contact sheet: one row per color scheme, sizes in
 * order, every tile at the same scale so text compares at its real
 * relative size, each labeled with its name, size and scheme.
 */
export function composeSizesSheet(
  shots: Array<{ preset: SizePreset; scheme: ColorScheme | null; bitmap: Bitmap }>,
  maxWidth: number,
): { sheet: Bitmap; tiles: SizeTile[]; scale: number } {
  const rows: Array<typeof shots> = [];
  for (const shot of shots) {
    const row = rows.find((candidate) => candidate[0].scheme === shot.scheme);
    if (row) row.push(shot);
    else rows.push([shot]);
  }
  const gaps = (row: typeof shots) => GAP * (row.length - 1);
  const scale = Math.min(1, ...rows.map((row) => (maxWidth - PADDING * 2 - gaps(row)) / row.reduce((sum, shot) => sum + shot.preset.width, 0)));
  const tileSize = (preset: SizePreset) => ({
    width: Math.max(1, Math.round(preset.width * scale)),
    height: Math.max(1, Math.round(preset.height * scale)),
  });
  const rowHeights = rows.map((row) => Math.max(...row.map((shot) => tileSize(shot.preset).height)) + LABEL_BLOCK);
  const width = Math.max(...rows.map((row) => row.reduce((sum, shot) => sum + tileSize(shot.preset).width, 0) + gaps(row))) + PADDING * 2;
  const height = rowHeights.reduce((sum, h) => sum + h, 0) + PADDING * 2 + GAP * (rows.length - 1);
  const sheet = createBitmap(width, height, SHEET_BACKGROUND);
  const tiles: SizeTile[] = [];
  let y = PADDING;
  rows.forEach((row, r) => {
    let x = PADDING;
    for (const shot of row) {
      const { width: tileWidth, height: tileHeight } = tileSize(shot.preset);
      const label = `${shot.preset.name} ${shot.preset.width}x${shot.preset.height}${shot.scheme ? ` ${shot.scheme}` : ""}`;
      const fitted = fitLabel(label, tileWidth);
      drawText(sheet, fitted, x, y, LABEL_COLOR, LABEL_SCALE);
      const top = y + LABEL_BLOCK;
      blit(sheet, scaleBitmap(shot.bitmap, { width: tileWidth, height: tileHeight }), x, top);
      strokeRect(sheet, { x: x - 1, y: top - 1, width: tileWidth + 2, height: tileHeight + 2 }, FRAME_COLOR, 1);
      tiles.push({
        name: shot.preset.name,
        width: shot.preset.width,
        height: shot.preset.height,
        colorScheme: shot.scheme,
        box: { x, y: top, width: tileWidth, height: tileHeight },
      });
      x += tileWidth + GAP;
    }
    y += rowHeights[r] + GAP;
  });
  return { sheet, tiles, scale: Math.round(scale * 1000) / 1000 };
}

function fitLabel(label: string, width: number): string {
  if (textWidth(label, LABEL_SCALE) <= width) return label;
  let text = label;
  while (text.length > 1 && textWidth(`${text}.`, LABEL_SCALE) > width) text = text.slice(0, -1);
  return `${text}.`;
}
