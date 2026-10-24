// Downloads a library, stylesheet or font a page loads from a public CDN, so
// the shared page carries it inline (share:fetchRemote). The shared page is
// served with a CSP that loads nothing from the network, and that stays so:
// what a page needs from the web is fetched here, once, at share time.
//
// Only the CDNs in shareRemoteAllowed, only over HTTPS, and every redirect
// is checked against the same list before it is followed. Each file has a
// size cap (also the room left in the 5 MB page) and a time cap, an
// integrity attribute is checked when the page gave one, and the response
// must be the type the page uses it as. No cookies or credentials are sent:
// main's fetch has no cookie jar. Electron-free so the unit suite can drive
// it with a fake CDN.

import { createHash } from "node:crypto";
import { SHARE_MAX_PAGE_BYTES } from "../../shared/share";
import {
  SHARE_ASSET_TYPES,
  SHARE_REMOTE_KINDS,
  shareRemoteAllowed,
  type ShareLeftOutReason,
  type ShareRemoteKind,
  type ShareRemoteRequest,
  type ShareRemoteResult,
} from "../../shared/share-assets";

export const SHARE_REMOTE_TIMEOUT_MS = 15_000;
export const SHARE_REMOTE_MAX_REDIRECTS = 5;
// One file from the web. The page's own 5 MB cap usually binds first.
export const SHARE_REMOTE_MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_INTEGRITY_CHARS = 2048;

export interface ShareRemoteDeps {
  fetch?: typeof fetch;
  /** Tests only: the CDN allowlist. The app always uses shareRemoteAllowed. */
  allowed?: (url: URL, kind: ShareRemoteKind) => boolean;
  timeoutMs?: number;
  userAgent?: string;
}

const ACCEPT: Record<ShareRemoteKind, string> = {
  script: "text/javascript, application/javascript, */*;q=0.1",
  css: "text/css, */*;q=0.1",
  font: "font/woff2, font/woff, font/ttf, font/otf, */*;q=0.1",
  image: "image/avif, image/webp, image/png, image/svg+xml, image/*;q=0.8, */*;q=0.1",
};

const SCRIPT_MIMES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

const FONT_MIMES = new Set([
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/font-sfnt",
  "application/vnd.ms-fontobject",
]);

// The MIME type the embedded copy carries, or null when the response is not
// what the page uses it as (an HTML error page instead of a script, say).
function embeddedMime(kind: ShareRemoteKind, served: string, url: URL): string | null {
  const byExtension = SHARE_ASSET_TYPES[url.pathname.slice(url.pathname.lastIndexOf(".") + 1).toLowerCase()];
  switch (kind) {
    case "script":
      return SCRIPT_MIMES.has(served) ? "text/javascript" : null;
    case "css":
      return served === "text/css" ? "text/css" : null;
    case "font":
      if (served.startsWith("font/") || FONT_MIMES.has(served)) return served;
      // Some CDNs serve fonts as bytes; the file name says which font it is.
      if (served === "application/octet-stream" && byExtension?.kind === "font") return byExtension.mime;
      return null;
    case "image":
      return served.startsWith("image/") ? served : null;
  }
}

const SRI_STRENGTH: Record<string, number> = { sha256: 1, sha384: 2, sha512: 3 };

/**
 * Whether `bytes` match the integrity attribute, by the strongest hash it
 * names (as browsers check it). Null when it names no hash Studio knows, in
 * which case the browser would not check it either.
 */
export function integrityMatches(bytes: Uint8Array, integrity: string): boolean | null {
  const entries: { alg: string; digest: string }[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?.*)?$/i.exec(token);
    if (match?.[1] && match[2]) {
      entries.push({ alg: match[1].toLowerCase(), digest: match[2].replace(/-/g, "+").replace(/_/g, "/") });
    }
  }
  if (entries.length === 0) return null;
  const strongest = entries.reduce((best, entry) =>
    (SRI_STRENGTH[entry.alg] ?? 0) > (SRI_STRENGTH[best.alg] ?? 0) ? entry : best,
  ).alg;
  const actual = createHash(strongest).update(bytes).digest("base64");
  const strip = (digest: string) => digest.replace(/=+$/, "");
  return entries.some((entry) => entry.alg === strongest && strip(entry.digest) === strip(actual));
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function refused(reason: ShareLeftOutReason): ShareRemoteResult {
  return { ok: false, reason };
}

function defaultUserAgent(): string {
  // A plain Chrome identity: Google Fonts answers it with woff2 files split
  // by script, which keeps the embedded fonts small, and it does not tell
  // the CDN which app is asking.
  const chrome = process.versions.chrome ?? "130.0.0.0";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

export async function fetchShareRemote(input: unknown, deps: ShareRemoteDeps = {}): Promise<ShareRemoteResult> {
  const raw = (input ?? {}) as Partial<Record<keyof ShareRemoteRequest, unknown>>;
  if (typeof raw.url !== "string" || raw.url.length > MAX_URL_CHARS) return refused("unavailable");
  if (!SHARE_REMOTE_KINDS.includes(raw.kind as ShareRemoteKind)) return refused("unavailable");
  const kind = raw.kind as ShareRemoteKind;
  const integrity =
    typeof raw.integrity === "string" && raw.integrity.length <= MAX_INTEGRITY_CHARS ? raw.integrity : "";
  const cap =
    typeof raw.maxBytes === "number" && Number.isFinite(raw.maxBytes)
      ? Math.min(Math.floor(raw.maxBytes), SHARE_REMOTE_MAX_FILE_BYTES, SHARE_MAX_PAGE_BYTES)
      : 0;
  if (cap <= 0) return refused("too_large");
  const allowed = deps.allowed ?? shareRemoteAllowed;
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return refused("unavailable");
  }
  if (!allowed(url, kind)) return refused("unavailable");

  const limit = deps.timeoutMs ?? SHARE_REMOTE_TIMEOUT_MS;
  const timeoutMs =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
      ? Math.max(1, Math.min(Math.floor(raw.timeoutMs), limit))
      : limit;
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; ; hop += 1) {
      const response = await doFetch(url.href, {
        method: "GET",
        // Each hop is checked against the allowlist before it is followed.
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { accept: ACCEPT[kind], "user-agent": deps.userAgent ?? defaultUserAgent() },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location || hop >= SHARE_REMOTE_MAX_REDIRECTS) return refused("unavailable");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return refused("unavailable");
        }
        if (!allowed(next, kind)) return refused("unavailable");
        url = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return refused("unavailable");
      }
      const served = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const mime = embeddedMime(kind, served, url);
      if (!mime) {
        await response.body?.cancel().catch(() => undefined);
        return refused("unavailable");
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > cap) {
        await response.body?.cancel().catch(() => undefined);
        return refused("too_large");
      }
      const bytes = await readCapped(response, cap);
      if (!bytes) return refused("too_large");
      if (integrity && integrityMatches(bytes, integrity) === false) return refused("integrity");
      return { ok: true, bytes, url: url.href, mime };
    }
  } catch {
    return refused("unavailable");
  } finally {
    clearTimeout(timer);
  }
}
