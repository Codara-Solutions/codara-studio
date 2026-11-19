// The page's console for Codara, from document start (see lib/console.js).
// A content script: it runs only on sites the user let the extension use,
// in the tab's own page (not its frames). It wraps the page's console
// methods (each still logs as before) and listens for uncaught errors, and
// sends what it saw only while the extension says this tab is shared with
// Codara; until then it keeps the last few entries in the page, as the
// debugger replays them when Codara starts listening.

(() => {
  // Registered for document start and put into pages loaded before that: one copy per page.
  if (window.codaraConsoleHook) return;
  window.codaraConsoleHook = true;
  const page = window.wrappedJSObject;
  const KEPT = 50;
  const PER_SECOND = 100;
  let on = false;
  let kept = [];
  let second = 0;
  let sent = 0;

  const send = (entry) => browser.runtime.sendMessage({ type: "codara-console-entry", entry }).catch(() => {});
  function add(entry) {
    if (!on) {
      kept.push(entry);
      if (kept.length > KEPT) kept.shift();
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) [second, sent] = [now, 0];
    // A page logging in a loop would flood the link: the rest of that second is dropped.
    if (++sent <= PER_SECOND) send(entry);
  }
  function setOn(next) {
    on = next === true;
    if (on) for (const entry of kept.splice(0)) add(entry);
    else kept = [];
  }

  const errorText = (value) => {
    try {
      if (typeof value?.stack === "string" && typeof value?.message === "string") return `${value.name ?? "Error"}: ${value.message}\n${value.stack}`;
    } catch {}
    return null;
  };
  function describe(value) {
    switch (typeof value) {
      case "string":
      case "boolean":
        return { type: typeof value, value };
      case "number":
        return Number.isFinite(value) && !Object.is(value, -0) ? { type: "number", value } : { type: "number", unserializableValue: String(Object.is(value, -0) ? "-0" : value) };
      case "bigint":
        return { type: "bigint", unserializableValue: `${value}n` };
      case "undefined":
        return { type: "undefined" };
      case "symbol":
      case "function":
        return { type: typeof value, description: String(value).slice(0, 200) };
    }
    if (value === null) return { type: "object", subtype: "null", value: null };
    const error = errorText(value);
    if (error) return { type: "object", subtype: "error", description: error };
    let json = null;
    try {
      json = page.JSON.stringify(value);
    } catch {}
    const subtype = page.Array.isArray(value) ? { subtype: "array" } : {};
    return typeof json === "string" ? { type: "object", ...subtype, value: json } : { type: "object", ...subtype, description: Object.prototype.toString.call(value) };
  }
  // The page's frame that called: an Error made in the page leaves this script's frames out (measured).
  function caller() {
    try {
      const frame = /@(.*):(\d+):\d+$/m.exec(String(new page.Error().stack).split("\n")[0]);
      return frame ? { source: frame[1], line: Number(frame[2]) } : {};
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
          if (level !== "assert") add({ kind: "console", level, args: args.map(describe), at: Date.now(), ...caller() });
          else if (!args[0]) add({ kind: "console", level: "assert", args: [{ type: "string", value: "Assertion failed:" }, ...args.slice(1).map(describe)], at: Date.now(), ...caller() });
        } catch {}
        return original.call(page.console, ...args);
      },
      page.console,
      { defineAs: level },
    );
  }
  window.addEventListener("error", (event) => {
    add({ kind: "exception", message: errorText(event.error) ?? String(event.message), source: event.filename, line: event.lineno, at: Date.now() });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = errorText(reason) ?? (() => {
      const described = describe(reason);
      return String(described.value ?? described.description ?? described.unserializableValue ?? described.type);
    })();
    add({ kind: "exception", message: `Uncaught (in promise) ${message}`, at: Date.now() });
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "codara-console") setOn(message.on);
  });
  browser.runtime.sendMessage({ type: "codara-console-hello" }).then((answer) => setOn(answer?.on), () => {});
})();
