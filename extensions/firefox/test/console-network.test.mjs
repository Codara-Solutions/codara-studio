import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

/** console-hook.js in a fresh context with a page console and Firefox's content-script helpers stubbed. */
function hookedPage(assembled) {
  const logged = [];
  const sent = [];
  const listeners = {};
  let answerHello;
  const page = {
    console: Object.fromEntries(["log", "info", "debug", "warn", "error", "trace", "dir", "table", "assert"].map((level) => [level, (...args) => logged.push([level, ...args])])),
  };
  const context = {
    // The hook's own stack: its frame, then the page's (as Firefox gives it).
    Error: function HookError() {
      return { stack: "@moz-extension://id/console-hook.js:80:15\nrun@https://a.example/app.js:12:5\n" };
    },
    window: { wrappedJSObject: page, addEventListener: (type, listener) => (listeners[type] = listener) },
    exportFunction: (fn, target, { defineAs }) => (target[defineAs] = fn),
    browser: {
      runtime: {
        sendMessage: (message) => {
          if (message.type === "codara-console-hello") return new Promise((resolve) => (answerHello = resolve));
          // Firefox hands messages over as structured clones.
          sent.push(structuredClone(message.entry));
          return Promise.resolve();
        },
        onMessage: { addListener: (listener) => (listeners.message = listener) },
      },
    },
  };
  vm.runInNewContext(readFileSync(join(assembled, "console-hook.js"), "utf8"), context);
  return { page, logged, sent, listeners, answerHello: (answer) => answerHello(answer) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function run(assembled) {
  const { consoleEvent } = await import(pathToFileURL(join(assembled, "lib", "console.js")).href);
  const network = await import(pathToFileURL(join(assembled, "lib", "network.js")).href);
  const { redactCdpEvent } = await import(pathToFileURL(join(assembled, "lib", "policy.js")).href);

  // ── the hook: the page's console still logs; nothing leaves before the tab is shared ──
  const hook = hookedPage(assembled);
  hook.page.console.log("early", { x: 1 }, [1, 2], 0 / 0);
  hook.page.console.assert(true, "fine");
  assert.deepEqual(hook.logged.map(([level]) => level), ["log", "assert"], "the page's own console still runs");
  assert.deepEqual(hook.sent, [], "nothing is sent before the extension answers");
  hook.answerHello({ mode: "off" });
  await tick();
  hook.page.console.warn("unshared");
  hook.listeners.message({ type: "codara-console", mode: "on", since: 0 });
  assert.deepEqual(hook.sent, [], "a tab not shared at load sends nothing, and keeps nothing for later");
  hook.listeners.message({ type: "codara-console", mode: "off", since: 0 });
  hook.page.console.log("while off");
  hook.listeners.message({ type: "codara-console", mode: "wait", since: 0 });
  hook.page.console.error("kept while shared");
  hook.listeners.message({ type: "codara-console", mode: "on", since: 0 });
  assert.equal(hook.sent.length, 1, "only what was logged while the tab was shared is replayed");
  assert.deepEqual(hook.sent[0], { kind: "console", level: "error", args: [{ type: "string", value: "kept while shared" }], at: hook.sent[0].at, source: "https://a.example/app.js", line: 12 });
  // Entries from before the tab's current sharing began are never replayed.
  hook.listeners.message({ type: "codara-console", mode: "off", since: 0 });
  hook.listeners.message({ type: "codara-console", mode: "wait", since: 0 });
  hook.page.console.log("from an earlier sharing");
  hook.listeners.message({ type: "codara-console", mode: "on", since: Date.now() + 5000 });
  assert.equal(hook.sent.length, 1, "kept entries older than the sharing are dropped");
  const loop = { a: 1 };
  loop.self = loop;
  hook.page.console.log({ x: 1 }, [1, 2], 0 / 0, -0, 10n, null, undefined, "y".repeat(20_000), ...Array(30).fill(1));
  hook.page.console.log(loop, { long: Array(100_000).fill(7) }, new Date(0));
  assert.deepEqual(hook.sent.at(-1).args.map((arg) => arg.value.slice(0, 40)), ['{"a":1,"self":{"a":1,"self":{"a":1,"self', '{"long":[7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7', '"1970-01-01T00:00:00.000Z"']);
  assert.ok(hook.sent.at(-1).args[1].value.endsWith(",…]}"), "a long array is cut, not walked");
  hook.page.console.log(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])), { ["x".repeat(50_000)]: 1, y: 2 });
  assert.ok(hook.sent.at(-1).args[0].value.endsWith(',"k99":99,…}'), "at most 100 keys are shown");
  assert.equal(hook.sent.at(-1).args[1].value.length <= 10_010, true, "key text counts against the length");
  hook.sent.pop();
  hook.sent.pop();
  assert.deepEqual(hook.sent.at(-1).args.slice(0, 7), [
    { type: "object", value: '{"x":1}' },
    { type: "object", subtype: "array", value: "[1,2]" },
    { type: "number", unserializableValue: "NaN" },
    { type: "number", unserializableValue: "-0" },
    { type: "bigint", unserializableValue: "10n" },
    { type: "object", subtype: "null", value: null },
    { type: "undefined" },
  ]);
  assert.equal(hook.sent.at(-1).args.length, 20, "arguments capped in the page, before they are sent");
  assert.equal(hook.sent.at(-1).args[7].value.length, 10_000, "text capped in the page");
  hook.page.console.log("same");
  hook.page.console.log("same");
  assert.notEqual(hook.sent.at(-1).at, hook.sent.at(-2).at, "two entries never share a time, so Codara's replay check keeps both");
  const error = { name: "TypeError", message: "x is null", stack: "f@https://a.example/app.js:3:1\n" };
  hook.listeners.error({ isTrusted: true, message: "Uncaught TypeError: x is null", filename: "https://a.example/app.js", lineno: 3, error });
  assert.deepEqual(hook.sent.at(-1), { kind: "exception", message: "TypeError: x is null\nf@https://a.example/app.js:3:1\n", source: "https://a.example/app.js", line: 3, at: hook.sent.at(-1).at });
  const before = hook.sent.length;
  hook.listeners.error({ isTrusted: false, message: "made up", filename: "https://a.example/app.js", lineno: 1 });
  hook.listeners.unhandledrejection({ isTrusted: false, reason: "made up" });
  assert.equal(hook.sent.length, before, "events a page dispatches itself are not the page's errors");
  hook.listeners.unhandledrejection({ isTrusted: true, reason: "no" });
  assert.equal(hook.sent.at(-1).message, "Uncaught (in promise) no");
  hook.listeners.message({ type: "codara-console", mode: "off", since: 0 });
  const count = hook.sent.length;
  for (let i = 0; i < 300; i++) hook.page.console.log("loop");
  hook.listeners.message({ type: "codara-console", mode: "on", since: 0 });
  assert.equal(hook.sent.length, count, "nothing once the tab is unshared, and nothing kept from then");
  for (let i = 0; i < 300; i++) hook.page.console.log("loop");
  assert.ok(hook.sent.length - count <= 100, "a page logging in a loop is capped per second, before it is described");

  // ── console entries as protocol events ──
  assert.deepEqual(consoleEvent({ kind: "console", level: "warn", args: [{ type: "string", value: "w" }, { type: "object", value: '{"a":1}', extra: "x" }], at: 5000, source: "https://a.example/app.js", line: 12 }), [
    "Runtime.consoleAPICalled",
    {
      type: "warning",
      args: [{ type: "string", value: "w" }, { type: "object", value: '{"a":1}' }],
      timestamp: 5000,
      stackTrace: { callFrames: [{ url: "https://a.example/app.js", lineNumber: 11, columnNumber: 0, functionName: "", scriptId: "" }] },
    },
  ]);
  assert.deepEqual(consoleEvent({ kind: "exception", message: "TypeError: x", at: 5000 }), ["Runtime.exceptionThrown", { timestamp: 5000, exceptionDetails: { text: "Uncaught", exception: { type: "object", subtype: "error", description: "TypeError: x" } } }]);
  for (const bad of [null, "x", { kind: "console", level: "eval", args: [] }, { kind: "console", level: "log" }, { kind: "exception" }, { kind: "debugger" }]) assert.equal(consoleEvent(bad), null, JSON.stringify(bad));
  const long = consoleEvent({ kind: "console", level: "log", args: Array.from({ length: 50 }, () => ({ type: "string", value: "x".repeat(20_000) })), at: 1 });
  assert.equal(long[1].args.length, 20);
  assert.equal(long[1].args[0].value.length, 10_000);

  // ── webRequest as Network events ──
  const base = { requestId: "38", tabId: 7, frameId: 0, type: "xmlhttprequest", url: "https://a.example/data.json", method: "GET", documentUrl: "https://a.example/app", timeStamp: 5000 };
  const sent = network.requestEvent(base, {
    headers: [{ name: "Accept", value: "*/*" }, { name: "Cookie", value: "s=1" }],
    redirect: { ...base, statusCode: 302, statusLine: "HTTP/1.1 302 Found", responseHeaders: [{ name: "location", value: "/data.json" }, { name: "Set-Cookie", value: "a=1" }, { name: "Set-Cookie", value: "b=2" }], ip: "127.0.0.1", fromCache: false },
    loaderId: "L1",
  });
  assert.deepEqual(sent[1].request, { url: "https://a.example/data.json", method: "GET", headers: { Accept: "*/*", Cookie: "s=1" } });
  assert.deepEqual(sent[1].redirectResponse.headers, { location: "/data.json", "Set-Cookie": "a=1\nb=2" });
  assert.deepEqual(network.headerObject([{ name: "constructor", value: "x" }, { name: "toString", value: "y" }]), { constructor: "x", toString: "y" }, "header names are only names");
  assert.deepEqual([sent[1].type, sent[1].frameId, sent[1].loaderId, sent[1].documentURL, sent[1].redirectResponse.status, sent[1].redirectResponse.statusText], ["Fetch", "firefox-tab-7", "L1", "https://a.example/app", 302, "Found"]);
  // Cookies come out unless the tab's cookie switch is on, as in Chrome.
  assert.deepEqual(redactCdpEvent(...sent, false).request.headers, { Accept: "*/*" });
  assert.deepEqual(redactCdpEvent(...sent, true).request.headers, { Accept: "*/*", Cookie: "s=1" });
  const response = network.responseEvent({ ...base, statusCode: 200, statusLine: "HTTP/1.1 200 OK", ip: "127.0.0.1", fromCache: true, responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }, { name: "Set-Cookie", value: "s=1; HttpOnly" }] }, "L1");
  assert.deepEqual(response[1].response, { url: base.url, status: 200, statusText: "OK", headers: { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "s=1; HttpOnly" }, mimeType: "application/json", protocol: "http/1.1", remoteIPAddress: "127.0.0.1", fromDiskCache: true });
  assert.deepEqual(redactCdpEvent(...response, false).response.headers, { "Content-Type": "application/json; charset=utf-8" });
  assert.deepEqual(network.finishedEvent(base), ["Network.loadingFinished", { requestId: "38", timestamp: 5 }]);
  assert.deepEqual(network.failedEvent({ ...base, error: "NS_BINDING_ABORTED" })[1], { requestId: "38", timestamp: 5, type: "Fetch", errorText: "NS_BINDING_ABORTED", canceled: true });
  assert.equal(network.frameIdOf({ tabId: 7, frameId: 4 }), "firefox-frame-7-4");
  // Nothing for or from a blocked site, nor from no tab.
  const blocked = (url) => new URL(url).hostname === "bank.example";
  assert.equal(network.requestVisible(base, blocked), true);
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/pixel.gif", type: "image" }, blocked), false, "a page's request to a blocked site");
  assert.equal(network.requestVisible({ ...base, frameId: 9, frameAncestors: [{ url: "https://bank.example/", frameId: 3 }] }, blocked), false, "inside a blocked site's frame");
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/", type: "main_frame", documentUrl: undefined }, blocked), false);
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/frame", type: "sub_frame" }, blocked), false);
  assert.equal(network.requestVisible({ ...base, documentUrl: "https://bank.example/frame" }, blocked), false);
  assert.equal(network.requestVisible({ ...base, tabId: -1 }, blocked), false);
  assert.equal(network.requestVisible({ ...base, type: "sub_frame", url: "https://a.example/frame", originUrl: "https://bank.example/frame" }, blocked), false, "a blocked frame navigating itself");
  return "console and network: the hook sends nothing until shared, entries and webRequest as protocol events, cookies out unless switched on";
}
