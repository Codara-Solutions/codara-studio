// Which console entries a tab's recorder keeps. Everything is kept for now;
// entries Codara itself causes (a preload's isolated world, Electron's own
// security warnings) are the ones to drop here.

import type { ConsoleEntry } from "./console";

export interface ConsoleOrigin {
  /** The execution context that logged, when the protocol says. */
  contextId?: number;
  /** The protocol event, plus the Log source for Log.entryAdded. */
  method: string;
  /** Contexts that are a frame's main world, as seen so far. */
  defaultContexts: ReadonlySet<number>;
}

export function keepConsoleEntry(_entry: ConsoleEntry, _origin: ConsoleOrigin): boolean {
  return true;
}
