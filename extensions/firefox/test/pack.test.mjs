import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { FIREFOX_DIR, assembledEntries } from "../build/assemble.mjs";
import { ADDON_ID, checkAddon, pack } from "../build/pack.mjs";

/** Reads a zip's entries back from its central directory. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The assembled entries with manifest.json changed by `edit`, or one file replaced. */
function withManifest(entries, edit) {
  return entries.map((entry) => {
    if (entry.name !== "manifest.json") return entry;
    const manifest = JSON.parse(entry.data.toString("utf8"));
    edit(manifest);
    return { name: entry.name, data: Buffer.from(JSON.stringify(manifest)) };
  });
}
const withFile = (entries, name, data) => [...entries.filter((entry) => entry.name !== name), { name, data: Buffer.from(data) }];

export function run() {
  const entries = assembledEntries();
  const { manifest, problems } = checkAddon(entries);
  assert.deepEqual(problems, [], "the add-on passes its own checks");
  assert.equal(manifest.browser_specific_settings.gecko.id, ADDON_ID);
  assert.equal(ADDON_ID, "@codara-firefox", "the id Mozilla ties the listing and its updates to");
  assert.equal(manifest.host_permissions, undefined, "no site access at install");

  // What the checks refuse, each on its own.
  const refused = (changed, pattern) => assert.ok(checkAddon(changed).problems.some((problem) => pattern.test(problem)), String(pattern));
  refused(withManifest(entries, (m) => (m.browser_specific_settings.gecko.id = "codara@example")), /add-on id must stay @codara-firefox/);
  refused(withManifest(entries, (m) => delete m.browser_specific_settings.gecko.data_collection_permissions), /data_collection_permissions/);
  refused(withManifest(entries, (m) => (m.version = "1.0-beta")), /plain dotted version/);
  refused(withManifest(entries, (m) => (m.host_permissions = ["<all_urls>"])), /no site access at install/);
  refused(withManifest(entries, (m) => (m.description = "x".repeat(133))), /longer than 132/);
  refused(entries.filter((entry) => entry.name !== "popup.js"), /popup.html loads popup.js, which is missing/);
  refused(withFile(entries, "lib/extra.js", `export const a = ${JSON.stringify("x".repeat(1200))};\n`), /looks minified/);
  refused(withFile(entries, "popup.html", '<script src="https://cdn.example/x.js"></script>'), /may run only its own files/);
  refused(withFile(entries, "lib/extra.js", 'import { gone } from "./gone.js";\n'), /imports \.\/gone\.js, which is missing/);
  assert.match(checkAddon(entries.filter((entry) => entry.name !== "manifest.json")).problems[0], /manifest.json is missing/);

  const out = mkdtempSync(join(tmpdir(), "codara-firefox-pack-"));
  try {
    const first = pack(out);
    assert.equal(first.file, join(out, `codara-firefox-${manifest.version}.zip`));
    const bytes = readFileSync(first.file);
    assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(readFileSync(pack(out).file), bytes, "the same sources pack to the same bytes");
    // The zip holds exactly the assembled add-on, byte for byte.
    const zipped = readZip(bytes);
    assert.deepEqual([...zipped.keys()], entries.map((entry) => entry.name));
    for (const { name, data } of entries) assert.deepEqual(zipped.get(name), data, name);
    for (const devOnly of ["build/pack.mjs", "build/assemble.mjs", "test/run.mjs", "shared.json", "versions.json", "README.md", "LISTING.txt", "package.json"]) {
      assert.ok(!zipped.has(devOnly), `${devOnly} stays out of the upload`);
    }
    // The upload is the version Codara hands out: a version whose files are not the recorded ones is not packed.
    const copy = join(out, "source");
    cpSync(FIREFOX_DIR, copy, { recursive: true, filter: (from) => !from.includes(`${FIREFOX_DIR}/dist`) });
    writeFileSync(join(copy, "background.js"), `${readFileSync(join(copy, "background.js"), "utf8")}\n// changed\n`);
    assert.throws(() => pack(join(out, "unrecorded"), { firefoxDir: copy }), /is not recorded with these files: raise "version"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return "pack: Mozilla's checks (id, data collection, version, files, no minified or remote code), a reproducible zip of exactly the assembled add-on";
}
