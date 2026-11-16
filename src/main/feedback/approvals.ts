// The questions an agent's feedback call waits on: "send this?" before
// codara_feedback_send, and "delete this?" before an admin delete. Pure apart
// from the injected window, so scripts/test-feedback-agent.cjs drives it
// without Electron; asks.ts wires it to the window.

import type { FeedbackAnswer, FeedbackAsk, FeedbackAskClosed, FeedbackAskInput } from "@shared/feedback";

export interface FeedbackAsksDeps {
  // False when no window can show the question.
  show(request: FeedbackAsk): boolean;
  close(payload: FeedbackAskClosed): void;
  newId?(): string;
}

interface Pending {
  request: FeedbackAsk;
  answer(value: FeedbackAnswer): void;
}

export class FeedbackAsks {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;

  constructor(private readonly deps: FeedbackAsksDeps) {}

  list(): FeedbackAsk[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  // Resolves "yes" or "no" from the person, or null when no window can ask,
  // nobody answered in time, or the agent stopped waiting. The question
  // closes then, so a late Send acts for nobody. Only a click answers it:
  // nothing an agent says counts as the person's yes.
  ask(input: FeedbackAskInput, options: { timeoutMs: number; signal?: AbortSignal }): Promise<FeedbackAnswer | null> {
    if (options.signal?.aborted) return Promise.resolve(null);
    const id = this.deps.newId?.() ?? `feedback-${++this.nextId}`;
    const request = { ...input, id, expiresAt: Date.now() + options.timeoutMs } as FeedbackAsk;
    return new Promise<FeedbackAnswer | null>((resolve) => {
      const finish = (value: FeedbackAnswer | null, reason?: FeedbackAskClosed["reason"]) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", withdraw);
        if (!this.pending.delete(id)) return;
        if (reason) this.deps.close({ id, reason });
        resolve(value);
      };
      const timer = setTimeout(() => finish(null, "expired"), options.timeoutMs);
      const withdraw = () => finish(null, "withdrawn");
      options.signal?.addEventListener("abort", withdraw, { once: true });
      this.pending.set(id, { request, answer: (value) => finish(value) });
      if (!this.deps.show(request)) finish(null);
    });
  }

  // False when the question is no longer waited for.
  answer(id: string, value: FeedbackAnswer): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.answer(value);
    return true;
  }
}
