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
    JSON,
    Array,
    Error: function PageError() {
      return { stack: "@https://a.example/app.js:12:5\n" };
    },
  };
  const context = {
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
  assert.deepEqual(hook.sent, [], "nothing is sent before the extension says the tab is shared");
  hook.answerHello({ on: false });
  await tick();
  hook.page.console.warn("unshared");
  assert.deepEqual(hook.sent, [], "an unshared tab sends nothing, and keeps nothing");
  hook.page.console.error("kept until shared");
  hook.listeners.message({ type: "codara-console", on: true });
  assert.equal(hook.sent.length, 2, "the entries kept since the tab was turned off go once it is on");
  assert.deepEqual(hook.sent[1], { kind: "console", level: "error", args: [{ type: "string", value: "kept until shared" }], at: hook.sent[1].at, source: "https://a.example/app.js", line: 12 });
  hook.page.console.log({ x: 1 }, [1, 2], 0 / 0, -0, 10n, null, undefined);
  assert.deepEqual(hook.sent[2].args, [
    { type: "object", value: '{"x":1}' },
    { type: "object", subtype: "array", value: "[1,2]" },
    { type: "number", unserializableValue: "NaN" },
    { type: "number", unserializableValue: "-0" },
    { type: "bigint", unserializableValue: "10n" },
    { type: "object", subtype: "null", value: null },
    { type: "undefined" },
  ]);
  hook.listeners.error({ message: "Uncaught TypeError: x is null", filename: "https://a.example/app.js", lineno: 3, error: { name: "TypeError", message: "x is null", stack: "f@https://a.example/app.js:3:1\n" } });
  assert.deepEqual(hook.sent.at(-1), { kind: "exception", message: "TypeError: x is null\nf@https://a.example/app.js:3:1\n", source: "https://a.example/app.js", line: 3, at: hook.sent.at(-1).at });
  hook.listeners.message({ type: "codara-console", on: false });
  hook.page.console.log("after unsharing");
  const count = hook.sent.length;
  for (let i = 0; i < 300; i++) hook.page.console.log("loop");
  assert.equal(hook.sent.length, count, "nothing once the tab is unshared");
  hook.listeners.message({ type: "codara-console", on: true });
  for (let i = 0; i < 300; i++) hook.page.console.log("loop");
  assert.ok(hook.sent.length - count <= 100 + 50, "a page logging in a loop is capped per second");

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
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/pixel.gif", type: "image" }, blocked), true, "a page's request to another site is the page's, as in Chrome");
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/", type: "main_frame", documentUrl: undefined }, blocked), false);
  assert.equal(network.requestVisible({ ...base, url: "https://bank.example/frame", type: "sub_frame" }, blocked), false);
  assert.equal(network.requestVisible({ ...base, documentUrl: "https://bank.example/frame" }, blocked), false);
  assert.equal(network.requestVisible({ ...base, tabId: -1 }, blocked), false);
  return "console and network: the hook sends nothing until shared, entries and webRequest as protocol events, cookies out unless switched on";
}
