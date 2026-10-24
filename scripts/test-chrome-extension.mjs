// The Codara browser extension's unit tests (extensions/chrome/test/), in
// the test registry: sharing and blocked-site rules, protocol permissions,
// cookie redaction, the link client against a fake Codara, and the store
// package. Then the two other copies of the extension: the packaged app's
// (package.json extraResources) and the folder Settings prepares leave out
// the same development files as the store zip.
//
//   node scripts/test-chrome-extension.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_FILES } from "../extensions/chrome/build/pack.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [join(root, "extensions", "chrome", "test", "run.mjs")], { stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const entry = pkg.build.extraResources.find((item) => typeof item === "object" && item.from === "extensions/chrome");
assert.ok(entry, "package.json ships extensions/chrome");
assert.equal(entry.to, "chrome-extension", "src/main/browser/chrome/index.ts reads resources/chrome-extension");
for (const name of DEV_FILES) {
  assert.ok(entry.filter.includes(`!${name}`) || entry.filter.includes(`!${name}/**`), `the packaged copy leaves out ${name}`);
}
const main = readFileSync(join(root, "src", "main", "browser", "chrome", "extension-update.ts"), "utf8");
const prepared = /EXTENSION_DEV_FILES = new Set\(\[([^\]]*)\]\)/.exec(main);
assert.ok(prepared, "extension-update.ts names the files Settings leaves out");
assert.deepEqual(JSON.parse(`[${prepared[1]}]`).sort(), [...DEV_FILES].sort(), "Settings prepares the same files Chrome loads");
console.log("ok - the packaged app and Settings ship what the store zip ships");

process.exitCode = result.status ?? 1;
