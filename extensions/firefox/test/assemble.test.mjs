import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHROME_DIR, FIREFOX_DIR, assemble, assembledEntries, ownFiles, sharedSpec } from "../build/assemble.mjs";

export function run() {
  const spec = sharedSpec();
  const entries = assembledEntries();
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort(), "a stable order");
  for (const required of ["manifest.json", "background.js", "lib/firefox.js", "lib/link-client.js", "lib/policy.js", "popup.html", "popup.js", "options.html", "icons/icon-128.png"]) {
    assert.ok(names.includes(required), required);
  }
  for (const devOnly of ["build/assemble.mjs", "test/run.mjs", "shared.json", "README.md", "package.json"]) {
    assert.ok(!names.includes(devOnly), `${devOnly} stays out of the extension`);
  }
  // Shared files are Chrome's bytes, but for the patches.
  for (const name of spec.files) {
    const chrome = readFileSync(join(CHROME_DIR, name));
    const firefox = entries.find((entry) => entry.name === name).data;
    if (spec.patches?.[name]) assert.notDeepEqual(firefox, chrome, `${name} is patched`);
    else assert.deepEqual(firefox, chrome, name);
  }
  const popup = entries.find((entry) => entry.name === "popup.js").data.toString("utf8");
  assert.ok(!popup.includes("Chrome Web Store"), "the popup does not talk about Chrome in Firefox");
  assert.ok(popup.includes("Firefox does not let extensions work on this page"));

  // Every file the manifest names and every relative import is there.
  const manifest = JSON.parse(readFileSync(join(FIREFOX_DIR, "manifest.json"), "utf8"));
  const referenced = [...manifest.background.scripts, manifest.action.default_popup, manifest.options_ui.page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const file of referenced) assert.ok(names.includes(file), `manifest names ${file}`);
  for (const { name, data } of entries) {
    if (!name.endsWith(".js")) continue;
    for (const match of data.toString("utf8").matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)) {
      const target = join(name, "..", match[1]).replace(/\\/g, "/");
      assert.ok(names.includes(target), `${name} imports ${match[1]}`);
    }
  }

  // A patch whose text left the Chrome file stops the build, and a file
  // cannot be both shared and Firefox's own.
  const scratch = mkdtempSync(join(tmpdir(), "codara-firefox-assemble-"));
  try {
    const firefoxDir = join(scratch, "firefox");
    const chromeDir = join(scratch, "chrome");
    cpSync(FIREFOX_DIR, firefoxDir, { recursive: true, filter: (source) => !source.includes(`${join(FIREFOX_DIR, "dist")}`) });
    cpSync(CHROME_DIR, chromeDir, { recursive: true, filter: (source) => !source.includes(`${join(CHROME_DIR, "dist")}`) });
    writeFileSync(join(chromeDir, "popup.js"), "// reworded\n");
    assert.throws(() => assembledEntries({ firefoxDir, chromeDir }), /expects its text exactly once/);
    cpSync(join(CHROME_DIR, "popup.js"), join(chromeDir, "popup.js"));
    mkdirSync(join(firefoxDir, "lib"), { recursive: true });
    writeFileSync(join(firefoxDir, "lib", "policy.js"), "// a fork\n");
    assert.throws(() => assembledEntries({ firefoxDir, chromeDir }), /both shared from Chrome and Firefox's own/);
    rmSync(join(firefoxDir, "lib", "policy.js"));

    // Writing the folder: an earlier assembly is replaced, anything else is never emptied.
    const out = join(scratch, "out");
    const first = assemble(out, { firefoxDir, chromeDir });
    assert.deepEqual(first.files, ownFiles(firefoxDir).concat(sharedSpec(firefoxDir).files).sort());
    writeFileSync(join(out, "stale.js"), "");
    assemble(out, { firefoxDir, chromeDir });
    assert.equal(existsSync(join(out, "stale.js")), false, "a new assembly leaves nothing old behind");
    const precious = join(scratch, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "notes.txt"), "keep");
    assert.throws(() => assemble(precious, { firefoxDir, chromeDir }), /not an assembled extension/);
    assert.equal(readFileSync(join(precious, "notes.txt"), "utf8"), "keep");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return "assemble: Chrome's shared files as they are but for checked patches, Firefox's own files, nothing written outside the output";
}
