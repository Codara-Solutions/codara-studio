// Checks the extension and packs it for the Chrome Web Store (and the Edge
// Add-ons store, which takes the same zip):
//
//   node extensions/chrome/build/pack.mjs [--out <dir>]
//
// It only builds the upload; publishing stays a manual step in the store's
// dashboard (see ../STORE.md). The zip holds exactly what Load unpacked reads,
// with fixed timestamps so the same sources give the same bytes.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Development files that are not part of the extension Chrome loads. The
// packaged app's copy (package.json extraResources) and the folder Settings
// prepares (src/main/browser/chrome/index.ts) leave out the same ones.
export const DEV_FILES = Object.freeze(["build", "test", "dist", "package.json", "README.md", "STORE.md", ".gitignore"]);
const EXCLUDED = new Set(DEV_FILES);

/** The extension's files, relative to its folder, in a stable order. */
export function extensionFiles(dir = EXTENSION_DIR) {
  const out = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const rel = relative(dir, full).split(sep).join("/");
      if (EXCLUDED.has(rel) || name.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** Problems that would make Chrome or the store refuse the extension. */
export function checkExtension(dir = EXTENSION_DIR) {
  const problems = [];
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const files = new Set(extensionFiles(dir));
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" is not a Chrome version`);
  if (manifest.key) problems.push("remove the key field: the store assigns the id");
  if ((manifest.description ?? "").length > 132) problems.push("description is longer than 132 characters");
  if (manifest.host_permissions?.length) problems.push("host_permissions are not needed: chrome.debugger reaches shared tabs");
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
  for (const file of referenced) if (!files.has(file)) problems.push(`manifest names ${file}, which is missing`);
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)) {
      const target = join(dirname(file), match[1]).split(sep).join("/");
      if (!files.has(target)) problems.push(`${file} imports ${match[1]}, which is missing`);
    }
  }
  return { manifest, problems };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of stored (uncompressed) entries, which every store accepts. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 1980-01-01 00:00, the earliest DOS date, for reproducible output.
  const dosTime = 0;
  const dosDate = (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function pack(outDir = join(EXTENSION_DIR, "dist"), dir = EXTENSION_DIR) {
  const { manifest, problems } = checkExtension(dir);
  if (problems.length) throw new Error(`The extension is not ready to pack:\n  ${problems.join("\n  ")}`);
  const entries = extensionFiles(dir).map((name) => ({ name, data: readFileSync(join(dir, name)) }));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `codara-chrome-${manifest.version}.zip`);
  writeFileSync(file, zip(entries));
  return { file, files: entries.map((entry) => entry.name), version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf("--out");
  try {
    const result = pack(outFlag > 0 ? resolve(process.argv[outFlag + 1]) : undefined);
    console.log(`Packed ${result.files.length} files into ${result.file}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
