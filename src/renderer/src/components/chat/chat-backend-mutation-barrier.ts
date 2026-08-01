import type { RunState, UpdateChatBackendInput } from "@shared/types";

export const DESKTOP_CHAT_HOST_ID = "local-electron-renderer";

export interface ChatBackendMutationScope {
  hostId: string;
  workspaceId: string;
  runId: string;
}

export type ChatBackendMutationDesiredState = UpdateChatBackendInput;

export interface ChatBackendMutationBarrier {
  readonly key: string;
  readonly desired: ChatBackendMutationDesiredState;
  readonly promise: Promise<void>;
}

function scopeKey(scope: ChatBackendMutationScope): string {
  return JSON.stringify([scope.hostId, scope.workspaceId, scope.runId]);
}

export function chatBackendMutationScope(
  run: Pick<RunState, "id" | "workspaceId">,
): ChatBackendMutationScope {
  return {
    hostId: DESKTOP_CHAT_HOST_ID,
    workspaceId: run.workspaceId,
    runId: run.id,
  };
}

export function chatBackendMutationScopeMatchesRun(
  scope: ChatBackendMutationScope,
  run: Pick<RunState, "id" | "workspaceId"> | null,
): boolean {
  return (
    scope.hostId === DESKTOP_CHAT_HOST_ID &&
    run?.workspaceId === scope.workspaceId &&
    run.id === scope.runId
  );
}

/**
 * Renderer-process lifetime ordering fence for next-turn chat configuration.
 * ChatComposer is keyed by run and remounts during navigation, so the registry
 * deliberately lives at module scope rather than in a component ref.
 */
export class ChatBackendMutationBarrierRegistry {
  private readonly barriers = new Map<string, ChatBackendMutationBarrier>();

  current(scope: ChatBackendMutationScope): ChatBackendMutationBarrier | null {
    return this.barriers.get(scopeKey(scope)) ?? null;
  }

  enqueue(
    scope: ChatBackendMutationScope,
    desired: ChatBackendMutationDesiredState,
    mutate: () => Promise<void>,
  ): ChatBackendMutationBarrier {
    const key = scopeKey(scope);
    const previous = this.barriers.get(key);
    const promise = (previous?.promise ?? Promise.resolve())
      .catch(() => undefined)
      .then(mutate);
    const barrier = { key, desired, promise };
    this.barriers.set(key, barrier);

    // A confirmed success releases only this exact generation. Rejections
    // remain in the registry so a later send cannot silently use the previous
    // account; a subsequent explicit selection replaces and retries the full
    // desired state.
    void promise.then(
      () => {
        if (this.barriers.get(key) === barrier) this.barriers.delete(key);
      },
      () => undefined,
    );
    return barrier;
  }

  /**
   * Drain the newest mutation for this scope. A rapid picker change can replace
   * the observed barrier while it is pending, so every settlement re-reads the
   * registry. Only the latest rejection is authoritative.
   */
  async waitForStable(scope: ChatBackendMutationScope): Promise<void> {
    const key = scopeKey(scope);
    for (;;) {
      const barrier = this.barriers.get(key);
      if (!barrier) return;
      try {
        await barrier.promise;
      } catch (cause) {
        if (this.barriers.get(key) !== barrier) continue;
        throw cause;
      }
      if (this.barriers.get(key) === barrier) return;
    }
  }
}

export const chatBackendMutationBarriers =
  new ChatBackendMutationBarrierRegistry();
