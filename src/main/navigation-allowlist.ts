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
//      an http origin that matches that configured dev server URL by exact
//      protocol + hostname + port is allowed. The dev URL is the developer's
//      own configuration and only exists in unpackaged builds, so we trust the
//      host it names, whatever it is: `vite --host` (0.0.0.0), a dev server on
//      [::1], or a LAN IP all boot with their own origin allowed. localhost and
//      127.0.0.1 are additionally treated as interchangeable aliases of each
//      other. This is parsed with `new URL`, never with startsWith, so
//      "http://localhost.attacker.example/" (a different hostname) and
//      "http://localhost:9999/" (a different port) are both rejected.
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

// localhost and 127.0.0.1 name the same loopback interface, so a dev server
// configured on one is reachable via the other. When BOTH the configured dev
// host and the navigation target are in this set they are treated as equal.
// A "localhost.attacker.example" lookalike is not in this set (its parsed
// hostname is the full string), so it never aliases into the dev origin.
const LOOPBACK_ALIASES = new Set(["localhost", "127.0.0.1"]);

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
    // http is only ever legitimate for the local dev server, whose exact origin
    // the developer configured via ELECTRON_RENDERER_URL (present only in
    // unpackaged builds). https, ws, etc. are never allowed for the privileged
    // window, so "https://localhost/" is rejected here by falling through.
    if (!config.devServerUrl) return false;
    let dev: URL;
    try {
      dev = new URL(config.devServerUrl);
    } catch {
      return false;
    }
    if (dev.protocol !== "http:") return false;
    // Same port is always required. "http://localhost:9999/" against a dev
    // server on :5173 is rejected here.
    if (url.port !== dev.port) return false;
    // Trust the configured dev origin for whatever host it names. Exact hostname
    // equality against the developer's own config is the rule (not membership in
    // a fixed loopback set), so `vite --host` (0.0.0.0), [::1], and LAN-IP dev
    // servers all allow their own origin.
    if (url.hostname === dev.hostname) return true;
    // Additionally treat localhost and 127.0.0.1 as interchangeable, since they
    // resolve to the same loopback and the dev server answers on both.
    // "localhost.attacker.example" is not in this set (and its port would not
    // match anyway), so it is still rejected.
    if (LOOPBACK_ALIASES.has(url.hostname) && LOOPBACK_ALIASES.has(dev.hostname)) {
      return true;
    }
    return false;
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
    //
    // KNOWN, EXOTIC LIMITATION: Electron's loadFile() formats the file: URL with
    // the legacy url.format(), which does NOT percent-escape a literal "%" in
    // the install path. fileURLToPath then decodes any "%NN" sequence, so an
    // install directory containing a literal "%" (e.g. ".../codara%20studio/")
    // can round-trip to a different path and fail this equality. The only
    // consequence is the app's own renderer entry failing the allowlist on such
    // a path (a fail-closed self-DoS for that one install, never a bypass). This
    // is rare enough that it is documented rather than special-cased; if it ever
    // matters, install to a "%"-free path.
    return isSameResolvedPath(filePath, config.rendererEntryPath);
  }

  // http(s) to a remote origin, javascript:, data:, blob:, about:, and every
  // other scheme are rejected.
  return false;
}
