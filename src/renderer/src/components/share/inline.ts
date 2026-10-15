// Turns a page on disk into one self-contained HTML document for a share
// link. The shared page is served with a CSP that loads nothing from the
// network (codara-share SECURITY.md), so every local image, font, stylesheet
// and script the page uses is embedded here, and what cannot work there is
// left out and reported to the user before anything is uploaded.
//
// Which local files may be embedded is decided lexically, before any read:
//   * inside one of `allowedRoots` (the page's own folder and the workspace
//     it belongs to), so a page cannot pull in ~/.ssh or another project;
//   * no hidden segment below that root (.env, .git, .ssh...);
//   * an extension of the expected type for where it is used, so a "picture"
//     cannot be a key file renamed to anything.
// The fs sandbox in main checks every read again.

import { defaultTreeAdapter, html as parse5Html, parse, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { SHARE_MAX_PAGE_BYTES } from "@shared/share";
import { dirnameOf, isInsideDir, relativePath, relativeTo, resolveFrom } from "./paths";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export interface AssetReader {
  /** Size in bytes; throws when the file cannot be read. */
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
}

export type LeftOutReason = "outside" | "hidden" | "type" | "missing" | "too_large";

export interface PackagedPage {
  html: string;
  bytes: number;
  /** Local files embedded in the page, relative to the page's folder where possible. */
  included: string[];
  leftOut: { ref: string; reason: LeftOutReason }[];
  /** References to other sites. The shared page cannot load them. */
  remote: number;
  /** Frames, embeds, local links and redirects removed because they cannot work there. */
  removed: number;
}

export interface PackageOptions {
  /** Absolute path of the page on disk. */
  sourcePath: string;
  allowedRoots: string[];
  reader: AssetReader;
  maxBytes?: number;
}

type AssetKind = "image" | "font" | "media" | "css" | "script";

const MIME_BY_EXT: Record<string, { kind: AssetKind; mime: string }> = {
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

const MAX_IMPORT_DEPTH = 4;

type Ref =
  | { type: "keep" }
  | { type: "remote" }
  | { type: "local"; path: string };

function classify(raw: string, baseDir: string): Ref {
  const ref = raw.trim();
  if (!ref || ref.startsWith("#")) return { type: "keep" };
  if (/^(?:https?:)?\/\//i.test(ref)) return { type: "remote" };
  if (/^file:/i.test(ref)) {
    let p = ref.replace(/^file:(\/\/[^/]*)?/i, "");
    // file:///C:/x arrives as /C:/x.
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return { type: "local", path: resolveFrom(baseDir, decodePath(stripQuery(p))) };
  }
  // data:, blob:, mailto:, javascript: and every other scheme stay as they are.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-zA-Z]:[\\/]/.test(ref)) return { type: "keep" };
  return { type: "local", path: resolveFrom(baseDir, decodePath(stripQuery(ref))) };
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

function extensionOf(p: string): string {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
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

class Packager {
  private readonly maxBytes: number;
  private total: number;
  private readonly included = new Set<string>();
  private readonly leftOut: PackagedPage["leftOut"] = [];
  private remote = 0;
  private removed = 0;
  private readonly cache = new Map<string, string>();
  private readonly pageDir: string;

  constructor(
    private readonly options: PackageOptions,
    sourceBytes: number,
  ) {
    this.maxBytes = options.maxBytes ?? SHARE_MAX_PAGE_BYTES;
    this.total = sourceBytes;
    this.pageDir = dirnameOf(options.sourcePath);
  }

  result(html: string): PackagedPage {
    return {
      html,
      bytes: byteLength(html),
      included: [...this.included],
      leftOut: this.leftOut,
      remote: this.remote,
      removed: this.removed,
    };
  }

  countRemote(): void {
    this.remote += 1;
  }

  countRemoved(): void {
    this.removed += 1;
  }

  private display(path: string): string {
    return relativePath(this.pageDir, path);
  }

  private leave(ref: string, reason: LeftOutReason): void {
    if (this.leftOut.length < 200) this.leftOut.push({ ref, reason });
  }

  // The file behind a local reference, if it may be embedded as `kinds`.
  private allowed(path: string, ref: string, kinds: readonly AssetKind[]): { mime: string; kind: AssetKind } | null {
    const root = this.options.allowedRoots.find((r) => isInsideDir(r, path));
    if (!root) {
      this.leave(ref, "outside");
      return null;
    }
    if (relativeTo(root, path).split("/").some((segment) => segment.startsWith("."))) {
      this.leave(ref, "hidden");
      return null;
    }
    const type = MIME_BY_EXT[extensionOf(path)];
    if (!type || !kinds.includes(type.kind)) {
      this.leave(ref, "type");
      return null;
    }
    return type;
  }

  private async readWithin(path: string, ref: string, growth: (size: number) => number): Promise<Uint8Array | null> {
    let size: number;
    try {
      size = await this.options.reader.size(path);
    } catch {
      this.leave(ref, "missing");
      return null;
    }
    if (this.total + growth(size) > this.maxBytes) {
      this.leave(ref, "too_large");
      return null;
    }
    try {
      return await this.options.reader.read(path);
    } catch {
      this.leave(ref, "missing");
      return null;
    }
  }

  /** A data: URI for a local binary asset, or null to leave the reference as it is. */
  async dataUri(raw: string, baseDir: string, kinds: readonly AssetKind[]): Promise<string | null> {
    const ref = classify(raw, baseDir);
    if (ref.type === "remote") this.countRemote();
    if (ref.type !== "local") return null;
    const type = this.allowed(ref.path, raw, kinds);
    if (!type) return null;
    const cached = this.cache.get(ref.path);
    if (cached !== undefined) {
      if (this.total + cached.length - raw.length > this.maxBytes) {
        this.leave(raw, "too_large");
        return null;
      }
      this.total += cached.length - raw.length;
      return cached;
    }
    // Base64 grows a file by a third, plus the data: prefix.
    const bytes = await this.readWithin(ref.path, raw, (size) => Math.ceil(size / 3) * 4 + 64 - raw.length);
    if (!bytes) return null;
    const uri = `data:${type.mime};base64,${bytesToBase64(bytes)}`;
    this.total += uri.length - raw.length;
    this.cache.set(ref.path, uri);
    this.included.add(this.display(ref.path));
    return uri;
  }

  /** The text of a local stylesheet or script, or null to leave the reference. */
  async text(raw: string, baseDir: string, kind: "css" | "script"): Promise<{ text: string; path: string } | null> {
    const ref = classify(raw, baseDir);
    if (ref.type === "remote") this.countRemote();
    if (ref.type !== "local") return null;
    if (!this.allowed(ref.path, raw, [kind])) return null;
    const bytes = await this.readWithin(ref.path, raw, (size) => size);
    if (!bytes) return null;
    this.total += bytes.length;
    this.included.add(this.display(ref.path));
    return { text: utf8Decoder.decode(bytes), path: ref.path };
  }

  async inlineCss(css: string, baseDir: string, depth = 0, seen = new Set<string>()): Promise<string> {
    let out = css;
    // @import first: each becomes the imported sheet's text, in place.
    const imports = [...out.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/gi)];
    for (const match of imports) {
      const [whole, , target, media] = match;
      if (!target) continue;
      const ref = classify(target, baseDir);
      if (ref.type === "remote") {
        this.countRemote();
        continue;
      }
      if (ref.type !== "local" || depth >= MAX_IMPORT_DEPTH || seen.has(ref.path)) continue;
      const sheet = await this.text(target, baseDir, "css");
      if (!sheet) continue;
      seen.add(sheet.path);
      let body = await this.inlineCss(sheet.text, dirnameOf(sheet.path), depth + 1, seen);
      const condition = (media ?? "").trim();
      if (condition) body = `@media ${condition} {\n${body}\n}`;
      out = out.replace(whole, body);
    }
    const urls = [...out.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
    for (const match of urls) {
      const [whole, , target] = match;
      if (!target) continue;
      const uri = await this.dataUri(target, baseDir, ["image", "font"]);
      if (uri) out = out.replace(whole, `url("${uri}")`);
    }
    return out;
  }

  async srcset(value: string, baseDir: string): Promise<string> {
    const parts: string[] = [];
    for (const candidate of value.split(/,\s+/)) {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      if (!url) continue;
      const uri = await this.dataUri(url, baseDir, ["image"]);
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
      const script = await p.text(src, dir, "script");
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
        const target = attr(el, "src") ?? attr(el, "data") ?? "";
        const kind = classify(target, dir).type;
        if (kind === "remote") p.countRemote();
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
    const sheet = await p.text(href, dir, "css");
    if (!sheet) return true;
    const style = defaultTreeAdapter.createElement("style", parse5Html.NS.HTML, []);
    const media = attr(el, "media");
    if (media) style.attrs.push({ name: "media", value: media });
    setText(style, escapeStyleText(await p.inlineCss(sheet.text, dirnameOf(sheet.path), 1, new Set([sheet.path]))));
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
  const kind = classify(href, dir).type;
  if (kind === "local") {
    p.countRemoved();
    return false;
  }
  if (kind === "remote") p.countRemote();
  return true;
}

export async function packageHtmlPage(source: string, options: PackageOptions): Promise<PackagedPage> {
  const packager = new Packager(options, byteLength(source));
  const doc = parse(source);
  await visit(doc, packager);
  return packager.result(serialize(doc));
}
