// Puts the Firefox extension together in one folder Firefox can load:
//
//   node extensions/firefox/build/assemble.mjs [--out <dir>]
//
// The popup, the options page, the icons and the link, policy and presence
// code are the Chrome extension's own files (shared.json lists them), read
// from extensions/chrome and never written there, so the Chrome extension
// ships exactly what it did. A shared file that needs other words in Firefox
// gets a text patch; a patch whose text is no longer in the Chrome file
// stops the build instead of shipping the Chrome wording. Everything else
// (manifest.json, background.js, lib/firefox.js) lives here.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FIREFOX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHROME_DIR = resolve(FIREFOX_DIR, "..", "chrome");
// Files of this folder that are not part of the extension Firefox loads.
export const DEV_FILES = Object.freeze(["build", "test", "dist", "package.json", "README.md", "LISTING.txt", "shared.json", ".gitignore"]);

export function sharedSpec(dir = FIREFOX_DIR) {
  return JSON.parse(readFileSync(join(dir, "shared.json"), "utf8"));
}

/** This folder's own extension files, relative to it, in a stable order. */
export function ownFiles(dir = FIREFOX_DIR) {
  const out = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const rel = relative(dir, full).split(sep).join("/");
      if (DEV_FILES.includes(rel) || name.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

function patched(name, data, patches) {
  if (!patches?.length) return data;
  let text = data.toString("utf8");
  for (const { find, replace } of patches) {
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) {
      throw new Error(`The Firefox patch for ${name} expects its text exactly once in extensions/chrome/${name}: ${JSON.stringify(find.slice(0, 60))}`);
    }
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  }
  return Buffer.from(text, "utf8");
}

/** Every file of the Firefox extension with its bytes, sorted by name. */
export function assembledEntries({ firefoxDir = FIREFOX_DIR, chromeDir = CHROME_DIR } = {}) {
  const spec = sharedSpec(firefoxDir);
  const own = ownFiles(firefoxDir);
  const entries = new Map();
  for (const name of own) entries.set(name, readFileSync(join(firefoxDir, name)));
  for (const name of spec.files) {
    if (entries.has(name)) throw new Error(`${name} is both shared from Chrome and Firefox's own: keep one.`);
    entries.set(name, patched(name, readFileSync(join(chromeDir, name)), spec.patches?.[name]));
  }
  for (const name of Object.keys(spec.patches ?? {})) {
    if (!spec.files.includes(name)) throw new Error(`shared.json patches ${name}, which it does not share.`);
  }
  return [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, data]) => ({ name, data }));
}

/** Written into every assembly; only a folder holding it is ever replaced. */
export const ASSEMBLY_MARKER = ".codara-firefox-assembly";

/** The real path of a folder that may not exist yet (its nearest existing parent, resolved). */
function realFolder(folder) {
  const missing = [];
  let at = resolve(folder);
  while (!existsSync(at)) {
    missing.unshift(at.slice(dirname(at).length + 1));
    if (dirname(at) === at) break;
    at = dirname(at);
  }
  return join(realpathSync(at), ...missing);
}

const within = (folder, root) => folder === root || folder.startsWith(root + sep);

/** Write the assembled extension to `out`, replacing an earlier assembly there. */
export function assemble(out = join(FIREFOX_DIR, "dist", "extension"), options = {}) {
  const firefoxDir = realFolder(options.firefoxDir ?? FIREFOX_DIR);
  const chromeDir = realFolder(options.chromeDir ?? CHROME_DIR);
  const target = realFolder(out);
  // Never into or over either source folder; inside this one only under dist/.
  for (const source of [firefoxDir, chromeDir]) {
    if (within(source, target)) throw new Error(`${out} holds the extension's sources; pick another folder.`);
  }
  if (within(target, chromeDir) || (within(target, firefoxDir) && !within(target, join(firefoxDir, "dist")))) {
    throw new Error(`${out} is inside the extension's sources; pick a folder outside them (or under extensions/firefox/dist).`);
  }
  const entries = assembledEntries(options);
  // Only an earlier assembly is replaced: a folder given by mistake is never emptied.
  let existing = [];
  try {
    existing = readdirSync(target);
  } catch {
    existing = [];
  }
  if (existing.length && !existing.includes(ASSEMBLY_MARKER)) throw new Error(`${out} is not an assembled extension; pick an empty folder.`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, ASSEMBLY_MARKER), "Written by extensions/firefox/build/assemble.mjs; the next assembly replaces this folder.\n");
  for (const { name, data } of entries) {
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  return { dir: out, files: entries.map((entry) => entry.name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf("--out");
  try {
    const result = assemble(outFlag > 0 ? resolve(process.argv[outFlag + 1]) : undefined);
    console.log(`Assembled ${result.files.length} files into ${result.dir}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
