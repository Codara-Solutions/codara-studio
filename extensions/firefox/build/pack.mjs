// Checks the Firefox extension and packs it for addons.mozilla.org:
//
//   node extensions/firefox/build/pack.mjs [--out <dir>]
//
// It only builds the upload; submitting stays a manual step in Mozilla's
// Developer Hub (see ../LISTING.txt). The zip holds exactly what the
// assembled folder holds (build/assemble.mjs: this folder's own files and the
// Chrome files shared.json names, patched), stored with fixed timestamps so
// the same sources give the same bytes. Every file is plain JavaScript, HTML
// and CSS as written: nothing is bundled, minified or generated, so Mozilla
// needs no separate source upload.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zip } from "../../chrome/build/pack.mjs";
import { assembledEntries, FIREFOX_DIR, payloadDigest, recordedVersions } from "./assemble.mjs";

export const ADDON_ID = "@codara-firefox";

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
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" is not a plain dotted version`);
  if (gecko.id !== ADDON_ID) problems.push(`the add-on id must stay ${ADDON_ID}: Mozilla ties the listing, and every update, to it`);
  if (!gecko.strict_min_version) problems.push("strict_min_version is missing");
  if (!gecko.data_collection_permissions?.required?.length) problems.push("data_collection_permissions must declare what the add-on collects");
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

/** Pack the assembled add-on into <outDir>/codara-firefox-<version>.zip; returns the file, its sha256 and its entries. */
export function pack(outDir = join(FIREFOX_DIR, "dist"), options = {}) {
  const entries = assembledEntries(options);
  const { manifest, problems } = checkAddon(entries);
  // The upload is the very version Codara hands out: same number, same files.
  const firefoxDir = options.firefoxDir ?? FIREFOX_DIR;
  if (recordedVersions(firefoxDir)[manifest.version] !== payloadDigest(entries)) {
    problems.push(`version ${manifest.version} is not recorded with these files: raise "version" in manifest.json and run node extensions/firefox/build/assemble.mjs --record-version`);
  }
  if (problems.length) throw new Error(`The add-on is not ready to pack:\n  ${problems.join("\n  ")}`);
  const bytes = zip(entries);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `codara-firefox-${manifest.version}.zip`);
  writeFileSync(file, bytes);
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), files: entries.map((entry) => entry.name), version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf("--out");
  try {
    const result = pack(outFlag > 0 ? resolve(process.argv[outFlag + 1]) : undefined);
    console.log(`Packed ${result.files.length} files into ${result.file}\nsha256 ${result.sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
