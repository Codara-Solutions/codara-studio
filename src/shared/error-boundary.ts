// What the renderer's crash screen says about a crash.
//
// The boundary reports to main through the console, not IPC: a preload that
// no longer matches the renderer is one of the crashes it has to record, so
// the record cannot depend on the preload. main.log gets only the lines that
// carry this prefix (the console-message listener in src/main/index.ts).

const LOG_PREFIX = "[error-boundary] ";
const MAX_LOG_ENTRY_CHARS = 16_000;

function describeError(error: unknown): string {
  const { name, message } = (error ?? {}) as Partial<Error>;
  return `${name ?? "Error"}: ${message ?? String(error)}`;
}

/** One string, because a second console argument reaches main as "[object Object]". */
export function errorBoundaryConsoleLine(error: unknown, componentStack: string | null | undefined): string {
  const stack = (error as Partial<Error> | null | undefined)?.stack;
  const parts = [`${LOG_PREFIX}caught render error: ${describeError(error)}`];
  if (stack) parts.push(stack.trim());
  if (componentStack) parts.push(`Component stack:${componentStack}`);
  return parts.join("\n");
}

/** The main.log text for a console message, or null for anything but the boundary's line. */
export function errorBoundaryLogEntry(level: string, message: string): string | null {
  if (level !== "error" || !message.startsWith(LOG_PREFIX)) return null;
  return message.slice(LOG_PREFIX.length, LOG_PREFIX.length + MAX_LOG_ENTRY_CHARS);
}

/**
 * Under `npm run dev`, the errors that come from the dev session rather than
 * the code: a missing preload call (the preload is only built at start) or a
 * dynamic import the dev server can no longer serve.
 */
export function cannotRecoverByReload(error: unknown): boolean {
  const message = String((error as Partial<Error> | null | undefined)?.message ?? error ?? "");
  return message.includes("window.spark") || message.includes("Failed to fetch dynamically imported module");
}
