// Which console entries a tab's recorder keeps: what the page itself logged.
// Entries Codara or Electron cause are dropped, so an agent reading the
// console sees the app it is working on and nothing else:
// - Electron's security and deprecation warnings ("Electron Security Warning
//   (Insecure Content-Security-Policy)"), which a development build of
//   Codara prints into every page it hosts;
// - anything logged from an isolated world (Codara's preload in the tab, an
//   extension's content script), which runs in another execution context.

import type { ConsoleEntry } from "./console";

export interface ConsoleOrigin {
  /** The execution context that logged, when the protocol says. */
  contextId?: number;
  /** The protocol event, plus the Log source for Log.entryAdded. */
  method: string;
  /** Contexts that are a frame's main world, as seen so far. */
  defaultContexts: ReadonlySet<number>;
}

const ELECTRON_NOISE = /^(?:%c)?\s*Electron (?:Security|Deprecation) Warning\b/;

export function isElectronNoise(message: string): boolean {
  return ELECTRON_NOISE.test(message);
}

export function keepConsoleEntry(entry: ConsoleEntry, origin: ConsoleOrigin): boolean {
  if (isElectronNoise(entry.message)) return false;
  if (origin.method === "Runtime.consoleAPICalled" || origin.method === "Runtime.exceptionThrown") {
    // Only judge once the page's main world is known; an unknown context
    // before that is the page's own early logging.
    if (origin.contextId !== undefined && origin.defaultContexts.size > 0 && !origin.defaultContexts.has(origin.contextId)) {
      return false;
    }
  }
  return true;
}
