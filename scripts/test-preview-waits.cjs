"use strict";
// codara_preview_wait_for (feedback round 5, item 4): src/main/browser/wait.ts
// and the activity it reads (page-activity.ts).
// - request rules: at least one condition, defaults (5 s, 15 s for
//   navigation/load/hmr), the 50 s cap, fresh needs a selector;
// - matchUrl: exact, path, glob, /regex/;
// - dev-server hot update lines and requests (Vite, webpack/Next, parcel);
// - checkWait verdicts, pure;
// - on a real Chromium page: url, navigation, load, networkidle (an
//   EventSource does not count), fresh elements after an agent action, a
//   stable DOM, hot updates, reloads and errors, and timeouts that say what
//   was seen.
//
//   node scripts/test-preview-waits.cjs

const assert = require("node:assert/strict");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, navigate, sleep } = require("./fixtures/browser-page-target.cjs");

const lib = bundleBrowser(`
  export * from "./wait";
  export { classifyHmrConsole, isHmrRequest, noteAgentAction } from "./page-activity";
  export { markAgentAction } from "./agent-action";
`);

function requests() {
  const { normalizeWaitRequest, WAIT_MAX_MS } = lib;
  assert.throws(() => normalizeWaitRequest({}), /Give at least one condition: selector, url, navigation, load, stableMs or hmr/);
  assert.throws(() => normalizeWaitRequest({ fresh: true }), /Give at least one condition/);
  assert.throws(() => normalizeWaitRequest({ url: "/x", fresh: true }), /fresh needs a selector/);
  assert.throws(() => normalizeWaitRequest({ selector: "h1", state: "gone" }), /state must be/);
  assert.throws(() => normalizeWaitRequest({ load: "idle" }), /load must be domcontentloaded, load or networkidle/);
  const plain = normalizeWaitRequest({ selector: " h1 " });
  assert.equal(plain.selector, "h1");
  assert.equal(plain.state, "visible");
  assert.equal(plain.timeoutMs, 5000);
  assert.equal(normalizeWaitRequest({ load: "load" }).timeoutMs, 15000);
  assert.equal(normalizeWaitRequest({ navigation: true }).timeoutMs, 15000);
  assert.equal(normalizeWaitRequest({ hmr: true }).timeoutMs, 15000);
  assert.equal(normalizeWaitRequest({ selector: "h1", timeoutMs: 999_999 }).timeoutMs, WAIT_MAX_MS);
  assert.equal(normalizeWaitRequest({ stableMs: 99_999 }).stableMs, 10_000);
  assert.equal(normalizeWaitRequest({ selector: "h1", stableMs: -1 }).stableMs, null);
}

function urls() {
  const { matchUrl } = lib;
  const href = "http://localhost:5173/settings/profile?tab=2#top";
  assert.equal(matchUrl(href, href), true, "exact");
  assert.equal(matchUrl("/settings/profile?tab=2#top", href), true, "path with query and hash");
  assert.equal(matchUrl("/settings/profile", href), true, "a bare path ignores query and hash");
  assert.equal(matchUrl("/settings/profile/", href), true, "a trailing slash is the same page");
  assert.equal(matchUrl("/settings", href), false, "a parent path is not the page");
  assert.equal(matchUrl("/settings/*", href), true, "path glob");
  assert.equal(matchUrl("*/profile*", href), true, "full URL glob");
  assert.equal(matchUrl("http://localhost:5173/*", href), true);
  assert.equal(matchUrl("http://other:5173/*", href), false);
  assert.equal(matchUrl("/profile\\?tab=\\d/", href), true, "regex");
  assert.equal(matchUrl("/^https:/", href), false);
  assert.equal(matchUrl("/(/", "http://x/("), true, "an invalid regex falls back to a path");
}

function hmrSignals() {
  const { classifyHmrConsole, isHmrRequest } = lib;
  assert.equal(classifyHmrConsole("[vite] hot updated: /src/App.tsx"), "update");
  assert.equal(classifyHmrConsole("%c[vite] css hot updated: /src/index.css"), "update");
  assert.equal(classifyHmrConsole("[vite] page reload src/main.ts"), "reload");
  assert.equal(classifyHmrConsole("[vite] Internal Server Error"), "error");
  assert.equal(classifyHmrConsole("[Fast Refresh] rebuilding"), "start");
  assert.equal(classifyHmrConsole("[Fast Refresh] done in 120ms"), "update");
  assert.equal(classifyHmrConsole("[Fast Refresh] performing full reload"), "reload");
  assert.equal(classifyHmrConsole("[HMR] Updated modules:"), "update");
  assert.equal(classifyHmrConsole("[HMR] Waiting for update signal from WDS..."), "start");
  assert.equal(classifyHmrConsole("[webpack-dev-server] App updated. Recompiling..."), "update");
  assert.equal(classifyHmrConsole("[webpack-dev-server] Errors while compiling. Reload prevented."), "error");
  assert.equal(classifyHmrConsole("[parcel] ✨ Built in 20ms"), "update");
  assert.equal(classifyHmrConsole("hot updated"), null);
  assert.equal(isHmrRequest("http://localhost:3000/_next/static/webpack/abc.webpack.hot-update.json"), true);
  assert.equal(isHmrRequest("http://localhost:8080/main.4f2a.hot-update.js"), true);
  assert.equal(isHmrRequest("http://localhost:5173/src/App.tsx?t=1712345678901"), true);
  assert.equal(isHmrRequest("http://localhost:5173/src/App.tsx?import"), false);
}

function verdicts() {
  const { checkWait, normalizeWaitRequest } = lib;
  const activity = (over = {}) => ({
    lastActionAt: 0, navigations: [], loadingStartedAt: 0, loadingStoppedAt: 0, navigationRequestedAt: 0,
    inFlight: new Map(), lastNetworkAt: 0, hmr: [], lastHmrAt: 0, ...over,
  });
  const probe = (over = {}) => ({ href: "http://x/a", readyState: "complete", title: "", quietMs: 5000, ...over });
  const now = 100_000;

  const nav = normalizeWaitRequest({ navigation: true });
  assert.deepEqual(checkWait(nav, activity({ lastActionAt: 90_000, navigations: [{ at: 80_000, url: "http://x/a" }] }), probe(), now, 99_000).waiting,
    ["no navigation since your last action"]);
  assert.equal(checkWait(nav, activity({ lastActionAt: 90_000, navigations: [{ at: 95_000, url: "http://x/b" }] }), probe(), now, 99_000).ok, true);

  const load = normalizeWaitRequest({ load: "load" });
  assert.deepEqual(checkWait(load, activity({ navigationRequestedAt: 99_000 }), probe(), now, now).waiting, ["a navigation is still loading"]);
  assert.deepEqual(checkWait(load, activity({ lastActionAt: now - 100 }), probe(), now, now).waiting, ["the last action just happened"]);
  assert.deepEqual(checkWait(load, activity(), probe({ readyState: "interactive" }), now, now).waiting, ["document.readyState is interactive"]);
  assert.equal(checkWait(normalizeWaitRequest({ load: "domcontentloaded" }), activity(), probe({ readyState: "interactive" }), now, now).ok, true);
  const idle = normalizeWaitRequest({ load: "networkidle" });
  const busy = checkWait(idle, activity({ inFlight: new Map([["1", { url: "http://x/api", at: 1 }]]) }), probe(), now, now);
  assert.deepEqual(busy.waiting, ["1 request in flight (http://x/api)"]);
  assert.deepEqual(checkWait(idle, activity({ lastNetworkAt: now - 100 }), probe(), now, now).waiting, ["the network was busy less than 500 ms ago"]);

  const hmr = normalizeWaitRequest({ hmr: true });
  assert.deepEqual(checkWait(hmr, activity(), probe(), now, now).waiting, ["no hot update or reload seen yet"]);
  assert.match(checkWait(hmr, activity({ hmr: [{ at: now - 1000, kind: "error", detail: "boom" }], lastHmrAt: now - 1000 }), probe(), now, now).failure, /reported an error after the update: boom/);
  assert.deepEqual(checkWait(hmr, activity({ hmr: [{ at: now - 1000, kind: "reload", detail: "" }], lastHmrAt: now - 1000 }), probe(), now, now).waiting, ["the page has not reloaded yet"]);
  assert.deepEqual(checkWait(hmr, activity({ hmr: [{ at: now - 1000, kind: "update", detail: "" }], lastHmrAt: now - 1000 }), probe({ quietMs: 10 }), now, now).waiting, ["the DOM is still changing"]);
  assert.equal(checkWait(hmr, activity({ hmr: [{ at: now - 1000, kind: "update", detail: "" }], lastHmrAt: now - 1000 }), probe(), now, now).ok, true);
  assert.equal(checkWait(hmr, activity({ hmr: [{ at: now - 20_000, kind: "update", detail: "" }], lastHmrAt: now - 20_000 }), probe(), now, now).ok, false, "an old update does not count");

  const fresh = normalizeWaitRequest({ selector: "h1", fresh: true });
  const stale = checkWait(fresh, activity(), probe({ selector: { count: 2, visible: 2, fresh: 0, matched: false } }), now, now);
  assert.deepEqual(stale.waiting, ["h1 is not visible (fresh): 2 elements match but all existed before your last action"]);
}

const PAGES = {
  "/": `<!doctype html><title>Home</title>
    <h1>Home</h1>
    <a id="next" href="/next">Next</a>
    <button id="push" onclick="setTimeout(() => history.pushState({}, '', '/done?x=1'), 300)">Push</button>
    <button id="swap" onclick="setTimeout(() => { document.body.innerHTML = '<h1>Fresh</h1>'; }, 300)">Swap</button>
    <button id="fetch" onclick="setTimeout(() => fetch('/delay?ms=700'), 50)">Fetch</button>
    <button id="churn" onclick="let n = 0; const t = setInterval(() => { document.title = 'n' + n; document.body.dataset.n = ++n; if (n > 12) clearInterval(t); }, 50)">Churn</button>`,
  "/next": `<!doctype html><title>Next</title><h1>Next page</h1>`,
  "/slow": `<!doctype html><title>Slow</title><h1>Slow</h1><img src="/delay?ms=900">`,
  "/stream": `<!doctype html><title>Stream</title><h1>Stream</h1><script>new EventSource('/sse');</script>`,
  "/sse": (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: hello\n\n");
  },
};

async function inChromium() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium wait checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = await startPageServer(PAGES);
  const page = await openPage(chromium, lib, server.url("/"));
  const { target } = page;
  const unregister = lib.registerBrowserBackend({ kind: "preview", resolve: async () => target });
  const wait = (params) => lib.waitForPage(target, lib.normalizeWaitRequest(params));
  const act = async (expression) => {
    await lib.markAgentAction({});
    await target.evaluate(expression);
  };
  try {
    // url
    await act("document.getElementById('push').click()");
    const pushed = await wait({ url: "/done", timeoutMs: 3000 });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    assert.ok(pushed.waitedMs >= 150, "it waited for the pushState");
    assert.equal(pushed.url, server.url("/done?x=1"));
    assert.equal((await wait({ url: "*/done*" })).ok, true);
    assert.equal((await wait({ url: "/done\\?x=\\d/" })).ok, true);
    const wrong = await wait({ url: "/elsewhere", timeoutMs: 200 });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, `Timed out after 200 ms waiting for url /elsewhere. Seen: url is ${server.url("/done?x=1")}.`);

    // navigation since the last action
    await navigate(target, server.url("/"));
    await act("document.getElementById('next').click()");
    const navigated = await wait({ navigation: true, selector: "h1", timeoutMs: 5000 });
    assert.equal(navigated.ok, true, JSON.stringify(navigated));
    assert.equal(navigated.navigation.url, server.url("/next"));
    assert.equal(navigated.element.text, "Next page");
    await lib.markAgentAction({});
    const none = await wait({ navigation: true, timeoutMs: 300 });
    assert.equal(none.error, "Timed out after 300 ms waiting for a navigation. Seen: no navigation since your last action.");

    // load waits for a slow image; the click's navigation is caught even though it starts after the action returns
    await navigate(target, server.url("/"));
    await act(`setTimeout(() => { location.href = ${JSON.stringify(server.url("/slow"))}; }, 100)`);
    const loaded = await wait({ load: "load" });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.equal(loaded.url, server.url("/slow"));
    assert.ok(loaded.waitedMs >= 800, `load waited for the image (${loaded.waitedMs} ms)`);

    // networkidle: a fetch after the click is waited for
    await navigate(target, server.url("/"));
    await act("document.getElementById('fetch').click()");
    await sleep(120);
    const idle = await wait({ load: "networkidle" });
    assert.equal(idle.ok, true, JSON.stringify(idle));
    assert.ok(idle.waitedMs >= 500, `networkidle waited for the fetch (${idle.waitedMs} ms)`);
    await act("void fetch('/delay?ms=3000')");
    await sleep(100);
    const stillBusy = await wait({ load: "networkidle", timeoutMs: 300 });
    assert.match(stillBusy.error, /^Timed out after 300 ms waiting for networkidle\. Seen: 1 request in flight \(http:\/\/127\.0\.0\.1:\d+\/delay\?ms=3000\)\.$/);
    // An open EventSource never ends, and does not count.
    await navigate(target, server.url("/stream"));
    const streaming = await wait({ load: "networkidle", timeoutMs: 3000 });
    assert.equal(streaming.ok, true, JSON.stringify(streaming));

    // fresh: the h1 of the page being replaced does not count
    await navigate(target, server.url("/"));
    assert.equal((await wait({ selector: "h1" })).element.text, "Home");
    await act("document.getElementById('swap').click()");
    const fresh = await wait({ selector: "h1", fresh: true, timeoutMs: 3000 });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.element.text, "Fresh");
    assert.match(fresh.element.ref, /^@/);
    await lib.markAgentAction({});
    const old = await wait({ selector: "h1", fresh: true, timeoutMs: 200 });
    assert.equal(old.error, "Timed out after 200 ms waiting for h1 visible (fresh). Seen: h1 is not visible (fresh): 1 element match but all existed before your last action.");
    const missing = await wait({ selector: "#nope", timeoutMs: 200 });
    assert.equal(missing.error, "Timed out after 200 ms waiting for #nope visible. Seen: #nope is not visible: no element matches.");
    await assert.rejects(wait({ selector: "h1[", timeoutMs: 1000 }), /not a valid selector/);

    // stable DOM
    await navigate(target, server.url("/"));
    await act("document.getElementById('churn').click()");
    const stable = await wait({ stableMs: 300, timeoutMs: 5000 });
    assert.equal(stable.ok, true, JSON.stringify(stable));
    assert.ok(stable.waitedMs >= 550, `it waited for the churn to stop (${stable.waitedMs} ms)`);

    // hot updates: Vite's console line, then a full reload, then an error
    await navigate(target, server.url("/"));
    await act("setTimeout(() => console.debug('[vite] hot updated: /src/App.tsx'), 200)");
    const updated = await wait({ hmr: true });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.deepEqual(updated.hmr, { kind: "update", detail: "[vite] hot updated: /src/App.tsx" });
    await act("setTimeout(() => { console.debug('[vite] page reload src/main.ts'); setTimeout(() => location.reload(), 300); }, 100)");
    await sleep(200);
    const reloaded = await wait({ hmr: true });
    assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
    assert.equal(reloaded.hmr.kind, "reload");
    assert.ok(reloaded.waitedMs >= 200, "it waited for the reload");
    await act("setTimeout(() => console.error('[vite] Internal Server Error: Transform failed'), 100)");
    const broken = await wait({ hmr: true });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /^The dev server reported an error after the update: \[vite\] Internal Server Error/);
    // Enabling Runtime again replays what the page logged; old lines are not new updates.
    const recorded = lib.pageActivity(page.session).hmr.length;
    await page.session.send("Runtime.disable");
    await page.session.send("Runtime.enable");
    await sleep(150);
    assert.equal(lib.pageActivity(page.session).hmr.length, recorded, "a replayed console line is not a new hot update");
    await lib.markAgentAction({});
    const quiet = await wait({ hmr: true, timeoutMs: 300 });
    assert.equal(quiet.error, "Timed out after 300 ms waiting for the hot update to finish. Seen: no hot update or reload seen yet.");
  } finally {
    unregister();
    page.close();
    server.close();
    await chromium.close();
  }
}

(async () => {
  requests();
  urls();
  hmrSignals();
  verdicts();
  await inChromium();
  console.log("preview waits: request rules, url matching, hot update signals, verdicts, and url/navigation/load/networkidle/fresh/stable/hmr on a real page");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
