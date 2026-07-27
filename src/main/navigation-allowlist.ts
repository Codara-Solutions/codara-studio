// Navigation allowlist for the privileged main window.
//
// The main window's webContents runs the preload that exposes the full
// window.spark IPC surface. If attacker-controlled content ever becomes the
// document of that webContents, the preload re-runs and re-exposes every
// privileged channel to that content. So navigation of the main window's own
// frames must be restricted to exactly two things:
//
//   1. The dev renderer origin. In `npm run dev` the renderer is served by the
//      Vite dev server and loaded via process.env.ELECTRON_RENDERER_URL. Only
//      an http origin whose hostname is exactly "localhost" or "127.0.0.1" and
//      whose port matches that dev server URL is allowed. This is parsed with
//      `new URL`, never with startsWith, so "http://localhost.attacker.example/"
//      (a different hostname) and "http://localhost:9999/" (a different port)
//      are both rejected.
//
//   2. The packaged renderer entry file. Production builds load the renderer
//      via loadFile(index.html). Only that exact file, matched by resolved
//      filesystem path equality (not prefix), is allowed. Any other file:// URL,
//      including one whose path traverses out of the renderer directory, is
//      rejected.
//
// Everything else (a remote http(s) origin, an arbitrary local file, a
// javascript: or data: URL) is rejected. The caller hands rejected URLs to the
// in-app browser instead of navigating the privileged window to them.
//
// This module deliberately imports nothing from electron so the predicate can
// be unit-tested without booting Electron.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NavigationAllowlistConfig {
  // The exact dev server URL (process.env.ELECTRON_RENDERER_URL) when running
  // the Vite dev renderer, otherwise null. When null, no http origin is
  // allowed at all (packaged builds never navigate to http).
  devServerUrl: string | null;
  // Absolute path to the packaged renderer entry (index.html) that loadFile
  // targets. Compared by resolved-path equality, never by prefix.
  rendererEntryPath: string;
}

// Loopback hostnames the dev server is allowed to bind. Anything else (a real
// remote host, a "localhost.attacker.example" lookalike) is not loopback and is
// rejected regardless of how the string is spelled.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

// Resolve `..` segments and follow symlinks where the target exists. When the
// path does not exist on disk (e.g. inside a unit test with a synthetic entry
// path) realpathSync throws, so fall back to the lexically resolved path. Both
// sides of every comparison go through this, so the fallback is symmetric.
function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// Exported so callers that need the same resolved-path equality (e.g. the
// webview preload guard) do not reimplement the canonicalization.
export function isSameResolvedPath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return canonicalPath(a) === canonicalPath(b);
}

// Derive the runtime allowlist config from the same source of truth the window
// loader uses: the dev server URL is honored only in an unpackaged build, and
// the renderer entry path is the file loadFile() targets.
export function resolveMainWindowAllowlistConfig(params: {
  isPackaged: boolean;
  rendererDevUrl: string | undefined;
  rendererEntryPath: string;
}): NavigationAllowlistConfig {
  return {
    devServerUrl:
      !params.isPackaged && params.rendererDevUrl ? params.rendererDevUrl : null,
    rendererEntryPath: params.rendererEntryPath,
  };
}

// The single predicate. Returns true only for the dev renderer origin or the
// packaged renderer entry file; everything else is false.
export function isAllowedMainWindowUrl(
  rawUrl: string,
  config: NavigationAllowlistConfig,
): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a parseable absolute URL (relative, malformed) -> never allowed.
    return false;
  }

  if (url.protocol === "http:") {
    // http is only ever legitimate for the local dev server. https, ws, etc.
    // are never allowed for the privileged window, so "https://localhost/" is
    // rejected here by falling through.
    if (!config.devServerUrl) return false;
    let dev: URL;
    try {
      dev = new URL(config.devServerUrl);
    } catch {
      return false;
    }
    if (dev.protocol !== "http:") return false;
    // The dev server itself must be loopback, and the navigation target must be
    // the same loopback hostname AND the same port. Hostname is compared for
    // exact equality after the loopback membership check, so a lookalike host
    // like "localhost.attacker.example" (parsed hostname is the full string) is
    // rejected because it is not in the loopback set.
    if (!LOOPBACK_HOSTNAMES.has(dev.hostname)) return false;
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
    if (url.hostname !== dev.hostname) return false;
    if (url.port !== dev.port) return false;
    return true;
  }

  if (url.protocol === "file:") {
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return false;
    }
    // Resolved-path equality against the known renderer entry. `new URL`
    // already normalizes `..` segments, and canonicalPath resolves+realpaths
    // both sides, so a traversal like renderer/../../evil.html can never
    // resolve back to the entry file.
    return isSameResolvedPath(filePath, config.rendererEntryPath);
  }

  // http(s) to a remote origin, javascript:, data:, blob:, about:, and every
  // other scheme are rejected.
  return false;
}
