"use strict";
// The capture features on a real Chromium page served over HTTP, through the
// same DevTools protocol session interface a Chrome tab uses: element and
// full-page screenshots, a before/after diff that finds the changed box and
// survives a reload, phone/tablet/desktop in light and dark in one image
// with the tab put back as it was, and a recording decoded frame by frame
// (plus WebM when ffmpeg is installed). Prints SKIP without a Chromium.
//
//   node scripts/test-browser-capture-chromium.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { loadCaptureLib, pngBitmapCodec, pngImageCodec, decodePng, decodeGif, pixel, near } = require("./fixtures/capture-lib.cjs");

const PAGE = `<!doctype html><title>Capture fixture</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; background: rgb(250, 240, 230); font: 16px sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: rgb(10, 20, 30); } }
  #bar { height: 40px; background: rgb(0, 128, 0); }
  @media (max-width: 500px) { #bar { background: rgb(200, 0, 0); } }
  #box { position: absolute; left: 100px; top: 100px; width: 120px; height: 60px; background: rgb(31, 151, 211); }
  #tick { position: absolute; left: 10px; top: 200px; width: 50px; height: 50px; background: rgb(0, 0, 0); }
  #tall { position: absolute; top: 0; left: 0; width: 1px; height: 2400px; }
</style>
<div id="bar"></div><div id="box"></div><div id="tick"></div><div id="tall"></div>`;

function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/app` })));
}

function makeTarget(lib, chromium, targetId) {
  const session = new lib.CdpSession(`test:${targetId}`, chromium.transportFor(targetId));
  const target = {
    kind: "chrome",
    ref: "chrome:7",
    session,
    workspaceId: "ws-real",
    async info() {
      const m = await target.evaluate("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, url: location.href, title: document.title })");
      return { ref: target.ref, kind: "chrome", url: m.url, title: m.title, viewport: { width: m.w, height: m.h }, devicePixelRatio: m.dpr };
    },
    evaluate: (expression, options) => lib.evaluateOverCdp(session, expression, options),
    async captureViewport() {
      const shot = await session.send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(shot.data, "base64");
    },
    async showActivity() {},
  };
  return target;
}

async function waitFor(check, label, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function screenshots(lib, target, imageCodec) {
  const element = await lib.captureScreenshot(target, lib.normalizeScreenshotRequest({ selector: "#box", save: false }), { codec: imageCodec });
  assert.deepEqual(element.imageSize, { width: 120, height: 60 }, "an element shot is the element's box");
  assert.equal(element.element.selector, "#box");
  assert.ok(near(pixel(decodePng(Buffer.from(element.data, "base64")), 60, 30), [31, 151, 211]));
  const full = await lib.captureScreenshot(target, lib.normalizeScreenshotRequest({ fullPage: true, scale: 0.25 }), { codec: imageCodec });
  assert.equal(full.imageSize.height, 600, "a full page covers the whole document (2400 CSS px at scale 0.25)");
  assert.ok(fs.existsSync(full.path));
  const region = await lib.captureScreenshot(target, lib.normalizeScreenshotRequest({ clip: { x: 90, y: 90, width: 40, height: 20 }, scale: 3, save: false }), { codec: imageCodec });
  assert.deepEqual(region.imageSize, { width: 120, height: 60 }, "a zoomed region");
  assert.deepEqual(region.scale, { x: 3, y: 3 });
}

async function compare(lib, target, codecs) {
  const saved = await lib.runCompare(target, { mode: "baseline" }, codecs);
  assert.match(saved.name, /^127\.0\.0\.1:\d+\/app@\d+x\d+$/, "the default name is the page and the viewport");
  assert.ok(fs.existsSync(saved.path));
  const same = await lib.runCompare(target, { format: "png" }, codecs);
  assert.equal(same.percent, 0);
  assert.equal(same.summary, "No visible change.");
  assert.equal(same.dataUrl, undefined, "no image when nothing changed");

  await target.evaluate("document.getElementById('box').style.background = 'rgb(240, 90, 20)'");
  const changed = await lib.runCompare(target, { mode: "diff", format: "png" }, codecs);
  assert.ok(changed.percent > 0);
  assert.equal(changed.regions.length, 1, JSON.stringify(changed.regions));
  const [box] = changed.regions;
  assert.ok(Math.abs(box.x - 100) <= 1 && Math.abs(box.y - 100) <= 1 && Math.abs(box.width - 120) <= 2 && Math.abs(box.height - 60) <= 2, `the changed region is the box: ${JSON.stringify(box)}`);
  assert.equal(changed.regionsIn, "viewport CSS pixels");
  assert.match(changed.dataUrl, /^data:image\/png;base64,/);
  assert.ok(fs.existsSync(changed.path) && fs.existsSync(changed.currentPath) && fs.existsSync(changed.baselinePath));
  const marked = decodePng(fs.readFileSync(changed.path));
  assert.ok(near(pixel(marked, 150, 120), [235, 28, 92], 2), "the diff image marks the change");

  // The baseline is on disk, so a reload (or a new session) still compares.
  await target.session.send("Page.reload");
  await waitFor(async () => (await target.evaluate("document.readyState")) === "complete" && (await target.evaluate("getComputedStyle(box).backgroundColor")) === "rgb(31, 151, 211)", "the reload");
  const reloaded = await lib.runCompare(target, { format: "png" }, codecs);
  assert.equal(reloaded.percent, 0, `after a reload the page matches its baseline again: ${JSON.stringify(reloaded.regions)}`);

  const named = await lib.runCompare(target, { mode: "baseline", name: "hero box", selector: "#box" }, codecs);
  assert.equal(named.imageSize.width, 120);
  await target.evaluate("document.getElementById('box').style.boxShadow = 'inset 0 0 0 10px rgb(0, 0, 0)'");
  const element = await lib.runCompare(target, { name: "hero box", format: "png" }, codecs);
  assert.ok(element.percent > 30, `an element diff reuses the baseline's selector (${element.percent}%)`);
  assert.ok(element.regions[0].x >= 100 && element.regions[0].y >= 100, "element regions are placed in the viewport");
  const listed = await lib.runCompare(target, { mode: "list" }, codecs);
  assert.deepEqual(listed.baselines.map((meta) => meta.name).sort(), ["hero box", saved.name].sort());
  await assert.rejects(lib.runCompare(target, { name: "nope" }, codecs), (error) => error instanceof lib.CompareOptionError && /hero box/.test(error.message));
  await target.evaluate("document.getElementById('box').style.boxShadow = ''");
}

async function sizes(lib, target, codecs) {
  const before = await target.evaluate("({ w: innerWidth, h: innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches })");
  await target.evaluate("scrollTo(0, 0)");
  const result = await lib.runCompare(target, { mode: "sizes", colorScheme: "both", format: "png" }, codecs);
  assert.equal(result.tiles.length, 6);
  const sheet = decodePng(Buffer.from(result.dataUrl.split(",")[1], "base64"));
  assert.deepEqual(result.imageSize, { width: sheet.width, height: sheet.height });
  assert.ok(sheet.width <= 1600);
  const at = (tile, cssX, cssY) => {
    const scale = tile.box.width / tile.width;
    return pixel(sheet, Math.round(tile.box.x + cssX * scale), Math.round(tile.box.y + cssY * scale));
  };
  const [phone, tablet, desktop, darkPhone, , darkDesktop] = result.tiles;
  assert.ok(near(at(phone, 200, 15), [200, 0, 0]), `the phone gets the narrow layout: ${at(phone, 200, 15)}`);
  assert.ok(near(at(tablet, 200, 15), [0, 128, 0]), "the tablet gets the wide layout");
  assert.ok(near(at(desktop, 700, 15), [0, 128, 0]));
  assert.ok(near(at(phone, 300, 700), [250, 240, 230]), "light row");
  assert.ok(near(at(darkPhone, 300, 700), [10, 20, 30]), `dark row: ${at(darkPhone, 300, 700)}`);
  assert.ok(near(at(darkDesktop, 1200, 800), [10, 20, 30]));
  assert.ok(fs.existsSync(result.path));
  const after = await target.evaluate("({ w: innerWidth, h: innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches })");
  assert.deepEqual(after, before, "the tab's size and color scheme are put back");
}

// A Codara tab only paints its on-screen surface, so its captures go through
// the protocol's viewport override instead (capture/surface.ts). The same
// engine runs here, so the tiles, the zoom and the sizes are checked for
// where they land.
async function throughSurface(lib, target, codecs) {
  const surfaceTarget = { ...target, kind: "preview" };
  const viewport = await target.evaluate("({ w: innerWidth, h: innerHeight })");
  await target.evaluate(`(() => {
    const deep = document.createElement("div");
    deep.id = "deep";
    deep.style.cssText = "position:absolute;left:0;top:1500px;width:200px;height:100px;background:rgb(128,0,128)";
    document.body.appendChild(deep);
    const screenHigh = document.createElement("div");
    screenHigh.id = "screen-high";
    screenHigh.style.cssText = "position:absolute;left:300px;top:0;width:60px;height:100vh;background:rgb(255,200,0)";
    document.body.appendChild(screenHigh);
    const pinned = document.createElement("div");
    pinned.id = "pinned";
    pinned.style.cssText = "position:fixed;left:500px;top:0;width:60px;height:60px;background:rgb(0,200,200)";
    document.body.appendChild(pinned);
    scrollTo(0, 30);
  })()`);
  const full = await lib.captureScreenshot(surfaceTarget, lib.normalizeScreenshotRequest({ fullPage: true, scale: 0.25, save: false }), { codec: codecs.image, bitmap: codecs.bitmap });
  assert.equal(full.imageSize.height, 600, "the stitched page covers the whole document");
  const page = decodePng(Buffer.from(full.data, "base64"));
  assert.ok(near(pixel(page, 5, Math.round(1550 * 0.25)), [128, 0, 128]), `a tile far down lands in place: ${pixel(page, 5, Math.round(1550 * 0.25))}`);
  assert.ok(near(pixel(page, Math.round(35 * 0.25), Math.round(225 * 0.25)), [0, 0, 0]), "the first tile");
  const seam = Math.round((viewport.h + 10) * 0.25);
  assert.ok(near(pixel(page, 100, seam), [250, 240, 230]), `the second tile starts below the first, not over it: ${pixel(page, 100, seam)}`);
  // A 100vh element stays one screen tall, as in Chrome's own full-page
  // capture, and a fixed element shows once, not in every screen.
  assert.ok(near(pixel(page, Math.round(330 * 0.25), Math.round((viewport.h - 20) * 0.25)), [255, 200, 0]), "the screen-high element fills the first screen");
  assert.ok(near(pixel(page, Math.round(330 * 0.25), Math.round((viewport.h + 60) * 0.25)), [250, 240, 230]), `and ends there: ${pixel(page, Math.round(330 * 0.25), Math.round((viewport.h + 60) * 0.25))}`);
  assert.ok(near(pixel(page, Math.round(530 * 0.25), Math.round(30 * 0.25)), [0, 200, 200]), "the fixed element is at the top");
  assert.ok(near(pixel(page, Math.round(530 * 0.25), Math.round((viewport.h + 30) * 0.25)), [250, 240, 230]), "and not repeated below");
  assert.deepEqual(
    await target.evaluate("[scrollY, document.getElementById('pinned').style.visibility]"),
    [30, ""],
    "the scroll position and the fixed element are put back",
  );
  await target.evaluate("document.getElementById('screen-high').remove(); document.getElementById('pinned').remove()");

  await target.evaluate("scrollTo(0, 50)");
  const zoomed = await lib.captureScreenshot(surfaceTarget, lib.normalizeScreenshotRequest({ clip: { x: 90, y: 40, width: 40, height: 20 }, scale: 3, save: false }), { codec: codecs.image, bitmap: codecs.bitmap });
  assert.deepEqual(zoomed.imageSize, { width: 120, height: 60 });
  assert.deepEqual(zoomed.region, { x: 90, y: 40, width: 40, height: 20 });
  const zoom = decodePng(Buffer.from(zoomed.data, "base64"));
  assert.ok(near(pixel(zoom, 5, 5), [250, 240, 230]), `a zoomed region of a scrolled page starts at its clip: ${pixel(zoom, 5, 5)}`);
  assert.ok(near(pixel(zoom, 100, 50), [31, 151, 211]), `and shows the box: ${pixel(zoom, 100, 50)}`);
  // The edge between page and box stays one rendered pixel wide, not three.
  const edge = [27, 28, 29, 30, 31, 32, 33].map((x) => pixel(zoom, x, 50)).filter((rgb) => !near(rgb, [250, 240, 230]) && !near(rgb, [31, 151, 211]));
  assert.ok(edge.length <= 1, `the region is rendered at its zoom, not enlarged: ${JSON.stringify(edge)}`);
  await target.evaluate("scrollTo(0, 0); document.getElementById('deep').remove()");
  const after = await target.evaluate("({ w: innerWidth, h: innerHeight })");
  assert.deepEqual(after, viewport, "the override is cleared");

  await sizes(lib, surfaceTarget, codecs);
}

async function record(lib, target, codec) {
  const deps = { codec, frameFormat: "png", frameFromPng: async (png) => png };
  await target.evaluate(`window.__ticks = 0; window.__timer = setInterval(() => {
    const tick = document.getElementById("tick");
    tick.style.background = ["rgb(255, 0, 0)", "rgb(0, 160, 0)", "rgb(0, 0, 255)"][window.__ticks++ % 3];
  }, 150)`);
  await lib.startRecording(target, lib.normalizeRecordOptions({ fps: 10, maxWidth: 400 }), deps);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const gif = await lib.stopRecording(target);
  const decoded = decodeGif(fs.readFileSync(gif.path));
  assert.ok(decoded.frames.length >= 5, `the animation was recorded (${decoded.frames.length} frames)`);
  assert.ok(decoded.width <= 400, "frames respect maxWidth");
  assert.ok(gif.durationMs >= 1400 && gif.durationMs < 4000, `duration ${gif.durationMs}`);
  const { viewport } = await target.info();
  const scale = decoded.width / viewport.width;
  const colors = new Set(decoded.frames.map((frame) => pixel({ width: decoded.width, rgba: frame.rgba }, Math.round(35 * scale), Math.round(225 * scale)).join(",")));
  assert.ok(colors.size >= 2, `frames show the box changing: ${[...colors].join(" | ")}`);

  const ffmpeg = lib.findFfmpeg();
  if (!ffmpeg) {
    console.log("SKIP WebM recording: no ffmpeg on PATH");
  } else {
    await lib.startRecording(target, lib.normalizeRecordOptions({ fps: 8, format: "webm", maxWidth: 320 }), { ...deps, ffmpeg: () => ffmpeg });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const webm = await lib.stopRecording(target);
    assert.equal(webm.format, "webm");
    assert.equal(webm.mimeType, "video/webm");
    assert.ok(webm.path.endsWith(".webm") && webm.bytes > 200);
    const magic = fs.readFileSync(webm.path).subarray(0, 4).toString("hex");
    assert.equal(magic, "1a45dfa3", "an EBML (WebM) file");
    try {
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", webm.path], { encoding: "utf8" }));
      assert.match(probe.streams[0].codec_name, /^vp[89]$/);
      assert.equal(probe.streams[0].width % 2, 0);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await target.evaluate("clearInterval(window.__timer)");
}

(async () => {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium capture checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const { lib, cleanup } = await loadCaptureLib();
  const { server, url } = await serve();
  try {
    const { targetId } = await chromium.newPage(url);
    const target = makeTarget(lib, chromium, targetId);
    await waitFor(async () => (await target.evaluate("document.readyState")) === "complete" && (await target.evaluate("!!document.getElementById('tall')")), "the fixture page");
    const imageCodec = pngImageCodec(lib);
    const codecs = { bitmap: pngBitmapCodec, image: imageCodec };
    await screenshots(lib, target, imageCodec);
    await compare(lib, target, codecs);
    await sizes(lib, target, codecs);
    await throughSurface(lib, target, codecs);
    await record(lib, target, pngBitmapCodec);
    target.session.dispose();
    console.log("browser capture on real Chromium: element, full-page and zoomed shots, diff regions across a reload, sizes in light and dark, recordings");
  } finally {
    server.close();
    await chromium.close();
    cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
