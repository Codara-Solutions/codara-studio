import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { EXTENSION_DIR, checkExtension, extensionFiles, pack } from "../build/pack.mjs";

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

export function run() {
  const { manifest, problems } = checkExtension();
  assert.deepEqual(problems, [], "the extension passes its own checks");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"], "no permission beyond what the link needs");
  assert.equal(manifest.host_permissions, undefined);

  const files = extensionFiles();
  for (const required of ["manifest.json", "background.js", "popup.html", "popup.js", "options.html", "lib/policy.js", "lib/link-client.js", "icons/icon-128.png"]) {
    assert.ok(files.includes(required), required);
  }
  for (const devOnly of ["package.json", "build/pack.mjs", "test/run.mjs", "README.md", "STORE.md"]) {
    assert.ok(!files.includes(devOnly), `${devOnly} stays out of the extension`);
  }

  const out = mkdtempSync(join(tmpdir(), "codara-chrome-pack-"));
  try {
    const first = pack(out);
    const bytes = readFileSync(first.file);
    assert.deepEqual(readFileSync(pack(out).file), bytes, "the same sources pack to the same bytes");
    const entries = readZip(bytes);
    assert.deepEqual([...entries.keys()], files);
    for (const name of files) assert.deepEqual(entries.get(name), readFileSync(join(EXTENSION_DIR, name)), name);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return "pack: manifest checks, only extension files, a reproducible store zip that reads back";
}
