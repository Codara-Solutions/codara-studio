// What a shared page may embed. The renderer applies these rules to report
// what it will leave out before reading anything; main applies them again to
// the file's real path when it reads (src/main/share/assets.ts) and to every
// address it downloads from (src/main/share/remote.ts). Main is the one that
// enforces them: the renderer's answer is only a preview.

export type ShareAssetKind = "image" | "font" | "media" | "css" | "script";

/** Why something the page refers to is not embedded. */
export type ShareLeftOutReason =
  | "outside"
  | "private"
  | "hidden"
  | "type"
  | "missing"
  | "too_large"
  | "unavailable"
  | "integrity";

// The extension decides what a local file may be used as, so a "picture" or
// "script" cannot be a key or a database renamed to anything.
export const SHARE_ASSET_TYPES: Readonly<Record<string, { kind: ShareAssetKind; mime: string }>> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  svg: { kind: "image", mime: "image/svg+xml" },
  ico: { kind: "image", mime: "image/x-icon" },
  bmp: { kind: "image", mime: "image/bmp" },
  woff: { kind: "font", mime: "font/woff" },
  woff2: { kind: "font", mime: "font/woff2" },
  ttf: { kind: "font", mime: "font/ttf" },
  otf: { kind: "font", mime: "font/otf" },
  mp4: { kind: "media", mime: "video/mp4" },
  webm: { kind: "media", mime: "video/webm" },
  ogv: { kind: "media", mime: "video/ogg" },
  ogg: { kind: "media", mime: "audio/ogg" },
  oga: { kind: "media", mime: "audio/ogg" },
  mp3: { kind: "media", mime: "audio/mpeg" },
  m4a: { kind: "media", mime: "audio/mp4" },
  wav: { kind: "media", mime: "audio/wav" },
  css: { kind: "css", mime: "text/css" },
  js: { kind: "script", mime: "text/javascript" },
  mjs: { kind: "script", mime: "text/javascript" },
};

export const SHARE_ASSET_KINDS: readonly ShareAssetKind[] = ["image", "font", "media", "css", "script"];

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function shareAssetType(path: string): { kind: ShareAssetKind; mime: string } | null {
  return SHARE_ASSET_TYPES[extensionOf(path)] ?? null;
}

// Names that hold keys and secrets by convention. Refused even inside the
// workspace and even with an allowed extension, except an id_* picture
// (id_card.png is a picture; id_rsa and id_ed25519.pub are not).
function privateName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(".env")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  if (lower.startsWith("id_") && shareAssetType(lower)?.kind !== "image") return true;
  return false;
}

/**
 * Why a file may not be embedded as one of `kinds`, judged from its path
 * relative to the allowed root that holds it ("/"-separated), or null when
 * it may. Main calls this for the path the page names and again for the path
 * it really resolves to, so a link cannot dress up one file as another.
 */
export function refusedAssetPath(relative: string, kinds: readonly ShareAssetKind[]): ShareLeftOutReason | null {
  const segments = relative.split("/").filter((segment) => segment !== "" && segment !== ".");
  const name = segments[segments.length - 1] ?? "";
  if (segments.some((segment) => segment.toLowerCase() === ".git") || privateName(name)) return "private";
  if (segments.some((segment) => segment.startsWith("."))) return "hidden";
  const type = shareAssetType(name);
  if (!type || !kinds.includes(type.kind)) return "type";
  return null;
}

export interface ShareAssetRequest {
  /** Absolute path the page refers to. */
  path: string;
  /** The page's folder and its workspace; the file must really be inside one. */
  roots: string[];
  kinds: ShareAssetKind[];
  /** The most bytes the page has room for. */
  maxBytes: number;
}

export type ShareAssetResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: ShareLeftOutReason };

// Files from the web are embedded only from these public CDNs, over HTTPS,
// and only as what each one serves: libraries and their styles from cdnjs,
// jsDelivr's npm mirror and unpkg (jsDelivr's /gh/ serves any GitHub
// repository, so only /npm/ is allowed), stylesheets from Google Fonts and
// font files from its font host. Pictures come only from these CDNs when a
// stylesheet embedded from them uses one.
export type ShareRemoteKind = "script" | "css" | "font" | "image";

export const SHARE_REMOTE_KINDS: readonly ShareRemoteKind[] = ["script", "css", "font", "image"];

export function shareRemoteAllowed(raw: string | URL, kind: ShareRemoteKind): boolean {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return false;
  switch (url.hostname) {
    case "cdnjs.cloudflare.com":
    case "unpkg.com":
      return true;
    case "cdn.jsdelivr.net":
      return url.pathname.startsWith("/npm/");
    case "fonts.googleapis.com":
      return kind === "css";
    case "fonts.gstatic.com":
      return kind === "font";
    default:
      return false;
  }
}

export interface ShareRemoteRequest {
  url: string;
  kind: ShareRemoteKind;
  maxBytes: number;
  /** The element's integrity attribute, checked when it names sha256, sha384 or sha512. */
  integrity?: string;
  /** The time left for this page's downloads; main caps each download lower. */
  timeoutMs?: number;
}

export type ShareRemoteResult =
  | { ok: true; bytes: Uint8Array; /** after redirects */ url: string; mime: string }
  | { ok: false; reason: ShareLeftOutReason };
