// The live keeper and status registry as the socket tools reach them.
// servers/index.ts provides them when main loads it, so the tool handlers in
// preview-tools/ never import the pty manager and stay loadable on their own
// (scripts/test-preview-tools-routing.cjs bundles them without it).

import type { ServerKeeper } from "./keeper";
import type { StatusRegistry } from "./status";

export interface ServersService {
  keeper(): ServerKeeper;
  status(): StatusRegistry;
  /** The workspace on screen, for a caller outside every pane. */
  activeWorkspaceId(): Promise<string | null>;
}

let service: ServersService | null = null;

export function provideServersService(next: ServersService): void {
  service = next;
}

export function serversService(): ServersService {
  if (!service) throw new Error("Codara's dev-server keeper is not running yet.");
  return service;
}
