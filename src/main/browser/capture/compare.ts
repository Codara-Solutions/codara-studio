// codara_preview_compare: before/after baselines and diffs, and several
// screen sizes side by side. Images come back compact (JPEG, capped width)
// and are also saved as files; the lossless captures behind a diff are
// saved too, for a pull request's before and after.

import { writeBrowserArtifact } from "../artifacts";
import {
  defaultBaselineName,
  diffBitmaps,
  listBaselines,
  loadBaseline,
  renderDiff,
  saveBaseline,
  type BaselineMeta,
  type DiffRegion,
} from "../diff";
import { captureScreenshot, normalizeScreenshotRequest, ScreenshotOptionError, type ImageCodec, type Rect } from "../screenshot";
import type { BrowserTarget } from "../targets";
import { fitSize, scaleBitmap, type Bitmap } from "./bitmap";
import { FILE_EXTENSIONS, MIME_TYPES, type BitmapCodec, type ImageFormat } from "./codec";
import { captureSizes, composeSizesSheet, normalizeSchemes, normalizeSizes } from "./sizes";

export type CompareMode = "baseline" | "diff" | "sizes" | "list";

export class CompareOptionError extends Error {}

/** Image codecs: nativeImage in the app; tests pass their own. */
export interface CompareCodecs {
  bitmap: BitmapCodec;
  /** For the screenshot pipeline; its default is nativeImage. */
  image?: ImageCodec;
}

/** Regions listed in a result; the image shows every one. */
export const MAX_LISTED_REGIONS = 12;

interface OutputImage {
  format: ImageFormat;
  quality: number;
  maxWidth: number;
}

function outputImage(params: Record<string, unknown>, maxWidth: number): OutputImage {
  const request = normalizeScreenshotRequest(
    { format: params.format, quality: params.quality, maxWidth: params.maxWidth },
    { format: "jpeg", quality: 70, maxWidth },
  );
  return { format: request.format as ImageFormat, quality: request.quality, maxWidth: request.maxWidth ?? maxWidth };
}

async function encodeImage(
  codec: BitmapCodec,
  bitmap: Bitmap,
  output: OutputImage,
): Promise<{ data: Buffer; mimeType: string; ext: string; imageSize: { width: number; height: number } }> {
  const size = fitSize(bitmap, { width: output.maxWidth });
  const scaled = size.width === bitmap.width ? bitmap : scaleBitmap(bitmap, size);
  const data = await codec.encode(scaled, output.format, output.quality);
  return { data, mimeType: MIME_TYPES[output.format], ext: FILE_EXTENSIONS[output.format], imageSize: size };
}

/** The capture a baseline or diff takes: lossless, one image pixel per CSS pixel. */
async function captureLossless(
  target: BrowserTarget,
  capture: { fullPage: boolean; selector: string | null; clip: Rect | null },
  codecs: CompareCodecs,
) {
  const request = normalizeScreenshotRequest({
    format: "png",
    scale: 1,
    fullPage: capture.fullPage,
    ...(capture.selector ? { selector: capture.selector } : {}),
    ...(capture.clip ? { clip: capture.clip } : {}),
    save: false,
  }, { maxWidth: null });
  return captureScreenshot(target, request, { bitmap: codecs.bitmap, ...(codecs.image ? { codec: codecs.image } : {}) });
}

function captureOptions(params: Record<string, unknown>): { fullPage: boolean; selector: string | null; clip: Rect | null } | null {
  if (params.fullPage === undefined && params.selector === undefined && params.clip === undefined) return null;
  const request = normalizeScreenshotRequest({ fullPage: params.fullPage, selector: params.selector, clip: params.clip });
  return { fullPage: request.fullPage, selector: request.selector, clip: request.clip };
}

/**
 * The viewport's scrollbars, relative to the captured region: their thumbs
 * fade in and out with scrolling and hovering, which is not a change.
 */
async function scrollbarGutters(
  target: BrowserTarget,
  capture: { fullPage: boolean; selector: string | null },
  region: Rect,
): Promise<Rect[]> {
  if (capture.fullPage || capture.selector) return [];
  const m = await target
    .evaluate<{ cw: number; ch: number; iw: number; ih: number }>(
      "({ cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight, iw: innerWidth, ih: innerHeight })",
    )
    .catch(() => null);
  if (!m) return [];
  const gutters: Rect[] = [];
  if (m.iw > m.cw) gutters.push({ x: m.cw - region.x, y: -region.y, width: m.iw - m.cw, height: m.ih });
  if (m.ih > m.ch) gutters.push({ x: -region.x, y: m.ch - region.y, width: m.iw, height: m.ih - m.ch });
  return gutters;
}

function nameParam(params: Record<string, unknown>): string | null {
  if (params.name === undefined) return null;
  if (typeof params.name !== "string" || !params.name.trim()) throw new CompareOptionError("name must be non-empty text.");
  return params.name.trim().slice(0, 120);
}

export async function runCompare(target: BrowserTarget, params: Record<string, unknown>, codecs: CompareCodecs): Promise<Record<string, unknown>> {
  const mode = params.mode ?? "diff";
  if (mode === "list") return { mode, baselines: await listBaselines(target.workspaceId) };
  if (mode === "sizes") return sizes(target, params, codecs.bitmap);
  if (mode === "baseline") return baseline(target, params, codecs);
  if (mode === "diff") return diff(target, params, codecs);
  throw new CompareOptionError('mode must be "baseline", "diff", "sizes" or "list".');
}

async function baseline(target: BrowserTarget, params: Record<string, unknown>, codecs: CompareCodecs): Promise<Record<string, unknown>> {
  const capture = captureOptions(params) ?? { fullPage: false, selector: null, clip: null };
  const shot = await captureLossless(target, capture, codecs);
  const name = nameParam(params) ?? defaultBaselineName({ url: shot.url, viewport: shot.viewport, ...capture });
  const previous = await loadBaseline(target.workspaceId, name).catch(() => null);
  const meta: BaselineMeta = {
    name,
    url: shot.url,
    title: shot.title,
    viewport: shot.viewport,
    imageSize: shot.imageSize,
    capture,
    savedAt: new Date().toISOString(),
  };
  const saved = await saveBaseline(target.workspaceId, meta, Buffer.from(shot.data, "base64"));
  return {
    mode: "baseline",
    name,
    tabId: target.ref,
    url: shot.url,
    viewport: shot.viewport,
    imageSize: shot.imageSize,
    path: saved.path,
    replaced: Boolean(previous),
    next: `After the change, call codara_preview_compare with mode "diff" and name ${JSON.stringify(name)}.`,
  };
}

async function diff(target: BrowserTarget, params: Record<string, unknown>, codecs: CompareCodecs): Promise<Record<string, unknown>> {
  const codec = codecs.bitmap;
  const requested = nameParam(params);
  const override = captureOptions(params);
  let stored = requested ? await loadBaseline(target.workspaceId, requested) : null;
  if (!requested) {
    const info = await target.info();
    const name = defaultBaselineName({ url: info.url, viewport: info.viewport, ...(override ?? {}) });
    stored = await loadBaseline(target.workspaceId, name);
  }
  if (!stored) {
    const names = (await listBaselines(target.workspaceId)).map((meta) => meta.name).slice(0, 20);
    throw new CompareOptionError(
      `No baseline ${requested ? JSON.stringify(requested) : "for this page and viewport"}. ` +
      `Save one first with mode "baseline"${names.length ? `, or pass one of: ${names.join(", ")}` : ""}.`,
    );
  }
  const capture = override ?? stored.meta.capture;
  const shot = await captureLossless(target, capture, codecs);
  const current = Buffer.from(shot.data, "base64");
  const before = codec.decode(stored.png);
  const after = codec.decode(current);
  const threshold = typeof params.threshold === "number" ? params.threshold : undefined;
  if (threshold !== undefined && (!(threshold >= 0) || threshold > 1)) throw new CompareOptionError("threshold must be between 0 and 1.");
  const result = diffBitmaps(before, after, { threshold, ignore: await scrollbarGutters(target, capture, shot.region) });
  const label = stored.meta.name;
  const currentPath = await writeBrowserArtifact(target.workspaceId, "diffs", { label: `${label}-after`, ext: "png", data: current });
  const offset = { x: shot.region.x, y: shot.region.y };
  const regions = result.regions.slice(0, MAX_LISTED_REGIONS).map((region): DiffRegion => ({
    x: Math.round(region.x + offset.x),
    y: Math.round(region.y + offset.y),
    width: region.width,
    height: region.height,
    changedPixels: region.changedPixels,
  }));
  const summary = result.changedPixels === 0
    ? "No visible change."
    : `${result.percent}% of pixels changed in ${result.regions.length} region${result.regions.length === 1 ? "" : "s"}${result.sizeChanged ? `; the size changed from ${before.width}x${before.height} to ${after.width}x${after.height}` : ""}.`;
  const out: Record<string, unknown> = {
    mode: "diff",
    name: label,
    tabId: target.ref,
    url: shot.url,
    summary,
    percent: result.percent,
    changedPixels: result.changedPixels,
    regions,
    ...(result.regions.length > regions.length ? { moreRegions: result.regions.length - regions.length } : {}),
    regionsIn: capture.fullPage ? "page CSS pixels" : "viewport CSS pixels",
    sizeChanged: result.sizeChanged,
    baselinePath: stored.path,
    currentPath,
    baselineSavedAt: stored.meta.savedAt,
  };
  if (result.changedPixels === 0) return out;
  const image = await encodeImage(codec, renderDiff(after, result), outputImage(params, 1280));
  const path = await writeBrowserArtifact(target.workspaceId, "diffs", { label: `${label}-diff`, ext: image.ext, data: image.data });
  return { ...out, path, imageSize: image.imageSize, dataUrl: `data:${image.mimeType};base64,${image.data.toString("base64")}` };
}

async function sizes(target: BrowserTarget, params: Record<string, unknown>, codec: BitmapCodec): Promise<Record<string, unknown>> {
  const presets = normalizeSizes(params.sizes);
  const schemes = normalizeSchemes(params.colorScheme);
  if (presets.length * schemes.length > 8) throw new CompareOptionError("At most 8 captures per call (sizes times color schemes).");
  const output = outputImage(params, 1600);
  const shots = await captureSizes(target, presets, schemes, codec);
  const { sheet, tiles } = composeSizesSheet(shots, output.maxWidth);
  const image = await encodeImage(codec, sheet, output);
  const info = await target.info().catch(() => null);
  const path = await writeBrowserArtifact(target.workspaceId, "screenshots", { label: `${target.ref}-sizes`, ext: image.ext, data: image.data });
  return {
    mode: "sizes",
    tabId: target.ref,
    url: info?.url ?? "",
    tiles,
    imageSize: image.imageSize,
    path,
    dataUrl: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
  };
}

export function isCompareOptionError(error: unknown): boolean {
  return error instanceof CompareOptionError || error instanceof ScreenshotOptionError;
}
