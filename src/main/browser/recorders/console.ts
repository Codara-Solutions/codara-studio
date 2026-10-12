// Console recording for one tab, from the moment its session exists. Uses
// the protocol rather than Electron's console-message event so a preview tab
// and a Chrome tab record the same thing.

import type { CdpSession, RingBuffer } from "../cdp-session";
import { keepConsoleEntry } from "./console-filter";

export const CONSOLE_RING = "console";
export const CONSOLE_RING_CAP = 500;

export interface ConsoleEntry {
  level: string;
  message: string;
  line: number | null;
  source: string | null;
  at: string;
}

interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: {
    overflow?: boolean;
    subtype?: string;
    properties?: Array<{ name: string; type?: string; value?: string }>;
  };
}

interface StackLike {
  callFrames?: Array<{ url?: string; lineNumber?: number }>;
}

const LEVELS: Record<string, string> = {
  log: "info",
  info: "info",
  debug: "debug",
  verbose: "debug",
  warning: "warning",
  warn: "warning",
  error: "error",
  assert: "error",
  trace: "info",
  dir: "info",
  dirxml: "info",
  table: "info",
  count: "info",
  timeEnd: "info",
};

function describe(arg: RemoteObjectLike): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === "string" && typeof arg.value === "string") return arg.value;
  if (arg.value !== undefined) {
    try {
      return typeof arg.value === "object" ? JSON.stringify(arg.value) : String(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  const preview = arg.preview;
  if (preview?.properties && (arg.type === "object" && arg.subtype !== "error")) {
    const more = preview.overflow ? ", ..." : "";
    const value = (prop: { type?: string; value?: string }) => (prop.type === "string" ? JSON.stringify(prop.value ?? "") : prop.value ?? "");
    if (arg.subtype === "array") return `[${preview.properties.map(value).join(", ")}${more}]`;
    return `{${preview.properties.map((prop) => `${prop.name}: ${value(prop)}`).join(", ")}${more}}`;
  }
  return arg.description ?? arg.type ?? "";
}

function topFrame(stack: StackLike | undefined): { line: number | null; source: string | null } {
  const frame = stack?.callFrames?.[0];
  return {
    line: typeof frame?.lineNumber === "number" ? frame.lineNumber + 1 : null,
    source: frame?.url ? frame.url : null,
  };
}

export function consoleRing(session: CdpSession): RingBuffer<ConsoleEntry> {
  return session.ring<ConsoleEntry>(CONSOLE_RING, CONSOLE_RING_CAP);
}

const recording = new WeakSet<CdpSession>();

export function startConsoleRecorder(session: CdpSession): void {
  if (recording.has(session)) return;
  recording.add(session);
  const ring = consoleRing(session);
  const record = (entry: ConsoleEntry, origin: { contextId?: number; method: string }) => {
    if (keepConsoleEntry(entry, { ...origin, defaultContexts })) ring.push(entry);
  };
  // Execution contexts that are a frame's main world; console calls from a
  // preload's isolated world carry another context id.
  const defaultContexts = new Set<number>();
  session.on("Runtime.executionContextCreated", (params) => {
    const context = params.context as { id?: number; auxData?: { isDefault?: boolean } } | undefined;
    if (typeof context?.id === "number" && context.auxData?.isDefault) defaultContexts.add(context.id);
  });
  session.on("Runtime.executionContextDestroyed", (params) => {
    if (typeof params.executionContextId === "number") defaultContexts.delete(params.executionContextId);
  });
  session.on("Runtime.executionContextsCleared", () => defaultContexts.clear());
  session.on("Runtime.consoleAPICalled", (params) => {
    const args = Array.isArray(params.args) ? (params.args as RemoteObjectLike[]) : [];
    const type = typeof params.type === "string" ? params.type : "log";
    record({
      level: LEVELS[type] ?? "info",
      message: args.map(describe).join(" "),
      ...topFrame(params.stackTrace as StackLike | undefined),
      at: new Date(typeof params.timestamp === "number" ? params.timestamp : Date.now()).toISOString(),
    }, { contextId: typeof params.executionContextId === "number" ? params.executionContextId : undefined, method: "Runtime.consoleAPICalled" });
  });
  session.on("Runtime.exceptionThrown", (params) => {
    const details = (params.exceptionDetails ?? {}) as {
      text?: string;
      exception?: RemoteObjectLike;
      lineNumber?: number;
      url?: string;
      stackTrace?: StackLike;
      executionContextId?: number;
    };
    const frame = topFrame(details.stackTrace);
    record({
      level: "error",
      message: details.exception?.description ?? details.text ?? "Uncaught exception",
      line: frame.line ?? (typeof details.lineNumber === "number" ? details.lineNumber + 1 : null),
      source: frame.source ?? details.url ?? null,
      at: new Date().toISOString(),
    }, { contextId: details.executionContextId, method: "Runtime.exceptionThrown" });
  });
  session.on("Log.entryAdded", (params) => {
    const entry = (params.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number; source?: string };
    record({
      level: LEVELS[entry.level ?? "info"] ?? "info",
      message: entry.text ?? "",
      line: typeof entry.lineNumber === "number" ? entry.lineNumber + 1 : null,
      source: entry.url ?? null,
      at: new Date().toISOString(),
    }, { method: `Log.entryAdded:${entry.source ?? "other"}` });
  });
  session.hold("Runtime");
  session.hold("Log");
}
