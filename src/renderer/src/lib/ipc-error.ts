import { QUESTION_INACTIVE_ERROR_PREFIX } from "@shared/run-questions";

/**
 * The main process's own message for a failed IPC call. Electron wraps a
 * main-process throw as "Error invoking remote method 'x': Error: message",
 * and error-code prefixes are for the code that branches on them, not for
 * the user.
 */
export function unwrapIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .replace(QUESTION_INACTIVE_ERROR_PREFIX, "")
    .trim();
}
