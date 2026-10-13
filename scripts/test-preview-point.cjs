"use strict";
// Pointing at the page (src/shared/preview-point.ts, src/main/browser/point/,
// src/shared/point-format.ts): source maps, bundler URLs and served paths
// resolve to files in the workspace; a workspace search proposes files when
// the page names none; and in a real Chromium page the probe reports React
// (both dev-source and owner-stack builds), Vue, Svelte and dev-plugin
// attributes, the box model, styles and CSS rules, elements under drawn
// boxes, and crops, through the minified bundle the app ships.
//
//   node scripts/test-preview-point.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-point-home-"));
const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-point-ws-")));

async function bundle(contents, extra = {}) {
  const out = await esbuild.build({
    stdin: { contents, resolveDir: path.join(ROOT, "src/main/browser/point"), loader: "ts" },
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
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function write(rel, text) {
  const file = path.join(WORKSPACE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const CARD_TSX = [
  "type Props = { title: string };",
  "",
  "export function Card({ title }: Props) {",
  "  const label: string = title.toUpperCase();",
  '  return { tag: "section", marker: "card-marker", label };',
  "}",
  "",
].join("\n");

async function sourceMaps(lib) {
  // A real esbuild map: the marker on line 5 of Card.tsx.
  const out = await esbuild.transform(CARD_TSX, { loader: "tsx", sourcemap: "inline", sourcefile: "Card.tsx" });
  const lines = out.code.split("\n");
  const line = lines.findIndex((text) => text.includes("card-marker")) + 1;
  const column = lines[line - 1].indexOf('"card-marker"') + 1;
  const resolver = new lib.SourceMapResolver(async (url) => (url === "http://dev.local/src/Card.js" ? out.code : null));
  const original = await resolver.original("http://dev.local/src/Card.js", line, column);
  assert.equal(original.source, "Card.tsx");
  assert.equal(original.line, 5, "the generated marker maps back to its source line");
  assert.equal(lib.sourcePathFromUrl(original.source, original.sourceRoot, original.mapUrl), "/src/Card.tsx");

  // An index map with sections (Turbopack) offsets into the right section.
  const sectionMap = JSON.parse(Buffer.from(out.code.split("base64,")[1], "base64").toString());
  const indexed = new lib.SourceMapLookup({ version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sources: ["other.ts"], mappings: "AAAA" } },
    { offset: { line: 10, column: 0 }, map: sectionMap },
  ] }, "http://dev.local/chunk.js");
  assert.equal(indexed.original(line + 10, column).line, 5);
  assert.equal(indexed.original(1, 1).source, "other.ts");

  assert.equal(lib.sourceMappingUrl("x\n//# sourceMappingURL=app.js.map\n", "http://h/a/app.js"), "http://h/a/app.js.map");
  assert.equal(lib.sourceMappingUrl("x\n/*# sourceMappingURL=data:application/json;base64,e30= */", "http://h/a.css"), "data:application/json;base64,e30=");
  assert.equal(lib.sourceMappingUrl("no map here", "http://h/a.js"), null);
  assert.deepEqual(lib.decodeMappings("AAAA,CAAC;AACA"), [[[0, 0, 0, 0], [1, 0, 0, 1]], [[0, 0, 1, 1]]]);

  // Bundler and served URLs become paths.
  const cases = [
    ["webpack://_N_E/./src/app/page.tsx?abc", "src/app/page.tsx"],
    ["webpack-internal:///(app-pages-browser)/./src/app/page.tsx", "src/app/page.tsx"],
    ["turbopack:///[project]/src/app/page.tsx", "src/app/page.tsx"],
    ["http://localhost:5173/src/App.tsx?t=1712", "/src/App.tsx"],
    ["http://localhost:5173/@fs/home/me/lib/Button.tsx", "/home/me/lib/Button.tsx"],
    ["file:///home/me/app/src/App.vue", "/home/me/app/src/App.vue"],
    ["/abs/src/App.svelte", "/abs/src/App.svelte"],
  ];
  for (const [input, expected] of cases) assert.equal(lib.sourcePathFromUrl(input), expected, input);
  assert.equal(lib.sourcePathFromUrl("../src/Card.tsx", "", "http://h/assets/app.js.map"), "/src/Card.tsx");
}

async function workspaceFiles(lib) {
  const located = await lib.locateSourceFile("/src/Card.tsx", WORKSPACE);
  assert.deepEqual(located, { file: "src/Card.tsx", absolute: path.join(WORKSPACE, "src/Card.tsx"), exists: true });
  assert.equal((await lib.locateSourceFile(path.join(WORKSPACE, "src/Hero.tsx"), WORKSPACE)).file, "src/Hero.tsx");
  assert.equal((await lib.locateSourceFile("src/Nope.tsx", WORKSPACE)).exists, false);
  const outside = await lib.locateSourceFile("../../etc/passwd", WORKSPACE);
  assert.equal(outside.exists, false, "a relative path never escapes the workspace");

  const found = await lib.searchWorkspaceSources(WORKSPACE, { components: ["App", "Pricing"], classes: ["pricing-card"], text: "Choose your plan" });
  assert.equal(found[0].file, "src/Pricing.tsx", "the file defining the component and holding the text ranks first");
  assert.equal(found[0].line, 1);
  assert.match(found[0].reason, /defines Pricing/);
  assert.ok(!found.some((candidate) => candidate.file.includes("node_modules")), "dependencies are not searched");
  assert.deepEqual(await lib.searchWorkspaceSources(WORKSPACE, { components: [], classes: [], text: "" }), []);
}

function fixturePage(port) {
  const base = `http://127.0.0.1:${port}`;
  return `<!doctype html><html><head><title>Point fixture</title>
<style data-vite-dev-id="${WORKSPACE}/src/App.css">body{margin:0;font-family:Inter,system-ui} .cta{padding:8px 16px;border-radius:6px;color:rgb(255, 0, 0);display:inline-flex}</style>
<style>.wrap{display:flex;gap:12px;align-items:center;padding:10px}</style>
</head><body>
<div class="wrap" id="hero"><button class="cta" id="react-btn">Get started</button><span id="react19">Card title</span></div>
<div id="vue"><p class="panel-text">Vue panel</p></div>
<div id="svelte">Badge</div>
<footer><a id="attr" href="/about" data-inspector-relative-path="src/Footer.tsx" data-inspector-line="9" data-inspector-column="3">About</a></footer>
<section class="pricing-card"><h2 id="plain">Choose your plan</h2></section>
<div id="box-area" style="position:absolute;left:400px;top:300px;width:200px;height:120px;background:#eee"><span id="inner" style="display:block;width:60px;height:30px">in</span></div>
<script>
  function Hero() {} function App() {}
  const btn = document.getElementById("react-btn");
  btn.__reactFiber$abc = { type: "button", _debugSource: { fileName: ${JSON.stringify(WORKSPACE + "/src/Hero.tsx")}, lineNumber: 12, columnNumber: 7 },
    _debugOwner: { type: Hero }, return: { type: Hero, return: { type: App, return: null } } };
  function Card() {}
  document.getElementById("react19").__reactFiber$abc = { type: "span", _debugStack: { stack: "Error: react-stack-top-frame\\n    at exports.jsxDEV (${base}/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:16)\\n    at Card (${base}/src/Card.js:__LINE__:__COL__)\\n    at react_stack_bottom_frame (${base}/node_modules/.vite/deps/react-dom_client.js:1:1)" },
    _debugOwner: { type: Card }, return: { type: Card, return: { type: App, return: null } } };
  document.querySelector("#vue p").__vueParentComponent = { type: { __file: ${JSON.stringify(WORKSPACE + "/src/Panel.vue")}, __name: "Panel" }, parent: { type: { name: "App" }, parent: null } };
  document.getElementById("svelte").__svelte_meta = { loc: { file: "src/Badge.svelte", line: 4, column: 2, char: 40 } };
</script></body></html>`;
}

async function inChromium(lib, label) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium point checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const card = await esbuild.transform(CARD_TSX, { loader: "tsx", sourcemap: "inline", sourcefile: "Card.tsx" });
  const cardLines = card.code.split("\n");
  const genLine = cardLines.findIndex((text) => text.includes("card-marker")) + 1;
  const genCol = cardLines[genLine - 1].indexOf('"card-marker"') + 1;
  const server = http.createServer((req, res) => {
    if (req.url === "/src/Card.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(card.code);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fixturePage(server.address().port).replace("__LINE__", String(genLine)).replace("__COL__", String(genCol)));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { targetId } = await chromium.newPage(url);
    const transport = chromium.transportFor(targetId);
    await transport.attach();
    await transport.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
    const fakeImage = (width, height, ops = []) => Buffer.from(JSON.stringify({ width, height, ops }));
    const readFake = (buffer) => JSON.parse(buffer.toString());
    const codec = {
      size: (png) => { const { width, height } = readFake(png); return { width, height }; },
      crop: (png, rect) => fakeImage(rect.width, rect.height, [...readFake(png).ops, ["crop", rect]]),
      resize: (png, size) => fakeImage(size.width, size.height, [...readFake(png).ops, ["resize", size]]),
      encode: (png, format, quality) => fakeImage(readFake(png).width, readFake(png).height, [...readFake(png).ops, ["encode", format, quality]]),
    };
    const target = {
      kind: "preview",
      ref: "tab-9",
      workspaceId: "ws-point",
      async evaluate(expression) {
        const result = await transport.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
      async captureViewport() { return fakeImage(2000, 1400); },
      async showActivity() {},
    };
    for (let i = 0; i < 100 && (await target.evaluate("document.readyState + ':' + !!document.getElementById('box-area')")) !== "complete:true"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await target.evaluate(`document.getElementById("react-btn").setAttribute("data-codara-pick", "1")`);
    const resolver = new lib.SourceMapResolver(lib.pointTextFetcher(WORKSPACE));
    const inspection = await lib.inspectPage(target, {
      selectors: ['[data-codara-pick="1"]', "#react19", "#vue p", "#svelte", "#attr", "#plain", "#missing"],
      regions: [{ x: 390, y: 290, width: 220, height: 140 }, { x: 405, y: 305, width: 30, height: 10 }],
      clearAttribute: "data-codara-pick",
      crops: "both",
      workspaceRoot: WORKSPACE,
    }, { resolver, codec });
    assert.equal(inspection.tabId, "tab-9", `${label}: the result names the tab`);
    assert.equal(inspection.url, url);
    assert.deepEqual(inspection.viewport, { width: 1000, height: 700 });
    assert.equal(inspection.devicePixelRatio, 2);
    assert.equal(await target.evaluate(`document.querySelectorAll("[data-codara-pick]").length`), 0, "the picker's marks are removed");
    assert.deepEqual(inspection.missing.map((m) => m.selector), ["#missing"]);
    const [react, react19, vue, svelte, attr, plain] = inspection.elements;

    assert.equal(react.selector, "#react-btn");
    assert.equal(react.framework, "react");
    assert.deepEqual(react.components, ["App", "Hero"]);
    assert.deepEqual(react.source, { file: "src/Hero.tsx", line: 12, column: 7, via: "react", component: "Hero", exists: true }, `${label}: React dev source`);
    assert.equal(react.styles.display, "flex", "a flex item is blockified");
    assert.equal(react.styles.color, "rgb(255, 0, 0)");
    assert.equal(react.styles.padding, "8px 16px");
    assert.deepEqual(react.boxModel.padding, [8, 16, 8, 16]);
    assert.ok(react.rules.some((rule) => rule.selector === ".cta" && rule.source === "src/App.css" && /border-radius: 6px/.test(rule.declarations)), "the rule and the dev server's file for it");
    assert.match(react.path, /div#hero.wrap > button#react-btn.cta$/);
    assert.equal(react.crop.mimeType, "image/jpeg");
    assert.ok(fs.existsSync(react.crop.path) && react.crop.path.startsWith(HOME), "the crop is saved under Codara's data folder");
    const cropOps = JSON.parse(Buffer.from(react.crop.data, "base64").toString()).ops;
    assert.deepEqual(cropOps[0][0], "crop");
    assert.equal(cropOps[0][1].x, Math.floor((react.box.x - 8) * 2), "crops are in image pixels at the page's density");

    assert.equal(react19.source.file, "src/Card.tsx", `${label}: an owner-stack frame is mapped through the inline source map`);
    assert.equal(react19.source.line, 5);
    assert.equal(react19.source.via, "react-stack");
    assert.equal(react19.source.component, "Card");

    assert.equal(vue.framework, "vue");
    assert.deepEqual(vue.components, ["App", "Panel"]);
    assert.deepEqual(vue.source, { file: "src/Panel.vue", via: "vue", component: "Panel", exists: true });

    assert.equal(svelte.framework, "svelte");
    assert.equal(svelte.source.file, "src/Badge.svelte");
    assert.equal(svelte.source.line, 5, "Svelte 4 lines count from 0");

    assert.deepEqual(attr.source, { file: "src/Footer.tsx", line: 9, column: 3, via: "data-attribute", exists: true });
    assert.ok(attr.target.endsWith("/about"));

    assert.equal(plain.source, null);
    assert.equal(plain.candidates[0].file, "src/Pricing.tsx", "with no source on the page, the workspace search proposes the file");
    assert.deepEqual(plain.hints.classes, ["pricing-card"]);

    const [outer, inner] = inspection.regions;
    assert.equal(outer.box.pageX, 390);
    assert.equal(outer.elements[0].selector, "#box-area", "a box around an element names it");
    assert.equal(outer.elements[0].contains, false);
    assert.equal(inner.elements[0].selector, "#inner", "a box inside an element names the innermost one holding it");
    assert.equal(inner.elements[0].contains, true);

    const text = lib.formatPickText({ ...inspection, elements: [react, plain] }, "make it smaller");
    assert.match(text, /^\[Codara\] Picked 2 elements on http:\/\/127\.0\.0\.1:\d+\/ \(tab tab-9\)/);
    assert.match(text, /Note: make it smaller/);
    assert.match(text, /1\. <button> "Get started" @/);
    assert.match(text, /selector: #react-btn/);
    assert.match(text, /source: src\/Hero\.tsx:12:7 \(react, <App> > <Hero>\)/);
    assert.match(text, /box: \d+x\d+ at \d+,\d+ \(page \d+,\d+\); padding 8 16/);
    assert.match(text, /rules: \.cta \(src\/App\.css\)/);
    assert.match(text, /source: not reported by the page; likely src\/Pricing\.tsx:2 \(text "Choose your plan"/);
    assert.match(text, /image: \//);
    assert.ok(!/claude/i.test(text));

    const comment = lib.formatCommentText(inspection, [
      { kind: "box", x: 390, y: 290, width: 220, height: 140, note: "make this smaller" },
      { kind: "arrow", x: 405, y: 305, width: 30, height: 10, from: { x: 300, y: 200 }, to: { x: 420, y: 310 }, note: "" },
    ], "two things", { x: 0, y: 100 });
    assert.match(comment, /2 comments on .* the annotated screenshot is attached/);
    assert.match(comment, /1\. "make this smaller"; box at page 390,390 size 220x140 \(viewport 390,290\)/);
    assert.match(comment, /has <div> "in" @\S+ #box-area/);
    assert.match(comment, /2\. \(no note\); arrow from page 300,300 to 420,410/);
    assert.match(comment, /in <span> "in" @\S+ #inner/);
  } finally {
    server.close();
    await chromium.close();
  }
}

function formatting(lib) {
  const tab = lib.formatTabReference({ tabId: "tab-3", url: "http://localhost:5173/", title: "Home", session: "Codex in Terminal 2", workspace: "Shop" });
  assert.equal(tab.split("\n")[0], "tabId: tab-3");
  assert.match(tab, /session: Codex in Terminal 2/);
  assert.match(tab, /--tabId tab-3/);
  assert.equal(lib.sourceLabel({ file: "a.ts", line: 3 }), "a.ts:3");
  assert.equal(lib.sourceLabel({ file: "a.ts" }), "a.ts");
}

(async () => {
  try {
    write("src/Card.tsx", CARD_TSX);
    write("src/Hero.tsx", "export function Hero() {\n  return null;\n}\n");
    write("src/Panel.vue", "<template><p class=\"panel-text\">Vue panel</p></template>\n");
    write("src/Badge.svelte", "<script></script>\n\n\n\n<div>Badge</div>\n");
    write("src/Footer.tsx", "export const Footer = () => null;\n");
    write("src/Pricing.tsx", "export function Pricing() {\n  return <section className=\"pricing-card\"><h2>Choose your plan</h2></section>;\n}\n");
    write("src/App.tsx", "export function App() { return <div className=\"pricing-card\" />; }\n");
    write("node_modules/lib/Pricing.tsx", "export function Pricing() { return 'Choose your plan pricing-card'; }\n");
    const source = `
      export * from "./source-map";
      export * from "./source-files";
      export * from "./inspect";
      export * from "../../../shared/point-format";
    `;
    const lib = await bundle(source);
    await sourceMaps(lib);
    await workspaceFiles(lib);
    formatting(lib);
    await inChromium(lib, "plain bundle");
    // The app ships the probe minified; stringified page code must survive it.
    await inChromium(await bundle(source, { minify: true }), "minified bundle");
    console.log("point at the page: source maps, workspace files and search, framework sources, box model, styles, rules, regions, crops and the agent text");
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
