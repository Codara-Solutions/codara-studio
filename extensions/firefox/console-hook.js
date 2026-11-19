// The page's console for Codara, from document start (see lib/console.js).
// A content script: it runs only on sites the user let the extension use,
// in the tab's own page (not its frames). It wraps the page's console
// methods (each still logs as before) and listens for the page's uncaught
// errors. The extension sets its mode: "on" sends what the page logs;
// "wait" (the tab is shared, Codara has not asked yet) keeps the last few
// entries, as the debugger replays them when Codara starts listening;
// "off" sends and keeps nothing, and forgets what it kept. Each answer
// says since when the tab is shared with Codara: anything kept from before
// (the moments before the first answer included) is dropped, never sent.

(() => {
  // Registered for document start and put into pages loaded before that: one copy per page.
  if (window.codaraConsoleHook) return;
  window.codaraConsoleHook = true;
  const page = window.wrappedJSObject;
  const KEPT = 50;
  const PER_SECOND = 100;
  const ARGS = 20;
  const TEXT = 10_000;
  let mode = "wait";
  let kept = [];
  let second = 0;
  let count = 0;
  let order = 0;

  const send = (entry) => browser.runtime.sendMessage({ type: "codara-console-entry", entry }).catch(() => {});
  /** Whether to describe one more entry: never when off, and at most PER_SECOND a second. */
  function admit() {
    if (mode === "off") return false;
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) [second, count] = [now, 0];
    return ++count <= PER_SECOND;
  }
  function add(entry) {
    // Distinct times for distinct entries, so Codara's replay check never takes one for another.
    entry.at = Date.now() + (order++ % 1000) / 1000;
    if (mode === "on") return void send(entry);
    kept.push(entry);
    if (kept.length > KEPT) kept.shift();
  }
  function setMode(next, since) {
    mode = ["on", "wait"].includes(next) && Number.isFinite(since) ? next : "off";
    // `since` is the first millisecond after the attachment: anything kept from before is dropped.
    kept = mode === "off" ? [] : kept.filter((entry) => entry.at >= since);
    if (mode === "on") for (const entry of kept.splice(0)) send(entry);
  }

  const cap = (text) => String(text).slice(0, TEXT);
  // Logged values reach this script as Xrays (measured on Firefox 160): it
  // sees only their data properties, so no getter, toJSON or other page
  // code runs to describe them. The walk is bounded (depth, items, length),
  // so a huge or self-referencing value costs the page little.
  function json(value, room, depth = 0) {
    if (room.left <= 0) return "…";
    let out;
    if (value === null || ["number", "boolean"].includes(typeof value)) out = Number.isNaN(value) ? "NaN" : String(value);
    else if (typeof value === "string") out = JSON.stringify(value.slice(0, room.left));
    else if (typeof value !== "object") out = typeof value === "undefined" ? "undefined" : `[${typeof value}]`;
    else if (Object.prototype.toString.call(value) === "[object Date]") out = JSON.stringify(Date.prototype.toISOString.call(value));
    else if (depth >= 4) out = Array.isArray(value) ? "[…]" : "{…}";
    else {
      const array = Array.isArray(value);
      // At most 101 keys are looked up (one to tell there are more), each charged to the room left.
      const keys = [];
      if (!array) {
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (keys.push(key) > 100) break;
        }
      }
      const length = array ? value.length : keys.length;
      const parts = [];
      for (let i = 0; i < Math.min(length, 100) && room.left > 0; i++) {
        if (array) parts.push(json(value[i], room, depth + 1));
        else {
          const key = JSON.stringify(keys[i].slice(0, room.left));
          room.left -= key.length + 1;
          parts.push(`${key}:${json(value[keys[i]], room, depth + 1)}`);
        }
      }
      if (length > parts.length) parts.push("…");
      return array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
    }
    room.left -= out.length;
    return out;
  }
  const errorText = (value) => {
    try {
      if (typeof value?.stack === "string" && typeof value?.message === "string") return cap(`${value.name ?? "Error"}: ${value.message}\n${value.stack}`);
    } catch {}
    return null;
  };
  function describe(value) {
    switch (typeof value) {
      case "string":
        return { type: "string", value: cap(value) };
      case "boolean":
        return { type: "boolean", value };
      case "number":
        return Number.isFinite(value) && !Object.is(value, -0) ? { type: "number", value } : { type: "number", unserializableValue: Object.is(value, -0) ? "-0" : String(value) };
      case "bigint":
        return { type: "bigint", unserializableValue: cap(`${value}n`) };
      case "undefined":
        return { type: "undefined" };
      case "symbol":
      case "function":
        return { type: typeof value, description: typeof value === "symbol" ? cap(value.description ?? "Symbol()") : "function" };
    }
    if (value === null) return { type: "object", subtype: "null", value: null };
    const error = errorText(value);
    if (error) return { type: "object", subtype: "error", description: error };
    const subtype = Array.isArray(value) ? { subtype: "array" } : {};
    try {
      return { type: "object", ...subtype, value: cap(json(value, { left: TEXT })) };
    } catch {
      return { type: "object", ...subtype, description: Object.prototype.toString.call(value) };
    }
  }
  // The page's frame that called: this script's own stack lists the page's
  // frames after its own (measured on Firefox 160), with no page code run.
  function caller() {
    try {
      for (const line of String(new Error().stack).split("\n")) {
        const frame = /@(.*):(\d+):\d+$/.exec(line);
        if (frame && !frame[1].startsWith("moz-extension:")) return { source: cap(frame[1]), line: Number(frame[2]) };
      }
    } catch {}
    return {};
  }

  for (const level of ["log", "info", "debug", "warn", "error", "trace", "dir", "table", "assert"]) {
    const original = page.console[level];
    if (typeof original !== "function") continue;
    exportFunction(
      function (...args) {
        try {
          if (level === "assert" && args[0]) {
            // A passing assertion logs nothing.
          } else if (admit()) {
            const shown = level === "assert" ? [{ type: "string", value: "Assertion failed:" }, ...args.slice(1, ARGS).map(describe)] : args.slice(0, ARGS).map(describe);
            add({ kind: "console", level, args: shown, ...caller() });
          }
        } catch {}
        return original.call(page.console, ...args);
      },
      page.console,
      { defineAs: level },
    );
  }
  // Only Firefox's own error events: a page (or a same-origin frame) can dispatch made-up ones (isTrusted false, measured).
  window.addEventListener("error", (event) => {
    if (event.isTrusted && admit()) add({ kind: "exception", message: errorText(event.error) ?? cap(event.message), source: cap(event.filename), line: event.lineno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!event.isTrusted || !admit()) return;
    const described = describe(event.reason);
    const message = errorText(event.reason) ?? String(described.value ?? described.description ?? described.unserializableValue ?? described.type);
    add({ kind: "exception", message: `Uncaught (in promise) ${message}` });
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "codara-console") setMode(message.mode, message.since);
  });
  browser.runtime.sendMessage({ type: "codara-console-hello" }).then((answer) => setMode(answer?.mode, answer?.since), () => setMode("off"));
})();
