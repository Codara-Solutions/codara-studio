"use strict";
// The shared screenshot pipeline (src/main/browser/screenshot.ts) and element
// locator (src/shared/preview-locator.ts): option validation, crop and scale
// math on a high-density display, files saved under the workspace's data
// folder, and selectors, boxes, roles and names
// computed in a real Chromium page. Electron's image codec is exercised by
// the preview capture e2e specs.
//
//   node scripts/test-browser-screenshot-locator.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-shot-home-"));

async function bundle(contents, extra = {}) {
  const out = await esbuild.build({
    stdin: { contents, resolveDir: path.join(ROOT, "src/main/browser"), loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [{
      name: "home",
      setup(build) {
        build.onResolve({ filter: /codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `module.exports = { codaraHome: () => ${JSON.stringify(HOME)} };`,
          loader: "js",
        }));
      },
    }],
    ...extra,
  });
  return out.outputFiles[0].text;
}

function load(code) {
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

// An "image" is JSON describing its size and the operations applied to it.
const fakeImage = (width, height, ops = []) => Buffer.from(JSON.stringify({ width, height, ops }));
const readFake = (buffer) => JSON.parse(buffer.toString());
const fakeCodec = {
  size: (png) => { const { width, height } = readFake(png); return { width, height }; },
  crop: (png, rect) => { const image = readFake(png); return fakeImage(rect.width, rect.height, [...image.ops, ["crop", rect]]); },
  resize: (png, size) => { const image = readFake(png); return fakeImage(size.width, size.height, [...image.ops, ["resize", size]]); },
  encode: (png, format, quality) => { const image = readFake(png); return fakeImage(image.width, image.height, [...image.ops, ["encode", format, quality]]); },
};

function fakeTarget({ element } = {}) {
  const sent = [];
  return {
    kind: "preview",
    ref: "tab-7",
    workspaceId: "ws/one",
    sent,
    session: {
      async send(method, params) {
        sent.push([method, params]);
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 5000 } };
        if (method === "Page.captureScreenshot") return { data: fakeImage(800, 5000).toString("base64") };
        throw new Error(`unexpected ${method}`);
      },
    },
    async info() {
      return { ref: "tab-7", kind: "preview", url: "http://localhost:3000/", title: "Home", viewport: { width: 800, height: 600 }, devicePixelRatio: 2 };
    },
    async evaluate(expression) {
      sent.push(["evaluate", expression.length]);
      return element;
    },
    async captureViewport() {
      return fakeImage(1600, 1200);
    },
    async showActivity() {},
  };
}

async function pipeline(lib) {
  const normalize = lib.normalizeScreenshotRequest;
  assert.deepEqual(normalize({}), lib.SCREENSHOT_DEFAULTS);
  assert.equal(normalize({ format: "jpeg", quality: 250 }).quality, 100);
  assert.equal(normalize({}, { format: "jpeg", maxWidth: 1280 }).maxWidth, 1280, "a tool supplies its own defaults");
  assert.equal(normalize({ maxWidth: undefined }, { maxWidth: 1280 }).maxWidth, 1280);
  for (const [raw, message] of [
    [{ format: "gif" }, /format/],
    [{ scale: 0 }, /scale/],
    [{ maxWidth: 4 }, /maxWidth/],
    [{ clip: { x: 0, y: 0, width: 0, height: 10 } }, /clip/],
    [{ clip: { x: 0, y: 0, width: 10, height: 10 }, fullPage: true }, /at most one/],
    [{ selector: "#a", fullPage: true }, /at most one/],
  ]) {
    assert.throws(() => normalize(raw), (error) => error instanceof lib.ScreenshotOptionError && message.test(error.message));
  }

  assert.deepEqual(lib.cssRectToImage({ x: 10, y: 20, width: 100, height: 50 }, { width: 800, height: 600 }, { width: 1600, height: 1200 }), { x: 20, y: 40, width: 200, height: 100 });
  assert.deepEqual(lib.cssRectToImage({ x: -50, y: 580, width: 100, height: 100 }, { width: 800, height: 600 }, { width: 1600, height: 1200 }), { x: 0, y: 1160, width: 100, height: 40 }, "clamped to the image");
  assert.equal(lib.cssRectToImage({ x: 900, y: 0, width: 10, height: 10 }, { width: 800, height: 600 }, { width: 800, height: 600 }), null);
  assert.deepEqual(lib.outputSize({ width: 800, height: 600 }, 1, null), { width: 800, height: 600 });
  assert.deepEqual(lib.outputSize({ width: 800, height: 600 }, 0.5, null), { width: 400, height: 300 });
  assert.deepEqual(lib.outputSize({ width: 2000, height: 1000 }, 1, 1280), { width: 1280, height: 640 });

  // A viewport shot on a 2x display comes back at CSS size by default.
  const viewport = await lib.captureScreenshot(fakeTarget(), normalize({ format: "jpeg", quality: 70 }), { codec: fakeCodec });
  assert.equal(viewport.mimeType, "image/jpeg");
  assert.deepEqual(viewport.imageSize, { width: 800, height: 600 });
  assert.deepEqual(viewport.scale, { x: 1, y: 1 });
  assert.deepEqual(readFake(Buffer.from(viewport.data, "base64")).ops, [["resize", { width: 800, height: 600 }], ["encode", "jpeg", 70]]);
  assert.ok(viewport.path.startsWith(path.join(HOME, "workspace-data", "ws_one", "browser", "screenshots")), viewport.path);
  assert.ok(viewport.path.endsWith(".jpg"));
  assert.deepEqual(readFake(fs.readFileSync(viewport.path)), readFake(Buffer.from(viewport.data, "base64")), "the saved file is the returned image");

  const clipped = await lib.captureScreenshot(fakeTarget(), normalize({ clip: { x: 100, y: 100, width: 200, height: 100 }, scale: 2, save: false }), { codec: fakeCodec });
  assert.equal(clipped.path, null);
  assert.deepEqual(clipped.region, { x: 100, y: 100, width: 200, height: 100 });
  assert.deepEqual(clipped.imageSize, { width: 400, height: 200 });
  assert.deepEqual(readFake(Buffer.from(clipped.data, "base64")).ops, [["crop", { x: 200, y: 200, width: 400, height: 200 }], ["encode", "png", 80]], "device pixels already match scale 2: no resize");

  const element = { ref: "@a-1", selector: "#hero", tag: "section", role: "generic", name: "", text: "", attributes: {}, box: { x: 0, y: 50, width: 800, height: 300, pageX: 0, pageY: 50, visible: true, inViewport: true } };
  const target = fakeTarget({ element });
  const shot = await lib.captureScreenshot(target, normalize({ selector: "#hero", maxWidth: 400, save: false }), { codec: fakeCodec });
  assert.equal(shot.element.selector, "#hero");
  assert.deepEqual(shot.imageSize, { width: 400, height: 150 });
  assert.ok(target.sent.some(([method]) => method === "evaluate"), "the element box comes from the locator");
  await assert.rejects(
    lib.captureScreenshot(fakeTarget({ element: { ...element, box: { ...element.box, visible: false } } }), normalize({ selector: "#hero" }), { codec: fakeCodec }),
    /not visible/,
  );

  const fullTarget = fakeTarget();
  const full = await lib.captureScreenshot(fullTarget, normalize({ fullPage: true, scale: 0.25, save: false }), { codec: fakeCodec });
  assert.deepEqual(full.imageSize, { width: 200, height: 1250 });
  assert.equal(full.fullPage, true);
  assert.deepEqual(fullTarget.sent.find(([method]) => method === "Page.captureScreenshot")[1].clip, { x: 0, y: 0, width: 800, height: 5000, scale: 1 });
}

async function locatorInChromium(lib) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium locator checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  try {
    const html = `<!doctype html><title>t</title><style>body{margin:0}.row{height:40px}</style>
      <nav><a href="/docs" id="docs">Docs</a><a href="/blog" class="css-1x2y3z">Blog</a></nav>
      <main>
        <div class="row card"><button>Save</button><button aria-label="Close dialog"><svg><title>x</title></svg></button></div>
        <div class="row card"><button>Save</button><label>Email <input name="email" type="email"></label></div>
        <ul><li>a</li><li>b</li><li><a href="/search" data-testid="search-link"><img alt="Search" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></li></ul>
        <div style="height:2000px"></div><p id="far">Far away</p>
      </main>`;
    const { targetId } = await chromium.newPage(`data:text/html,${encodeURIComponent(html)}`);
    const transport = chromium.transportFor(targetId);
    await transport.attach();
    const target = {
      async evaluate(expression) {
        const result = await transport.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
    };
    for (let i = 0; i < 100 && (await target.evaluate("document.readyState + ':' + !!document.getElementById('far')")) !== "complete:true"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const all = await lib.runLocator(target, (_args, locator) =>
      Array.from(document.querySelectorAll("a, button, input, li, p")).map((el) => {
        const description = locator.describe(el);
        return { ...description, unique: document.querySelectorAll(description.selector).length === 1 && document.querySelector(description.selector) === el, resolved: locator.resolve(description.ref) === el };
      }), {});
    for (const item of all) {
      assert.ok(item.unique, `${item.selector} matches exactly its element`);
      assert.ok(item.resolved, `${item.ref} resolves back to its element`);
    }
    const by = (predicate) => all.find(predicate);
    assert.equal(by((item) => item.name === "Docs").selector, "#docs");
    assert.equal(by((item) => item.name === "Docs").target.endsWith("/docs"), true, "links report where they lead");
    assert.ok(!by((item) => item.name === "Blog").selector.includes("css-1x2y3z"), "generated class names stay out of selectors");
    const close = by((item) => item.name === "Close dialog");
    assert.equal(close.role, "button");
    const search = by((item) => item.attributes["data-testid"] === "search-link");
    assert.equal(search.selector, 'a[data-testid="search-link"]');
    assert.equal(search.name, "Search", "an icon-only link is named by its image");
    assert.equal(by((item) => item.tag === "input").role, "textbox");
    assert.equal(by((item) => item.tag === "input").name, "Email");
    assert.equal(by((item) => item.tag === "input").selector, 'input[name="email"]');
    const saves = all.filter((item) => item.name === "Save");
    assert.equal(saves.length, 2);
    assert.notEqual(saves[0].selector, saves[1].selector);

    const far = await lib.locateElement(target, "#far");
    assert.equal(far.box.inViewport, false);
    const scrolled = await lib.locateElement(target, "#far", { scrollIntoView: true });
    assert.equal(scrolled.box.inViewport, true, "scrollIntoView brings it on screen");
    assert.equal(scrolled.box.pageY, far.box.pageY, "page coordinates do not move with scrolling");
    await target.evaluate("scrollTo(0, 0)");
    const hit = await lib.elementAtPoint(target, 5, 5);
    assert.equal(hit.name, "Docs", "the element under a point");
    await assert.rejects(lib.locateElement(target, "#missing"), /No element matches/);
    await assert.rejects(lib.locateElement(target, "button"), /Ambiguous selector/);
  } finally {
    await chromium.close();
  }
}

(async () => {
  try {
    const lib = load(await bundle(`
      export * from "./screenshot";
      export * from "./locator";
    `));
    await pipeline(lib);
    await locatorInChromium(lib);
    console.log("browser screenshot pipeline and element locator: options, crop and scale, saved files, real-page selectors");
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
