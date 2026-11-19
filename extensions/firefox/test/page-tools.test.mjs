import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

// The scripts run here in a fresh context, as userScripts.execute runs them
// in a page: the value of the script's last statement is the result.
const PAGE = "https://a.example/account?x=1";

function inPage(code, globals = {}) {
  return vm.runInNewContext(code, { location: { href: PAGE }, ...globals });
}

/** What Firefox reports for a script: { result } or an empty error when it does not compile or throws. */
async function execute(code, globals) {
  try {
    // Firefox hands results over as structured clones.
    return { result: structuredClone(await inPage(code, globals)) };
  } catch {
    return { error: null };
  }
}

export async function run(assembled) {
  const tools = await import(pathToFileURL(join(assembled, "lib", "page-tools.js")).href);
  const { expressionScript, expressionAnswer, frameFailed, NO_ANSWER, documentGuard } = tools;
  const evaluate = async (expression, options = {}, globals = {}) => expressionAnswer((await execute(expressionScript(expression, options), globals)).result);

  // Values come back as Runtime.evaluate gives them with returnByValue.
  assert.deepEqual(await evaluate("document.title", {}, { document: { title: "Strict" } }), { result: { type: "string", value: "Strict" } });
  assert.deepEqual(await evaluate("({ a: 1, b: [2, 'x'], skip: undefined })"), { result: { type: "object", value: { a: 1, b: [2, "x"] } } });
  assert.deepEqual(await evaluate("undefined"), { result: { type: "undefined" } });
  assert.deepEqual(await evaluate("null"), { result: { type: "object", subtype: "null", value: null } });
  assert.deepEqual(await evaluate("0 / 0"), { result: { type: "number", unserializableValue: "NaN" } });
  assert.deepEqual(await evaluate("-0"), { result: { type: "number", unserializableValue: "-0" } });
  assert.deepEqual(await evaluate("10n"), { result: { type: "bigint", unserializableValue: "10n" } });
  assert.deepEqual(await evaluate("() => 1"), { result: { type: "function", value: {} } });
  // A last line comment does not swallow the wrapper.
  assert.deepEqual(await evaluate("1 + 1 // done"), { result: { type: "number", value: 2 } });
  // The expression sees the page's globals, never the wrapper's names.
  assert.deepEqual(await evaluate("[value, encode, describe]", {}, { value: "v", encode: "e", describe: "d" }), { result: { type: "object", value: ["v", "e", "d"] } });

  // A throw comes back as exceptionDetails, with the message Codara shows first.
  const thrown = await evaluate("null.x");
  assert.equal(thrown.exceptionDetails.text, "Uncaught");
  assert.match(thrown.exceptionDetails.exception.description, /^TypeError: /);
  assert.deepEqual((await evaluate("(() => { throw 'boom'; })()")).exceptionDetails.exception, { type: "string", value: "boom" });
  // Promises: awaited when asked, a rejection is a throw; not awaited, a promise is an empty object.
  assert.deepEqual(await evaluate("Promise.resolve({ late: 1 })", { awaitPromise: true }), { result: { type: "object", value: { late: 1 } } });
  assert.match((await evaluate("Promise.reject(new RangeError('nope'))", { awaitPromise: true })).exceptionDetails.exception.description, /^RangeError: nope/);
  assert.deepEqual(await evaluate("Promise.resolve(1)"), { result: { type: "object", value: {} } });
  // A cycle cannot be returned by value: an error, not a hang.
  assert.match((await evaluate("(() => { const a = {}; a.a = a; return a; })()")).exceptionDetails.exception.description, /^TypeError/);
  assert.throws(() => expressionAnswer(undefined), /no answer/);
  assert.throws(() => expressionAnswer({ value: "forged" }), /no answer/);

  // Firefox's answer for a frame: an error (even for a syntax error) or a result.
  assert.equal(frameFailed(await execute(expressionScript("var x = 1; x"))), true, "statements do not compile as the expression");
  assert.equal(frameFailed({ frameId: 0, result: null }), false);
  assert.equal(frameFailed({ frameId: 0, error: null }), true);
  assert.equal(frameFailed(undefined), true);
  assert.equal(NO_ANSWER.exceptionDetails.exception.className, "SyntaxError");

  // The guard runs alone, first: on another address it throws its token
  // (and Firefox runs nothing after it), even if the page replaced String methods.
  const guard = documentGuard(PAGE, "moved-1");
  assert.equal(inPage(guard), undefined);
  assert.throws(() => inPage(guard, { location: { href: `${PAGE}#elsewhere` } }), (thrown) => thrown === "moved-1");
  assert.throws(
    () => inPage(`String.prototype.split = () => [${JSON.stringify(PAGE)}]; String.prototype.startsWith = () => true;\n${guard}`, { location: { href: "https://a.example/admin" } }),
    (thrown) => thrown === "moved-1",
  );
  // The address is a string literal: one that looks like code runs nothing.
  const quoted = { location: { href: PAGE } };
  assert.throws(() => vm.runInNewContext(documentGuard('x"; globalThis.ran = 1; "', "t"), quoted), (thrown) => thrown === "t");
  assert.equal(quoted.ran, undefined);

  permissions(tools);
  screenshots(tools);
  return "page tools: evaluate's wrapper and answers, compile checks run nothing, permissions and their errors, screenshots and layout";
}

function permissions({ PAGE_METHODS, accessNeeds, sitePattern, accessRequest, accessKey, accessError, accessRows, unansweredAsks, currentQuestion }) {
  // A question shown for one site never asks for it once the tab is on another.
  const shown = [
    { need: "site", tabId: 7, key: "site:https://a.example/*", request: { origins: ["https://a.example/*"] } },
    { need: "scripts", tabId: 7, key: "scripts", request: { permissions: ["userScripts"] } },
  ];
  assert.equal(currentQuestion(shown, "site", { tabId: 7, url: "https://a.example/other?x" }), shown[0], "same site, other page");
  assert.equal(currentQuestion(shown, "site", { tabId: 7, url: "https://b.example/" }), null, "the tab moved to another site");
  assert.equal(currentQuestion(shown, "site", { tabId: 7, url: "http://a.example/" }), null, "another scheme is another site");
  assert.equal(currentQuestion(shown, "site", { tabId: 8, url: "https://a.example/" }), null, "another tab");
  assert.equal(currentQuestion(shown, "scripts", { tabId: 7, url: "https://b.example/" }), shown[1], "not about a site");
  assert.equal(currentQuestion(shown, "allSites", { tabId: 7, url: "https://a.example/" }), null);

  // A no is forgotten only when that very permission is granted.
  const asked = { "site:https://a.example/*": 1, scripts: 2, allSites: 3 };
  assert.deepEqual(unansweredAsks(asked, { permissions: [], origins: ["<all_urls>"] }), { "site:https://a.example/*": 1, scripts: 2 });
  assert.deepEqual(unansweredAsks(asked, { permissions: ["userScripts"], origins: ["https://a.example/*"] }), { allSites: 3 });
  assert.deepEqual(unansweredAsks(undefined, {}), {});

  assert.deepEqual([...PAGE_METHODS].sort(), ["Page.captureScreenshot", "Page.getLayoutMetrics", "Runtime.evaluate"]);
  assert.deepEqual(accessNeeds("Runtime.evaluate"), ["site", "scripts"]);
  assert.deepEqual(accessNeeds("Page.getLayoutMetrics"), ["site"]);
  assert.deepEqual(accessNeeds("Page.captureScreenshot"), ["allSites"]);
  assert.deepEqual(accessNeeds("Page.enable"), []);

  // Firefox's match patterns take no port.
  assert.equal(sitePattern("http://127.0.0.1:8080/a?b#c"), "http://127.0.0.1/*");
  assert.equal(sitePattern("https://xn--bcher-kva.example/"), "https://xn--bcher-kva.example/*");
  for (const url of ["file:///etc/passwd", "about:blank", "moz-extension://x/popup.html", "", "not a url"]) assert.equal(sitePattern(url), null, url);
  assert.deepEqual(accessRequest("site", "https://a.example/x"), { origins: ["https://a.example/*"] });
  assert.equal(accessRequest("site", "about:blank"), null);
  assert.deepEqual(accessRequest("scripts"), { permissions: ["userScripts"] }, "asked alone: Firefox refuses it with another permission");
  assert.deepEqual(accessRequest("allSites"), { origins: ["<all_urls>"] });
  assert.equal(accessKey("site", "https://a.example:444/x"), "site:https://a.example/*");
  assert.equal(accessKey("scripts", "https://a.example/"), "scripts");

  // A plain error says what to do, and says so differently after a no.
  for (const need of ["site", "scripts", "allSites"]) {
    const first = accessError(need, "https://a.example/x", false);
    const after = accessError(need, "https://a.example/x", true);
    assert.notEqual(first, after);
    assert.match(first, /Codara extension popup/);
    assert.match(after, /did not allow/);
  }
  assert.match(accessError("site", "https://a.example/x", false), /a\.example/);

  const none = { site: false, scripts: false, allSites: false };
  const noAsks = { site: false, scripts: false, allSites: false };
  const needs = (rows) => rows.map((row) => row.need);
  // One tab: its site first, then scripts, then screenshots (all sites).
  assert.deepEqual(needs(accessRows({ url: "https://a.example/", reach: "tabs", has: none, asked: noAsks })), ["site", "scripts", "allSites"]);
  // This window or Everything: all sites first, the site still on offer (enough to read this tab).
  assert.deepEqual(needs(accessRows({ url: "https://a.example/", reach: "window", has: none, asked: noAsks })), ["allSites", "site", "scripts"]);
  assert.deepEqual(needs(accessRows({ url: "https://a.example/", reach: "all", has: { ...none, site: true }, asked: { ...noAsks, allSites: true } })), ["allSites", "scripts"]);
  // All sites covers the site.
  assert.deepEqual(needs(accessRows({ url: "https://a.example/", reach: "tabs", has: { site: true, scripts: false, allSites: true }, asked: noAsks })), ["scripts"]);
  assert.deepEqual(accessRows({ url: "https://a.example/", reach: "all", has: { site: true, scripts: true, allSites: true }, asked: noAsks }), []);
  const rows = accessRows({ url: "https://a.example/", reach: "tabs", has: none, asked: noAsks });
  const rowsAfterNo = accessRows({ url: "https://a.example/", reach: "tabs", has: none, asked: { site: true, scripts: true, allSites: true } });
  for (const [at, row] of rows.entries()) {
    assert.ok(row.text && row.button, row.need);
    assert.ok(!/\.\s+\S/.test(row.text), `one sentence: ${row.text}`);
    assert.notEqual(row.text, rowsAfterNo[at].text, `a no reads differently: ${row.need}`);
  }
  assert.equal(rows[0].button, "Allow a.example");
}

function screenshots({ captureOptions, screenshotAnswer, measureLayout, layoutMetrics, isPageChange, MOVED_ERROR }) {
  // A reading is dropped when the tab changed page at any point while it was
  // taken: a load, or an app's own route change (there and back included).
  assert.equal(isPageChange({ status: "loading" }), true);
  assert.equal(isPageChange({ url: "https://a.example/b" }), true, "a route change counts, not only a load");
  assert.equal(isPageChange({ title: "New title" }), false);
  assert.equal(isPageChange({ status: "complete" }), false);

  assert.deepEqual(captureOptions({ format: "png" }), { format: "png" });
  assert.deepEqual(captureOptions(undefined), { format: "png" });
  assert.throws(() => captureOptions({ format: "webp" }), /PNG or JPEG only, not webp/);
  assert.deepEqual(captureOptions({ format: "jpeg", quality: 140 }), { format: "jpeg", quality: 100 });
  assert.deepEqual(
    captureOptions({ format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 3000, scale: 1 } }),
    { format: "png", rect: { x: 0, y: 0, width: 800, height: 3000 } },
  );
  assert.deepEqual(captureOptions({ clip: { x: 10, y: 20, width: 30, height: 40, scale: 2 } }).scale, 2);
  assert.equal(captureOptions({ clip: { x: 0, y: 0, width: 0, height: 10 } }).rect, undefined);
  assert.equal(captureOptions({ clip: { x: "0", y: 0, width: 5, height: 10 } }).rect, undefined);

  assert.deepEqual(screenshotAnswer("data:image/png;base64,iVBORw0K"), { data: "iVBORw0K" });
  assert.deepEqual(screenshotAnswer("data:image/jpeg;base64,/9j/"), { data: "/9j/" });
  assert.throws(() => screenshotAnswer("data:text/html,hi"), /no image/);

  const page = {
    document: { documentElement: { clientWidth: 1350, clientHeight: 680, scrollWidth: 1350, scrollHeight: 3000 }, body: { scrollWidth: 1200, scrollHeight: 3029 } },
    window: { visualViewport: { offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 400, width: 1350, height: 680, scale: 1 } },
    scrollX: 0,
    scrollY: 400,
    devicePixelRatio: 2,
  };
  const measure = (context, expected = PAGE) => vm.runInNewContext(`(${measureLayout.toString()})(${JSON.stringify(expected)})`, { location: { href: PAGE }, ...context });
  const measured = measure(page);
  // Measured only on the page checked: another address of the same document is not measured.
  assert.throws(() => layoutMetrics(measure({ ...page, location: { href: "https://a.example/other" } })), (error) => error.message === MOVED_ERROR);
  const metrics = layoutMetrics(measured);
  assert.deepEqual(metrics.cssContentSize, { x: 0, y: 0, width: 1350, height: 3029 });
  assert.deepEqual(metrics.cssLayoutViewport, { pageX: 0, pageY: 400, clientWidth: 1350, clientHeight: 680 });
  assert.equal(metrics.cssVisualViewport.pageY, 400);
  assert.deepEqual(metrics.contentSize, { x: 0, y: 0, width: 2700, height: 6058 }, "the old fields in device pixels");
  assert.equal(layoutMetrics({ ...measured, visual: null }).cssVisualViewport.clientWidth, 1350);
  // In quirks mode the root's client size is the document's; the body's is the viewport's.
  const quirks = {
    ...page,
    document: {
      compatMode: "BackCompat",
      documentElement: { clientWidth: 1350, clientHeight: 3029, scrollWidth: 1350, scrollHeight: 3029 },
      body: { clientWidth: 1350, clientHeight: 680, scrollWidth: 1350, scrollHeight: 3029 },
    },
  };
  const inQuirks = layoutMetrics(measure(quirks));
  assert.deepEqual(inQuirks.cssLayoutViewport, { pageX: 0, pageY: 400, clientWidth: 1350, clientHeight: 680 });
  assert.deepEqual(inQuirks.cssContentSize, { x: 0, y: 0, width: 1350, height: 3029 });
  assert.throws(() => layoutMetrics(null), /did not report its size/);
}
