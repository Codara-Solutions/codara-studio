// The page's console for Codara, from document start (see lib/console.js).
// A content script: it runs only on sites the user let the extension use,
// in the tab's own page (not its frames). It wraps the page's console
// methods (each still logs as before) and listens for the page's uncaught
// errors. The extension sets its mode: "on" sends what the page logs;
// "wait" (the tab is shared, Codara has not asked yet) keeps the last few
// entries, as the debugger replays them when Codara starts listening;
// "off" sends and keeps nothing, and forgets what it kept. It waits for
// the extension's first answer before keeping anything past that.

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
  function setMode(next) {
    mode = ["on", "wait"].includes(next) ? next : "off";
    if (mode === "off") kept = [];
    if (mode === "on") for (const entry of kept.splice(0)) send(entry);
  }

  const cap = (text) => String(text).slice(0, TEXT);
  // Logged values reach this script as Xrays (measured on Firefox 160): its
  // own JSON and Object functions see only their data properties, so no
  // getter, toJSON or other page code runs to describe them.
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
    let json = null;
    try {
      json = JSON.stringify(value);
    } catch {}
    return typeof json === "string" ? { type: "object", ...subtype, value: cap(json) } : { type: "object", ...subtype, description: Object.prototype.toString.call(value) };
  }
  // The page's frame that called: an Error made in the page leaves this script's frames out (measured).
  function caller() {
    try {
      const frame = /@(.*):(\d+):\d+$/m.exec(String(new page.Error().stack).split("\n")[0]);
      return frame ? { source: cap(frame[1]), line: Number(frame[2]) } : {};
    } catch {
      return {};
    }
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
    if (message?.type === "codara-console") setMode(message.mode);
  });
  browser.runtime.sendMessage({ type: "codara-console-hello" }).then((answer) => setMode(answer?.mode), () => setMode("off"));
})();
