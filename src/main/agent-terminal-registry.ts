// Ownership + idempotency for terminal tabs created through the local
// codara-studio agent socket.
//
// The socket token is shared by every Cora process in this app instance, so a
// bare pane-id set cannot distinguish a terminal owned by run A from one owned
// by run B. Keep the run identity that the MCP server stamps onto create/close,
// and retain a small tombstone after a successful close so a lost JSON-RPC
// response can be retried without turning success into "unknown pane".

export type AgentTerminalRetention = "temporary" | "service";
export type AgentTerminalRetentionFilter = AgentTerminalRetention | "all";

export interface AgentTerminalRegistration {
  paneId: string;
  tabId: string;
  runId: string | null;
  /**
   * Temporary panes are eligible for cleanup when their owning run settles.
   * Service panes intentionally survive settlement, but remain run-owned so a
   * later run deletion can close them exactly. Older callers omit this field
   * and retain the safe temporary default.
   */
  retention?: AgentTerminalRetention;
}

export interface AgentTerminalSnapshot extends AgentTerminalRegistration {
  retention: AgentTerminalRetention;
  state: "active" | "exited";
}

export interface AgentTerminalCloseResult {
  paneId: string;
  alreadyClosed: boolean;
}

export interface AgentTerminalBulkCloseSuccess {
  terminal: AgentTerminalSnapshot;
  result: AgentTerminalCloseResult;
}

export interface AgentTerminalBulkCloseFailure {
  terminal: AgentTerminalSnapshot;
  error: unknown;
}

export interface AgentTerminalBulkCloseResult {
  runId: string;
  retention: AgentTerminalRetentionFilter;
  closed: AgentTerminalBulkCloseSuccess[];
  failures: AgentTerminalBulkCloseFailure[];
}

interface ActiveAgentTerminal {
  paneId: string;
  tabId: string;
  runId: string | null;
  retention: AgentTerminalRetention;
  closePromise?: Promise<AgentTerminalCloseResult>;
}

export class AgentTerminalOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTerminalOwnershipError";
  }
}

const DEFAULT_CLOSED_TOMBSTONE_LIMIT = 1_024;

export class AgentTerminalRegistry {
  private readonly active = new Map<string, ActiveAgentTerminal>();
  private readonly exited = new Map<string, ActiveAgentTerminal>();
  private readonly closed = new Map<string, string | null>();

  constructor(
    private readonly closedTombstoneLimit = DEFAULT_CLOSED_TOMBSTONE_LIMIT,
  ) {}

  register(input: AgentTerminalRegistration): void {
    this.exited.delete(input.paneId);
    this.closed.delete(input.paneId);
    this.active.set(input.paneId, {
      ...input,
      // Treat malformed JavaScript callers like legacy callers: only an
      // explicit supported service marker may opt out of settlement cleanup.
      retention: input.retention === "service" ? "service" : "temporary",
    });
  }

  isActiveOwnedBy(paneId: string, runId: string | null): boolean {
    return this.active.get(paneId)?.runId === runId;
  }

  /**
   * Return immutable copies of the exact active/exited terminals owned by one
   * non-null run. Tombstones are intentionally excluded: they have no process
   * or renderer tab left to reconcile.
   */
  listForRun(
    runId: string,
    retention: AgentTerminalRetentionFilter = "all",
  ): readonly AgentTerminalSnapshot[] {
    const snapshots: AgentTerminalSnapshot[] = [];
    const append = (
      terminals: ReadonlyMap<string, ActiveAgentTerminal>,
      state: AgentTerminalSnapshot["state"],
    ) => {
      for (const terminal of terminals.values()) {
        if (terminal.runId !== runId) continue;
        if (retention !== "all" && terminal.retention !== retention) continue;
        snapshots.push(
          Object.freeze({
            paneId: terminal.paneId,
            tabId: terminal.tabId,
            runId: terminal.runId,
            retention: terminal.retention,
            state,
          }),
        );
      }
    };
    append(this.active, "active");
    append(this.exited, "exited");
    return Object.freeze(snapshots);
  }

  markExited(input: { paneId: string; tabId: string }): boolean {
    const registration = this.active.get(input.paneId);
    if (!registration || registration.tabId !== input.tabId) return false;
    this.active.delete(input.paneId);
    this.exited.delete(input.paneId);
    this.exited.set(input.paneId, registration);
    while (this.exited.size > Math.max(0, this.closedTombstoneLimit)) {
      const oldest = this.exited.keys().next().value;
      if (typeof oldest !== "string") break;
      this.exited.delete(oldest);
    }
    return true;
  }

  async close(input: {
    paneId: string;
    runId: string | null;
    stop: () => void | Promise<void>;
    destroyTab: (registration: AgentTerminalRegistration) => void | Promise<void>;
  }): Promise<AgentTerminalCloseResult> {
    const registration =
      this.active.get(input.paneId) ?? this.exited.get(input.paneId);
    if (!registration) {
      if (!this.closed.has(input.paneId)) {
        throw new AgentTerminalOwnershipError(
          "terminal.close is only permitted for panes created through terminal.create",
        );
      }
      this.assertSameOwner(this.closed.get(input.paneId) ?? null, input.runId);
      // Refresh LRU order while keeping the original owner.
      const owner = this.closed.get(input.paneId) ?? null;
      this.closed.delete(input.paneId);
      this.closed.set(input.paneId, owner);
      return { paneId: input.paneId, alreadyClosed: true };
    }

    this.assertSameOwner(registration.runId, input.runId);
    if (registration.closePromise) return registration.closePromise;

    const closePromise = (async (): Promise<AgentTerminalCloseResult> => {
      let stopError: unknown = null;
      if (this.active.get(input.paneId) === registration) {
        try {
          await input.stop();
        } catch (error) {
          // Still close the renderer tab. A retry will attempt the process stop
          // again, but a dead/half-created pane should not strand visual state.
          stopError = error;
        }
      }
      await input.destroyTab(registration);
      if (stopError) throw stopError;

      let removed = false;
      if (this.active.get(input.paneId) === registration) {
        this.active.delete(input.paneId);
        removed = true;
      }
      if (this.exited.get(input.paneId) === registration) {
        this.exited.delete(input.paneId);
        removed = true;
      }
      if (removed) {
        this.rememberClosed(input.paneId, registration.runId);
      }
      return { paneId: input.paneId, alreadyClosed: false };
    })();
    registration.closePromise = closePromise;

    try {
      return await closePromise;
    } catch (error) {
      // A bridge timeout is retryable. Keep ownership but release the
      // single-flight promise so the caller can safely try the same close.
      if (
        this.active.get(input.paneId) === registration ||
        this.exited.get(input.paneId) === registration
      ) {
        registration.closePromise = undefined;
      }
      throw error;
    }
  }

  /**
   * Close every exact pane currently owned by a run.
   *
   * Each pane still goes through close(), preserving its ownership gate,
   * per-pane single flight, retryability, and idempotent tombstone behavior.
   * All panes are attempted even if some fail. Failures remain registered and
   * are returned to the caller for a later retry; unrelated and null-owned
   * terminals are never enumerated.
   */
  async closeForRun(input: {
    runId: string;
    retention?: AgentTerminalRetentionFilter;
    stop: (terminal: AgentTerminalSnapshot) => void | Promise<void>;
    destroyTab: (terminal: AgentTerminalSnapshot) => void | Promise<void>;
  }): Promise<AgentTerminalBulkCloseResult> {
    const retention = input.retention ?? "all";
    const terminals = this.listForRun(input.runId, retention);
    const outcomes = await Promise.all(
      terminals.map(async (terminal) => {
        try {
          const result = await this.close({
            paneId: terminal.paneId,
            runId: input.runId,
            stop: () => input.stop(terminal),
            destroyTab: () => input.destroyTab(terminal),
          });
          return { ok: true as const, terminal, result };
        } catch (error) {
          return { ok: false as const, terminal, error };
        }
      }),
    );

    const closed: AgentTerminalBulkCloseSuccess[] = [];
    const failures: AgentTerminalBulkCloseFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        closed.push({ terminal: outcome.terminal, result: outcome.result });
      } else {
        failures.push({ terminal: outcome.terminal, error: outcome.error });
      }
    }
    return {
      runId: input.runId,
      retention,
      closed,
      failures,
    };
  }

  private assertSameOwner(ownerRunId: string | null, callerRunId: string | null): void {
    if (ownerRunId === callerRunId) return;
    throw new AgentTerminalOwnershipError(
      "terminal.close cannot close a pane owned by another Cora run",
    );
  }

  private rememberClosed(paneId: string, runId: string | null): void {
    this.closed.delete(paneId);
    this.closed.set(paneId, runId);
    while (this.closed.size > Math.max(0, this.closedTombstoneLimit)) {
      const oldest = this.closed.keys().next().value;
      if (typeof oldest !== "string") break;
      this.closed.delete(oldest);
    }
  }
}
