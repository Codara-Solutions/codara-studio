// The page's console in DevTools protocol form. console-hook.js, a content
// script registered for document start, wraps the page's console methods
// and listens for its uncaught errors; it sends what the page logged only
// while the tab is shared and Codara asked for it (Runtime.enable), and
// keeps a few entries of its own until then, as the debugger replays them.
// What it sends is the page's own data, so it is checked and capped here.
// No browser.* here, so the tests run it in Node.

export const CONSOLE_TYPES = Object.freeze(["log", "info", "debug", "warn", "error", "trace", "dir", "table", "assert", "count", "timeEnd"]);
const TEXT_MAX = 10_000;
const ARGS_MAX = 20;

const text = (value) => (typeof value === "string" ? value.slice(0, TEXT_MAX) : undefined);

/** One logged value as a protocol RemoteObject, from what the hook described; unknown fields are dropped. */
function remoteObject(arg) {
  if (!arg || typeof arg !== "object") return { type: "undefined" };
  const out = { type: ["string", "number", "boolean", "undefined", "bigint", "symbol", "function", "object"].includes(arg.type) ? arg.type : "object" };
  if (typeof arg.subtype === "string" && ["null", "array", "error"].includes(arg.subtype)) out.subtype = arg.subtype;
  if (typeof arg.value === "string") out.value = text(arg.value);
  else if (typeof arg.value === "number" || typeof arg.value === "boolean" || arg.value === null) out.value = arg.value;
  if (typeof arg.unserializableValue === "string") out.unserializableValue = text(arg.unserializableValue);
  if (typeof arg.description === "string") out.description = text(arg.description);
  return out;
}

/** The page's stack frame as the protocol gives it (0-based line), or none. */
function stackTrace(source, line) {
  if (typeof source !== "string" || !source) return undefined;
  return { callFrames: [{ url: text(source), lineNumber: Number.isInteger(line) && line > 0 ? line - 1 : 0, columnNumber: 0, functionName: "", scriptId: "" }] };
}

/**
 * The protocol event for one entry from the hook, or null for anything
 * that is not one: { kind: "console", level, args, source?, line?, at } or
 * { kind: "exception", message, source?, line?, at }.
 */
export function consoleEvent(entry) {
  if (!entry || typeof entry !== "object") return null;
  const timestamp = Number.isFinite(entry.at) ? entry.at : Date.now();
  const trace = stackTrace(entry.source, entry.line);
  if (entry.kind === "console" && CONSOLE_TYPES.includes(entry.level) && Array.isArray(entry.args)) {
    const type = entry.level === "warn" ? "warning" : entry.level;
    return ["Runtime.consoleAPICalled", { type, args: entry.args.slice(0, ARGS_MAX).map(remoteObject), timestamp, ...(trace ? { stackTrace: trace } : {}) }];
  }
  if (entry.kind === "exception" && typeof entry.message === "string") {
    const message = text(entry.message);
    return [
      "Runtime.exceptionThrown",
      {
        timestamp,
        exceptionDetails: {
          text: "Uncaught",
          exception: { type: "object", subtype: "error", description: message },
          ...(trace ? { url: trace.callFrames[0].url, lineNumber: trace.callFrames[0].lineNumber, stackTrace: trace } : {}),
        },
      },
    ];
  }
  return null;
}
