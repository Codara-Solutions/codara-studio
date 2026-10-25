#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// Which open modal a key belongs to (shortcuts/modal-keys.ts): the one that
// holds focus, or with focus on nothing the latest open one. A dialog that
// claims Escape from a capture handler leaves a key typed in another dialog,
// such as the run switcher opened over the session-search intro, to it.
//
//   node scripts/test-modal-keys.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    const cache = path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
    const candidates = [];
    for (const directory of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
      for (const binary of ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const candidate = path.join(cache, directory, binary);
        if (fs.existsSync(candidate)) candidates.push(candidate);
      }
    }
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates.sort().pop() });
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-modal-keys-"));
  let browser;
  try {
    await esbuild.build({
      stdin: {
        contents: `import { keyBelongsToOtherModal, keyInsideModal, modalForKey } from "./src/renderer/src/shortcuts/modal-keys";
          // Mirrors SessionSearchIntro: document, capture phase, registered
          // before the dialog opened over it.
          window.introCloses = 0;
          document.addEventListener("keydown", (event) => {
            const intro = document.getElementById("intro");
            if (event.key !== "Escape" || keyBelongsToOtherModal(event, intro)) return;
            event.preventDefault();
            event.stopPropagation();
            window.introCloses += 1;
          }, true);
          window.switcherCloses = 0;
          document.getElementById("switcher").addEventListener("keydown", (event) => {
            if (event.key === "Escape") window.switcherCloses += 1;
          });
          window.owner = null;
          window.inside = null;
          window.addEventListener("keydown", (event) => {
            window.owner = modalForKey(event)?.id ?? null;
            window.inside = keyInsideModal(event);
          }, true);`,
        resolveDir: ROOT,
        sourcefile: "modal-keys-harness.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: path.join(directory, "view.js"),
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(directory, "index.html"),
      `<!doctype html><html><body>
        <input id="outside">
        <section id="switcher" role="dialog" aria-modal="true"><input id="search"><p id="text">Recent runs</p></section>
        <section id="hidden" role="dialog" aria-modal="true" style="display:none"><button>Hidden</button></section>
        <section id="intro" role="dialog" aria-modal="true"><button id="done">Done</button></section>
        <script src="view.js"></script></body></html>`,
    );
    browser = await launchBrowser();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("file://" + path.join(directory, "index.html"));
    const counts = () => page.evaluate(() => ({ intro: window.introCloses, switcher: window.switcherCloses, owner: window.owner, inside: window.inside }));

    // Escape typed in the switcher's search box: the switcher's, not the intro's.
    await page.focus("#search");
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 0, switcher: 1, owner: "switcher", inside: true });

    // Escape in the intro is the intro's.
    await page.focus("#done");
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 1, switcher: 1, owner: "intro", inside: true });

    // Focus on nothing: the latest rendered modal, skipping a hidden one.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 2, switcher: 1, owner: "intro", inside: true });
    await page.evaluate(() => { document.getElementById("intro").style.display = "none"; });
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 2, switcher: 1, owner: "switcher", inside: true });
    await page.evaluate(() => { document.getElementById("switcher").style.display = "none"; });
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 3, switcher: 1, owner: null, inside: false });

    // Focus outside every modal: no modal owns the key, so the intro keeps
    // the Escape it always had.
    await page.evaluate(() => { document.getElementById("intro").style.display = ""; });
    await page.focus("#outside");
    await page.keyboard.press("Escape");
    assert.deepEqual(await counts(), { intro: 4, switcher: 1, owner: null, inside: false });

    assert.deepEqual(errors, []);
    console.log("modal-keys: ok");
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
