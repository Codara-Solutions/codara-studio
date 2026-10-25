// The browser API a codara_browser_use snippet sees, evaluated once per
// session inside the kernel's QuickJS context (kernel-worker.ts). It takes the
// host functions the worker installed, hides them, and returns the settle
// function the worker hands each snippet's promise to. Every browser action is
// one __cbCall(method, argsJson) answered by main, which runs the existing
// preview.* handler for it; nothing here can reach the page or the host any
// other way. Plain ES2023 for QuickJS, kept as text so no build step rewrites
// it.

export const BROWSER_PRELUDE = String.raw`(function () {
  "use strict";
  var hostCall = globalThis.__cbCall;
  var hostSleep = globalThis.__cbSleep;
  var hostLog = globalThis.__cbLog;
  var hostDone = globalThis.__cbDone;
  var init = JSON.parse(globalThis.__cbInit);
  delete globalThis.__cbCall;
  delete globalThis.__cbSleep;
  delete globalThis.__cbLog;
  delete globalThis.__cbDone;
  delete globalThis.__cbInit;

  // Captured so a snippet that replaces JSON or Promise breaks only itself.
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var NativePromise = Promise;

  class BrowserError extends Error {
    constructor(message) {
      super(message);
      this.name = "BrowserError";
    }
  }

  function rpc(method, args) {
    return hostCall(method, stringify(args || {})).then(function (text) {
      var reply = parse(text);
      if (!reply.ok) throw new BrowserError(reply.error);
      var value = reply.value;
      if (value && typeof value === "object" && value.ok === false) throw new BrowserError(value.error || method + " failed");
      return value;
    });
  }

  function sleep(ms) {
    return hostSleep(Number(ms) || 0).then(function () { return undefined; });
  }

  var nextTimer = 1;
  var liveTimers = new Set();
  function setTimeout(fn, ms) {
    var id = nextTimer++;
    var rest = Array.prototype.slice.call(arguments, 2);
    liveTimers.add(id);
    sleep(ms).then(function () {
      if (!liveTimers.delete(id)) return;
      fn.apply(undefined, rest);
    });
    return id;
  }
  function clearTimeout(id) { liveTimers.delete(id); }
  function setInterval(fn, ms) {
    var id = nextTimer++;
    liveTimers.add(id);
    var tick = function () {
      sleep(Math.max(10, Number(ms) || 0)).then(function () {
        if (!liveTimers.has(id)) return;
        fn();
        tick();
      });
    };
    tick();
    return id;
  }

  function format(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) return value.name + ": " + value.message;
    try { return safeJson(value); } catch (error) { return String(value); }
  }

  function safeJson(value) {
    var seen = new WeakSet();
    return stringify(value, function (key, item) {
      if (typeof item === "bigint") return item.toString() + "n";
      if (typeof item === "function") return "[Function " + (item.name || "anonymous") + "]";
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return Array.from(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  }

  var consoleObject = {};
  ["log", "info", "warn", "error", "debug", "dir", "table"].forEach(function (level) {
    consoleObject[level] = function () {
      var line = Array.prototype.map.call(arguments, format).join(" ");
      hostLog(level === "log" || level === "info" || level === "dir" || level === "table" ? line : level + ": " + line);
    };
  });

  function pick(source, keys) {
    var out = {};
    if (!source) return out;
    keys.forEach(function (key) { if (source[key] !== undefined) out[key] = source[key]; });
    return out;
  }

  function textMatch(value) {
    if (value instanceof RegExp) return { re: value.source, flags: value.flags };
    if (value === undefined || value === null) return undefined;
    return String(value);
  }

  function step(kind, value, options) {
    var out = {};
    out[kind] = textMatch(value);
    options = options || {};
    if (options.exact) out.exact = true;
    if (options.includeHidden) out.includeHidden = true;
    return out;
  }

  function timeoutOf(options, fallback) {
    return options && typeof options.timeout === "number" ? options.timeout : fallback;
  }

  class Locator {
    constructor(tab, chain) {
      this.tab = tab;
      this.chain = chain;
    }
    _with(next) { return new Locator(this.tab, this.chain.concat([next])); }
    locator(selector) { return this._with({ css: String(selector) }); }
    getByRole(role, options) {
      options = options || {};
      var next = { role: String(role) };
      if (options.name !== undefined) next.name = textMatch(options.name);
      if (options.exact) next.exact = true;
      if (options.checked !== undefined) next.checked = Boolean(options.checked);
      if (options.level !== undefined) next.level = Number(options.level);
      if (options.includeHidden) next.includeHidden = true;
      return this._with(next);
    }
    getByText(text, options) { return this._with(step("text", text, options)); }
    getByLabel(text, options) { return this._with(step("label", text, options)); }
    getByPlaceholder(text, options) { return this._with(step("placeholder", text, options)); }
    getByAltText(text, options) { return this._with(step("altText", text, options)); }
    getByTitle(text, options) { return this._with(step("title", text, options)); }
    getByTestId(id) { return this._with({ testId: String(id) }); }
    first() { return this._with({ nth: 0 }); }
    last() { return this._with({ nth: -1 }); }
    nth(index) { return this._with({ nth: Number(index) }); }
    filter(options) {
      options = options || {};
      var filter = {};
      if (options.hasText !== undefined) filter.hasText = textMatch(options.hasText);
      if (options.hasNotText !== undefined) filter.hasNotText = textMatch(options.hasNotText);
      if (options.visible !== undefined) filter.visible = Boolean(options.visible);
      return this._with({ filter: filter });
    }
    async _locate(request) { return (await this.tab._call("preview.locate", { chain: this.chain, request: request })).value; }
    async _ref(options) {
      var found = await this._locate({ op: "resolve", timeoutMs: timeoutOf(options, 5000) });
      return found.ref;
    }
    async describe(options) { return this._locate({ op: "resolve", timeoutMs: timeoutOf(options, 5000) }); }
    async click(options) {
      options = options || {};
      var ref = await this._ref(options);
      if (options.button === "right" || options.clickCount === 2 || options.trusted || options.modifiers) {
        var action = options.button === "right" ? "rightclick" : options.clickCount === 2 ? "dblclick" : "click";
        return this.tab._call("preview.mouse", Object.assign({ selector: ref, action: action }, options.modifiers ? { modifiers: options.modifiers } : {}));
      }
      return this.tab._call("preview.click", { selector: ref });
    }
    async dblclick(options) { return this.click(Object.assign({}, options, { clickCount: 2 })); }
    async fill(text, options) {
      return this.tab._call("preview.type", { selector: await this._ref(options), text: String(text), clearFirst: true });
    }
    async type(text, options) {
      return this.tab._call("preview.type", { selector: await this._ref(options), text: String(text) });
    }
    async pressSequentially(text, options) { return this.type(text, options); }
    async press(key, options) {
      var ref = await this._ref(options);
      if (/.\+./.test(String(key))) {
        await this.focus({ timeout: 0 });
        return this.tab._call("preview.key", { key: String(key) });
      }
      return this.tab._call("preview.press_key", { selector: ref, key: String(key) });
    }
    async hover(options) { return this.tab._call("preview.hover", { selector: await this._ref(options) }); }
    async focus(options) { return this.evaluate(function (el) { el.focus(); return true; }, undefined, options); }
    async scrollIntoView(options) {
      return this.evaluate(function (el) { el.scrollIntoView({ block: "center", inline: "center" }); return true; }, undefined, options);
    }
    async isChecked(options) { return this._locate({ op: "read", prop: "checked", timeoutMs: timeoutOf(options, 5000) }); }
    async setChecked(checked, options) {
      if ((await this.isChecked(options)) !== Boolean(checked)) await this.click(options);
      return Boolean(checked);
    }
    async check(options) { return this.setChecked(true, options); }
    async uncheck(options) { return this.setChecked(false, options); }
    async selectOption(value, options) {
      var ref = await this._ref(options);
      var wanted = value && typeof value === "object" && !Array.isArray(value) ? value : { value: value };
      if (wanted.label !== undefined || wanted.index !== undefined) {
        var resolved = await this.tab.evaluate(function (args) {
          var el = window.__codaraPreviewDOM && window.__codaraPreviewDOM.refs.get(args.ref);
          if (!el || !el.options) throw new Error("not a select element");
          var options = Array.from(el.options);
          var option = args.index !== undefined ? options[args.index] : options.find(function (o) { return o.label.trim() === String(args.label).trim(); });
          if (!option) throw new Error("no option " + JSON.stringify(args.label !== undefined ? args.label : args.index));
          return option.value;
        }, { ref: ref, label: wanted.label, index: wanted.index });
        wanted = { value: resolved };
      }
      return this.tab._call("preview.type", { selector: ref, text: String(wanted.value) });
    }
    async waitFor(options) {
      options = options || {};
      return this._locate({ op: "wait", state: options.state || "visible", timeoutMs: timeoutOf(options, 5000) });
    }
    async count() { return this._locate({ op: "count" }); }
    async all() {
      var total = await this.count();
      var list = [];
      for (var i = 0; i < total; i++) list.push(this.nth(i));
      return list;
    }
    async textContent(options) { return this._locate({ op: "read", prop: "textContent", timeoutMs: timeoutOf(options, 5000) }); }
    async innerText(options) { return this._locate({ op: "read", prop: "innerText", timeoutMs: timeoutOf(options, 5000) }); }
    async inputValue(options) { return this._locate({ op: "read", prop: "inputValue", timeoutMs: timeoutOf(options, 5000) }); }
    async getAttribute(name, options) { return this._locate({ op: "read", prop: "attribute", name: String(name), timeoutMs: timeoutOf(options, 5000) }); }
    async isVisible() { return this._locate({ op: "read", prop: "visible" }); }
    async isEnabled(options) { return this._locate({ op: "read", prop: "enabled", timeoutMs: timeoutOf(options, 5000) }); }
    async boundingBox(options) { return this._locate({ op: "read", prop: "box", timeoutMs: timeoutOf(options, 5000) }); }
    async allTextContents() { return this._locate({ op: "texts" }); }
    async allInnerTexts() { return this._locate({ op: "texts", inner: true }); }
    async evaluate(fn, arg, options) {
      var ref = await this._ref(options);
      return this.tab.evaluate("(" + String(fn) + ")(" + elementExpression(ref) + ", " + stringify(arg === undefined ? null : arg) + ")");
    }
    async evaluateAll(fn, arg) {
      var refs = await this._locate({ op: "refs" });
      return this.tab.evaluate("(" + String(fn) + ")(" + stringify(refs) + ".map(function (r) { return " + elementExpression("r", true) + "; }), " + stringify(arg === undefined ? null : arg) + ")");
    }
    async screenshot(options) {
      return this.tab.screenshot(Object.assign({}, options, { selector: await this._ref(options) }));
    }
    toJSON() { return { locator: this.chain }; }
  }

  // The page-side lookup of an @reference the snapshot and locators share
  // (src/shared/preview-dom.ts keeps them on window.__codaraPreviewDOM).
  function elementExpression(ref, isVariable) {
    var key = isVariable ? ref : stringify(ref);
    return "(function (r) { var s = window.__codaraPreviewDOM; var el = s && s.refs.get(r); " +
      "if (!el || !el.isConnected) throw new Error('Stale element reference ' + r + '. Locate it again.'); return el; })(" + key + ")";
  }

  function asLocator(tab, target) {
    if (target instanceof Locator) return target;
    var text = String(target);
    return new Locator(tab, [text.charAt(0) === "@" ? { ref: text } : { css: text }]);
  }

  class Keyboard {
    constructor(tab) { this.tab = tab; }
    press(key) { return this.tab._call("preview.key", { key: String(key) }); }
    async type(text) {
      for (var ch of String(text)) await this.tab._call("preview.key", { key: ch });
    }
  }

  class Mouse {
    constructor(tab) { this.tab = tab; }
    click(x, y, options) {
      options = options || {};
      var action = options.button === "right" ? "rightclick" : options.clickCount === 2 ? "dblclick" : "click";
      return this.tab._call("preview.mouse", Object.assign({ x: x, y: y, action: action }, options.modifiers ? { modifiers: options.modifiers } : {}));
    }
    dblclick(x, y) { return this.click(x, y, { clickCount: 2 }); }
    move(x, y) { return this.tab._call("preview.hover", { x: x, y: y }); }
    down(x, y) { return this.tab._call("preview.mouse", { x: x, y: y, action: "down" }); }
    up(x, y) { return this.tab._call("preview.mouse", { x: x, y: y, action: "up" }); }
    wheel(deltaX, deltaY, at) { return this.tab._call("preview.scroll", Object.assign({ deltaX: deltaX || 0, deltaY: deltaY || 0 }, at || {})); }
  }

  function matchesUrl(url, match) {
    if (match instanceof RegExp) return match.test(url);
    if (typeof match === "function") return Boolean(match(url));
    return String(url).indexOf(String(match)) >= 0;
  }

  // tab.network(options) still answers like codara_preview_network; the
  // methods are the readable form of the same calls.
  function networkApi(tab) {
    var network = function (options) { return tab._call("preview.network", options); };
    network.list = async function (filter) {
      var result = await tab._call("preview.network", pick(filter, ["filter", "type", "status", "failed", "limit"]));
      return result.requests;
    };
    network.get = async function (id, options) {
      var result = await tab._call("preview.network", Object.assign({ id: String(id) }, pick(options, ["body", "redact"])));
      return result.request;
    };
    network.har = function (options) {
      return tab._call("preview.network", Object.assign({ har: true }, pick(options, ["filter", "type", "status", "failed", "body", "redact"])));
    };
    network.clear = function () { return tab._call("preview.network", { clear: true }); };
    network.waitForResponse = async function (match, options) {
      options = options || {};
      var seen = new Set((await network.list({ limit: 500 })).map(function (row) { return row.id; }));
      var deadline = Date.now() + timeoutOf(options, 15000);
      for (;;) {
        var rows = await network.list({ limit: 500 });
        for (var row of rows) {
          if (seen.has(row.id) || row.pending || !matchesUrl(row.url, match)) continue;
          return options.detail === false ? row : network.get(row.id, pick(options, ["body", "redact"]));
        }
        if (Date.now() > deadline) throw new BrowserError("No finished response matched " + String(match) + " in time.");
        await sleep(100);
      }
    };
    return network;
  }

  class CdpSubscription {
    constructor(tab, id, events) {
      this.tab = tab;
      this.id = id;
      this.events = events;
      this.pending = [];
    }
    async take(options) {
      options = options || {};
      var result = await this.tab._call("preview.cdp_events", { action: "read", subscription: this.id, waitMs: options.wait || 0, max: options.max });
      var events = this.pending.concat(result.events);
      this.pending = [];
      return events;
    }
    async next(options) {
      options = options || {};
      var filter = typeof options.filter === "function" ? options.filter : null;
      var deadline = Date.now() + timeoutOf(options, 15000);
      for (;;) {
        while (this.pending.length) {
          var event = this.pending.shift();
          if (!filter || filter(event.params, event.method)) return event;
        }
        var left = deadline - Date.now();
        if (left <= 0) return null;
        var result = await this.tab._call("preview.cdp_events", { action: "read", subscription: this.id, waitMs: Math.min(left, 30000) });
        this.pending = result.events;
        if (result.closed && !this.pending.length) throw new BrowserError("The event subscription closed (its tab closed).");
      }
    }
    close() { return this.tab._call("preview.cdp_events", { action: "unsubscribe", subscription: this.id }); }
    toJSON() { return { subscription: this.id, events: this.events }; }
  }

  function cdpApi(tab) {
    return {
      send: async function (method, params) {
        var result = await tab._call("preview.cdp", { method: String(method), params: params || {} });
        return result.path ? { path: result.path, chars: result.chars, note: result.note } : result.result;
      },
      on: async function (events) {
        var result = await tab._call("preview.cdp_events", { action: "subscribe", events: events });
        return new CdpSubscription(tab, result.subscription, result.events);
      },
      waitForEvent: async function (event, options) {
        var subscription = await this.on(event);
        try {
          var found = await subscription.next(options);
          if (!found) throw new BrowserError("No " + event + " event in time.");
          return found.params;
        } finally {
          await subscription.close().catch(function () {});
        }
      },
    };
  }

  class Tab {
    constructor(id) {
      this.id = id || null;
      this.lastSnapshotId = null;
      this.keyboard = new Keyboard(this);
      this.mouse = new Mouse(this);
      this.network = networkApi(this);
      this.cdp = cdpApi(this);
    }
    async _call(method, args) {
      var withTab = Object.assign({}, args);
      if (this.id) withTab.tabId = this.id;
      var value = await rpc(method, withTab);
      if (!this.id && value && typeof value === "object" && typeof value.tabId === "string") this.id = value.tabId;
      return value;
    }
    async goto(url, options) {
      options = options || {};
      var result = await this._call("preview.navigate", Object.assign({ url: String(url) }, pick(options, ["group"])));
      if (options.waitUntil) await this.waitForLoadState(options.waitUntil, options);
      return pick(result, ["url", "tabId", "opened"]);
    }
    async _history(expression, options) {
      await this.evaluate(expression);
      try { await this.waitFor({ navigation: true, timeoutMs: timeoutOf(options, 5000) }); } catch (error) { /* same-document history moves commit no navigation */ }
      return this.url();
    }
    reload(options) { return this._history("location.reload()", options); }
    back(options) { return this._history("history.back()", options); }
    forward(options) { return this._history("history.forward()", options); }
    async url() { return (await this._call("preview.url", {})).url; }
    async title() { return (await this._call("preview.url", {})).title; }
    async snapshot(options) {
      options = options || {};
      var args = pick(options, ["selector", "maxBytes"]);
      if (options.since) args.since = options.since;
      else if (options.diff && this.lastSnapshotId) args.since = this.lastSnapshotId;
      var result = await this._call("preview.snapshot", args);
      this.lastSnapshotId = result.snapshotId || null;
      var header = (result.title ? result.title + " " : "") + "<" + result.url + ">" + (result.diff ? " (changes since the last snapshot)" : "") + (result.truncated ? " (truncated)" : "");
      return header + "\n" + result.snapshot;
    }
    async screenshot(options) {
      options = options || {};
      var args = pick(options, ["selector", "fullPage", "clip", "quality", "maxWidth", "scale", "format"]);
      return this._call("preview.screenshot", args);
    }
    async evaluate(fn, arg) {
      var code = typeof fn === "function" ? "(" + String(fn) + ")(" + stringify(arg === undefined ? null : arg) + ")" : String(fn);
      var result = await this._call("preview.evaluate", { code: code, awaitPromise: true });
      return result && typeof result === "object" && "value" in result ? result.value : result;
    }
    find(query, options) { return this._call("preview.find", Object.assign({ query: String(query) }, pick(options, ["limit"]))); }
    waitFor(conditions) {
      var args = Object.assign({}, conditions);
      if (typeof args.timeout === "number") { args.timeoutMs = args.timeout; delete args.timeout; }
      if (args.text instanceof RegExp) args.text = String(args.text);
      if (args.url instanceof RegExp) args.url = String(args.url);
      return this._call("preview.wait_for", args);
    }
    waitForURL(url, options) { return this.waitFor({ url: url instanceof RegExp ? String(url) : String(url), timeout: timeoutOf(options, 15000) }); }
    waitForLoadState(state, options) { return this.waitFor({ load: state || "load", timeout: timeoutOf(options, 15000) }); }
    waitForTimeout(ms) { return sleep(ms); }
    locator(selector) { return new Locator(this, [{ css: String(selector) }]); }
    ref(reference) { return new Locator(this, [{ ref: String(reference) }]); }
    getByRole(role, options) { return new Locator(this, []).getByRole(role, options); }
    getByText(text, options) { return new Locator(this, [step("text", text, options)]); }
    getByLabel(text, options) { return new Locator(this, [step("label", text, options)]); }
    getByPlaceholder(text, options) { return new Locator(this, [step("placeholder", text, options)]); }
    getByAltText(text, options) { return new Locator(this, [step("altText", text, options)]); }
    getByTitle(text, options) { return new Locator(this, [step("title", text, options)]); }
    getByTestId(id) { return new Locator(this, [{ testId: String(id) }]); }
    click(target, options) { return asLocator(this, target).click(options); }
    fill(target, text, options) { return asLocator(this, target).fill(text, options); }
    press(targetOrKey, key, options) {
      if (key === undefined) return this.keyboard.press(targetOrKey);
      return asLocator(this, targetOrKey).press(key, options);
    }
    console(options) { return this._call("preview.console", options); }
    dialog(options) { return this._call("preview.dialog", options); }
    close() { return this._call("preview.close", {}); }
    call(tool, args) { return this._call("preview." + String(tool).replace(/^codara_preview_/, ""), args); }
    toJSON() { return { tab: this.id }; }
  }

  var browser = {
    tab: function (id) {
      if (id instanceof Tab) return id;
      if (id && typeof id === "object" && id.id) id = id.id;
      return new Tab(id ? String(id) : null);
    },
    tabs: async function () {
      var result = await rpc("preview.list", {});
      return result && result.tabs ? result.tabs : result;
    },
    chrome: {
      status: function () { return rpc("preview.chrome", { action: "status" }); },
      open: async function (url, options) {
        var result = await rpc("preview.chrome", Object.assign({ action: "open", url: String(url) }, pick(options, ["group"])));
        if (result.blocked) throw new BrowserError(result.note || "That page is on a site the user blocked for agents.");
        return new Tab(result.tabId);
      },
    },
    call: function (tool, args) { return rpc("preview." + String(tool).replace(/^codara_preview_/, ""), args); },
    documentation: function () { return init.docs; },
    sleep: sleep,
  };

  function define(name, value) {
    Object.defineProperty(globalThis, name, { value: value, writable: true, configurable: true, enumerable: false });
  }
  define("browser", browser);
  define("console", consoleObject);
  define("setTimeout", setTimeout);
  define("clearTimeout", clearTimeout);
  define("setInterval", setInterval);
  define("clearInterval", clearTimeout);
  define("sleep", sleep);
  define("BrowserError", BrowserError);

  function serialize(value) {
    var max = init.maxResultChars;
    if (value === undefined) return {};
    var text = typeof value === "string";
    var out = text ? value : safeJson(value);
    if (out === undefined) return {};
    if (out.length > max) return { text: out.slice(0, max), truncated: true };
    return text ? { text: out } : { json: out };
  }

  var MAX_ERROR_CHARS = 4000;
  function clip(text, max) {
    text = String(text);
    return text.length > max ? text.slice(0, max) + " ... (" + (text.length - max) + " more characters)" : text;
  }

  function describeError(error) {
    if (error instanceof Error) {
      var line = typeof error.stack === "string" ? /snippet\.js:(\d+)/.exec(error.stack) : null;
      return clip(error.name + ": " + error.message, MAX_ERROR_CHARS) + (line ? " (line " + line[1] + ")" : "");
    }
    return clip("Thrown: " + format(error), MAX_ERROR_CHARS);
  }

  return function settle(id, promise) {
    NativePromise.resolve(promise).then(function (value) {
      var result;
      try { result = { ok: true, value: serialize(value) }; } catch (error) { result = { ok: false, error: "the result could not be turned into JSON: " + describeError(error) }; }
      hostDone(id, stringify(result));
    }, function (error) {
      hostDone(id, stringify({ ok: false, error: describeError(error) }));
    });
  };
})()`;
