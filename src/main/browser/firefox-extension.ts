// The Codara extension for Firefox, as the user loads it: assembled
// (extensions/firefox/build/assemble.mjs: Firefox's own files plus the Chrome
// files they share) into <codara home>/firefox-extension/<version>/. Each
// version gets its own folder, written once and never rewritten, so the
// add-on Firefox loaded from it never changes under it: a newer Codara
// assembles the newer version beside it, and the user loads that one when
// they choose to.

import { app } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
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

const VERSION = /^\d+(\.\d+){0,3}$/;
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
    return typeof version === "string" && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** The folder Firefox's Load Temporary Add-on is pointed at (its manifest.json) for this Codara's version, or null when it ships none. */
export function firefoxExtensionFolder(): string | null {
  const version = shippedFirefoxVersion();
  return version ? join(codaraHome(), "firefox-extension", version) : null;
}

/** Whether `dir` is a whole folder Codara assembled for `version` (its marker, that version, the files it runs). */
function wholeFolder(dir: string, version: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return manifest.version === version && WHOLE_FILES.every((name) => existsSync(join(dir, name)));
  } catch {
    return false;
  }
}
// The assembly's marker (build/assemble.mjs ASSEMBLY_MARKER) and what Firefox runs first.
const WHOLE_FILES = [".codara-firefox-assembly", "manifest.json", "background.js", "popup.html", "popup.js"];

const inTheWay = (dir: string) =>
  new Error(`${dir} is already there and is not a whole copy of Codara's extension for Firefox: move it away, then try again.`);

/**
 * Assembles this version's folder the first time; an existing one is left
 * exactly as it is and nothing in it is ever deleted. Assembled in a staging
 * folder of its own beside it and renamed into place in one step, so a
 * folder Codara made is always whole: if another Codara got there first,
 * its folder is used; if anything else is in the way, the user is told. The
 * folder is named after the version the staged files carry, so sources that
 * changed since this Codara started never land under an older version.
 */
export async function prepareFirefoxExtensionFolder(): Promise<string> {
  const sources = firefoxSources();
  const shown = firefoxExtensionFolder();
  const version = shippedFirefoxVersion();
  if (!sources || !shown || !version) throw new Error("This Codara build does not include the extension for Firefox.");
  if (wholeFolder(shown, version)) return shown;
  if (existsSync(shown)) {
    // An empty folder holds nothing to lose (rmdir removes only an empty one); anything else is the user's.
    if (readdirSync(shown).length) throw inTheWay(shown);
    rmdirSync(shown);
  }
  const parent = dirname(shown);
  mkdirSync(parent, { recursive: true });
  const { assemble } = (await import(/* @vite-ignore */ pathToFileURL(join(sources.firefoxDir, "build", "assemble.mjs")).href)) as {
    assemble: (out: string, options: { firefoxDir: string; chromeDir: string }) => { dir: string };
  };
  // A new, empty folder only this call uses: nothing already there is ever removed.
  const staging = mkdtempSync(join(parent, ".staging-"));
  try {
    assemble(staging, sources);
    const staged = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")).version;
    if (typeof staged !== "string" || !VERSION.test(staged)) throw new Error("The extension for Firefox in this Codara has no plain version.");
    const target = join(parent, staged);
    try {
      // Fails on a folder that is there and not empty: it is never replaced.
      renameSync(staging, target);
    } catch {
      if (wholeFolder(target, staged)) return target;
      throw inTheWay(target);
    }
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
