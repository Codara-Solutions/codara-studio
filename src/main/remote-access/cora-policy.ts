import type { RunState } from "@shared/types";

export interface RemoteCoraRetryInput {
  workspaceId: string;
  runId?: string;
  message: string;
  clientMessageId: string;
}

// Find the durable user message written by an earlier delivery of the same
// phone request. New-conversation retries do not yet know a run id, so the
// client key must be searched across the workspace rather than only inside a
// caller-selected run.
export function findRemoteCoraRetry(
  runs: RunState[],
  input: RemoteCoraRetryInput,
): RunState | undefined {
  const matches = runs.flatMap((run) =>
    run.workspaceId === input.workspaceId
      ? run.humanMessages
          .filter((entry) => entry.clientMessageId === input.clientMessageId)
          .map((entry) => ({ run, entry }))
      : [],
  );
  if (matches.length === 0) return undefined;

  const match = input.runId
    ? matches.find(({ run }) => run.id === input.runId)
    : matches[0];
  if (!match) {
    throw new Error("clientMessageId is already used by another Cora run.");
  }
  if (
    match.entry.author !== "user" ||
    (match.entry.kind !== "note" && match.entry.kind !== "answer") ||
    match.entry.message !== input.message
  ) {
    throw new Error("clientMessageId is already used by another Cora message.");
  }
  return match.run;
}

// Serialize one logical retry key across every phone connection. Run-store
// already serializes commits per run; this queue covers the earlier phase
// where a new conversation has no run id yet and two deliveries could both
// create one.
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  size(): number {
    return this.tails.size;
  }
}
