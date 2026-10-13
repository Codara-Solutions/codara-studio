"use strict";
// The capture features without a browser: bitmap composition, the pixel diff
// and its regions, baselines on disk, the side-by-side sizes sheet, the GIF
// encoder (decoded back pixel by pixel, on the worker thread too), and the
// recorder's frame sampling, background fallback and limits against a fake
// tab. Real pages are covered by test-browser-capture-chromium.cjs and the
// preview-capture e2e spec.
//
//   node scripts/test-browser-capture.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadCaptureLib, encodePng, pngBitmapCodec, decodeGif, pixel, near } = require("./fixtures/capture-lib.cjs");

function solid(lib, width, height, rgb) {
  return lib.createBitmap(width, height, [...rgb, 255]);
}

function bitmaps(lib) {
  const red = solid(lib, 4, 2, [255, 0, 0]);
  const canvas = solid(lib, 10, 6, [0, 0, 255]);
  lib.blit(canvas, red, 8, 5);
  assert.deepEqual(pixel(canvas, 9, 5), [255, 0, 0], "blit clips at the edge");
  assert.deepEqual(pixel(canvas, 7, 5), [0, 0, 255]);
  lib.blit(canvas, red, -2, -1);
  assert.deepEqual(pixel(canvas, 0, 0), [255, 0, 0], "negative offsets clip too");
  assert.deepEqual(pixel(canvas, 2, 0), [0, 0, 255]);
  const cropped = lib.cropBitmap(canvas, { x: 8, y: 4, width: 5, height: 5 });
  assert.deepEqual([cropped.width, cropped.height], [2, 2], "crop is clamped to the source");

  const stripes = lib.createBitmap(4, 1);
  stripes.data.set([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const half = lib.scaleBitmap(stripes, { width: 2, height: 1 });
  assert.deepEqual(pixel(half, 0, 0), [128, 128, 128], "shrinking averages, so thin lines fade instead of vanishing");
  assert.deepEqual(lib.fitSize({ width: 2000, height: 1000 }, { width: 1000 }), { width: 1000, height: 500 });
  assert.deepEqual(lib.fitSize({ width: 200, height: 1000 }, { width: 1000, height: 500 }), { width: 100, height: 500 });

  const label = lib.createBitmap(80, 20);
  const width = lib.drawText(label, "390x844", 1, 1, [0, 0, 0, 255], 1);
  assert.equal(width, lib.textWidth("390x844", 1));
  let ink = 0;
  for (let i = 0; i < label.data.length; i += 4) if (label.data[i] === 0) ink += 1;
  assert.ok(ink > 40 && ink < 7 * 6 * 7, `the label draws glyphs (${ink} dark pixels)`);
}

function diffs(lib) {
  const before = solid(lib, 100, 80, [240, 240, 240]);
  assert.equal(lib.diffBitmaps(before, solid(lib, 100, 80, [240, 240, 240])).changedPixels, 0);
  assert.equal(lib.diffBitmaps(before, solid(lib, 100, 80, [242, 241, 240])).changedPixels, 0, "a barely different shade is not a change");

  const after = solid(lib, 100, 80, [240, 240, 240]);
  lib.fillRect(after, { x: 10, y: 20, width: 30, height: 10 }, [20, 90, 200, 255]);
  lib.fillRect(after, { x: 70, y: 60, width: 5, height: 5 }, [200, 0, 0, 255]);
  const result = lib.diffBitmaps(before, after);
  assert.equal(result.changedPixels, 30 * 10 + 25);
  assert.equal(result.percent, Math.round(((325) / 8000) * 10000) / 100);
  assert.equal(result.regions.length, 2);
  assert.deepEqual(result.regions[0], { x: 10, y: 20, width: 30, height: 10, changedPixels: 300 }, "regions are tight boxes, largest first");
  assert.deepEqual(result.regions[1], { x: 70, y: 60, width: 5, height: 5, changedPixels: 25 });
  assert.equal(lib.diffBitmaps(before, after, { threshold: 1 }).changedPixels, 0, "threshold 1 ignores every color change");

  const grown = solid(lib, 100, 100, [240, 240, 240]);
  const tall = lib.diffBitmaps(before, grown);
  assert.equal(tall.sizeChanged, true);
  assert.equal(tall.changedPixels, 100 * 20, "the area only the bigger image covers is changed");
  assert.deepEqual(tall.regions[0], { x: 0, y: 80, width: 100, height: 20, changedPixels: 2000 });

  const picture = lib.renderDiff(after, result);
  assert.deepEqual(pixel(picture, 15, 25), [235, 28, 92], "changed pixels are highlighted");
  const faded = pixel(picture, 50, 5);
  assert.ok(faded[0] > 240 && faded[0] === faded[1], "unchanged pixels fade to gray");
  assert.deepEqual(pixel(picture, 8, 18), [235, 28, 92], "each region is boxed");

  assert.equal(lib.defaultBaselineName({ url: "http://localhost:3000/settings/", viewport: { width: 1280, height: 720 } }), "localhost:3000/settings@1280x720");
  assert.equal(lib.defaultBaselineName({ url: "http://localhost:3000/", viewport: { width: 390, height: 844 }, fullPage: true }), "localhost:3000@390x844-full");
  assert.equal(lib.defaultBaselineName({ url: "http://a.test/x", viewport: null, selector: "#hero" }), "a.test/x-#hero");
  assert.equal(lib.baselineKey("Home Page @ 390x844"), "home-page-@-390x844");
  assert.throws(() => lib.baselineKey("///"), /letter or digit/);
}

async function baselines(lib, home) {
  const meta = {
    name: "localhost:3000/@800x600",
    url: "http://localhost:3000/",
    title: "Home",
    viewport: { width: 800, height: 600 },
    imageSize: { width: 800, height: 600 },
    capture: { fullPage: false, selector: null, clip: null },
    savedAt: new Date().toISOString(),
  };
  const png = encodePng(solid(lib, 2, 2, [1, 2, 3]));
  const saved = await lib.saveBaseline("ws/a", meta, png);
  assert.ok(saved.path.startsWith(path.join(home, "workspace-data", "ws_a", "browser", "baselines")), "baselines live in Codara's data folder, never the repository");
  const loaded = await lib.loadBaseline("ws/a", "LOCALHOST:3000/@800x600");
  assert.deepEqual(loaded.png, png, "names are matched by their key");
  assert.equal(loaded.meta.url, meta.url);
  assert.equal(await lib.loadBaseline("ws/a", "missing"), null);
  assert.equal(await lib.loadBaseline("ws/b", meta.name), null, "baselines are per workspace");
  assert.deepEqual((await lib.listBaselines("ws/a")).map((item) => item.name), [meta.name]);
  assert.equal(await lib.deleteBaseline("ws/a", meta.name), true);
  assert.deepEqual(await lib.listBaselines("ws/a"), []);
}

function sizes(lib) {
  assert.deepEqual(lib.normalizeSizes(undefined).map((size) => size.name), ["phone", "tablet", "desktop"]);
  assert.deepEqual(lib.normalizeSizes(["tablet", "1024x768"]), [
    { name: "tablet", width: 820, height: 1180, mobile: true },
    { name: "1024x768", width: 1024, height: 768, mobile: false },
  ]);
  assert.deepEqual(lib.normalizeSizes([{ name: "watch", width: 200, height: 240 }])[0], { name: "watch", width: 200, height: 240, mobile: true });
  for (const [raw, message] of [[[], /non-empty/], [["huge"], /Unknown size/], [["50x50"], /between/], [new Array(7).fill("phone"), /at most 6/]]) {
    assert.throws(() => lib.normalizeSizes(raw), (error) => error instanceof lib.SizesOptionError && message.test(error.message));
  }
  assert.deepEqual(lib.normalizeSchemes(undefined), [null]);
  assert.deepEqual(lib.normalizeSchemes("both"), ["light", "dark"]);
  assert.throws(() => lib.normalizeSchemes("sepia"), /colorScheme/);

  const presets = lib.normalizeSizes(undefined);
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    for (const preset of presets) shots.push({ preset, scheme, bitmap: solid(lib, preset.width, preset.height, scheme === "light" ? [250, 250, 250] : [20, 20, 20]) });
  }
  const { sheet, tiles, scale } = lib.composeSizesSheet(shots, 1600);
  assert.ok(sheet.width <= 1600, `the sheet fits maxWidth (${sheet.width})`);
  assert.equal(tiles.length, 6);
  assert.ok(scale < 1 && scale > 0.5, "one scale for every tile");
  const [phone, tablet, desktop, darkPhone] = tiles;
  assert.equal(phone.box.y, tablet.box.y, "a scheme is one row");
  assert.ok(phone.box.x < tablet.box.x && tablet.box.x < desktop.box.x, "sizes in order");
  assert.ok(darkPhone.box.y > phone.box.y + phone.box.height, "dark is the second row");
  assert.equal(Math.round(desktop.box.width / phone.box.width * 100), Math.round(1440 / 390 * 100), "tiles keep their relative sizes");
  assert.deepEqual(pixel(sheet, phone.box.x + 5, phone.box.y + 5), [250, 250, 250]);
  assert.deepEqual(pixel(sheet, darkPhone.box.x + 5, darkPhone.box.y + 5), [20, 20, 20]);
  assert.deepEqual(pixel(sheet, desktop.box.x + desktop.box.width + 5 > sheet.width - 1 ? 2 : desktop.box.x + desktop.box.width + 5, 2), [226, 229, 234], "the sheet background");
}

// A sizes capture drives the tab's media and metrics itself, then puts back
// the agent's own dark mode, reduced motion and device size, and the resize
// watcher stays out of its way meanwhile.
async function sizesKeepEmulation(lib) {
  const sent = [];
  const listeners = new Map();
  const session = {
    key: "chrome:test-sizes",
    isDisposed: false,
    isAttached: () => true,
    hold() {},
    onDetach() { return () => {}; },
    on(method, listener) { listeners.set(method, listener); return () => listeners.delete(method); },
    async send(method, params) {
      if (method === "Runtime.evaluate") return { result: { value: [2560, 1] } };
      sent.push([method, params]);
      if (method === "Page.captureScreenshot") {
        return { data: encodePng(solid(lib, params.clip.width, params.clip.height, [200, 200, 200])).toString("base64") };
      }
      return {};
    },
  };
  const target = {
    kind: "chrome",
    session,
    async evaluate(expression) {
      // The page's frame resizes under the capture's own override, while it settles.
      if (expression.includes("getBoundingClientRect")) listeners.get("Page.frameResized")?.({});
      if (expression.includes("scrollX")) return { x: 0, y: 0 };
      return undefined;
    },
  };
  await lib.applyEmulation(target, { colorScheme: "dark", reducedMotion: true, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, mobile: true });
  sent.length = 0;
  const shots = await lib.captureSizes(target, lib.normalizeSizes(["phone"]), [null], pngBitmapCodec);
  assert.equal(shots.length, 1);
  const media = sent.filter(([method]) => method === "Emulation.setEmulatedMedia").map(([, params]) => params.features);
  assert.deepEqual(media[0], [
    { name: "prefers-color-scheme", value: "dark" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ], "the capture keeps the agent's own scheme and reduced motion");
  assert.deepEqual(media.at(-1), media[0], "and sends them again afterwards");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const metrics = sent.filter(([method]) => method.includes("DeviceMetrics"));
  assert.deepEqual(metrics.slice(-2), [
    ["Emulation.clearDeviceMetricsOverride", undefined],
    ["Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }],
  ], "the agent's device size comes back last, not cleared");
  assert.equal(metrics.filter(([method]) => method === "Emulation.setDeviceMetricsOverride").length, 2, "the resize watcher did not restore metrics under the capture");
  assert.deepEqual(lib.currentEmulation(target).viewport, { width: 412, height: 915 });
  await lib.applyEmulation(target, {}, { reset: true });
}

async function gif(lib) {
  const width = 40;
  const height = 30;
  const frames = [];
  const first = solid(lib, width, height, [250, 250, 250]);
  lib.fillRect(first, { x: 0, y: 0, width: 20, height: 30 }, [31, 151, 211, 255]);
  frames.push(first);
  const second = { ...first, data: first.data.slice() };
  lib.fillRect(second, { x: 30, y: 10, width: 6, height: 6 }, [211, 71, 41, 255]);
  frames.push(second);
  frames.push({ ...second, data: second.data.slice() });
  const gradient = lib.createBitmap(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) gradient.data.set([x * 6, y * 8, (x * y) % 256, 255], (y * width + x) * 4);
  }
  frames.push(gradient);

  const encoder = lib.createGifEncoder(width, height);
  encoder.addFrame(frames[0].data, 50);
  encoder.addFrame(frames[1].data, 20);
  encoder.addFrame(frames[2].data, 30);
  encoder.addFrame(frames[3].data, 100);
  const bytes = Buffer.from(encoder.finish());
  const decoded = decodeGif(bytes);
  assert.equal(decoded.loops, true, "loops forever");
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  assert.equal(decoded.frames.length, 3, "an unchanged frame is folded into the one before it");
  assert.deepEqual(decoded.frames.map((frame) => frame.delay), [50, 50, 100]);
  assert.deepEqual(decoded.frames[1].box, { left: 30, top: 10, width: 6, height: 6 }, "only the changed box is stored");
  assert.deepEqual(pixel({ width, rgba: decoded.frames[0].rgba }, 5, 5), [31, 151, 211], "flat colors are exact");
  assert.deepEqual(pixel({ width, rgba: decoded.frames[1].rgba }, 32, 12), [211, 71, 41]);
  assert.deepEqual(pixel({ width, rgba: decoded.frames[1].rgba }, 5, 5), [31, 151, 211], "earlier pixels stay");
  let worst = 0;
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const got = pixel({ width, rgba: decoded.frames[2].rgba }, x, y);
      const want = pixel(gradient, x, y);
      const errors = got.map((value, i) => Math.abs(value - want[i]));
      worst = Math.max(worst, ...errors);
      total += errors.reduce((sum, error) => sum + error, 0) / 3;
    }
  }
  const mean = total / (width * height);
  assert.ok(mean <= 8 && worst <= 64, `a 1200-color frame quantizes closely (mean channel error ${mean.toFixed(1)}, worst ${worst})`);

  // A frame big enough to fill the LZW table several times over.
  const big = lib.createBitmap(300, 200);
  for (let i = 0; i < big.data.length; i += 4) big.data.set([(i * 7) % 256, (i * 13) % 256, (i * 3) % 256, 255], i);
  const bigEncoder = lib.createGifEncoder(300, 200);
  bigEncoder.addFrame(big.data, 10);
  const bigDecoded = decodeGif(Buffer.from(bigEncoder.finish()));
  assert.equal(bigDecoded.frames.length, 1, "table resets decode");

  const worker = lib.startGifWorker(width, height);
  for (const [index, delay] of [[0, 50], [1, 20], [2, 30], [3, 100]]) await worker.addFrame(frames[index].data, delay);
  const fromWorker = await worker.finish();
  assert.deepEqual(fromWorker, bytes, "the worker thread writes the same file");
  assert.throws(() => encoder.addFrame(frames[0].data, 10), /finished/);
  assert.throws(() => lib.createGifEncoder(2, 2).addFrame(new Uint8Array(4), 10), /must be 2x2/);
}

function fakeSession(key) {
  const listeners = new Map();
  const disposeListeners = new Set();
  const sent = [];
  return {
    key,
    sent,
    onDispose(listener) {
      disposeListeners.add(listener);
      return () => disposeListeners.delete(listener);
    },
    dispose() {
      for (const listener of [...disposeListeners]) listener();
      disposeListeners.clear();
    },
    async send(method, params) {
      sent.push(method);
      return {};
    },
    async enable() {
      return async () => {};
    },
    on(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    onDetach() {
      return () => {};
    },
    emit(method, params) {
      listeners.get(method)?.(params, method);
    },
  };
}

const deps = {
  codec: pngBitmapCodec,
  frameFormat: "png",
  frameFromPng: async (png) => png,
  ffmpeg: () => null,
};

async function recorder(lib, home) {
  assert.deepEqual(lib.normalizeRecordOptions({}), lib.RECORD_DEFAULTS);
  for (const [raw, message] of [[{ format: "mp4" }, /format/], [{ fps: 60 }, /fps/], [{ maxSeconds: 600 }, /maxSeconds/], [{ maxWidth: 10 }, /maxWidth/]]) {
    assert.throws(() => lib.normalizeRecordOptions(raw), (error) => error instanceof lib.RecordOptionError && message.test(error.message));
  }

  // A visible tab: frames come from the screencast; the newest frame wins
  // each tick, so the state right before stop is never lost.
  const session = fakeSession("tab-a");
  const target = { ref: "tab-a", session, workspaceId: "ws-rec", captureViewport: async () => { throw new Error("not used"); } };
  const changes = [];
  const off = lib.onRecordingChange((change) => changes.push(change));
  // Frames left behind by a recording the app never finished are dropped;
  // a recent folder may still be in use.
  const framesRoot = path.join(home, "workspace-data", "ws-rec", "browser", "recording-frames");
  fs.mkdirSync(path.join(framesRoot, "crashed"), { recursive: true });
  fs.writeFileSync(path.join(framesRoot, "crashed", "000000.png"), "x");
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(framesRoot, "crashed"), hourAgo, hourAgo);
  fs.mkdirSync(path.join(framesRoot, "recent"));
  const started = await lib.startRecording(target, lib.normalizeRecordOptions({ fps: 10, maxWidth: 160 }), deps);
  assert.equal(started.recording, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(framesRoot, "crashed")), false, "stale frames are removed");
  assert.equal(fs.existsSync(path.join(framesRoot, "recent")), true);
  fs.rmdirSync(path.join(framesRoot, "recent"));
  assert.equal((await lib.startRecording(target, lib.normalizeRecordOptions({}), deps)).already, true, "a second start reports the running recording");
  assert.ok(session.sent.includes("Page.startScreencast"));
  const frame = (rgb) => encodePng(solid(lib, 32, 24, rgb)).toString("base64");
  session.emit("Page.screencastFrame", { data: frame([255, 0, 0]), sessionId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  session.emit("Page.screencastFrame", { data: frame([0, 255, 0]), sessionId: 2 });
  session.emit("Page.screencastFrame", { data: frame([0, 0, 255]), sessionId: 3 });
  assert.ok(session.sent.filter((method) => method === "Page.screencastFrameAck").length >= 3, "every frame is acknowledged");
  assert.deepEqual(lib.recordingStatus(target).frames >= 1, true);
  const result = await lib.stopRecording(target);
  assert.ok(session.sent.includes("Page.stopScreencast"));
  assert.equal(result.format, "gif");
  assert.equal(result.mimeType, "image/gif");
  assert.ok(result.path.startsWith(path.join(home, "workspace-data", "ws-rec", "browser", "recordings")), result.path);
  assert.equal(result.bytes, fs.statSync(result.path).size);
  const decoded = decodeGif(fs.readFileSync(result.path));
  assert.equal(decoded.frames.length, 2, "red, then blue: green was replaced before the next tick");
  assert.deepEqual(pixel({ width: 32, rgba: decoded.frames.at(-1).rgba }, 3, 3), [0, 0, 255], "the last state before stop is the last frame");
  assert.ok(decoded.frames.at(-1).delay >= 100, "the last frame holds before the GIF loops");
  assert.equal(fs.existsSync(path.join(home, "workspace-data", "ws-rec", "browser", "recording-frames")) ? fs.readdirSync(path.join(home, "workspace-data", "ws-rec", "browser", "recording-frames")).length : 0, 0, "frame files are removed");
  await assert.rejects(lib.stopRecording(target), /not being recorded/);
  assert.deepEqual(changes.map((change) => change.recording), [true, false]);
  assert.equal(changes[1].result.path, result.path);
  off();

  // A tab that paints no screencast frames (hidden, minimized window) is
  // captured with its background-safe viewport capture instead; webm
  // without ffmpeg falls back to a GIF and says so.
  const quiet = fakeSession("tab-b");
  let polls = 0;
  const hidden = {
    ref: "tab-b",
    session: quiet,
    workspaceId: "ws-rec",
    captureViewport: async () => encodePng(solid(lib, 20, 20, (polls += 1) < 3 ? [10, 10, 10] : [200, 200, 200])),
  };
  await lib.startRecording(hidden, lib.normalizeRecordOptions({ fps: 10, format: "webm", maxWidth: 160 }), deps);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const fallback = await lib.stopRecording(hidden);
  assert.ok(polls >= 3, `the hidden tab was captured directly (${polls} captures)`);
  assert.equal(fallback.format, "gif");
  assert.match(fallback.note, /ffmpeg/);
  const fallbackFrames = decodeGif(fs.readFileSync(fallback.path)).frames;
  assert.equal(fallbackFrames.length, 2, "identical captures are stored once");

  // An ffmpeg that cannot encode (here node, which rejects ffmpeg's flags)
  // still leaves the flow as a GIF, with no half-written WebM beside it.
  const broken = fakeSession("tab-d");
  const brokenTarget = { ref: "tab-d", session: broken, workspaceId: "ws-rec", captureViewport: async () => encodePng(solid(lib, 20, 20, [5, 5, 5])) };
  await lib.startRecording(brokenTarget, lib.normalizeRecordOptions({ fps: 5, format: "webm" }), { ...deps, ffmpeg: () => process.execPath });
  broken.emit("Page.screencastFrame", { data: frame([7, 7, 7]), sessionId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rescued = await lib.stopRecording(brokenTarget);
  assert.equal(rescued.format, "gif");
  assert.match(rescued.note, /WebM encoding failed/);
  assert.ok(fs.existsSync(rescued.path));
  const recordings = path.join(home, "workspace-data", "ws-rec", "browser", "recordings");
  assert.deepEqual(fs.readdirSync(recordings).filter((name) => name.endsWith(".webm")), []);

  // The time limit stops a forgotten recording; the next stop returns it.
  const limited = fakeSession("tab-c");
  const limitedTarget = { ref: "tab-c", session: limited, workspaceId: "ws-rec", captureViewport: async () => encodePng(solid(lib, 20, 20, [1, 2, 3])) };
  await lib.startRecording(limitedTarget, lib.normalizeRecordOptions({ maxSeconds: 1, fps: 5 }), deps);
  limited.emit("Page.screencastFrame", { data: frame([9, 9, 9]), sessionId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(lib.recordingStatus(limitedTarget), null, "it stopped itself");
  const late = await lib.stopRecording(limitedTarget);
  assert.match(late.stoppedBy, /maxSeconds/);
  assert.ok(fs.existsSync(late.path));

  // A tab that closes mid-recording ends its session without a detach. The
  // recording finishes then, not at its time limit, and a stop that names
  // the closed tab (which no longer resolves to a session) gets it, once.
  const closing = fakeSession("preview-guest:41");
  const closingTarget = { ref: "tab-e", session: closing, workspaceId: "ws-rec", captureViewport: async () => { throw new Error("This browser tab closed."); } };
  await lib.startRecording(closingTarget, lib.normalizeRecordOptions({ maxSeconds: 60, fps: 5 }), deps);
  closing.emit("Page.screencastFrame", { data: frame([4, 4, 4]), sessionId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const closedAt = Date.now();
  closing.dispose();
  const claimed = await lib.claimRecording("tab-e");
  assert.ok(Date.now() - closedAt < 5_000, "it finished when the tab closed");
  assert.equal(claimed.stoppedBy, "the tab closed");
  assert.ok(fs.existsSync(claimed.path));
  assert.equal(lib.claimRecording("tab-e"), null, "the result is handed out once");
  assert.equal(lib.recordingStatus(closingTarget), null);

  // When nobody asked yet, the result waits under the tab's id.
  const closing2 = fakeSession("preview-guest:42");
  const closingTarget2 = { ...closingTarget, ref: "tab-f", session: closing2 };
  await lib.startRecording(closingTarget2, lib.normalizeRecordOptions({ maxSeconds: 60, fps: 5 }), deps);
  closing2.emit("Page.screencastFrame", { data: frame([6, 6, 6]), sessionId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  closing2.dispose();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const kept = await lib.claimRecording("tab-f");
  assert.equal(kept.stoppedBy, "the tab closed");
  assert.equal(lib.claimRecording("tab-f"), null);
}

async function screenshotFormats(lib) {
  const request = lib.normalizeScreenshotRequest({ format: "webp", quality: 55 });
  assert.equal(request.format, "webp");
  const fakeCodec = {
    size: () => ({ width: 100, height: 50 }),
    crop: (image) => image,
    resize: (image) => image,
    encode: async (image, format, quality) => Buffer.from(`${format}:${quality}`),
  };
  const target = {
    kind: "preview",
    ref: "tab-9",
    workspaceId: "ws-shot",
    session: { send: async () => ({}) },
    info: async () => ({ ref: "tab-9", kind: "preview", url: "http://x.test/", title: "X", viewport: { width: 100, height: 50 }, devicePixelRatio: 1 }),
    evaluate: async () => null,
    captureViewport: async () => Buffer.from("png"),
    showActivity: async () => {},
  };
  const shot = await lib.captureScreenshot(target, request, { codec: fakeCodec });
  assert.equal(shot.mimeType, "image/webp");
  assert.ok(shot.path.endsWith(".webp"));
  assert.equal(Buffer.from(shot.data, "base64").toString(), "webp:55", "an async encoder is awaited");
}

async function guestPaint(lib) {
  const sent = [];
  let answer = true;
  lib.setGuestPaintTransport((request) => {
    sent.push(request);
    if (request.hold && answer) setTimeout(() => lib.acknowledgeGuestPaint({ reqId: request.reqId, held: true }), 5);
    return true;
  });
  try {
    const none = await lib.holdGuestPaint({ key: "chrome-tab:12" });
    none();
    assert.equal(sent.length, 0, "a Chrome tab needs no paint lease");

    const release = await lib.holdGuestPaint({ key: "preview-guest:41" });
    assert.deepEqual(sent.map(({ webContentsId, hold }) => ({ webContentsId, hold })), [{ webContentsId: 41, hold: true }]);
    release();
    release();
    assert.deepEqual(sent.map(({ hold }) => hold), [true, false], "a lease is released once");
    assert.equal(sent[1].reqId, sent[0].reqId);

    const order = [];
    const value = await lib.withGuestPaint({ key: "preview-guest:42" }, async () => {
      order.push(sent.at(-1).hold);
      return 7;
    });
    assert.equal(value, 7);
    assert.deepEqual([...order, sent.at(-1).hold], [true, false], "the capture runs inside the lease");

    // No pane answers in time: the capture goes ahead without a lease, and
    // a pane that took it late is told to let it go.
    answer = false;
    const before = sent.length;
    const started = Date.now();
    const orphan = await lib.holdGuestPaint({ key: "preview-guest:43" });
    assert.ok(Date.now() - started >= 1000);
    assert.deepEqual(sent.slice(before).map(({ webContentsId, hold }) => ({ webContentsId, hold })), [
      { webContentsId: 43, hold: true },
      { webContentsId: 43, hold: false },
    ]);
    assert.equal(sent.at(-1).reqId, sent.at(-2).reqId);
    orphan();
    assert.equal(sent.length, before + 2, "the no-op release sends nothing more");
  } finally {
    lib.setGuestPaintTransport(null);
  }
}

(async () => {
  const { lib, home, cleanup } = await loadCaptureLib();
  try {
    bitmaps(lib);
    diffs(lib);
    await baselines(lib, home);
    sizes(lib);
    await sizesKeepEmulation(lib);
    await gif(lib);
    await recorder(lib, home);
    await screenshotFormats(lib);
    await guestPaint(lib);
    console.log("browser capture: bitmaps, pixel diff regions, baselines, sizes sheet, GIF encoder and worker, recorder sampling and fallbacks, webp, background paint leases");
  } finally {
    cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
