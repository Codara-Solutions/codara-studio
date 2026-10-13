"use strict";
// Finding elements by description and naming them in the outline (feedback
// round 5, items 18 and 19), on a real Chromium page:
// - codara_preview_snapshot (src/renderer/src/components/Preview/domSnapshot.ts
//   with src/shared/preview-names.ts): links show their target, icon-only
//   links and buttons get a name from aria-label, title, an svg <title>, an
//   icon class or sprite id, or where the link goes;
// - codara_preview_find (src/main/browser/find.ts): "the search button" and
//   similar phrases rank the right element first, a role word must agree,
//   a button and the icon inside it are one answer, and the references it
//   returns are the snapshot's, usable by click and type.
//
//   node scripts/test-preview-find-outline.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, ROOT } = require("./fixtures/browser-page-target.cjs");

const lib = bundleBrowser(`export * from "./find";`);

function bundleSnapshot() {
  const out = esbuild.buildSync({
    stdin: {
      contents: `
        export { snapshotProbe } from "./domSnapshot";
        export { createPreviewDOM } from "@shared/preview-dom";
        export { createPreviewNames } from "@shared/preview-names";
      `,
      resolveDir: path.join(ROOT, "src/renderer/src/components/Preview"),
      loader: "ts",
    },
    alias: { "@shared": path.join(ROOT, "src/shared") },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const PAGE = `<!doctype html><title>Shop</title>
  <style>.sprite { display: none } button, a { display: inline-block; min-width: 20px; min-height: 20px; }</style>
  <svg class="sprite"><symbol id="icon-cart"><path d="M0 0h10v10z"/></symbol></svg>
  <header>
    <a href="/" aria-label="Acme home"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></a>
    <nav>
      <a href="/docs/getting-started">Docs</a>
      <a href="https://github.com/acme/shop"><svg width="16" height="16"><path d="M0 0h16v16z"/></svg></a>
      <a href="/settings/profile" title="Your profile"><span class="avatar"></span></a>
      <a href="/cart"><svg width="16" height="16"><use href="#icon-cart"></use></svg></a>
      <a href="/help"><svg width="16" height="16"><title>Help center</title><path d="M0 0h16v16z"/></svg></a>
    </nav>
    <form role="search" onsubmit="event.preventDefault(); document.body.dataset.searched = this.q.value">
      <input name="q" type="search" placeholder="Search products">
      <button id="go" class="btn"><i class="fa-solid fa-magnifying-glass"></i></button>
    </form>
  </header>
  <main>
    <h2>Search tips</h2>
    <p>Use the search box above to find products, orders and help articles.</p>
    <label for="email">Email address</label> <input id="email" type="email">
    <button onclick="document.body.dataset.closed = 'yes'">×</button>
    <button>Add to cart</button>
    <a href="/search/advanced">Advanced search</a>
  </main>`;

async function inChromium() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium find and outline checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = await startPageServer({ "/": PAGE });
  const page = await openPage(chromium, lib, server.url("/"));
  const { target } = page;
  try {
    const snap = bundleSnapshot();
    const outline = (await target.evaluate(
      `(${snap.snapshotProbe.toString()})(${JSON.stringify({ mode: "outline", maxBytes: 12000 })}, ${snap.createPreviewDOM.toString()}, ${snap.createPreviewNames.toString()})`,
    )).snapshot;
    const line = (pattern) => {
      const found = outline.split("\n").find((entry) => pattern.test(entry));
      assert.ok(found, `outline has ${pattern}:\n${outline}`);
      return found.trim();
    };
    assert.match(line(/"Acme home"/), /^link @\S+ "Acme home" -> \/$/, "aria-label names a link, its target follows");
    assert.match(line(/"Docs"/), /^link @\S+ "Docs" -> \/docs\/getting-started$/);
    assert.match(line(/github/), /^link @\S+ "github\.com" -> https:\/\/github\.com\/acme\/shop$/, "an icon-only external link is named by its host");
    assert.match(line(/"Your profile"/), /-> \/settings\/profile$/, "title names a link");
    assert.match(line(/-> \/cart$/), /^link @\S+ "cart" -> \/cart$/, "a sprite id names an icon link");
    assert.match(line(/"Help center"/), /-> \/help$/, "an svg title names an icon link");
    assert.match(line(/#go/), /^button @\S+ #go "magnifying glass"$/, "an icon class names an icon button");
    assert.match(line(/searchbox/), /searchbox @\S+ "Search products"|searchbox @\S+ value=""/);

    const find = (query, limit) => lib.findElements(target, query, limit);
    const searchButton = await find("the search button");
    assert.equal(searchButton.query, "the search button");
    const top = searchButton.candidates[0];
    assert.equal(top.role, "button", JSON.stringify(searchButton.candidates, null, 1));
    assert.equal(top.selector, "#go");
    assert.match(top.why, /search~(?:name|icon)/, "matched through the icon's name");
    assert.match(top.why, /role button/);
    assert.ok(searchButton.candidates.every((candidate) => candidate.selector !== "#go > i"), "the icon inside the button is not a second answer");
    assert.ok(top.box.width > 0 && top.box.inViewport);
    assert.match(top.ref, /^@/);
    assert.ok(outline.includes(top.ref), "find returns the outline's reference");

    const field = (await find("search field")).candidates[0];
    assert.equal(field.role, "searchbox", "a role word picks the field over the button");
    const link = (await find("advanced search link")).candidates[0];
    assert.equal(link.target, "/search/advanced");
    assert.equal((await find("email")).candidates[0].selector, "#email", "a label names its field");
    assert.equal((await find("github link")).candidates[0].target, "https://github.com/acme/shop");
    assert.equal((await find("close")).candidates[0].name, "×", "synonyms: close ~ ×");
    assert.equal((await find("shopping cart icon", 1)).count, 1, "limit is honored");
    assert.equal((await find("help")).candidates[0].target, "/help");
    const nothing = await find("rocket launcher");
    assert.equal(nothing.count, 0);
    assert.deepEqual(nothing.candidates, []);

    // The reference works where the tools take a selector.
    await target.evaluate(`document.querySelector("input[name=q]").value = "boots"`);
    await target.evaluate(`(${snap.createPreviewDOM.toString()})().find(${JSON.stringify(top.ref)}).click()`);
    assert.equal(await target.evaluate("document.body.dataset.searched"), "boots");
  } finally {
    page.close();
    server.close();
    await chromium.close();
  }
}

(async () => {
  await inChromium();
  console.log("preview find and outline: link targets, icon-only names, ranked matches by description, references usable by click");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
