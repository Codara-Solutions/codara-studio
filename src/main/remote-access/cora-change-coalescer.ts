export const CORA_CHANGED_COALESCE_MS = 500;

export interface CoraChangedHint {
  workspaceId: string;
  runId?: string;
  sequence?: number;
}

export interface CoraChangedCoalescer<TEvent extends CoraChangedHint> {
  push(event: TEvent): void;
  flushAll(): void;
  dispose(): void;
}

export interface CoraChangedCoalescerOptions {
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/**
 * Per-run trailing throttle for journal invalidations. The first event opens
 * one fixed window; later events update its payload without moving the timer,
 * so a continuously streaming assistant produces at most one push per window.
 */
export function createCoraChangedCoalescer<TEvent extends CoraChangedHint>(
  flush: (event: TEvent) => void,
  options: CoraChangedCoalescerOptions = {},
): CoraChangedCoalescer<TEvent> {
  const delayMs = options.delayMs ?? CORA_CHANGED_COALESCE_MS;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new TypeError("delayMs must be a non-negative safe integer.");
  }
  const schedule =
    options.schedule ??
    ((callback: () => void, delay: number): unknown => setTimeout(callback, delay));
  const cancel =
    options.cancel ??
    ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const pending = new Map<string, { event: TEvent; timer: unknown }>();

  const flushKey = (key: string, timer?: unknown): void => {
    const entry = pending.get(key);
    if (!entry || (timer !== undefined && entry.timer !== timer)) return;
    pending.delete(key);
    flush(entry.event);
  };

  return {
    push(event): void {
      const key = JSON.stringify([event.workspaceId, event.runId ?? null]);
      const existing = pending.get(key);
      if (existing) {
        const previousSequence = validSequence(existing.event.sequence);
        const nextSequence = validSequence(event.sequence);
        existing.event = {
          ...event,
          ...(previousSequence !== undefined || nextSequence !== undefined
            ? { sequence: Math.max(previousSequence ?? 0, nextSequence ?? 0) }
            : {}),
        };
        return;
      }
      let timer: unknown;
      timer = schedule(() => flushKey(key, timer), delayMs);
      (timer as { unref?: () => void } | null)?.unref?.();
      pending.set(key, { event, timer });
    },
    flushAll(): void {
      for (const [key, entry] of [...pending]) {
        cancel(entry.timer);
        flushKey(key, entry.timer);
      }
    },
    dispose(): void {
      for (const entry of pending.values()) cancel(entry.timer);
      pending.clear();
    },
  };
}

function validSequence(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value : undefined;
}
