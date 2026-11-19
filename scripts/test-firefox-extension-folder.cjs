"use strict";
// The folder Settings > Browser hands Firefox (src/main/browser/firefox-extension.ts):
// assembled from the sources into <codara home>/firefox-extension/<version>/,
// exactly what build/assemble.mjs makes; written once and never again, so the
// add-on Firefox loaded never changes under it; a newer version gets its own
// folder beside it; a folder left half-written is made again. Packaged, the
// sources come from the app's resources as package.json's extraResources
// filters copy them, and that copy has everything the assembly needs.
//
//   node scripts/test-firefox-extension-folder.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(app, home) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/browser/firefox-extension.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "stubs",
      setup(build) {
        build.onResolve({ filter: /^electron$|codara-home$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path === "electron" ? "module.exports = { app: globalThis.__testApp };" : `module.exports = { codaraHome: () => ${JSON.stringify(home)} };`,
          loader: "js",
        }));
      },
    }],
  });
  globalThis.__testApp = app;
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

/** Every file under a folder, relative, with its bytes. */
function filesOf(dir) {
  const out = new Map();
  const walk = (folder) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join("/"), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** Copy `from` to `to` as electron-builder's extraResources filter does (the "!" patterns this repo uses). */
function copyFiltered(from, to, filter) {
  const excluded = filter.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const skip = (rel) => excluded.some((pattern) => (pattern.endsWith("/**") ? rel === pattern.slice(0, -3) || rel.startsWith(pattern.slice(0, -2)) : rel === pattern));
  for (const [rel, data] of filesOf(from)) {
    if (skip(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.writeFileSync(path.join(to, rel), data);
  }
}

(async () => {
  const { assembledEntries, ASSEMBLY_MARKER } = await import(pathToFileURL(path.join(ROOT, "extensions/firefox/build/assemble.mjs")).href);
  const expected = new Map(assembledEntries().map((entry) => [entry.name, entry.data]));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "extensions/firefox/manifest.json"), "utf8")).version;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codara-firefox-folder-"));
  const sameAsAssembly = (dir, what) => {
    const got = filesOf(dir);
    got.delete(ASSEMBLY_MARKER);
    assert.deepEqual([...got.keys()], [...expected.keys()], `${what}: the assembled files`);
    for (const [name, data] of expected) assert.ok(got.get(name).equals(data), `${what}: ${name}`);
  };
  try {
    // From a checkout: the sources in extensions/.
    const home = path.join(scratch, "home");
    let lib = await load({ isPackaged: false, getAppPath: () => ROOT }, home);
    const folder = path.join(home, "firefox-extension", version);
    assert.equal(lib.firefoxExtensionFolder(), folder, "one folder per version, in Codara's home");
    assert.equal(fs.existsSync(folder), false, "nothing is written until the user asks");
    assert.equal(await lib.prepareFirefoxExtensionFolder(), folder);
    sameAsAssembly(folder, "checkout");
    assert.deepEqual(fs.readdirSync(path.dirname(folder)), [version], "no staging folder is left");

    // Written once: what Firefox loaded is never rewritten, even by a newer assembly of the same version.
    fs.writeFileSync(path.join(folder, "background.js"), "// the copy Firefox loaded\n");
    const before = fs.statSync(path.join(folder, "manifest.json")).mtimeMs;
    assert.equal(await (await load({ isPackaged: false, getAppPath: () => ROOT }, home)).prepareFirefoxExtensionFolder(), folder);
    assert.equal(fs.readFileSync(path.join(folder, "background.js"), "utf8"), "// the copy Firefox loaded\n");
    assert.equal(fs.statSync(path.join(folder, "manifest.json")).mtimeMs, before);

    // A folder left without its manifest (a write cut short) is made again.
    fs.rmSync(path.join(folder, "manifest.json"));
    await (await load({ isPackaged: false, getAppPath: () => ROOT }, home)).prepareFirefoxExtensionFolder();
    sameAsAssembly(folder, "made again");

    // Packaged: the sources as extraResources copies them, and they assemble the same add-on.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const resource = (to) => pkg.build.extraResources.find((entry) => typeof entry === "object" && entry.to === to);
    const resources = path.join(scratch, "resources");
    for (const to of ["firefox-extension-source", "chrome-extension"]) {
      const entry = resource(to);
      assert.ok(entry, `package.json ships ${to}`);
      copyFiltered(path.join(ROOT, entry.from), path.join(resources, to), entry.filter ?? []);
    }
    assert.equal(fs.existsSync(path.join(resources, "firefox-extension-source", "test")), false, "tests are not shipped");
    const packagedHome = path.join(scratch, "packaged-home");
    const savedResources = process.resourcesPath;
    process.resourcesPath = resources;
    try {
      lib = await load({ isPackaged: true, getAppPath: () => path.join(resources, "app.asar") }, packagedHome);
      const packaged = await lib.prepareFirefoxExtensionFolder();
      assert.equal(packaged, path.join(packagedHome, "firefox-extension", version));
      sameAsAssembly(packaged, "packaged");

      // A newer version gets its own folder; the one Firefox loaded stays as it was.
      const manifestPath = path.join(resources, "firefox-extension-source", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "99.0.0" }));
      fs.writeFileSync(path.join(packaged, "popup.js"), "// loaded before the update\n");
      lib = await load({ isPackaged: true, getAppPath: () => path.join(resources, "app.asar") }, packagedHome);
      const newer = await lib.prepareFirefoxExtensionFolder();
      assert.equal(newer, path.join(packagedHome, "firefox-extension", "99.0.0"));
      assert.equal(JSON.parse(fs.readFileSync(path.join(newer, "manifest.json"), "utf8")).version, "99.0.0");
      assert.equal(fs.readFileSync(path.join(packaged, "popup.js"), "utf8"), "// loaded before the update\n");

      // A build without the Firefox sources says so.
      fs.rmSync(path.join(resources, "firefox-extension-source"), { recursive: true });
      lib = await load({ isPackaged: true, getAppPath: () => path.join(resources, "app.asar") }, packagedHome);
      assert.equal(lib.firefoxExtensionFolder(), null);
      await assert.rejects(lib.prepareFirefoxExtensionFolder(), /does not include the extension for Firefox/);
    } finally {
      process.resourcesPath = savedResources;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("firefox extension folder: assembled once per version into Codara's home, never rewritten, a cut-short one made again; packaged resources assemble the same add-on");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
