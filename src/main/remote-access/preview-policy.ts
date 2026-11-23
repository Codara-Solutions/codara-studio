import { truncateUtf8 } from "./local-policy";

// Pure-Node policy, validation, and framing helpers for remote Browser Preview.
// Kept free of Electron imports so unit tests run directly in plain Node.

export const MAX_REMOTE_PREVIEW_TABS = 32;
export const MAX_REMOTE_PREVIEW_TITLE_BYTES = 240;
export const MAX_REMOTE_PREVIEW_URL_BYTES = 2048;
// Keeps the base64 JSON response safely below the 1 MiB Noise frame ceiling.
export const MAX_REMOTE_PREVIEW_IMAGE_BYTES = 480 * 1024;
export const REMOTE_PREVIEW_MAX_WIDTH = 960;
export const REMOTE_PREVIEW_FALLBACK_WIDTH = 640;

export const REMOTE_PREVIEW_VIEWPORTS = {
  mobile: { width: 430, height: 860 },
  desktop: { width: 1280, height: 800 },
} as const;

export const PREVIEW_ACTION_BURST = 32;
export const PREVIEW_ACTION_REFILL_MS = 500;

export type RemotePreviewViewportMode = "mobile" | "desktop";

export interface RemotePreviewTab {
  tabId: string;
  workspaceId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewportMode?: RemotePreviewViewportMode;
  updatedAt?: string;
}

export interface RemotePreviewScreenshot {
  tabId: string;
  workspaceId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewportMode?: RemotePreviewViewportMode;
  screenshotDataUrl: string;
  width: number;
  height: number;
  updatedAt: string;
}

// Deliberately narrow interaction surface: no arbitrary navigate, evaluate,
// type, press_key, or upload actions over remote access.
export type RemotePreviewInteractAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "reload" }
  | { kind: "viewport"; mode: RemotePreviewViewportMode };

export interface PreviewImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    quality?: "good" | "better" | "best";
  }): PreviewImageLike;
  toJPEG(quality: number): Buffer;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== expected.length) return false;
  return expected.every((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
}

const DISALLOWED_PREVIEW_TITLE_SCHEMES = new Set([
  "file:",
  "javascript:",
  "data:",
  "chrome:",
  "devtools:",
  "about:",
  "electron:",
]);

function stripAsciiControlChars(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

export function sanitizeRemotePreviewUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_REMOTE_PREVIEW_URL_BYTES) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.username = "";
  parsed.password = "";
  const sanitized = parsed.toString();
  if (Buffer.byteLength(sanitized, "utf8") > MAX_REMOTE_PREVIEW_URL_BYTES) {
    return null;
  }
  return sanitized;
}

// Untitled or error pages frequently mirror the raw URL (including embedded
// basic-auth credentials or disallowed schemes) into the document title.
export function sanitizeRemotePreviewTitle(
  rawTitle: unknown,
  fallbackUrl: string,
  rawUrl?: unknown,
): string {
  const cleaned =
    typeof rawTitle === "string" ? stripAsciiControlChars(rawTitle) : "";
  if (!cleaned) {
    return truncateUtf8(fallbackUrl, MAX_REMOTE_PREVIEW_TITLE_BYTES);
  }
  const cleanedRawUrl =
    typeof rawUrl === "string" ? stripAsciiControlChars(rawUrl) : "";
  if (cleanedRawUrl && cleaned === cleanedRawUrl) {
    return truncateUtf8(
      sanitizeRemotePreviewUrl(cleaned) ?? fallbackUrl,
      MAX_REMOTE_PREVIEW_TITLE_BYTES,
    );
  }
  try {
    const parsed = new URL(cleaned);
    const protocol = parsed.protocol.toLowerCase();
    const isHttpOrHttps = protocol === "http:" || protocol === "https:";
    const hasCredentials = Boolean(parsed.username || parsed.password);
    const isDisallowedScheme = DISALLOWED_PREVIEW_TITLE_SCHEMES.has(protocol);
    if (isHttpOrHttps || hasCredentials || isDisallowedScheme) {
      return truncateUtf8(
        sanitizeRemotePreviewUrl(cleaned) ?? fallbackUrl,
        MAX_REMOTE_PREVIEW_TITLE_BYTES,
      );
    }
  } catch {
    // Plain non-URL title; keep as-is after control-char stripping.
  }
  return truncateUtf8(cleaned, MAX_REMOTE_PREVIEW_TITLE_BYTES);
}

export function isValidRemotePreviewInteractAction(
  value: unknown,
): value is RemotePreviewInteractAction {
  if (!isPlainObject(value)) return false;
  if (value.kind === "click") {
    return (
      hasExactKeys(value, ["kind", "x", "y"]) &&
      typeof value.x === "number" &&
      Number.isFinite(value.x) &&
      value.x >= 0 &&
      value.x <= 1 &&
      typeof value.y === "number" &&
      Number.isFinite(value.y) &&
      value.y >= 0 &&
      value.y <= 1
    );
  }
  if (value.kind === "reload") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "viewport") {
    return (
      hasExactKeys(value, ["kind", "mode"]) &&
      (value.mode === "mobile" || value.mode === "desktop")
    );
  }
  return false;
}

export function mapNormalizedPreviewClick(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    throw new Error("Browser viewport size is unavailable.");
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Browser click coordinates are invalid.");
  }
  const clampedX = Math.min(1, Math.max(0, x));
  const clampedY = Math.min(1, Math.max(0, y));
  const maxX = Math.max(0, Math.floor(viewportWidth) - 1);
  const maxY = Math.max(0, Math.floor(viewportHeight) - 1);
  return {
    x: Math.min(maxX, Math.max(0, Math.round(clampedX * viewportWidth))),
    y: Math.min(maxY, Math.max(0, Math.round(clampedY * viewportHeight))),
  };
}

function tryEncodeJpegQualities(
  image: PreviewImageLike,
  qualities: readonly number[],
  maxBytes: number,
): { dataUrl: string; width: number; height: number; bytes: number } | null {
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (
    !size ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  for (const quality of qualities) {
    const buffer = image.toJPEG(quality);
    if (buffer.length > 0 && buffer.length <= maxBytes) {
      return {
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        width: size.width,
        height: size.height,
        bytes: buffer.length,
      };
    }
  }
  return null;
}

export function encodeBoundedPreviewJpeg(
  image: PreviewImageLike,
  maxBytes = MAX_REMOTE_PREVIEW_IMAGE_BYTES,
): { dataUrl: string; width: number; height: number; bytes: number } {
  if (!image || image.isEmpty()) {
    throw new Error("Browser preview capture returned an empty frame.");
  }
  const initialSize = image.getSize();
  if (
    !initialSize ||
    !Number.isFinite(initialSize.width) ||
    !Number.isFinite(initialSize.height) ||
    initialSize.width <= 0 ||
    initialSize.height <= 0
  ) {
    throw new Error("Browser preview capture returned an invalid frame size.");
  }
  const current =
    initialSize.width > REMOTE_PREVIEW_MAX_WIDTH
      ? image.resize({ width: REMOTE_PREVIEW_MAX_WIDTH, quality: "better" })
      : image;
  const primary = tryEncodeJpegQualities(current, [78, 64, 50, 38], maxBytes);
  if (primary) return primary;

  if (current.getSize().width > REMOTE_PREVIEW_FALLBACK_WIDTH) {
    const fallbackImage = current.resize({
      width: REMOTE_PREVIEW_FALLBACK_WIDTH,
      quality: "good",
    });
    const fallback = tryEncodeJpegQualities(
      fallbackImage,
      [60, 44, 34],
      maxBytes,
    );
    if (fallback) return fallback;
  }

  throw new Error("Browser preview frame exceeded the remote transfer limit.");
}

export function projectRemotePreviewTabs(
  rawTabs: readonly unknown[],
  workspaceId: string,
  viewportModes?: ReadonlyMap<string, RemotePreviewViewportMode>,
): RemotePreviewTab[] {
  const tabs: RemotePreviewTab[] = [];
  const seen = new Set<string>();
  for (const raw of rawTabs) {
    if (tabs.length >= MAX_REMOTE_PREVIEW_TABS) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.workspaceId !== workspaceId) continue;
    // Sleeping desktop tabs stay asleep until the desktop user wakes them.
    if (entry.asleep === true) continue;
    if (typeof entry.id !== "string") continue;
    const tabId = entry.id.trim();
    if (!tabId || tabId.length > 128 || seen.has(tabId)) continue;
    const url = sanitizeRemotePreviewUrl(entry.url);
    if (!url) continue;
    seen.add(tabId);
    const title = sanitizeRemotePreviewTitle(entry.title, url, entry.url);
    const viewportMode = viewportModes?.get(tabId);
    tabs.push({
      tabId,
      workspaceId,
      title,
      url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      ...(viewportMode ? { viewportMode } : {}),
    });
  }
  return tabs;
}
