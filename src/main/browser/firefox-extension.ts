// The Codara extension for Firefox, as the user loads it: assembled
// (extensions/firefox/build/assemble.mjs: Firefox's own files plus the Chrome
// files they share) into <codara home>/firefox-extension/<version>/. Each
// version gets its own folder, written once and never rewritten, so the
// add-on Firefox loaded from it never changes under it: a newer Codara
// assembles the newer version beside it, and the user loads that one when
// they choose to.

import { app } from "electron";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { codaraHome } from "../codara-home";

/** Where the extension's sources are: extensions/ in a checkout, the app's resources when packaged. */
export function firefoxSources(): { firefoxDir: string; chromeDir: string } | null {
  if (app.isPackaged) {
    const firefoxDir = join(process.resourcesPath, "firefox-extension-source");
    const chromeDir = join(process.resourcesPath, "chrome-extension");
    return existsSync(join(firefoxDir, "manifest.json")) ? { firefoxDir, chromeDir } : null;
  }
  let current = app.getAppPath();
  for (let depth = 0; depth <= 4; depth += 1) {
    const firefoxDir = join(current, "extensions", "firefox");
    if (existsSync(join(firefoxDir, "manifest.json"))) return { firefoxDir, chromeDir: join(current, "extensions", "chrome") };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

let shippedVersion: string | null | undefined;

/** The version of the add-on this Codara ships, or null when it ships none; read once. */
export function shippedFirefoxVersion(): string | null {
  if (shippedVersion === undefined) shippedVersion = readShippedVersion();
  return shippedVersion;
}

function readShippedVersion(): string | null {
  const sources = firefoxSources();
  if (!sources) return null;
  try {
    const version = JSON.parse(readFileSync(join(sources.firefoxDir, "manifest.json"), "utf8")).version;
    return typeof version === "string" && /^\d+(\.\d+){0,3}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** The folder Firefox's Load Temporary Add-on is pointed at (its manifest.json) for this Codara's version, or null when it ships none. */
export function firefoxExtensionFolder(): string | null {
  const version = shippedFirefoxVersion();
  return version ? join(codaraHome(), "firefox-extension", version) : null;
}

/**
 * Assembles this version's folder the first time; an existing one is left
 * exactly as it is and nothing in it is ever deleted. Written beside it
 * first and renamed into place in one step, so a folder Codara made is
 * always whole: if another Codara got there first, its folder is used; if
 * something else is in the way, the user is told.
 */
export async function prepareFirefoxExtensionFolder(): Promise<string> {
  const sources = firefoxSources();
  const target = firefoxExtensionFolder();
  if (!sources || !target) throw new Error("This Codara build does not include the extension for Firefox.");
  if (existsSync(join(target, "manifest.json"))) return target;
  const staging = `${target}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  const { assemble } = (await import(/* @vite-ignore */ pathToFileURL(join(sources.firefoxDir, "build", "assemble.mjs")).href)) as {
    assemble: (out: string, options: { firefoxDir: string; chromeDir: string }) => { dir: string };
  };
  try {
    assemble(staging, sources);
    try {
      // Fails on a folder that is there and not empty: it is never replaced.
      renameSync(staging, target);
    } catch (error) {
      if (existsSync(join(target, "manifest.json"))) return target;
      throw new Error(`${target} is already there and is not Codara's extension for Firefox: move it away, then try again. (${error instanceof Error ? error.message : String(error)})`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
