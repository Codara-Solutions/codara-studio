// Keeping the extension the user loaded current with this Codara. Chrome
// loads it unpacked from a copy in Codara's home, so an update is two steps:
// the copy is refreshed whenever its files differ from the ones Codara ships
// (not only when the version changes), and a connected extension older than
// the copy is asked over its sealed session to reload itself. An extension
// too old to know "reload" is shown in Settings with what the user does.
//
// Nothing here touches a file outside the two folders it is given.

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/**
 * What to do about a connected extension: nothing (current, or the version
 * Codara ships is unknown), ask it to reload, or tell the user, when it
 * cannot reload itself or a reload Codara already asked for did not bring the
 * new version.
 */
export function extensionUpdateAction(
  running: string,
  features: readonly string[],
  shipped: string | null,
  alreadyAsked: boolean,
): "none" | "reload" | "manual" {
  if (!shipped || !running || compareExtensionVersions(running, shipped) >= 0) return "none";
  if (!features.includes("reload") || alreadyAsked) return "manual";
  return "reload";
}
