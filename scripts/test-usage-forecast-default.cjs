#!/usr/bin/env node
"use strict";

// The usage forecast is on by default (the `usageForecast` preference). It was
// a Labs switch that was off, and preferences are saved whole, so builds of
// that time wrote `usageForecast: false` for everyone. Guards:
//
//   - with no preference file, and with that old `false`, the forecast is on;
//     only a choice the user made (usageForecastChosen) turns it off, and that
//     choice survives a restart and later saves of other settings
//   - the Settings toggle reads on when nothing is saved
//
//   node scripts/test-usage-forecast-default.cjs

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
    assert.equal(fs.existsSync(PREFS), false);
    assert.equal((await (await prefsStore()).loadPreferences()).usageForecast, true, "no file: on");

    // What a build with the Labs default saved for everyone, untouched.
    fs.writeFileSync(PREFS, JSON.stringify({ usageForecast: false, vimMode: true }));
    const upgraded = await (await prefsStore()).loadPreferences();
    assert.equal(upgraded.usageForecast, true, "an old default is not a choice");
    assert.equal(upgraded.vimMode, true);

    const store = await prefsStore();
    const off = await store.setPreference("usageForecast", false);
    assert.equal(off.usageForecast, false);
    assert.equal(off.usageForecastChosen, true);
    await store.setPreference("vimMode", false);
    const restarted = await (await prefsStore()).loadPreferences();
    assert.equal(restarted.usageForecast, false, "the user's off survives a restart and other saves");
    const back = await (await prefsStore()).setPreference("usageForecast", true);
    assert.equal(back.usageForecast, true);
    console.log("ok - the forecast is on by default; only the user's own choice turns it off, and it sticks");

    const toggles = await load("src/renderer/src/components/settings/setting-toggles.ts");
    assert.equal(toggles.PREFERENCE_TOGGLES.usageForecast.read({}), true);
    assert.equal(toggles.PREFERENCE_TOGGLES.usageForecast.read({ usageForecast: false }), false);
    console.log("ok - the Settings toggle reads on when nothing is saved");
  } finally {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
