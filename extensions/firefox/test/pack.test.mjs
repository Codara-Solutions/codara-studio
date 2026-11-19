import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { CHROME_DIR, FIREFOX_DIR, assembledEntries } from "../build/assemble.mjs";
import { ADDON_ID, checkAddon, pack, sourceEntries } from "../build/pack.mjs";

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
  refused(withManifest(entries, (m) => (m.version = "0.01.1")), /plain dotted version/);
  refused(withManifest(entries, (m) => (m.version = "1.2.3.4.5")), /plain dotted version/);
  const collecting = (declared, pattern) => refused(withManifest(entries, (m) => (m.browser_specific_settings.gecko.data_collection_permissions = declared)), pattern);
  collecting({ required: "websiteContent" }, /required must be a list/);
  collecting({ required: [] }, /required must be a list/);
  collecting({ required: ["websiteContent", "pageText"] }, /"pageText", which is not one of Mozilla's categories/);
  collecting({ required: ["none", "websiteContent"] }, /"none" stands alone/);
  collecting({ required: ["websiteContent", "technicalAndInteraction"] }, /technicalAndInteraction can only be optional/);
  collecting({ required: ["websiteContent"], optional: "technicalAndInteraction" }, /optional must be a list/);
  assert.deepEqual(checkAddon(withManifest(entries, (m) => (m.browser_specific_settings.gecko.data_collection_permissions = { required: ["none"], optional: ["technicalAndInteraction"] }))).problems, []);
  // Sharing a tab sends its address, the page and what the agent does in it, and the sign-in data the page reaches.
  assert.deepEqual(
    [...manifest.browser_specific_settings.gecko.data_collection_permissions.required].sort(),
    ["authenticationInfo", "browsingActivity", "websiteActivity", "websiteContent"],
  );
  refused(withManifest(entries, (m) => (m.host_permissions = ["<all_urls>"])), /no site access at install/);
  refused(withManifest(entries, (m) => (m.description = "x".repeat(133))), /longer than 132/);
  refused(withManifest(entries, (m) => delete m.name), /name is missing/);
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
    // Packing never writes over another file of the same name; the same bytes there are fine.
    const other = mkdtempSync(join(out, "other-"));
    writeFileSync(join(other, `codara-firefox-${manifest.version}.zip`), "someone else's file");
    assert.throws(() => pack(other), /is already there with other contents/);
    assert.equal(readFileSync(join(other, `codara-firefox-${manifest.version}.zip`), "utf8"), "someone else's file");
    // A clashing source archive leaves no upload behind; a link to a matching zip is not the zip.
    const clash = mkdtempSync(join(out, "clash-"));
    writeFileSync(join(clash, `codara-firefox-${manifest.version}-source.zip`), "another source");
    assert.throws(() => pack(clash), /is already there with other contents/);
    assert.equal(existsSync(join(clash, `codara-firefox-${manifest.version}.zip`)), false, "no upload without its source");
    const linked = mkdtempSync(join(out, "linked-"));
    symlinkSync(first.file, join(linked, `codara-firefox-${manifest.version}.zip`));
    assert.throws(() => pack(linked), /is already there with other contents/);

    // The source archive rebuilds the very same upload, from its own folders and nothing else.
    const sourceZip = readZip(readFileSync(first.source));
    assert.match(sourceZip.get("README.txt").toString("utf8"), /node extensions\/firefox\/build\/pack\.mjs --out out/);
    assert.ok(!sourceZip.has("extensions/firefox/test/run.mjs") && !sourceZip.has("extensions/chrome/background.js"), "only what the build reads");
    const rebuilt = join(out, "rebuilt");
    for (const [name, data] of sourceZip) {
      mkdirSync(dirname(join(rebuilt, name)), { recursive: true });
      writeFileSync(join(rebuilt, name), data);
    }
    const again = pack(join(out, "again"), { firefoxDir: join(rebuilt, "extensions/firefox"), chromeDir: join(rebuilt, "extensions/chrome") });
    assert.equal(again.sha256, first.sha256, "the source rebuilds the upload byte for byte");
    // Only the files the build reads: a stray local file stays out, a link among them is refused.
    writeFileSync(join(rebuilt, "extensions/firefox/.env"), "SECRET=1\n");
    writeFileSync(join(rebuilt, "extensions/firefox/build/notes.txt"), "mine\n");
    writeFileSync(join(rebuilt, "extensions/chrome/STORE.md"), "chrome's own\n");
    const stray = readZip(readFileSync(pack(join(out, "stray"), { firefoxDir: join(rebuilt, "extensions/firefox"), chromeDir: join(rebuilt, "extensions/chrome") }).source));
    assert.deepEqual([...stray.keys()], [...sourceZip.keys()], "the same files as before, nothing local added");
    // Never into the sources (dist/ excepted), where the zips would become part of the add-on.
    const opts = { firefoxDir: join(rebuilt, "extensions/firefox"), chromeDir: join(rebuilt, "extensions/chrome") };
    assert.throws(() => pack(join(rebuilt, "extensions/firefox/release"), opts), /is inside the extension's sources/);
    assert.throws(() => pack(join(rebuilt, "extensions/chrome/out"), opts), /is inside the extension's sources/);
    assert.equal(existsSync(join(rebuilt, "extensions/firefox/release")), false, "nothing made there");
    assert.equal(pack(join(rebuilt, "extensions/firefox/dist"), opts).sha256, first.sha256);
    // A folder reached through a link is not the source's own.
    const elsewhere = join(out, "elsewhere-lib");
    cpSync(join(rebuilt, "extensions/chrome/lib"), elsewhere, { recursive: true });
    rmSync(join(rebuilt, "extensions/chrome/lib"), { recursive: true });
    symlinkSync(elsewhere, join(rebuilt, "extensions/chrome/lib"));
    assert.throws(() => sourceEntries(opts, manifest.version), /lib\/link-client\.js is not a plain file of its folder/);
    rmSync(join(rebuilt, "extensions/chrome/lib"));
    cpSync(elsewhere, join(rebuilt, "extensions/chrome/lib"), { recursive: true });
    rmSync(join(rebuilt, "extensions/chrome/popup.css"));
    symlinkSync(join(CHROME_DIR, "popup.css"), join(rebuilt, "extensions/chrome/popup.css"));
    assert.throws(() => sourceEntries({ firefoxDir: join(rebuilt, "extensions/firefox"), chromeDir: join(rebuilt, "extensions/chrome") }, manifest.version), /popup\.css is not a plain file of its folder/);
    assert.notEqual(CHROME_DIR, join(rebuilt, "extensions/chrome"));

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
