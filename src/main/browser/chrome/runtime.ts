// The running link, set once at boot (index.ts) and read by the tool
// handlers, so the socket's handler modules import neither Electron nor the
// boot wiring.

import type { ChromeTargetBackend } from "./chrome-target";
import type { ChromeLinkServer } from "./link-server";

export interface ChromeLinkRuntime {
  server: ChromeLinkServer;
  backend: ChromeTargetBackend;
}

let current: ChromeLinkRuntime | null = null;

export function setChromeLinkRuntime(next: ChromeLinkRuntime | null): void {
  current = next;
}

export function chromeLinkRuntime(): ChromeLinkRuntime | null {
  return current;
}
