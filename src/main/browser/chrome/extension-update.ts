// Keeping the extension the user loaded current with this Codara, only when
// the user asks. Chrome loads it unpacked from a copy in Codara's home: the
// copy is made once when the user first reveals the folder, and refreshed
// only when the user presses Update extension in Settings > Browser for a
// browser running an older version. Only then is that browser's extension
// asked, over its sealed session, to reload itself. Starting Codara or a
// browser connecting changes nothing. An extension Chrome did not load from
// that folder (the Chrome Web Store, or a folder of the user's own) is left
// alone: Chrome updates a store install by itself.
//
// Nothing here touches a file outside the two folders it is given.

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** What the store zip leaves out (extensions/chrome/build/pack.mjs DEV_FILES); the copy leaves out the same. */
export const EXTENSION_DEV_FILES = new Set(["build", "test", "dist", "package.json", ".gitignore", "README.md", "STORE.md"]);

function isDevFile(rel: string): boolean {
  return EXTENSION_DEV_FILES.has(rel.split(/[\\/]/)[0] ?? "");
}

function listFiles(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(base, path).split(sep).join("/");
    if (isDevFile(rel)) continue;
    if (entry.isDirectory()) files.push(...listFiles(path, base));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** One hash over the extension's file names and contents, development files left out. Null when the folder cannot be read. */
export function extensionContentHash(dir: string): string | null {
  try {
    const hash = createHash("sha256");
    for (const rel of listFiles(dir).sort()) {
      hash.update(`${rel}\0`);
      hash.update(readFileSync(join(dir, rel)));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export function extensionManifestVersion(dir: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Copy `source` over `target` when forced, missing or different. True when it copied. */
export function syncExtensionFolder(source: string, target: string, force = false): boolean {
  if (!force && existsSync(target) && extensionContentHash(target) === extensionContentHash(source)) return false;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !isDevFile(path.slice(source.length).replace(/^[\\/]+/, "")),
  });
  return true;
}

/** The first copy, for a first install: only when `target` holds no readable extension. True when it copied. */
export function ensureExtensionFolder(source: string, target: string): boolean {
  if (extensionManifestVersion(target)) return false;
  return syncExtensionFolder(source, target, true);
}

/**
 * The id Chrome gives an extension loaded unpacked from `folder` without a
 * "key" in its manifest: the first 16 bytes of the SHA-256 of the folder's
 * path, in hex written with the letters a to p
 * (components/crx_file/id_util.cc GenerateIdForPath). The path is the one
 * Chrome stored: on Windows its UTF-16 code units with the drive letter in
 * upper case, elsewhere its UTF-8 bytes.
 */
export function unpackedExtensionId(folder: string, platform: NodeJS.Platform = process.platform): string {
  let bytes: Buffer;
  if (platform === "win32") {
    const path = /^[a-z]:/.test(folder) ? folder[0]!.toUpperCase() + folder.slice(1) : folder;
    bytes = Buffer.from(path, "utf16le");
  } else {
    bytes = Buffer.from(folder, "utf8");
  }
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/**
 * The ids an unpacked load of one of `folders` can have. Chrome resolves
 * symbolic links on macOS and Linux before it stores the path, so the
 * resolved path counts as well as the one given.
 */
export function unpackedExtensionIds(folders: readonly string[], platform: NodeJS.Platform = process.platform): Set<string> {
  const ids = new Set<string>();
  for (const folder of folders) {
    ids.add(unpackedExtensionId(folder, platform));
    try {
      ids.add(unpackedExtensionId(realpathSync.native(folder), platform));
    } catch {
      // A folder that does not exist yet has only the path given.
    }
  }
  return ids;
}

/** -1, 0 or 1 for two dotted versions; extensions/chrome/lib/policy.js compareVersions does the same. */
export function compareExtensionVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** A consent the user gave in Settings for one browser: the version Update brought and when. */
export interface ExtensionUpdateAsk {
  version: string;
  at: number;
}

/**
 * What Settings shows for a connected extension older than the one Codara
 * ships, or null when there is nothing to update (current, newer, or the
 * version shipped is unknown):
 * - "available": loaded from Codara's folder, and the user has not pressed
 *   Update extension for this version: the button.
 * - "updating": the user pressed it and the extension was asked to reload,
 *   for at most `graceMs`.
 * - "manual": the user pressed it, the folder holds the new version, and the
 *   extension did not come back with it (or cannot reload itself): the user
 *   presses reload in the browser's extensions page.
 * - "elsewhere": Chrome did not load it from Codara's folder (the Chrome Web
 *   Store, or a folder of the user's own): Codara never touches it.
 */
export function extensionUpdateState(options: {
  running: string;
  features: readonly string[];
  shipped: string | null;
  fromCodaraFolder: boolean;
  asked: ExtensionUpdateAsk | undefined;
  now: number;
  graceMs: number;
}): "available" | "updating" | "manual" | "elsewhere" | null {
  const { running, features, shipped, fromCodaraFolder, asked, now, graceMs } = options;
  if (!shipped || !running || compareExtensionVersions(running, shipped) >= 0) return null;
  if (!fromCodaraFolder) return "elsewhere";
  if (asked?.version !== shipped) return "available";
  return features.includes("reload") && now - asked.at < graceMs ? "updating" : "manual";
}
