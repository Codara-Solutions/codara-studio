// Turns a page on disk into one self-contained HTML document for a share
// link. The shared page is served with a CSP that loads nothing from the
// network (codara-share SECURITY.md), so every local image, font, stylesheet
// and script the page uses is embedded here, and so are libraries,
// stylesheets and fonts it loads from a few public CDNs. What cannot work
// there is left out and reported to the user before anything is uploaded.
//
// The rules for what may be embedded live in @shared/share-assets. This file
// applies them to the path the page names, to report early; main applies
// them again when it reads (to the file's real path, links resolved) and
// when it downloads (to every address, redirects included), and main's
// answer is the one that counts.

import { defaultTreeAdapter, html as parse5Html, parse, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { SHARE_MAX_PAGE_BYTES } from "@shared/share";
import {
  refusedAssetPath,
  shareAssetType,
  shareRemoteAllowed,
  type ShareAssetKind,
  type ShareAssetRequest,
  type ShareAssetResult,
  type ShareLeftOutReason,
  type ShareRemoteKind,
  type ShareRemoteRequest,
  type ShareRemoteResult,
} from "@shared/share-assets";
import { dirnameOf, isInsideDir, relativePath, relativeTo, resolveFrom } from "./paths";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

/** Reads a local file for the page; in the app, main checks and reads it. */
export interface AssetReader {
  read(request: ShareAssetRequest): Promise<ShareAssetResult>;
}

/** Downloads a file from an allowed CDN; in the app, main does. */
export interface RemoteFetcher {
  fetch(request: ShareRemoteRequest): Promise<ShareRemoteResult>;
}

export type LeftOutReason = ShareLeftOutReason;

export interface PackagedPage {
  html: string;
  bytes: number;
  /** Local files embedded in the page, relative to the page's folder where possible. */
  included: string[];
  /** Files from allowed CDNs embedded in the page, as addresses without https://. */
  embedded: string[];
  leftOut: { ref: string; reason: LeftOutReason }[];
  /** Addresses on other sites the shared page refers to but cannot load. */
  remote: string[];
  /** Frames, embeds, local links and redirects removed because they cannot work there. */
  removed: number;
}

export interface PackageOptions {
  /** Absolute path of the page on disk. */
  sourcePath: string;
  allowedRoots: string[];
  reader: AssetReader;
  /** Without one, files from the web are only reported. */
  remote?: RemoteFetcher;
  maxBytes?: number;
  /** Time for all of the page's downloads together. */
  remoteBudgetMs?: number;
}

const MAX_IMPORT_DEPTH = 4;
const MAX_LISTED = 200;
// A page that needs more than this from the web is not one page any more.
const MAX_REMOTE_FILES = 40;
const REMOTE_BUDGET_MS = 45_000;

type Ref =
  | { type: "keep" }
  | { type: "remote"; url: string }
  | { type: "local"; path: string };

// A stylesheet downloaded from the web resolves its references against its
// own address; a local one against its folder.
function isWebBase(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

function baseOf(location: string): string {
  return isWebBase(location) ? location : dirnameOf(location);
}

function remoteRef(raw: string): Ref {
  try {
    return { type: "remote", url: new URL(raw).href };
  } catch {
    return { type: "remote", url: raw };
  }
}

function classify(raw: string, base: string): Ref {
  const ref = raw.trim();
  if (!ref || ref.startsWith("#")) return { type: "keep" };
  if (isWebBase(base)) {
    // data:, blob: and other schemes stay as they are.
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^https?:/i.test(ref)) return { type: "keep" };
    try {
      return { type: "remote", url: new URL(ref, base).href };
    } catch {
      return { type: "keep" };
    }
  }
  // The shared page is served over HTTPS, so a protocol-relative address is.
  if (ref.startsWith("//")) return remoteRef(`https:${ref}`);
  if (/^https?:\/\//i.test(ref)) return remoteRef(ref);
  if (/^file:/i.test(ref)) {
    let p = ref.replace(/^file:(\/\/[^/]*)?/i, "");
    // file:///C:/x arrives as /C:/x.
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return { type: "local", path: resolveFrom(base, decodePath(stripQuery(p))) };
  }
  // data:, blob:, mailto:, javascript: and every other scheme stay as they are.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-zA-Z]:[\\/]/.test(ref)) return { type: "keep" };
  return { type: "local", path: resolveFrom(base, decodePath(stripQuery(ref))) };
}

function stripQuery(ref: string): string {
  return ref.split(/[?#]/, 1)[0] ?? "";
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

// What a CSS url() on the web is, by its file name; fonts.gstatic.com serves
// only fonts.
function remoteKindForCss(url: string): ShareRemoteKind {
  try {
    const parsed = new URL(url);
    const kind = shareAssetType(parsed.pathname)?.kind;
    if (kind === "font" || kind === "image") return kind;
    return parsed.hostname === "fonts.gstatic.com" ? "font" : "image";
  } catch {
    return "image";
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

// Inline script and style text must not close its own element early.
function escapeScriptText(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

// Replaces each match in turn with what `fn` returns (null keeps the match),
// in one pass, so text a replacement brings in is not scanned again.
async function replaceAsync(
  text: string,
  pattern: RegExp,
  fn: (match: RegExpExecArray) => Promise<string | null>,
): Promise<string> {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const replacement = await fn(match as RegExpExecArray);
    if (replacement === null) continue;
    out += text.slice(last, index) + replacement;
    last = index + match[0].length;
  }
  return out + text.slice(last);
}

// An @import (target in groups 1-5, media in 6) or a url() (target in 7-9).
// Quoted addresses may hold ";" and ")" (Google Fonts' "wght@400;700").
const CSS_REFERENCE =
  /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;

function parseUnicodeRange(value: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  for (const part of value.split(",")) {
    const match = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!match?.[1]) return null;
    const start = Number.parseInt(match[1].replace(/\?/g, "0"), 16);
    const end = Number.parseInt(match[2] ?? match[1].replace(/\?/g, "f"), 16);
    ranges.push([start, end]);
  }
  return ranges.length > 0 ? ranges : null;
}

class Packager {
  private readonly maxBytes: number;
  private total: number;
  private readonly included = new Set<string>();
  private readonly embedded = new Set<string>();
  private readonly remote = new Set<string>();
  private readonly leftOut: PackagedPage["leftOut"] = [];
  private removed = 0;
  private readonly cache = new Map<string, string>();
  private readonly pageDir: string;
  private remoteFiles = 0;
  private readonly deadline: number;
  private codePoints: number[] | null = null;

  constructor(
    private readonly options: PackageOptions,
    private readonly source: string,
  ) {
    this.maxBytes = options.maxBytes ?? SHARE_MAX_PAGE_BYTES;
    this.total = byteLength(source);
    this.pageDir = dirnameOf(options.sourcePath);
    this.deadline = Date.now() + (options.remoteBudgetMs ?? REMOTE_BUDGET_MS);
  }

  result(html: string): PackagedPage {
    return {
      html,
      bytes: byteLength(html),
      included: [...this.included],
      embedded: [...this.embedded],
      leftOut: this.leftOut,
      remote: [...this.remote],
      removed: this.removed,
    };
  }

  countRemote(url: string): void {
    if (this.remote.size < MAX_LISTED) this.remote.add(url);
  }

  countRemoved(): void {
    this.removed += 1;
  }

  private display(path: string): string {
    return relativePath(this.pageDir, path);
  }

  private leave(ref: string, reason: LeftOutReason): void {
    if (this.leftOut.length < MAX_LISTED) this.leftOut.push({ ref, reason });
  }

  private room(): number {
    return this.maxBytes - this.total;
  }

  // The renderer's early answer from the path as named: inside an allowed
  // root and of a name and type that may be embedded. Main repeats it on the
  // real path.
  private lexicalReason(path: string, kinds: readonly ShareAssetKind[]): LeftOutReason | null {
    const root = this.options.allowedRoots.find((r) => isInsideDir(r, path));
    if (!root) return "outside";
    return refusedAssetPath(relativeTo(root, path), kinds);
  }

  private async readLocal(path: string, ref: string, kinds: readonly ShareAssetKind[], maxBytes: number): Promise<Uint8Array | null> {
    const early = this.lexicalReason(path, kinds);
    if (early) {
      this.leave(ref, early);
      return null;
    }
    if (maxBytes <= 0) {
      this.leave(ref, "too_large");
      return null;
    }
    let result: ShareAssetResult;
    try {
      result = await this.options.reader.read({
        path,
        roots: [...this.options.allowedRoots],
        kinds: [...kinds],
        maxBytes,
      });
    } catch {
      result = { ok: false, reason: "missing" };
    }
    if (!result.ok) {
      this.leave(ref, result.reason);
      return null;
    }
    this.included.add(this.display(path));
    return result.bytes;
  }

  private async download(
    url: string,
    kind: ShareRemoteKind,
    integrity: string | null,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; url: string; mime: string } | null> {
    const fetcher = this.options.remote;
    if (!fetcher || !shareRemoteAllowed(url, kind)) {
      this.countRemote(url);
      return null;
    }
    const left = this.deadline - Date.now();
    if (this.remoteFiles >= MAX_REMOTE_FILES || left <= 0) {
      this.leave(url, "unavailable");
      return null;
    }
    if (maxBytes <= 0) {
      this.leave(url, "too_large");
      return null;
    }
    this.remoteFiles += 1;
    let result: ShareRemoteResult;
    try {
      result = await fetcher.fetch({ url, kind, maxBytes, integrity: integrity ?? undefined, timeoutMs: left });
    } catch {
      result = { ok: false, reason: "unavailable" };
    }
    if (!result.ok) {
      this.leave(url, result.reason);
      return null;
    }
    if (this.embedded.size < MAX_LISTED) this.embedded.add(displayUrl(url));
    return result;
  }

  // The data: URI already made for this file, if it still fits.
  private reuse(key: string, raw: string, refForReport: string): string | null | undefined {
    const cached = this.cache.get(key);
    if (cached === undefined) return undefined;
    if (cached.length - raw.length > this.room()) {
      this.leave(refForReport, "too_large");
      return null;
    }
    this.total += cached.length - raw.length;
    return cached;
  }

  private remember(key: string, raw: string, uri: string): string {
    this.total += uri.length - raw.length;
    this.cache.set(key, uri);
    return uri;
  }

  /**
   * A data: URI for a picture, font or media file, or null to leave the
   * reference as it is. Files from the web are downloaded only for CSS
   * url()s (`fromCss`): fonts and the pictures a stylesheet draws with.
   */
  async dataUri(raw: string, base: string, kinds: readonly ShareAssetKind[], fromCss = false): Promise<string | null> {
    const ref = classify(raw, base);
    if (ref.type === "keep") return null;
    // Base64 grows a file by a third, plus the data: prefix.
    const roomFor = () => Math.floor((this.room() - 64 + raw.length) / 4) * 3;
    if (ref.type === "remote") {
      if (!fromCss) {
        this.countRemote(ref.url);
        return null;
      }
      const reused = this.reuse(ref.url, raw, ref.url);
      if (reused !== undefined) return reused;
      const file = await this.download(ref.url, remoteKindForCss(ref.url), null, roomFor());
      if (!file) return null;
      return this.remember(ref.url, raw, `data:${file.mime};base64,${bytesToBase64(file.bytes)}`);
    }
    // The cache holds files that passed main's checks; the use (picture,
    // font, media) is checked again here for this reference.
    const early = this.lexicalReason(ref.path, kinds);
    if (early) {
      this.leave(raw, early);
      return null;
    }
    const reused = this.reuse(ref.path, raw, raw);
    if (reused !== undefined) return reused;
    const bytes = await this.readLocal(ref.path, raw, kinds, roomFor());
    if (!bytes) return null;
    const mime = shareAssetType(ref.path)?.mime ?? "application/octet-stream";
    return this.remember(ref.path, raw, `data:${mime};base64,${bytesToBase64(bytes)}`);
  }

  /** The text of a stylesheet or script and where it came from, or null to leave the reference. */
  async text(
    raw: string,
    base: string,
    kind: "css" | "script",
    integrity: string | null = null,
  ): Promise<{ text: string; location: string } | null> {
    const ref = classify(raw, base);
    if (ref.type === "keep") return null;
    if (ref.type === "remote") {
      const file = await this.download(ref.url, kind, integrity, this.room());
      if (!file) return null;
      this.total += file.bytes.length;
      return { text: utf8Decoder.decode(file.bytes), location: file.url };
    }
    const bytes = await this.readLocal(ref.path, raw, [kind], this.room());
    if (!bytes) return null;
    this.total += bytes.length;
    return { text: utf8Decoder.decode(bytes), location: ref.path };
  }

  private pageUses(ranges: [number, number][]): boolean {
    if (!this.codePoints) {
      const seen = new Set<number>();
      for (const ch of this.source) seen.add(ch.codePointAt(0) ?? 0);
      this.codePoints = [...seen].sort((a, b) => a - b);
    }
    const points = this.codePoints;
    return ranges.some(([start, end]) => {
      // First code point at or above `start`.
      let lo = 0;
      let hi = points.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((points[mid] ?? 0) < start) lo = mid + 1;
        else hi = mid;
      }
      return lo < points.length && (points[lo] ?? 0) <= end;
    });
  }

  // Google Fonts splits a family by script (latin, cyrillic, greek...), and a
  // browser downloads a part only when the page has text in its range. The
  // shared page carries only the parts its text uses, instead of all of them.
  private dropUnusedFontFaces(css: string): string {
    return css.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
      const range = /unicode-range\s*:\s*([^;}]+)/i.exec(block)?.[1];
      const ranges = range ? parseUnicodeRange(range) : null;
      return !ranges || this.pageUses(ranges) ? block : "";
    });
  }

  async inlineCss(css: string, base: string, depth = 0, seen = new Set<string>()): Promise<string> {
    const source = isWebBase(base) ? this.dropUnusedFontFaces(css) : css;
    return replaceAsync(source, CSS_REFERENCE, async (match) => {
      const importTarget = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      if (importTarget !== undefined) {
        // Each @import becomes the imported sheet's text, in place.
        const ref = classify(importTarget, base);
        if (ref.type === "keep") return null;
        const key = ref.type === "remote" ? ref.url : ref.path;
        if (depth >= MAX_IMPORT_DEPTH || seen.has(key)) return null;
        const sheet = await this.text(importTarget, base, "css");
        if (!sheet) return null;
        seen.add(sheet.location);
        const body = await this.inlineCss(sheet.text, baseOf(sheet.location), depth + 1, seen);
        const condition = (match[6] ?? "").trim();
        return condition ? `@media ${condition} {\n${body}\n}` : body;
      }
      const target = match[7] ?? match[8] ?? match[9];
      if (!target) return null;
      const uri = await this.dataUri(target, base, ["image", "font"], true);
      return uri ? `url("${uri}")` : null;
    });
  }

  async srcset(value: string, base: string): Promise<string> {
    const parts: string[] = [];
    for (const candidate of value.split(/,\s+/)) {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      if (!url) continue;
      const uri = await this.dataUri(url, base, ["image"]);
      parts.push([uri ?? url, ...descriptor].join(" "));
    }
    return parts.join(", ");
  }

  get dir(): string {
    return this.pageDir;
  }
}

function attr(el: Element, name: string): string | null {
  const found = el.attrs.find((a) => a.name === name);
  return found ? found.value : null;
}

function setAttr(el: Element, name: string, value: string): void {
  const found = el.attrs.find((a) => a.name === name);
  if (found) found.value = value;
  else el.attrs.push({ name, value });
}

function removeAttr(el: Element, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name !== name);
}

function textOf(el: Element): string {
  return el.childNodes.map((child) => ("value" in child && child.nodeName === "#text" ? child.value : "")).join("");
}

function setText(el: Element, text: string): void {
  el.childNodes = [];
  defaultTreeAdapter.insertText(el, text);
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function detach(node: Node): void {
  const parent = (node as { parentNode?: ParentNode | null }).parentNode;
  if (parent) defaultTreeAdapter.detachNode(node as Element);
}

const FRAME_TAGS = new Set(["iframe", "frame", "embed", "object", "portal", "applet"]);
// Hints that make a browser connect or fetch ahead. A sealed page cannot, and
// they carry nothing the reader sees.
const HINT_RELS = new Set(["preconnect", "dns-prefetch", "preload", "prefetch", "modulepreload", "prerender"]);

async function visit(node: Node, p: Packager): Promise<void> {
  if (isElement(node)) {
    const keep = await rewriteElement(node, p);
    if (!keep) {
      detach(node);
      return;
    }
  }
  const children = "childNodes" in node ? [...(node as ParentNode).childNodes] : [];
  for (const child of children) await visit(child, p);
}

// Rewrites one element in place. False removes it from the page.
async function rewriteElement(el: Element, p: Packager): Promise<boolean> {
  const dir = p.dir;
  const style = attr(el, "style");
  if (style && /url\(|@import/i.test(style)) setAttr(el, "style", await p.inlineCss(style, dir));

  switch (el.tagName) {
    case "base":
      p.countRemoved();
      return false;
    case "meta":
      if ((attr(el, "http-equiv") ?? "").toLowerCase() === "refresh") {
        p.countRemoved();
        return false;
      }
      return true;
    case "img":
    case "input": {
      if (el.tagName === "input" && (attr(el, "type") ?? "").toLowerCase() !== "image") return true;
      const src = attr(el, "src");
      if (src) {
        const uri = await p.dataUri(src, dir, ["image"]);
        if (uri) setAttr(el, "src", uri);
      }
      const srcset = attr(el, "srcset");
      if (srcset) setAttr(el, "srcset", await p.srcset(srcset, dir));
      return true;
    }
    case "source": {
      const src = attr(el, "src");
      if (src) {
        const uri = await p.dataUri(src, dir, ["image", "media"]);
        if (uri) setAttr(el, "src", uri);
      }
      const srcset = attr(el, "srcset");
      if (srcset) setAttr(el, "srcset", await p.srcset(srcset, dir));
      return true;
    }
    case "video":
    case "audio": {
      const src = attr(el, "src");
      if (src) {
        const uri = await p.dataUri(src, dir, ["media"]);
        if (uri) setAttr(el, "src", uri);
      }
      const poster = attr(el, "poster");
      if (poster) {
        const uri = await p.dataUri(poster, dir, ["image"]);
        if (uri) setAttr(el, "poster", uri);
      }
      return true;
    }
    case "image":
    case "feImage": {
      for (const name of ["href", "xlink:href"]) {
        const value = attr(el, name);
        if (!value) continue;
        const uri = await p.dataUri(value, dir, ["image"]);
        if (uri) setAttr(el, name, uri);
      }
      return true;
    }
    case "style":
      setText(el, escapeStyleText(await p.inlineCss(textOf(el), dir)));
      return true;
    case "link":
      return rewriteLink(el, p);
    case "script": {
      const src = attr(el, "src");
      if (!src) return true;
      const script = await p.text(src, dir, "script", attr(el, "integrity"));
      if (!script) return true;
      removeAttr(el, "src");
      removeAttr(el, "integrity");
      removeAttr(el, "crossorigin");
      setText(el, escapeScriptText(script.text));
      return true;
    }
    case "a":
    case "area": {
      const href = attr(el, "href");
      if (href && classify(href, dir).type === "local") {
        // A link to another file on this computer cannot work for the
        // person opening the link; the text stays.
        removeAttr(el, "href");
        p.countRemoved();
      }
      return true;
    }
    default:
      if (FRAME_TAGS.has(el.tagName)) {
        const target = classify(attr(el, "src") ?? attr(el, "data") ?? "", dir);
        if (target.type === "remote") p.countRemote(target.url);
        p.countRemoved();
        return false;
      }
      return true;
  }
}

async function rewriteLink(el: Element, p: Packager): Promise<boolean> {
  const rel = (attr(el, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const href = attr(el, "href");
  if (!href) return true;
  const dir = p.dir;
  if (rel.includes("stylesheet")) {
    const sheet = await p.text(href, dir, "css", attr(el, "integrity"));
    if (!sheet) return true;
    const style = defaultTreeAdapter.createElement("style", parse5Html.NS.HTML, []);
    const media = attr(el, "media");
    if (media) style.attrs.push({ name: "media", value: media });
    const css = await p.inlineCss(sheet.text, baseOf(sheet.location), 1, new Set([sheet.location]));
    setText(style, escapeStyleText(css));
    const parent = el.parentNode;
    if (parent) {
      const index = parent.childNodes.indexOf(el);
      style.parentNode = parent;
      parent.childNodes.splice(index, 1, style);
    }
    return true;
  }
  if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
    const uri = await p.dataUri(href, dir, ["image"]);
    if (uri) setAttr(el, "href", uri);
    return true;
  }
  // preload, manifest, alternate...: nothing the shared page can use.
  const target = classify(href, dir);
  if (target.type === "local") {
    p.countRemoved();
    return false;
  }
  if (target.type === "remote" && rel.some((r) => HINT_RELS.has(r))) return false;
  if (target.type === "remote" && rel.includes("manifest")) p.countRemote(target.url);
  return true;
}

export async function packageHtmlPage(source: string, options: PackageOptions): Promise<PackagedPage> {
  const packager = new Packager(options, source);
  const doc = parse(source);
  await visit(doc, packager);
  return packager.result(serialize(doc));
}
