#!/usr/bin/env node
"use strict";

// The editor word wrap preference (`editorWordWrap`: auto, on, off) as the
// main process loads it: a missing, mistyped or unknown value is "auto", a
// valid one is kept, and a saved choice survives a restart.
//
//   node scripts/test-editor-word-wrap-preference.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-forecast-default-"));
const HOME = path.join(OUT, "home");
fs.mkdirSync(HOME);
process.env.CODARA_HOME_DIR = HOME;
const PREFS = path.join(HOME, "spark-preferences.json");

let bundles = 0;
async function load(entry) {
  bundles += 1;
  const outfile = path.join(OUT, `bundle-${bundles}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `export const app = { getPath: () => ${JSON.stringify(HOME)}, isPackaged: false }; export const shell = {};`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

/** A fresh preference store, as after a restart. */
const prefsStore = () => load("src/main/preferences-store.ts");

(async () => {
  try {
    assert.equal((await (await prefsStore()).loadPreferences()).editorWordWrap, "auto", "no file");

    for (const value of [undefined, null, 1, true, "", "wrap", "ON", {}, []]) {
      fs.writeFileSync(PREFS, JSON.stringify(value === undefined ? { vimMode: true } : { editorWordWrap: value }));
      assert.equal((await (await prefsStore()).loadPreferences()).editorWordWrap, "auto", `invalid ${JSON.stringify(value)}`);
    }
    console.log("ok - a missing or invalid value is auto");

    for (const value of ["auto", "on", "off"]) {
      fs.writeFileSync(PREFS, JSON.stringify({ editorWordWrap: value }));
      assert.equal((await (await prefsStore()).loadPreferences()).editorWordWrap, value);
    }
    console.log("ok - a valid value is kept");

    fs.writeFileSync(PREFS, JSON.stringify({}));
    const saved = await (await prefsStore()).setPreference("editorWordWrap", "off");
    assert.equal(saved.editorWordWrap, "off");
    await (await prefsStore()).setPreference("vimMode", true);
    assert.equal((await (await prefsStore()).loadPreferences()).editorWordWrap, "off", "survives a restart and other saves");
    console.log("ok - the choice survives a restart");
  } finally {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
