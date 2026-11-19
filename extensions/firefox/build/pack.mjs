// Checks the Firefox extension and packs it for addons.mozilla.org:
//
//   node extensions/firefox/build/pack.mjs [--out <dir>]
//
// It only builds the upload; submitting stays a manual step in Mozilla's
// Developer Hub (see ../LISTING.txt). The zip holds exactly what the
// assembled folder holds (build/assemble.mjs: this folder's own files and the
// Chrome files shared.json names, patched), stored with fixed timestamps so
// the same sources give the same bytes. Every file is plain JavaScript, HTML
// and CSS as written: nothing is bundled or minified. The assembly does patch
// a few lines of the shared popup (shared.json), which Mozilla counts as
// preprocessing, so the source archive codara-firefox-<version>-source.zip is
// written beside the upload: the two source folders and this script, from
// which the reviewer rebuilds the very same zip.

import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zip } from "../../chrome/build/pack.mjs";
import { assembledEntries, CHROME_DIR, FIREFOX_DIR, ownFiles, payloadDigest, recordedVersions, sharedSpec } from "./assemble.mjs";

export const ADDON_ID = "@codara-firefox";

// The data Mozilla's consent screen names (extensionworkshop.com, Firefox built-in data consent).
export const DATA_CATEGORIES = Object.freeze([
  "personallyIdentifyingInfo", "healthInfo", "financialAndPaymentInfo", "authenticationInfo", "personalCommunications",
  "locationInfo", "browsingActivity", "websiteContent", "websiteActivity", "searchTerms", "bookmarksInfo", "technicalAndInteraction",
]);
// Each part a whole number without leading zeros, at most 9 digits, at most four parts (Mozilla's version format).
const PLAIN_VERSION = /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/;

/** Problems with the declared data collection: known categories in arrays, "none" alone, technical data only optional. */
function dataCollectionProblems(declared) {
  if (!declared || typeof declared !== "object") return ["data_collection_permissions must declare what the add-on collects"];
  const problems = [];
  const { required, optional } = declared;
  if (!Array.isArray(required) || !required.length) problems.push("data_collection_permissions.required must be a list (\"none\" when nothing is collected)");
  if (optional !== undefined && !Array.isArray(optional)) problems.push("data_collection_permissions.optional must be a list");
  const lists = [["required", Array.isArray(required) ? required : []], ["optional", Array.isArray(optional) ? optional : []]];
  for (const [list, names] of lists) {
    for (const name of names) {
      if (name === "none" && list === "required") continue;
      if (!DATA_CATEGORIES.includes(name)) problems.push(`data_collection_permissions.${list} names "${name}", which is not one of Mozilla's categories`);
    }
  }
  if (Array.isArray(required) && required.includes("none") && required.length > 1) problems.push('data_collection_permissions.required: "none" stands alone');
  if (Array.isArray(required) && required.includes("technicalAndInteraction")) problems.push("technicalAndInteraction can only be optional");
  return problems;
}

const text = (entries, name) => entries.find((entry) => entry.name === name)?.data.toString("utf8") ?? null;

/** Problems that would make Firefox or addons.mozilla.org refuse the add-on, given its assembled files. */
export function checkAddon(entries) {
  const problems = [];
  const names = new Set(entries.map((entry) => entry.name));
  let manifest = {};
  try {
    manifest = JSON.parse(text(entries, "manifest.json") ?? "");
  } catch {
    return { manifest, problems: ["manifest.json is missing or not JSON"] };
  }
  const gecko = manifest.browser_specific_settings?.gecko ?? {};
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  for (const field of ["name", "description"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) problems.push(`${field} is missing`);
  }
  if (!PLAIN_VERSION.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" is not a plain dotted version`);
  if (gecko.id !== ADDON_ID) problems.push(`the add-on id must stay ${ADDON_ID}: Mozilla ties the listing, and every update, to it`);
  if (!gecko.strict_min_version) problems.push("strict_min_version is missing");
  problems.push(...dataCollectionProblems(gecko.data_collection_permissions));
  if ((manifest.description ?? "").length > 132) problems.push("description is longer than 132 characters");
  if (manifest.host_permissions?.length) problems.push("no site access at install: sites are asked for from the popup");
  const referenced = [
    ...(manifest.background?.scripts ?? []),
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
  for (const file of referenced) if (!names.has(file)) problems.push(`manifest names ${file}, which is missing`);
  for (const { name, data } of entries) {
    if (name.endsWith(".js")) {
      const source = data.toString("utf8");
      for (const match of source.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)) {
        const target = join(dirname(name), match[1]).split("\\").join("/");
        if (!names.has(target)) problems.push(`${name} imports ${match[1]}, which is missing`);
      }
      // Mozilla's review reads every line: a minified file needs its source uploaded too.
      if (source.split("\n").some((line) => line.length > 1000)) problems.push(`${name} has a line over 1000 characters: it looks minified, which needs a source upload`);
    }
    if (name.endsWith(".html")) {
      for (const match of data.toString("utf8").matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
        if (/^[a-z]+:/i.test(match[1])) problems.push(`${name} loads ${match[1]}: an add-on may run only its own files`);
        else if (!names.has(join(dirname(name), match[1]).split("\\").join("/"))) problems.push(`${name} loads ${match[1]}, which is missing`);
      }
    }
  }
  return { manifest, problems };
}

const SOURCE_README = (version) => `Codara for Firefox ${version}: source of the uploaded zip

The upload is assembled from two folders of the public codara-studio
repository, both here as they are: extensions/firefox (this add-on) and the
files of extensions/chrome it shares (named in extensions/firefox/shared.json,
with the line patches listed there). Nothing is bundled, minified or
transpiled. To rebuild the upload (Node.js 20 or later, no npm install):

  node extensions/firefox/build/pack.mjs --out out

out/codara-firefox-${version}.zip is then byte for byte the uploaded file
(compare its sha256).
`;

// What the build reads besides the add-on's own files: nothing else of either folder goes in the source archive.
const FIREFOX_BUILD_FILES = ["build/assemble.mjs", "build/pack.mjs", "shared.json", "versions.json"];
const CHROME_BUILD_FILES = ["build/pack.mjs"];

/**
 * A source file's bytes. It must be a plain file reached without a link in
 * any part of its path below its folder, so the archive holds only the
 * folders' own files.
 */
function sourceFile(root, name) {
  const path = join(root, name);
  const notPlain = () => new Error(`${path} is not a plain file of its folder: the source archive takes only the files the build reads, never through a link.`);
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw notPlain();
  }
  if (real !== join(realpathSync(root), name) || !lstatSync(path).isFile()) throw notPlain();
  return readFileSync(path);
}

/** The files the assembly and this script read, as they are, each read once. */
function sourceFiles({ firefoxDir = FIREFOX_DIR, chromeDir = CHROME_DIR } = {}) {
  return [
    ...[...ownFiles(firefoxDir), ...FIREFOX_BUILD_FILES].map((name) => ({ name: `extensions/firefox/${name}`, data: sourceFile(firefoxDir, name) })),
    ...[...sharedSpec(firefoxDir).files, ...CHROME_BUILD_FILES].map((name) => ({ name: `extensions/chrome/${name}`, data: sourceFile(chromeDir, name) })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The source archive's entries: its README and exactly the files the build reads. */
export function sourceEntries(options = {}, version) {
  return [{ name: "README.txt", data: Buffer.from(SOURCE_README(version)) }, ...sourceFiles(options)];
}

/** `path` with its existing part's links resolved (the rest does not exist yet). */
function realOrPlanned(path) {
  const rest = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

/** The output folder may not be inside either source folder (but dist/), where the zips would become inputs. */
function checkOutDir(outDir, firefoxDir, chromeDir) {
  const within = (dir, root) => {
    const rel = relative(root, dir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const out = [resolve(outDir), realOrPlanned(outDir)];
  const roots = [firefoxDir, chromeDir].flatMap((root) => [root, realpathSync(root)]);
  const dists = [firefoxDir, realpathSync(firefoxDir)].map((root) => join(root, "dist"));
  if (out.some((dir) => roots.some((root) => within(dir, root)) && !dists.some((dist) => within(dir, dist)))) {
    throw new Error(`${outDir} is inside the extension's sources, where the zips would be read as part of the add-on: pack into dist/ or a folder outside.`);
  }
}

/** Whether `file` is free (false) or already a plain file with these bytes (true); anything else is refused. */
function alreadyThere(file, bytes) {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  // The path itself must be the file: a link to a matching zip could change under the checksum.
  if (info.isFile() && readFileSync(file).equals(bytes)) return true;
  throw new Error(`${file} is already there with other contents: pack into another folder, or move it away.`);
}

/** Writes `bytes` to `file` in one step and never over another file. */
function publish(file, bytes) {
  if (alreadyThere(file, bytes)) return;
  const staging = `${file}.${process.pid}.partial`;
  writeFileSync(staging, bytes, { flag: "wx" });
  try {
    // A hard link fails when the name is taken, so a file that appeared meanwhile is never replaced.
    linkSync(staging, file);
  } catch (error) {
    if (error.code !== "EEXIST" || !alreadyThere(file, bytes)) throw error;
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * Pack the assembled add-on into <outDir>/codara-firefox-<version>.zip and its
 * source into codara-firefox-<version>-source.zip; returns both files, the
 * upload's sha256 and its entries.
 */
export function pack(outDir = join(FIREFOX_DIR, "dist"), options = {}) {
  const firefoxDir = resolve(options.firefoxDir ?? FIREFOX_DIR);
  const chromeDir = resolve(options.chromeDir ?? CHROME_DIR);
  // Every input is read once; the upload is assembled from that very copy, so the source archive always rebuilds it.
  const files = sourceFiles({ firefoxDir, chromeDir });
  const copy = mkdtempSync(join(tmpdir(), "codara-firefox-pack-"));
  let entries;
  let recorded;
  try {
    for (const { name, data } of files) {
      mkdirSync(dirname(join(copy, name)), { recursive: true });
      writeFileSync(join(copy, name), data);
    }
    const copied = { firefoxDir: join(copy, "extensions/firefox"), chromeDir: join(copy, "extensions/chrome") };
    entries = assembledEntries(copied);
    recorded = recordedVersions(copied.firefoxDir);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  const { manifest, problems } = checkAddon(entries);
  // The upload is the very version Codara hands out: same number, same files.
  if (recorded[manifest.version] !== payloadDigest(entries)) {
    problems.push(`version ${manifest.version} is not recorded with these files: raise "version" in manifest.json and run node extensions/firefox/build/assemble.mjs --record-version`);
  }
  if (problems.length) throw new Error(`The add-on is not ready to pack:\n  ${problems.join("\n  ")}`);
  const bytes = zip(entries);
  const sourceBytes = zip([{ name: "README.txt", data: Buffer.from(SOURCE_README(manifest.version)) }, ...files]);
  checkOutDir(outDir, firefoxDir, chromeDir);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `codara-firefox-${manifest.version}.zip`);
  const source = join(outDir, `codara-firefox-${manifest.version}-source.zip`);
  // Both names are checked before either is written, and the source goes first, so a refusal leaves no upload without its source.
  alreadyThere(source, sourceBytes);
  alreadyThere(file, bytes);
  publish(source, sourceBytes);
  publish(file, bytes);
  return { file, source, sha256: createHash("sha256").update(bytes).digest("hex"), files: entries.map((entry) => entry.name), version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf("--out");
  try {
    const result = pack(outFlag > 0 ? resolve(process.argv[outFlag + 1]) : undefined);
    console.log(`Packed ${result.files.length} files into ${result.file}\nsha256 ${result.sha256}\nsource ${result.source}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
