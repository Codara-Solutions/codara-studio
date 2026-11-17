// terminal.create has one deadline, under the MCP server's 60 s for the call
// (resources/codara-studio-mcp/server.js). The lookups of the caller's pane, a
// hold for a starting window and the renderer's create all come out of it; the
// spawn wait and settle that follow the create are kept back at the end. Time
// spent making a worktree is not counted: the server waits longer for those.
export const CREATE_CALL_BUDGET_MS = 55_000;

export interface CreateDeadline {
  /** What the next step may take, with the reserve for after the create kept back. */
  leftMs(): number;
  /** Leaves time out of the count (a worktree being made). */
  exclude(ms: number): void;
}

export function createDeadline(reserveMs: number, startedAt: number = Date.now()): CreateDeadline {
  let excludedMs = 0;
  return {
    leftMs: () => Math.max(0, CREATE_CALL_BUDGET_MS - (Date.now() - startedAt - excludedMs) - reserveMs),
    exclude: (ms) => {
      excludedMs += ms;
    },
  };
}

/** Options for a lookup inside the call: what is left, a hold included. */
export function lookupOptions(deadline: CreateDeadline): { timeoutMs: number; holdWithinTimeout: true } {
  return { timeoutMs: deadline.leftMs(), holdWithinTimeout: true };
}

/**
 * Options for the create itself: what the lookups and a hold left, at most the
 * usual 30 s in one workspace, where no approval card took part of it. The 1 s
 * floor puts the worst case at 56 s.
 */
export function createOpOptions(
  deadline: CreateDeadline,
  crossWorkspace: boolean,
): { timeoutMs: number; holdWithinTimeout: true } {
  const left = deadline.leftMs();
  return { timeoutMs: Math.max(1_000, crossWorkspace ? left : Math.min(30_000, left)), holdWithinTimeout: true };
}
