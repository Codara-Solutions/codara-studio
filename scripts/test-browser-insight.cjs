// test-runner: heavy (launches Chromium through Playwright)
"use strict";
// Audits and performance (src/main/browser/audit/, src/main/browser/perf/):
// the axe-core accessibility audit and the page-quality checks, Core Web
// Vitals, traced page loads and interactions, heap sampling and snapshots,
// all run against real pages in Chromium over the same session and target
// interface Codara tabs use. The trace and heap summaries are checked on
// small hand-made files whose answers are known, inside the worker thread
// they run in. The bundle is minified like the app's main process, so the
// functions stringified into pages and workers are tested as they ship.
//
//   node scripts/test-browser-insight.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { startInsightFixture } = require("./fixtures/insight-pages.cjs");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-insight-home-"));

async function loadModules() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./cdp-session";
        export * from "./targets";
        export * from "./recorders/console";
        export * from "./recorders/network";
        export * from "./audit/accessibility";
        export * from "./audit/quality";
        export * from "./perf/performance";
        export * from "./perf/trace";
        export * from "./perf/trace-summary";
        export * from "./perf/heap-summary";
        export { evaluateInWorld } from "./audit/world";
        export * from "./perf/worker";
        export * from "./perf/vitals";
        export { ARTIFACT_BYTES_KEPT, pruneArtifacts } from "./artifacts";
      `,
      resolveDir: path.join(ROOT, "src/main/browser"),
      loader: "ts",
    },
    bundle: true,
    minify: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "axe-core/*"],
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
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeTarget(lib, chromium, url) {
  const { targetId } = await chromium.newPage("about:blank");
  const transport = chromium.transportFor(targetId);
  const session = new lib.CdpSession(targetId, transport);
  lib.startConsoleRecorder(session);
  lib.startNetworkRecorder(session);
  session.hold("Page");
  const target = {
    kind: "preview",
    ref: "tab-9",
    session,
    workspaceId: "ws-insight",
    async info() {
      const { url: current, title } = await lib.evaluateOverCdp(session, "({ url: location.href, title: document.title })");
      return { ref: "tab-9", kind: "preview", url: current, title, viewport: null, devicePixelRatio: 1 };
    },
    evaluate: (expression, options) => lib.evaluateOverCdp(session, expression, options),
    async captureViewport() {
      throw new Error("not used");
    },
    async showActivity() {},
  };
  await navigate(target, url);
  return target;
}

async function navigate(target, url) {
  await target.session.send("Page.navigate", { url });
  for (let i = 0; i < 200; i += 1) {
    const state = await target.evaluate("location.href + ' ' + document.readyState").catch(() => "");
    if (state === `${url} complete`) return;
    await sleep(50);
  }
  throw new Error(`${url} did not load`);
}

async function click(target, selector) {
  const box = await target.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await target.session.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

function pure(lib) {
  assert.equal(lib.formatContrast({ ratio: 2.3245, expected: 4.5, foreground: "#aaaaaa", background: "#ffffff", fontSize: "9.0pt (12px)", fontWeight: "normal" }), "2.32:1, needs 4.5:1 (#aaaaaa on #ffffff, 9.0pt (12px), normal)");
  assert.equal(lib.formatContrast({ ratio: 3, expected: null, foreground: null, background: null, fontSize: null, fontWeight: null }), "3:1");
  assert.deepEqual(lib.wcagCriteria(["wcag2aa", "wcag143", "wcag1410", "cat.color"]), ["1.4.3", "1.4.10"]);
  assert.equal(lib.rate("lcp", 2400), "good");
  assert.equal(lib.rate("lcp", 3000), "needs improvement");
  assert.equal(lib.rate("cls", 0.3), "poor");
  assert.equal(lib.rate("inp", 200), "good");
  assert.match(
    lib.accessibilitySummary({ violations: [], incomplete: [{ id: "x" }], passes: 30 }),
    /^No accessibility violations found by 30 rules\. 1 rule need/,
  );

  const probe = {
    url: "http://example.com/", protocol: "http:", local: false, timeOrigin: 0, viewportWidth: 1280,
    dom: { elements: 900, depth: 10, maxChildren: 70, maxChildrenSelector: "ul.list" },
    nav: { ttfb: 2000, status: 404, domContentLoaded: 2500, load: 3000, fcp: 2600 },
    resources: { requests: 5, bytes: 5 * 1024 * 1024, biggest: [{ url: "http://example.com/app.js", note: "3000 KB" }] },
    blocking: { totalMs: 0, items: [], count: 0 },
    uncompressed: { count: 1, items: [{ url: "http://example.com/app.js", note: "3000 KB" }] },
    mixedContent: { count: 0, items: [] },
    images: { oversized: { count: 0, items: [] }, wastedBytes: 0, unsized: { count: 0, items: [] }, offscreenEager: { count: 0, items: [] }, distorted: { count: 0, items: [] }, missingAlt: { count: 0, items: [] } },
    head: { doctype: true, standardsMode: true, charsetDeclared: true, characterSet: "UTF-8", viewport: "width=device-width, user-scalable=no", title: "T", description: "D", lang: "en-GB", robots: "noindex", canonical: ["/a", "/b"], jsonLd: { count: 0, invalid: 0 } },
    links: { generic: { count: 0, items: [] }, uncrawlable: { count: 0, items: [] } },
    smallText: { ratio: 0.5, sampled: 100 },
  };
  const checks = lib.evaluateQuality(probe, { consoleErrors: [], deprecations: [], failedRequests: [] });
  const status = Object.fromEntries(checks.map((entry) => [entry.id, entry.status]));
  assert.equal(status["server-response"], "fail", "a 2 s first byte fails");
  assert.equal(status["dom-size"], "warn");
  assert.deepEqual(checks.find((entry) => entry.id === "dom-size").items, [{ selector: "ul.list", note: "70 children" }]);
  assert.equal(status["page-weight"], "fail");
  assert.equal(status["text-compression"], "fail", "uncompressed text fails off a dev server");
  assert.equal(status.https, "fail");
  assert.equal(status.viewport, "warn", "blocked zoom warns");
  assert.equal(status["http-status"], "fail");
  assert.equal(status.crawlable, "fail");
  assert.equal(status.canonical, "fail", "two canonical links");
  assert.equal(status["html-lang"], "pass");
  assert.equal(status["font-size"], "warn", "small text only warns on a desktop viewport");
  assert.equal(checks.find((entry) => entry.id === "html-lang").detail, undefined, "passed checks carry no detail");
  const local = lib.evaluateQuality({ ...probe, local: true, protocol: "http:" }, { consoleErrors: [], deprecations: [], failedRequests: [] });
  assert.equal(local.find((entry) => entry.id === "text-compression").status, "warn", "a dev server only warns");
  assert.equal(local.find((entry) => entry.id === "https").status, "pass", "localhost needs no HTTPS");
  const scores = lib.scoreChecks(checks);
  assert.ok(scores.performance < 60 && scores.seo < 100 && scores.bestPractices < 100, JSON.stringify(scores));
  assert.match(lib.qualitySummary(checks, scores), /^performance \d+\/100 \(\d failing\), best practices \d+\/100.*, SEO \d+\/100.*Failing: server-response/);
}

// A snapshot with known retained sizes: root -> Window -.leaky-> Array -[0]->
// a big payload; the array also holds an object weakly that the root holds
// strongly; the window holds one detached div.
function writeSyntheticSnapshot(file) {
  const strings = ["", "(GC roots)", "Window / http://x/", "Array", "Payload", "WeakTarget", "leaky", "held", "Detached HTMLDivElement", "dom", "system / Context"];
  const nodeFields = ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"];
  const nodeTypes = ["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native", "synthetic", "concatenated string", "sliced string", "symbol", "bigint", "object shape"];
  const edgeTypes = ["context", "element", "property", "internal", "hidden", "shortcut", "weak"];
  const T = (name) => nodeTypes.indexOf(name);
  const E = (name) => edgeTypes.indexOf(name);
  const F = nodeFields.length;
  // ordinal: [type, name, id, self, edges, trace, detachedness]
  const nodes = [
    [T("synthetic"), 1, 1, 0, 2, 0, 0],
    [T("object"), 2, 3, 100, 2, 0, 0],
    [T("object"), 3, 5, 40, 2, 0, 0],
    [T("object"), 4, 7, 5000, 0, 0, 0],
    [T("object"), 5, 9, 700, 0, 0, 0],
    [T("native"), 8, 11, 300, 0, 0, 2],
  ];
  // [type, name_or_index, to_node], grouped by the node that owns them.
  const edges = [
    [E("shortcut"), 0, 1 * F],
    [E("element"), 1, 4 * F],
    [E("property"), 6, 2 * F],
    [E("property"), 9, 5 * F],
    [E("element"), 0, 3 * F],
    [E("weak"), 7, 4 * F],
  ];
  const snapshot = {
    snapshot: {
      meta: { node_fields: nodeFields, node_types: [nodeTypes, "string", "number", "number", "number", "number", "number"], edge_fields: ["type", "name_or_index", "to_node"], edge_types: [edgeTypes, "string_or_number", "node"] },
      node_count: nodes.length,
      edge_count: edges.length,
      trace_function_count: 0,
    },
  };
  const text = `${JSON.stringify(snapshot).slice(0, -1)},\n"nodes":[${nodes.map((row) => row.join(",")).join(",\n")}],\n"edges":[${edges.map((row) => row.join(",")).join(",\n")}],\n"trace_function_infos":[],\n"trace_tree":[],\n"samples":[],\n"locations":[],\n"strings":[${strings.map((s) => JSON.stringify(s)).join(",\n")}]}\n`;
  fs.writeFileSync(file, text);
}

function writeSyntheticTrace(file) {
  const pid = 10;
  const tid = 1;
  const events = [
    { name: "thread_name", ph: "M", pid, tid, ts: 0, args: { name: "CrRendererMain" } },
    { name: "thread_name", ph: "M", pid: 20, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
    { name: "TracingStartedInBrowser", ph: "I", pid: 1, tid: 1, ts: 0, args: { data: { frames: [{ frame: "F1", processId: pid }] } } },
    { name: "navigationStart", ph: "R", pid, tid, ts: 1_000, args: { frame: "F1" } },
    { name: "RunTask", ph: "X", pid, tid, ts: 10_000, dur: 80_000 },
    { name: "FunctionCall", ph: "X", pid, tid, ts: 11_000, dur: 70_000, args: { data: { url: "http://h/app.js", functionName: "heavy" } } },
    { name: "Layout", ph: "X", pid, tid, ts: 82_000, dur: 5_000 },
    { name: "RunTask", ph: "X", pid, tid, ts: 200_000, dur: 20_000 },
    { name: "Paint", ph: "X", pid, tid, ts: 201_000, dur: 4_000 },
    { name: "RunTask", ph: "X", pid: 20, tid: 1, ts: 300_000, dur: 900_000 },
    { name: "firstContentfulPaint", ph: "R", pid, tid, ts: 501_000, args: { frame: "F1" } },
    { name: "largestContentfulPaint::Candidate", ph: "R", pid, tid, ts: 801_000, args: { frame: "F1", data: { size: 5 } } },
    { name: "LayoutShift", ph: "I", pid, tid, ts: 900_000, args: { data: { weighted_score_delta: 0.12, had_recent_input: false } } },
  ];
  fs.writeFileSync(file, JSON.stringify({ traceEvents: events }));
}

async function summaries(lib) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-insight-files-"));
  try {
    // Trace and snapshot files keep to a byte budget, newest first; the
    // newest stays even alone over it, since it may still be streaming in.
    const kept = path.join(dir, "kept");
    fs.mkdirSync(kept);
    for (const [name, size] of [["1-a", 300], ["2-b", 300], ["3-c", 300], ["4-d", 500]]) fs.writeFileSync(path.join(kept, name), Buffer.alloc(size));
    assert.ok(lib.ARTIFACT_BYTES_KEPT.traces >= 1 << 30);
    await lib.pruneArtifacts(kept, 1_000);
    assert.deepEqual(fs.readdirSync(kept).sort(), ["3-c", "4-d"]);
    await lib.pruneArtifacts(kept, 100);
    assert.deepEqual(fs.readdirSync(kept), ["4-d"]);
    await lib.pruneArtifacts(kept);
    assert.deepEqual(fs.readdirSync(kept), ["4-d"]);

    const snapshotFile = path.join(dir, "synthetic.heapsnapshot");
    writeSyntheticSnapshot(snapshotFile);
    const input = { path: snapshotFile, maxBytes: 1 << 30, maxNodesForRetained: 1_000_000 };
    const direct = lib.summarizeHeapSnapshotFile(input);
    assert.equal(direct.nodes, 6);
    assert.equal(direct.totalBytes, 6140, "everything is retained by the root");
    const array = direct.retainers.find((row) => row.name === "Array");
    assert.equal(array.retainedBytes, 5040, "the array retains its payload, not the weakly held object");
    assert.equal(array.path, "Window.leaky");
    assert.equal(direct.retainers[0].name, "Array", "the window itself is not listed");
    assert.ok(!direct.retainers.some((row) => row.name === "Payload"), "an object inside a listed one is not repeated");
    assert.ok(direct.retainers.some((row) => row.name === "WeakTarget" && row.retainedBytes === 700), "weakly held: retained by the root alone");
    assert.deepEqual(direct.detached, { count: 1, retainedBytes: 300, top: ["Detached HTMLDivElement x1"] });
    assert.ok(direct.retainers.some((row) => row.name === "Detached HTMLDivElement" && row.path === "Window.dom"));
    assert.equal(direct.classes.find((row) => row.name === "Window").retainedBytes, 6140 - 700, "a class's retained size");
    const viaWorker = await lib.runInWorker(lib.summarizeHeapSnapshotFile, input, { timeoutMs: 20_000 });
    assert.deepEqual(viaWorker, direct, "the worker gives the same answer");
    const capped = lib.summarizeHeapSnapshotFile({ ...input, maxNodesForRetained: 2 });
    assert.match(capped.note, /retained sizes skipped/);
    assert.equal(capped.classes[0].name, "Payload", "class totals still come back");
    assert.match(lib.summarizeHeapSnapshotFile({ ...input, maxBytes: 10 }).note, /open it in DevTools/);

    const traceFile = path.join(dir, "synthetic.json");
    writeSyntheticTrace(traceFile);
    const trace = await lib.runInWorker(lib.summarizeTraceFile, { path: traceFile, frameId: "F1", maxBytes: 1 << 30 }, { timeoutMs: 20_000 });
    assert.equal(trace.longTasks.count, 1, "only the tab's renderer counts, and only tasks of 50 ms or more");
    assert.equal(trace.longTasks.blockingMs, 30);
    assert.deepEqual(trace.longTasks.longest[0], { atMs: 9, ms: 80, cause: "heavy() /app.js" });
    assert.equal(trace.mainThread.scriptingMs, 70);
    assert.equal(trace.mainThread.renderingMs, 5);
    assert.equal(trace.mainThread.paintingMs, 4);
    assert.equal(trace.mainThread.busyMs, 100);
    assert.deepEqual(trace.topScripts, [{ script: "heavy() /app.js", ms: 70 }]);
    assert.deepEqual(trace.marks, { fcpMs: 500, lcpMs: 800, layoutShifts: 1, cls: 0.12 });

    await assert.rejects(lib.runInWorker(() => { for (;;) { /* spin */ } }, null, { timeoutMs: 300 }), /longer than/);
    await assert.rejects(lib.runInWorker(() => { throw new Error("boom"); }, null, { timeoutMs: 5_000 }), /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function inChromium(lib) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium audit and performance checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = await startInsightFixture();
  try {
    // Accessibility.
    const a11yTarget = await makeTarget(lib, chromium, `${server.origin}/a11y`);
    await a11yTarget.evaluate("window.axe = { run: () => { throw new Error('page axe'); } }; window.Promise = undefined; true");
    const a11y = await lib.auditAccessibility(a11yTarget);
    assert.equal(a11y.kind, "accessibility");
    assert.equal(a11y.tabId, "tab-9");
    assert.match(a11y.engine, /^axe-core 4\./);
    const rules = Object.fromEntries(a11y.violations.map((rule) => [rule.rule, rule]));
    for (const id of ["color-contrast", "label", "image-alt", "button-name"]) assert.ok(rules[id], `${id} is reported: ${Object.keys(rules)}`);
    const contrast = rules["color-contrast"].elements[0];
    assert.match(contrast.contrast, /^2\.\d+:1, needs 4\.5:1 \(#aaaaaa on #ffffff/);
    assert.equal(contrast.selector, "#faint");
    assert.match(contrast.ref, /^@[a-z0-9]+-\d+$/, "elements carry the snapshot's @references");
    assert.equal(await a11yTarget.evaluate(`window.__codaraPreviewDOM.refs.get(${JSON.stringify(contrast.ref)}).id`), "faint", "the ref resolves in the page");
    assert.ok(rules.label.elements.some((element) => element.selector === "#nolabel"));
    assert.ok(rules["color-contrast"].wcag.includes("1.4.3"));
    assert.match(a11y.summary, /^\d+ rules failed on \d+ elements \(.*critical.*\): .*color-contrast x1 \(serious, worst 2\.\d+:1 needs 4\.5:1\)/);
    assert.equal(await a11yTarget.evaluate("typeof window.axe.run === 'function' && !('source' in window.axe)"), true, "axe stays out of the page's own world");
    const report = JSON.parse(fs.readFileSync(a11y.path, "utf8"));
    assert.ok(report.violations.length >= 4);
    assert.ok(a11y.path.startsWith(path.join(HOME, "workspace-data", "ws-insight", "browser", "audits")), a11y.path);
    assert.ok(JSON.stringify(a11y).length < 6_000, `compact: ${JSON.stringify(a11y).length} characters`);
    const again = await lib.auditAccessibility(a11yTarget);
    assert.deepEqual(again.violations.map((rule) => rule.rule), a11y.violations.map((rule) => rule.rule), "a second run reuses the injected engine");

    // Page quality.
    const qualityTarget = await makeTarget(lib, chromium, `${server.origin}/quality`);
    await sleep(300);
    const quality = await lib.auditQuality(qualityTarget);
    assert.equal(quality.kind, "quality");
    assert.match(quality.engine, /not Lighthouse/);
    const flagged = Object.fromEntries([...quality.failed, ...quality.warnings].map((entry) => [entry.id, entry]));
    for (const id of ["meta-description", "html-lang", "console-errors", "failed-requests", "structured-data", "render-blocking", "viewport"]) {
      assert.ok(quality.failed.some((entry) => entry.id === id), `${id} fails: ${JSON.stringify(quality.failed.map((entry) => entry.id))}`);
    }
    for (const id of ["link-text", "crawlable-anchors", "image-sizing", "text-compression"]) assert.ok(flagged[id], `${id} is flagged`);
    assert.ok(flagged["render-blocking"].items.some((item) => item.url.endsWith("/slow.js")));
    assert.match(flagged["console-errors"].items[0].note, /fixture failure/);
    assert.ok(flagged["failed-requests"].items[0].url.endsWith("/missing"));
    assert.equal(flagged["failed-requests"].items[0].note, "HTTP 404");
    const big = flagged["image-sizing"].items[0];
    assert.equal(big.selector, "#big");
    assert.match(big.ref, /^@/);
    assert.match(big.note, /^1600x1200 shown at 100x75/);
    assert.equal(flagged["link-text"].items[0].selector, "#generic");
    assert.ok(quality.passed.includes("doctype") && quality.passed.includes("document-title"));
    assert.ok(quality.scores.seo < 100 && quality.scores.performance < 100);
    assert.ok(quality.metrics.domElements > 5 && quality.metrics.requests >= 3);
    assert.match(quality.summary, /^performance \d+\/100.*Failing: .*meta-description/);
    assert.ok(fs.existsSync(quality.path));

    // Core Web Vitals on a loaded page, then after a slow click.
    const perfTarget = await makeTarget(lib, chromium, `${server.origin}/perf`);
    await sleep(600);
    const first = await lib.measureVitals(perfTarget);
    assert.equal(first.action, "vitals");
    assert.ok(first.lcp && first.lcp.ms > 0, `${JSON.stringify(first)} page=${JSON.stringify(await perfTarget.evaluate("({ visibility: document.visibilityState, focus: document.hasFocus(), paint: performance.getEntriesByType('paint').map((e) => e.name), types: PerformanceObserver.supportedEntryTypes })"))}`);
    assert.match(first.lcp.element.selector, /#story|#headline/);
    assert.match(first.lcp.element.ref, /^@/);
    assert.ok(first.cls.value > 0, `the late banner shifts the layout: ${JSON.stringify(first.cls)} page=${JSON.stringify(await perfTarget.evaluate("({ fcpSeenAt: window.__fcpSeenAt, bannerAt: window.__bannerAt, now: performance.now() })"))}`);
    assert.ok(first.cls.elements.some((element) => /#content|#headline|#story|#slow/.test(element.selector)), JSON.stringify(first.cls));
    assert.ok(first.fcp && first.ttfb);
    assert.ok(first.notes.some((note) => /started now/.test(note)), "a late observer says what it missed");
    assert.match(first.summary, /^LCP \d.* CLS 0\.\d+ (good|needs improvement|poor) \(\d+ shifts?, most from .*\), INP none yet/);
    await click(perfTarget, "#slow");
    await sleep(400);
    const afterClick = await lib.measureVitals(perfTarget);
    assert.ok(afterClick.inp.ms >= 250, JSON.stringify(afterClick.inp));
    assert.equal(afterClick.inp.slowest.element.selector, "#slow");
    assert.ok(afterClick.inp.slowest.processingMs >= 250);
    assert.ok(!afterClick.notes?.some((note) => /started now/.test(note)), "the observer was already running");
    assert.equal(afterClick.inp.estimated, undefined, "a visible tab reports event timing");
    // The in-page measurement that stands in where the browser reports no
    // event timing sees the same click.
    const measured = await lib.evaluateInWorld(perfTarget.session, "[...globalThis.__codaraVitals.measured.values()].map((entry) => ({ name: entry.name, ms: entry.duration, processing: entry.processingEnd - entry.processingStart, target: entry.target && entry.target.deref() && entry.target.deref().id }))");
    assert.ok(measured.some((entry) => entry.name === "click" && entry.ms >= 250 && entry.processing >= 250 && entry.target === "slow"), JSON.stringify(measured));

    // A traced reload.
    const load = await lib.measureLoad(perfTarget, 15_000);
    assert.equal(load.action, "load");
    assert.ok(load.path.endsWith(".json") && fs.existsSync(load.path));
    const raw = JSON.parse(fs.readFileSync(load.path, "utf8"));
    assert.ok((Array.isArray(raw) ? raw : raw.traceEvents).length > 100, "the trace file holds the events");
    assert.ok(load.trace.mainThread && load.trace.mainThread.busyMs > 100, JSON.stringify(load.trace));
    assert.ok(load.trace.longTasks.count >= 1, "the 120 ms script is a long task");
    assert.match(load.trace.longTasks.longest[0].cause, /^script \/perf/, "the inline script, not the parser around it");
    assert.equal((load.summary.match(/long tasks? blocking/g) ?? []).length, 1, "long tasks are reported once");
    assert.ok(load.lcp && load.ttfb && load.fcp, JSON.stringify(load));
    assert.ok(!load.notes?.some((note) => /started now/.test(note)), "the observer ran from the first byte");
    assert.ok(load.cls.value > 0, `${JSON.stringify(load.cls)} page=${JSON.stringify(await perfTarget.evaluate("({ fcpSeenAt: window.__fcpSeenAt, bannerAt: window.__bannerAt, frames: window.__framesAfterBanner, shifts: window.__shifts, now: performance.now(), paint: performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]) })"))}`);
    assert.match(load.summary, /^Page load: LCP .* Main thread busy \d+ ms .*long tasks? blocking/);
    assert.ok(JSON.stringify(load).length < 4_000, `compact: ${JSON.stringify(load).length}`);

    // A traced interaction.
    await assert.rejects(lib.stopInteractionTrace(perfTarget), /No trace is running/);
    let paintReleases = 0;
    perfTarget.keepPainting = async () => ({ background: true, release: async () => { paintReleases += 1; } });
    const started = await lib.startInteractionTrace(perfTarget);
    assert.equal(started.tracing, true);
    await click(perfTarget, "#slow");
    await sleep(400);
    // A refused second start leaves the running trace's window and paint lease alone.
    await assert.rejects(lib.startInteractionTrace(perfTarget), /already running/);
    assert.equal(paintReleases, 0, "the running trace keeps its paint lease");
    const stopped = await lib.stopInteractionTrace(perfTarget);
    delete perfTarget.keepPainting;
    assert.equal(paintReleases, 1, "stop releases the lease once");
    assert.ok(stopped.notes.some((note) => /in the background/.test(note)), JSON.stringify(stopped.notes));
    assert.equal(stopped.action, "stop");
    assert.ok(stopped.inp.ms >= 250 && stopped.inp.interactions >= 1, JSON.stringify(stopped));
    assert.equal(stopped.lcp, undefined, "an interaction window reports no page-load metrics");
    assert.ok(stopped.trace.longTasks.count >= 1);
    assert.match(stopped.trace.longTasks.longest[0].cause, /click/);
    assert.match(stopped.summary, /^Interaction \(\d+ s\): .*INP \d+ ms (needs improvement|poor) \(click on #slow\)/);
    assert.ok(fs.existsSync(stopped.path));

    // Elements the user clicked and the page then removed are garbage: the
    // vitals observer must not keep them alive as detached DOM for the
    // snapshot to blame on the page.
    await perfTarget.evaluate(`(() => { for (let i = 0; i < 12; i++) { const button = document.createElement("button"); button.className = "gone"; button.textContent = "Delete"; button.onclick = () => button.remove(); document.body.appendChild(button); } return true; })()`);
    for (let i = 0; i < 12; i += 1) await click(perfTarget, "button.gone");
    await sleep(1_200);
    assert.equal(await perfTarget.evaluate("document.querySelectorAll('button.gone').length"), 0);

    // Memory over time and a snapshot.
    const memory = await lib.measureMemory(perfTarget, 1_000, true);
    assert.ok(!memory.snapshot.detached.top.some((name) => /class="gone".* x([2-9]|\d\d)/.test(name)), `clicked elements are not retained: ${JSON.stringify(memory.snapshot.detached)}`);
    assert.equal(memory.action, "memory");
    assert.ok(memory.heap.samples.length >= 2);
    assert.ok(memory.page.after.nodes > 0);
    assert.ok(memory.path.endsWith(".heapsnapshot") && fs.statSync(memory.path).size > 100_000);
    assert.ok(memory.snapshot.retainers.some((row) => /leaky/.test(row.path) && row.retainedBytes > 500_000), JSON.stringify(memory.snapshot.retainers));
    assert.ok(memory.snapshot.detached && memory.snapshot.detached.count >= 5, JSON.stringify(memory.snapshot.detached));
    assert.match(memory.summary, /^JS heap \d.* used of .*, [+-].* over 1 s after garbage collection .*DOM nodes.* Snapshot: .* largest retainers .*leaky/);
    const quick = await lib.measureMemory(perfTarget, 0, false);
    assert.equal(quick.heap.samples, undefined);
    assert.equal(quick.path, undefined);
  } finally {
    await server.close();
    await chromium.close();
  }
}

(async () => {
  try {
    const lib = await loadModules();
    pure(lib);
    await summaries(lib);
    await inChromium(lib);
    console.log("browser insight: accessibility and quality audits, vitals, traced loads and interactions, heap snapshots");
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
