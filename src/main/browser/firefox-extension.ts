// The Codara extension for Firefox, as the user loads it: assembled
// (extensions/firefox/build/assemble.mjs: Firefox's own files plus the Chrome
// files they share) into <codara home>/firefox-extension/<version>/. Each
// version gets its own folder, written once and never rewritten, so the
// add-on Firefox loaded from it never changes under it: a newer Codara
// assembles the newer version beside it, and the user loads that one when
// they choose to.

import { app } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
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

type AssembleModule = {
  assemble: (out: string, options: { firefoxDir: string; chromeDir: string }) => { dir: string };
  payloadDigest: (entries: { name: string; data: Buffer }[]) => string;
  recordedVersions: (dir: string) => Record<string, string>;
  ASSEMBLY_MARKER: string;
};

/** Every file under `dir` but the assembly's marker, relative, sorted as the assembly sorts them. */
function folderEntries(dir: string, marker: string): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(folder, entry.name), name);
      else if (name !== marker) out.push({ name, data: readFileSync(join(folder, entry.name)) });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether `dir` is a whole folder Codara assembled: its marker, and every one of `names` there as a file, with this version. */
function wholeFolder(dir: string, version: string, names: string[], marker: string): boolean {
  try {
    if (!statSync(join(dir, marker)).isFile() || !names.every((name) => statSync(join(dir, name)).isFile())) return false;
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version === version;
  } catch {
    return false;
  }
}

const inTheWay = (dir: string) =>
  new Error(`${dir} is already there and is not a whole copy of Codara's extension for Firefox: move it away, then try again.`);

/**
 * Assembles this version's folder the first time; an existing one is left
 * exactly as it is and nothing in it is ever deleted. Assembled in a staging
 * folder of its own beside it, checked against the files recorded for its
 * version (versions.json), and renamed into place in one step, so a folder
 * Codara made is always whole and holds that version's files: if another
 * Codara got there first, its folder is used; if anything else is in the
 * way, the user is told. The folder is named after the version the staged
 * files carry, so sources that changed since this Codara started never land
 * under an older version.
 */
export async function prepareFirefoxExtensionFolder(): Promise<string> {
  const sources = firefoxSources();
  const shown = firefoxExtensionFolder();
  if (!sources || !shown) throw new Error("This Codara build does not include the extension for Firefox.");
  const parent = dirname(shown);
  mkdirSync(parent, { recursive: true });
  const build = (await import(/* @vite-ignore */ pathToFileURL(join(sources.firefoxDir, "build", "assemble.mjs")).href)) as AssembleModule;
  // A new, empty folder only this call uses: nothing already there is ever removed.
  const staging = mkdtempSync(join(parent, ".staging-"));
  try {
    build.assemble(staging, sources);
    const entries = folderEntries(staging, build.ASSEMBLY_MARKER);
    const version = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")).version;
    if (typeof version !== "string" || !VERSION.test(version)) throw new Error("The extension for Firefox in this Codara has no plain version.");
    if (build.recordedVersions(sources.firefoxDir)[version] !== build.payloadDigest(entries)) {
      throw new Error(`The extension files for Firefox in this Codara are not the ones recorded for version ${version}, so they are not handed out under it.`);
    }
    const names = entries.map((entry) => entry.name);
    const target = join(parent, version);
    if (wholeFolder(target, version, names, build.ASSEMBLY_MARKER)) return target;
    if (existsSync(target)) {
      // An empty folder holds nothing to lose (rmdir removes only an empty one); anything else is the user's.
      if (readdirSync(target).length) throw inTheWay(target);
      rmdirSync(target);
    }
    try {
      // Fails on a folder that is there and not empty: it is never replaced.
      renameSync(staging, target);
    } catch {
      if (wholeFolder(target, version, names, build.ASSEMBLY_MARKER)) return target;
      throw inTheWay(target);
    }
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
