import * as pty from "./pty-manager";
import { requestTerminalOp } from "./terminal-bridge";
import {
  AgentTerminalRegistry,
  type AgentTerminalBulkCloseResult,
  type AgentTerminalRegistration,
} from "./agent-terminal-registry";

export type AgentTerminalCleanupScope = "temporary" | "all";

// One process-wide ownership ledger. Both the agent socket (which creates and
// explicitly closes panes) and the run lifecycle (which reconciles forgotten
// panes) must observe the same registrations.
export const agentTerminals = new AgentTerminalRegistry();

const CLEANUP_BRIDGE_TIMEOUT_MS = 2_500;
const CLEANUP_RETRY_DELAYS_MS = [250, 1_000, 4_000, 10_000, 30_000] as const;
const MAX_RUN_FENCES = 2_048;

type RunFence = {
  phase: "settled" | "deleting";
  // A completed run can become active again when the user continues its chat.
  // Keep the fence until any failed renderer cleanup finishes, otherwise that
  // retry could enumerate and close a brand-new terminal from the new epoch.
  resumeRequested: boolean;
};

const runFences = new Map<string, RunFence>();

function rememberRunFence(runId: string, fence: RunFence): void {
  runFences.delete(runId);
  runFences.set(runId, fence);
  while (runFences.size > MAX_RUN_FENCES) {
    const oldest = runFences.keys().next().value;
    if (typeof oldest !== "string") break;
    runFences.delete(oldest);
  }
}

export function canRegisterAgentTerminal(runId: string | null): boolean {
  return runId === null || !runFences.has(runId);
}

/**
 * Atomically admit a terminal into the process ledger.
 *
 * The preflight in agent-socket provides a useful error before spawning, but
 * this synchronous fence is the authority for the race where a run settles or
 * starts deletion while the renderer is still creating the tab.
 */
export function registerAgentTerminal(input: AgentTerminalRegistration): boolean {
  if (!canRegisterAgentTerminal(input.runId)) return false;
  agentTerminals.register(input);
  return true;
}

function fenceSettledRun(runId: string): void {
  const current = runFences.get(runId);
  if (current?.phase === "deleting") return;
  rememberRunFence(runId, { phase: "settled", resumeRequested: false });
}

function fenceDeletingRun(runId: string): void {
  rememberRunFence(runId, { phase: "deleting", resumeRequested: false });
}

export function fenceAgentTerminalRunDeleting(runId: string): void {
  fenceDeletingRun(runId);
}

/**
 * Release a settlement fence when a completed chat is resumed.
 *
 * A failed cleanup retains the fence until its retry succeeds. That is safer
 * than admitting a new terminal which the old run-scoped retry would then
 * mistake for stale work and close.
 */
export function markAgentTerminalRunActive(runId: string): void {
  const fence = runFences.get(runId);
  if (!fence || fence.phase === "deleting") return;
  if (cleanupCoordinator.hasPending(runId)) {
    rememberRunFence(runId, { phase: "settled", resumeRequested: true });
    return;
  }
  runFences.delete(runId);
}

async function closeAgentTerminalsOnce(
  runId: string,
  retention: AgentTerminalCleanupScope,
): Promise<AgentTerminalBulkCloseResult> {
  return agentTerminals.closeForRun({
    runId,
    retention,
    stop: (terminal) => pty.killImmediate(terminal.paneId),
    destroyTab: (terminal) =>
      requestTerminalOp(
        "destroy",
        {
          tabId: terminal.tabId,
          paneId: terminal.paneId,
        },
        { timeoutMs: CLEANUP_BRIDGE_TIMEOUT_MS },
      ),
  });
}

type CleanupWaiter = {
  scope: AgentTerminalCleanupScope;
  resolve: (result: AgentTerminalBulkCloseResult) => void;
  reject: (error: unknown) => void;
};

type CleanupState = {
  runId: string;
  desiredScope: AgentTerminalCleanupScope | null;
  inFlightScope: AgentTerminalCleanupScope | null;
  running: boolean;
  retryIndex: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  waiters: CleanupWaiter[];
};

function scopeRank(scope: AgentTerminalCleanupScope): number {
  return scope === "all" ? 1 : 0;
}

function broaderScope(
  left: AgentTerminalCleanupScope | null,
  right: AgentTerminalCleanupScope,
): AgentTerminalCleanupScope {
  if (left === null) return right;
  return scopeRank(right) > scopeRank(left) ? right : left;
}

/**
 * Per-run, retention-upgrading cleanup queue.
 *
 * A delete request arriving behind settlement upgrades temporary -> all.
 * Per-pane close remains single-flight in AgentTerminalRegistry. Failed
 * renderer reconciliation is retried with bounded backoff while the PTY stays
 * stopped, and app:renderer-ready can flush every pending retry immediately.
 */
export class AgentTerminalCleanupCoordinator {
  private readonly states = new Map<string, CleanupState>();

  constructor(
    private readonly closeOnce: (
      runId: string,
      scope: AgentTerminalCleanupScope,
    ) => Promise<AgentTerminalBulkCloseResult>,
    private readonly retryDelaysMs: readonly number[] = CLEANUP_RETRY_DELAYS_MS,
    private readonly onIdle?: (runId: string) => void,
  ) {}

  request(
    runId: string,
    scope: AgentTerminalCleanupScope,
  ): Promise<AgentTerminalBulkCloseResult> {
    const state = this.stateFor(runId);

    // A request already in flight covers equal/narrower callers. A broader
    // deletion request is queued for the next pass and cannot be downgraded by
    // a later duplicate settlement request.
    if (
      state.inFlightScope === null ||
      scopeRank(scope) > scopeRank(state.inFlightScope)
    ) {
      state.desiredScope = broaderScope(state.desiredScope, scope);
    }

    const promise = new Promise<AgentTerminalBulkCloseResult>((resolve, reject) => {
      state!.waiters.push({ scope, resolve, reject });
    });

    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    this.start(state);
    return promise;
  }

  /**
   * Require a new enumeration pass even when a broader pass is already in
   * flight. Used for a renderer tab that finished spawning after the in-flight
   * cleanup took its registry snapshot.
   */
  enqueueFresh(runId: string, scope: AgentTerminalCleanupScope): void {
    const state = this.stateFor(runId);
    state.desiredScope = broaderScope(state.desiredScope, scope);
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    this.start(state);
  }

  hasPending(runId: string): boolean {
    return this.states.has(runId);
  }

  retryPendingNow(): void {
    for (const state of this.states.values()) {
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      this.start(state);
    }
  }

  private stateFor(runId: string): CleanupState {
    const existing = this.states.get(runId);
    if (existing) return existing;
    const state: CleanupState = {
      runId,
      desiredScope: null,
      inFlightScope: null,
      running: false,
      retryIndex: 0,
      retryTimer: null,
      waiters: [],
    };
    this.states.set(runId, state);
    return state;
  }

  private start(state: CleanupState): void {
    if (state.running || state.retryTimer || state.desiredScope === null) return;
    state.running = true;
    void this.drain(state);
  }

  private async drain(state: CleanupState): Promise<void> {
    try {
      while (state.desiredScope !== null) {
        const scope = state.desiredScope;
        state.desiredScope = null;
        state.inFlightScope = scope;

        let result: AgentTerminalBulkCloseResult;
        try {
          result = await this.closeOnce(state.runId, scope);
        } catch (error) {
          const covered = state.waiters.filter(
            (waiter) => scopeRank(waiter.scope) <= scopeRank(scope),
          );
          state.waiters = state.waiters.filter(
            (waiter) => scopeRank(waiter.scope) > scopeRank(scope),
          );
          for (const waiter of covered) waiter.reject(error);
          state.desiredScope = broaderScope(state.desiredScope, scope);
          this.armRetry(state);
          return;
        } finally {
          state.inFlightScope = null;
        }

        const covered = state.waiters.filter(
          (waiter) => scopeRank(waiter.scope) <= scopeRank(scope),
        );
        state.waiters = state.waiters.filter(
          (waiter) => scopeRank(waiter.scope) > scopeRank(scope),
        );
        for (const waiter of covered) waiter.resolve(result);

        if (result.failures.length > 0) {
          state.desiredScope = broaderScope(state.desiredScope, scope);
          // A broader request queued during this pass should run immediately.
          // Otherwise wait for backoff or renderer-ready.
          if (
            state.desiredScope === scope ||
            scopeRank(state.desiredScope) <= scopeRank(scope)
          ) {
            this.armRetry(state);
            return;
          }
        } else {
          state.retryIndex = 0;
        }
      }
    } finally {
      state.running = false;
      if (state.retryTimer === null && state.desiredScope === null) {
        this.states.delete(state.runId);
        this.onIdle?.(state.runId);
      } else if (state.retryTimer === null) {
        this.start(state);
      }
    }
  }

  private armRetry(state: CleanupState): void {
    if (state.retryTimer) return;
    const index = Math.min(
      state.retryIndex,
      Math.max(0, this.retryDelaysMs.length - 1),
    );
    const delay = this.retryDelaysMs[index] ?? 1_000;
    state.retryIndex += 1;
    const timer = setTimeout(() => {
      if (state.retryTimer !== timer) return;
      state.retryTimer = null;
      this.start(state);
    }, Math.max(0, delay));
    timer.unref?.();
    state.retryTimer = timer;
  }
}

function releaseResumedFenceWhenIdle(runId: string): void {
  const fence = runFences.get(runId);
  if (fence?.phase === "settled" && fence.resumeRequested) {
    runFences.delete(runId);
  }
}

const cleanupCoordinator = new AgentTerminalCleanupCoordinator(
  closeAgentTerminalsOnce,
  CLEANUP_RETRY_DELAYS_MS,
  releaseResumedFenceWhenIdle,
);

export function closeAgentTerminalsForRun(
  runId: string,
  retention: AgentTerminalCleanupScope = "all",
): Promise<AgentTerminalBulkCloseResult> {
  return cleanupCoordinator.request(runId, retention);
}

export function settleAgentTerminalRun(
  runId: string,
): Promise<AgentTerminalBulkCloseResult> {
  fenceSettledRun(runId);
  return closeAgentTerminalsForRun(runId, "temporary");
}

export function deleteAgentTerminalRun(
  runId: string,
): Promise<AgentTerminalBulkCloseResult> {
  fenceDeletingRun(runId);
  return closeAgentTerminalsForRun(runId, "all");
}

/**
 * Adopt a tab that lost the create-vs-settle race only long enough to clean it.
 *
 * Force the temporary policy even when the caller requested service: once the
 * owner is fenced, no new run-owned pane is allowed to survive. enqueueFresh
 * guarantees a pass after any cleanup snapshot already in flight.
 */
export function quarantineLateAgentTerminal(
  input: AgentTerminalRegistration & { runId: string },
): void {
  agentTerminals.register({ ...input, retention: "temporary" });
  cleanupCoordinator.enqueueFresh(input.runId, "temporary");
}

export function retryPendingAgentTerminalCleanups(): void {
  cleanupCoordinator.retryPendingNow();
}
