// Zoom in file viewers and browser tabs: the steps and wheel math every
// viewer shares, and the router that sends Ctrl+= / Ctrl+- / Ctrl+0 to the
// focused viewer instead of the whole window.
//
//   node scripts/test-viewer-zoom.cjs
//
// Both modules are pure, so they run here as bundled TypeScript. Zoom at the
// pointer, panning and the real key routing are covered by
// tests/e2e/viewer-zoom.spec.ts.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ZOOM = path.join(ROOT, "src", "renderer", "src", "components", "zoom");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: 'export * from "./zoom-math";\nexport * from "./zoom-router";\n',
      resolveDir: ZOOM,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** A fake element tree: each node knows its parent, and contains() walks up. */
function node(parent = null) {
  return {
    parent,
    contains(other) {
      for (let at = other; at; at = at.parent) if (at === this) return true;
      return false;
    },
  };
}

(async () => {
  const zoom = await load();

  await test("steps walk the shared list inside the viewer's range", () => {
    assert.equal(zoom.stepZoom(1, 1, 0.5, 3), 1.1);
    assert.equal(zoom.stepZoom(1, -1, 0.5, 3), 0.9);
    assert.equal(zoom.stepZoom(3, 1, 0.5, 3), 3);
    assert.equal(zoom.stepZoom(0.5, -1, 0.5, 3), 0.5);
    // A zoom between steps (after a pinch) moves to the next step, not past it.
    assert.equal(zoom.stepZoom(1.05, 1, 0.5, 3), 1.1);
    assert.equal(zoom.stepZoom(1.05, -1, 0.5, 3), 1);
    // A fitted image at 37% steps to the list's neighbours and to its own bounds.
    assert.equal(zoom.stepZoom(0.37, 1, 0.1, 16), 0.5);
    assert.equal(zoom.stepZoom(8, 1, 0.1, 16), 16);
    assert.equal(zoom.stepZoom(0.12, -1, 0.07, 16), 0.1);
    assert.equal(zoom.stepZoom(0.1, -1, 0.07, 16), 0.07);
  });

  await test("a mouse notch zooms a fixed amount, a pinch follows its own scale", () => {
    const notchIn = zoom.wheelZoomFactor(-100);
    const notchOut = zoom.wheelZoomFactor(100);
    assert.ok(notchIn > 1.15 && notchIn < 1.3, `notch in ${notchIn}`);
    assert.ok(Math.abs(notchIn * notchOut - 1) < 1e-9, "in then out returns to the start");
    assert.equal(zoom.wheelZoomFactor(-120), notchIn, "a 120px notch is still one notch");
    // A pinch's deltas compose to its scale: ten events of -6.93px are a 2x pinch.
    let pinched = 1;
    for (let i = 0; i < 10; i += 1) pinched *= zoom.wheelZoomFactor(-6.931471805599453);
    assert.ok(Math.abs(pinched - 2) < 1e-9, `pinch ${pinched}`);
    assert.equal(zoom.wheelPixels(3, 1), 120, "line mode");
    assert.equal(zoom.wheelPixels(1, 2), 800, "page mode");
  });

  await test("zoom levels read as whole percents", () => {
    assert.equal(zoom.zoomPercent(1), "100%");
    assert.equal(zoom.zoomPercent(0.3333), "33%");
    assert.equal(zoom.zoomPercent(2.5), "250%");
  });

  await test("the focused viewer takes the zoom keys; anywhere else the window does", () => {
    const body = node();
    global.document = { body, documentElement: node() };
    const app = node(body);
    const pane = node(app);
    const pdfRoot = node(pane);
    const pdfScroller = node(pdfRoot);
    const browserRoot = node(app);
    const webview = node(browserRoot);
    const nestedRoot = node(pdfScroller);
    const nestedChild = node(nestedRoot);
    const terminal = node(app);

    const calls = [];
    const target = (name, root, eligible = () => true) => ({
      root: () => root,
      eligible,
      zoom: (action) => calls.push(`${name}:${action}`),
    });
    let browserShown = true;
    const offs = [
      zoom.registerZoomTarget(target("pdf", pdfRoot)),
      zoom.registerZoomTarget(target("browser", browserRoot, () => browserShown)),
      zoom.registerZoomTarget(target("nested", nestedRoot)),
    ];

    assert.equal(zoom.routeZoom("in", pdfScroller), true);
    assert.equal(zoom.routeZoom("out", webview), true, "a key typed in the page arrives with focus on the webview");
    assert.equal(zoom.routeZoom("reset", nestedChild), true, "the innermost viewer wins");
    assert.deepEqual(calls, ["pdf:in", "browser:out", "nested:reset"]);

    assert.equal(zoom.routeZoom("in", terminal), false, "a terminal keeps the app zoom");
    assert.equal(zoom.routeZoom("in", body), false, "nothing focused keeps the app zoom");
    assert.equal(zoom.routeZoom("in", null), false);
    browserShown = false;
    assert.equal(zoom.routeZoom("in", webview), false, "a hidden tab does not take the keys");

    offs.forEach((off) => off());
    assert.equal(zoom.routeZoom("in", pdfScroller), false, "an unmounted viewer is gone");
    assert.equal(calls.length, 3);
    delete global.document;
  });

  console.log(`\n${passed} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
