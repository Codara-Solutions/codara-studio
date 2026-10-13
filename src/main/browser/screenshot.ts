// The screenshot pipeline every capture feature shares (the screenshot tool,
// element shots, before/after diffs, side-by-side sizes, comments on a
// screenshot, recordings): capture from any BrowserTarget, crop to a clip
// rect or an element, scale, encode PNG or JPEG, save the file in the
// workspace's data folder, and report the scale that maps image pixels
// back to CSS pixels.
//
// Viewport, clip and element shots start from the target's own viewport
// capture, which paints a background tab. A full-page shot asks the
// protocol to render beyond the viewport, which also works in the
// background but briefly resizes the page's layout viewport.

import type { ElementDescription } from "../../shared/preview-locator";
import { writeBrowserArtifact } from "./artifacts";
import { locateElement } from "./locator";
import type { BrowserTarget, BrowserViewport } from "./targets";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type ScreenshotFormat = "png" | "jpeg";

export interface ScreenshotRequest {
  format: ScreenshotFormat;
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** Output pixels per CSS pixel; 1 is the page's CSS size, whatever the display density. */
  scale: number;
  /** Cap on the output width in pixels, or null. */
  maxWidth: number | null;
  /** Viewport CSS pixels. */
  clip: Rect | null;
  /** An @reference or unique selector to capture. */
  selector: string | null;
  fullPage: boolean;
  /** Save the image under the workspace's data folder and return its path. */
  save: boolean;
}

export const SCREENSHOT_DEFAULTS: ScreenshotRequest = {
  format: "png",
  quality: 80,
  scale: 1,
  maxWidth: null,
  clip: null,
  selector: null,
  fullPage: false,
  save: true,
};

export const FULL_PAGE_MAX_HEIGHT = 16_384;

export class ScreenshotOptionError extends Error {}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validate tool arguments into a request; unknown fields are ignored. */
export function normalizeScreenshotRequest(
  raw: Record<string, unknown>,
  defaults: Partial<ScreenshotRequest> = {},
): ScreenshotRequest {
  const base = { ...SCREENSHOT_DEFAULTS, ...defaults };
  const format = raw.format === undefined ? base.format : raw.format;
  if (format !== "png" && format !== "jpeg") throw new ScreenshotOptionError('format must be "png" or "jpeg".');
  const quality = finite(raw.quality) ?? base.quality;
  const scale = finite(raw.scale) ?? base.scale;
  if (scale < 0.1 || scale > 4) throw new ScreenshotOptionError("scale must be between 0.1 and 4.");
  const maxWidth = raw.maxWidth === undefined ? base.maxWidth : finite(raw.maxWidth);
  if (maxWidth !== null && maxWidth < 16) throw new ScreenshotOptionError("maxWidth must be at least 16.");
  let clip: Rect | null = base.clip;
  if (raw.clip !== undefined) {
    const c = raw.clip as Record<string, unknown> | null;
    const rect = c && { x: finite(c.x), y: finite(c.y), width: finite(c.width), height: finite(c.height) };
    if (!rect || rect.x === null || rect.y === null || rect.width === null || rect.height === null || rect.width <= 0 || rect.height <= 0) {
      throw new ScreenshotOptionError("clip needs numeric x, y and a positive width and height, in CSS pixels.");
    }
    clip = rect as Rect;
  }
  const selector = typeof raw.selector === "string" && raw.selector.trim() ? raw.selector.trim() : base.selector;
  const fullPage = raw.fullPage === undefined ? base.fullPage : raw.fullPage === true;
  if ([clip !== null, selector !== null, fullPage].filter(Boolean).length > 1) {
    throw new ScreenshotOptionError("Pass at most one of clip, selector and fullPage.");
  }
  return {
    format,
    quality: Math.max(1, Math.min(100, Math.round(quality))),
    scale,
    maxWidth: maxWidth === null ? null : Math.round(maxWidth),
    clip,
    selector,
    fullPage,
    save: raw.save === undefined ? base.save : raw.save !== false,
  };
}

/**
 * The image-pixel rect for a CSS rect, given the CSS size the image shows.
 * Clamped to the image; null when nothing of it is inside.
 */
export function cssRectToImage(rect: Rect, css: Size, image: Size): Rect | null {
  const sx = image.width / css.width;
  const sy = image.height / css.height;
  const left = Math.max(0, Math.floor(rect.x * sx));
  const top = Math.max(0, Math.floor(rect.y * sy));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * sx));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * sy));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Output size for an image showing `css` CSS pixels. */
export function outputSize(css: Size, scale: number, maxWidth: number | null): Size {
  let width = Math.max(1, Math.round(css.width * scale));
  let height = Math.max(1, Math.round(css.height * scale));
  if (maxWidth !== null && width > maxWidth) {
    height = Math.max(1, Math.round((height * maxWidth) / width));
    width = maxWidth;
  }
  return { width, height };
}

/** Image operations, so the pipeline runs on Electron's nativeImage in the app and on a fake in tests. */
export interface ImageCodec {
  size(png: Buffer): Size;
  crop(png: Buffer, rect: Rect): Buffer;
  resize(png: Buffer, size: Size): Buffer;
  encode(png: Buffer, format: ScreenshotFormat, quality: number): Buffer;
}

export function nativeImageCodec(): ImageCodec {
  // Required lazily so this module loads in unit suites without Electron.
  const { nativeImage } = require("electron") as typeof import("electron");
  const load = (png: Buffer) => nativeImage.createFromBuffer(png);
  return {
    size: (png) => load(png).getSize(),
    crop: (png, rect) => load(png).crop(rect).toPNG(),
    resize: (png, size) => load(png).resize({ ...size, quality: "good" }).toPNG(),
    encode: (png, format, quality) => (format === "jpeg" ? load(png).toJPEG(quality) : png),
  };
}

export interface ScreenshotResult {
  tabId: string;
  url: string;
  title: string;
  mimeType: "image/png" | "image/jpeg";
  /** Base64 image data. */
  data: string;
  /** The saved file, or null with save: false. */
  path: string | null;
  bytes: number;
  imageSize: Size;
  /** CSS pixels of the layout viewport. */
  viewport: BrowserViewport | null;
  /** Image pixels per CSS pixel: divide image coordinates by it before passing them to input tools. */
  scale: { x: number; y: number };
  /** What the image shows, in viewport CSS pixels (page pixels for a full page). */
  region: Rect;
  fullPage: boolean;
  element?: ElementDescription;
}

async function captureFullPage(target: BrowserTarget): Promise<{ png: Buffer; css: Size }> {
  const metrics = await target.session.send<{ cssContentSize?: Size; contentSize?: Size }>("Page.getLayoutMetrics");
  const content = metrics.cssContentSize ?? metrics.contentSize;
  if (!content) throw new Error("The page did not report its size.");
  const css = { width: Math.ceil(content.width), height: Math.min(FULL_PAGE_MAX_HEIGHT, Math.ceil(content.height)) };
  const shot = await withTimeout(
    target.session.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: css.width, height: css.height, scale: 1 },
    }),
    20_000,
    "The full-page capture timed out.",
  );
  return { png: Buffer.from(shot.data, "base64"), css };
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

export async function captureScreenshot(
  target: BrowserTarget,
  request: ScreenshotRequest,
  options: { codec?: ImageCodec; label?: string } = {},
): Promise<ScreenshotResult> {
  const codec = options.codec ?? nativeImageCodec();
  const info = await target.info();
  let png: Buffer;
  let css: Size;
  let region: Rect;
  let element: ElementDescription | undefined;
  if (request.fullPage) {
    ({ png, css } = await captureFullPage(target));
    region = { x: 0, y: 0, ...css };
  } else {
    let clip = request.clip;
    if (request.selector) {
      element = await locateElement(target, request.selector, { scrollIntoView: true });
      if (!element.box.visible || element.box.width < 1 || element.box.height < 1) {
        throw new Error(`${request.selector} is not visible, so it cannot be captured.`);
      }
      clip = { x: element.box.x, y: element.box.y, width: element.box.width, height: element.box.height };
    }
    png = await target.captureViewport();
    const image = codec.size(png);
    const viewport = info.viewport ?? image;
    region = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    if (clip) {
      const crop = cssRectToImage(clip, viewport, image);
      if (!crop) throw new Error("The requested region is outside the viewport.");
      png = codec.crop(png, crop);
      const sx = image.width / viewport.width;
      const sy = image.height / viewport.height;
      region = { x: crop.x / sx, y: crop.y / sy, width: crop.width / sx, height: crop.height / sy };
    }
    css = { width: region.width, height: region.height };
  }
  const size = outputSize(css, request.scale, request.maxWidth);
  const current = codec.size(png);
  if (current.width !== size.width || current.height !== size.height) png = codec.resize(png, size);
  const encoded = codec.encode(png, request.format, request.quality);
  const ext = request.format === "jpeg" ? "jpg" : "png";
  const path = request.save
    ? await writeBrowserArtifact(target.workspaceId, "screenshots", { label: options.label ?? target.ref, ext, data: encoded })
    : null;
  return {
    tabId: target.ref,
    url: info.url,
    title: info.title,
    mimeType: request.format === "jpeg" ? "image/jpeg" : "image/png",
    data: encoded.toString("base64"),
    path,
    bytes: encoded.length,
    imageSize: size,
    viewport: info.viewport,
    scale: { x: size.width / css.width, y: size.height / css.height },
    region,
    fullPage: request.fullPage,
    ...(element ? { element } : {}),
  };
}
