// The Content-Security-Policy of Codara's own window, applied as a <meta> in
// src/renderer/index.html by studioCspPlugin (electron.vite.config.ts).
//
// It has to be a <meta>: the packaged app loads index.html from file://,
// where no response header can carry it. A <meta> policy only governs what
// the parser reaches after it, so the plugin moves it to the top of <head>
// and allows each inline script by hash. In development Vite prepends its
// client and the React refresh preamble (an inline module script); without
// that, the preamble would run unchecked before the policy, and putting the
// policy first without its hash would break hot reload.

import { createHash } from "node:crypto";

const DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'self'"],
  ["script-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["font-src", "'self' data:"],
  ["img-src", "'self' data: blob: file:"],
  ["media-src", "'self' blob: file:"],
  // The dev server's HMR socket, and local servers the renderer probes.
  ["connect-src", "'self' ws://localhost:* http://localhost:*"],
  ["worker-src", "'self' blob:"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
];

export function studioCsp(scriptHashes: readonly string[] = []): string {
  return DIRECTIVES.map(([name, value]) => {
    const extra = name === "script-src" ? scriptHashes.map((hash) => ` '${hash}'`).join("") : "";
    return `${name} ${value}${extra}`;
  }).join("; ");
}

export function scriptHash(source: string): string {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

const CSP_META = /\s*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi;
// Inline scripts only: one with a src attribute is covered by 'self'.
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Rewrite a page's HTML so its policy is the first thing in <head> and lets
 * exactly the inline scripts the page carries run. Any policy already in the
 * page is replaced.
 */
export function applyStudioCsp(html: string): string {
  const withoutMeta = html.replace(CSP_META, "");
  const hashes: string[] = [];
  for (const match of withoutMeta.matchAll(INLINE_SCRIPT)) {
    const hash = scriptHash(match[1]);
    if (!hashes.includes(hash)) hashes.push(hash);
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${studioCsp(hashes)}" />`;
  const head = /<head\b[^>]*>/i.exec(withoutMeta);
  if (!head) throw new Error("index.html has no <head> to carry the Content-Security-Policy");
  const at = head.index + head[0].length;
  return `${withoutMeta.slice(0, at)}\n    ${meta}${withoutMeta.slice(at)}`;
}
