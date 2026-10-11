#!/usr/bin/env node
"use strict";

// Where a clicked link opens (src/main/link-routing.ts, src/main/open-link.ts)
// and the linkOpenTarget preference that drives it.
//
// Proven here:
//   1. http(s) follows the preference: the default browser by default, a
//      Codara browser tab when the user picked "studio".
//   2. file: always opens in Codara (never shell.openExternal), mailto always
//      goes to the system handler, and every other scheme is dropped.
//   3. openLinkFromApp reads the live preference, sends Codara opens to the
//      app window, and never hands an unsafe URL to shell.openExternal.
//   4. The preference defaults to "system" and normalizes unknown values.
//   5. Every plain link caller in the renderer goes through the preload's
//      openExternal, which only invokes app:openLink.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-link-routing-"));
const HOME = path.join(OUT_DIR, "home");
fs.mkdirSync(HOME);
process.env.CODARA_HOME_DIR = HOME;
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const opened = [];

const stubPlugin = {
  name: "link-routing-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const shell = {
          openExternal: async (url) => { globalThis.__openedExternally.push(url); },
        };
        export const app = { getPath: () => ${JSON.stringify(HOME)}, isPackaged: false };`,
      loader: "js",
    }));
  },
};

async function load(entry, name) {
  const outfile = path.join(OUT_DIR, `${name}.bundle.cjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function fakeHost() {
  return {
    sent: [],
    isDestroyed: () => false,
    send(...args) {
      this.sent.push(args);
    },
  };
}

async function main() {
  globalThis.__openedExternally = opened;
  const { routeLink, openLink } = await load("src/main/link-routing.ts", "link-routing");

  assert.equal(routeLink("https://github.com/org/repo/pull/1", "system"), "system");
  assert.equal(routeLink("http://localhost:5173/", "system"), "system");
  assert.equal(routeLink("https://github.com/org/repo/pull/1", "studio"), "studio");
  assert.equal(routeLink("HTTP://LOCALHOST:5173/", "studio"), "studio");
  console.log("ok 1 http(s) follows the preference");

  for (const target of ["system", "studio"]) {
    assert.equal(routeLink("file:///tmp/report.html", target), "studio");
    assert.equal(routeLink("mailto:someone@example.com", target), "system");
    for (const unsafe of [
      "javascript:alert(1)",
      "vscode://file/etc/passwd",
      "smb://host/share",
      "//example.com/no-scheme",
      "not a url",
      "",
    ]) {
      assert.equal(routeLink(unsafe, target), "drop", `${target}: ${unsafe}`);
    }
  }
  const calls = [];
  const deps = (target) => ({
    target,
    openInStudio: (url) => calls.push(["studio", url]),
    openInSystem: async (url) => calls.push(["system", url]),
  });
  assert.equal(await openLink("https://example.com/", deps("system")), "system");
  assert.equal(await openLink("https://example.com/", deps("studio")), "studio");
  assert.equal(await openLink("javascript:alert(1)", deps("studio")), "drop");
  assert.deepEqual(calls, [
    ["system", "https://example.com/"],
    ["studio", "https://example.com/"],
  ]);
  console.log("ok 2 file: stays in Codara, mailto goes out, other schemes are dropped");

  const { openLinkFromApp, openInSystemBrowser } = await load("src/main/open-link.ts", "open-link");
  const prefs = await load("src/main/preferences-store.ts", "preferences-store");
  // open-link's bundled preference store is never loaded, so it reads the
  // default, which must be the machine's browser.
  const host = fakeHost();
  assert.equal(await openLinkFromApp("https://example.com/a", host), "system");
  assert.deepEqual(opened, ["https://example.com/a"]);
  assert.deepEqual(host.sent, []);
  await openInSystemBrowser("file:///C:/evil.bat");
  await openInSystemBrowser("javascript:alert(1)");
  assert.deepEqual(opened, ["https://example.com/a"], "unsafe schemes never reach shell.openExternal");
  assert.equal(await openLinkFromApp("file:///tmp/notes.md", host), "studio");
  assert.deepEqual(host.sent, [["app:open-browser-url", "file:///tmp/notes.md"]]);
  console.log("ok 3 openLinkFromApp opens the default browser and keeps file: in Codara");

  assert.equal(prefs.getPreferenceSync("linkOpenTarget"), "system");
  fs.writeFileSync(
    path.join(HOME, "spark-preferences.json"),
    JSON.stringify({ linkOpenTarget: "studio" }),
  );
  const loaded = await prefs.loadPreferences();
  assert.equal(loaded.linkOpenTarget, "studio");
  const reset = await prefs.setPreference("linkOpenTarget", "firefox");
  assert.equal(reset.linkOpenTarget, "system", "unknown values fall back to the default");
  const studio = await prefs.setPreference("linkOpenTarget", "studio");
  assert.equal(studio.linkOpenTarget, "studio");
  assert.equal(prefs.getPreferenceCached("linkOpenTarget"), "studio");
  const types = fs.readFileSync(path.join(ROOT, "src/shared/types.ts"), "utf8");
  assert.match(types, /linkOpenTarget: "system",/, "the default is the machine's browser");
  console.log("ok 4 the preference defaults to system and normalizes unknown values");

  const preload = fs.readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8");
  assert.match(preload, /openExternal: \(url: string\): Promise<void> =>\s*ipcRenderer\.invoke\("app:openLink", url\)/);
  const mainIndex = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8");
  assert.doesNotMatch(mainIndex, /webContents\.send\("app:open-browser-url"/, "main window links go through openLinkFromApp");
  assert.match(mainIndex, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*openLinkFromMainWindow\(url\);/);
  const github = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/git/GitHubSection.tsx"), "utf8");
  assert.doesNotMatch(github, /openInSystemBrowser/, "GitHub links follow the preference");
  console.log("ok 5 plain link callers reach app:openLink");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
