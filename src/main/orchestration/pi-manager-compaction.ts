import type { PiRpcEvent, PiRpcRequestOptions } from "./pi-rpc-client";
import {
  compactionReport,
  compactWithRecovery,
  contextPause,
  type CompactionOutcome,
  type CompactionReport,
} from "./pi-compaction-pipeline";

interface CompactionClient {
  request(command: { type: string; [key: string]: unknown }, options?: PiRpcRequestOptions): Promise<unknown>;
  /** Resumes a turn the extension paused mid-task. */
  prompt?(message: string): Promise<unknown>;
}

/** Starts with a prefix resources/pi-cora/compaction-ledger.ts recognizes, so
 *  the continuation never crowds out the user's real instructions. */
export const MANAGER_CONTINUE = [
  "Continue the user's request from the compacted context. Everything your tools already did in this turn",
  "stands: do not repeat successful actions, and re-read a file before editing it again. Keep the same",
  "constraints, tool restrictions and permissions, check the durable state block for open errors and",
  "worker results, then finish the work and close with the reply the user is waiting for.",
].join(" ");

type Pending = { phase: "mid-turn" | "settled"; tokens: number | null; satisfied: boolean };

/**
 * Compacts a manager session at the points the bundled extension marks.
 *
 * A "settled" pause comes after the answer is complete: compact, then hand
 * the finished turn back. A "mid-turn" pause comes after a tool round of a
 * long task: the extension aborted the loop at that boundary, so compact and
 * resume the same turn with a continuation prompt; the continuation's own
 * settlement ends the turn.
 */
export class PiManagerCompaction {
  private pending: Pending | null = null;
  private inFlight: Pending | null = null;
  private disposed = false;

  constructor(
    private readonly client: CompactionClient,
    private readonly options: {
      interrupted: () => boolean;
      onSettled: () => void;
      onError: (error: Error) => void;
      onReport?: (report: CompactionReport) => void;
      /** The memory sections the compaction summary leaves out, re-read for
       *  the continuation of a turn compacted mid-task; the next user turn
       *  is too late for a long run. */
      pinnedContext?: () => Promise<string | null>;
    },
  ) {}

  /** True while a mid-turn pause owns the turn: an agent_settled now is not
   *  the end of the user's turn. */
  holdsTurnOpen(): boolean {
    return this.pending?.phase === "mid-turn" || this.inFlight?.phase === "mid-turn";
  }

  consume(event: PiRpcEvent): boolean {
    if (this.disposed) return false;
    const pause = contextPause(event);
    if (pause && !this.inFlight) {
      this.pending = { phase: pause.phase ?? "settled", tokens: pause.tokens, satisfied: false };
    }
    if (event.type === "compaction_end" && !this.inFlight && this.pending) {
      // Pi's native compaction can satisfy the early request before the agent
      // settles. A failed native attempt must not trigger an immediate retry
      // of a finished answer; a paused task still has to be resumed.
      if (this.pending.phase === "settled") this.pending = null;
      else if (event.result) this.pending.satisfied = true;
    }
    if (event.type !== "agent_settled") return false;
    if (this.inFlight) return true;
    if (!this.pending) return false;
    const pending = this.pending;
    this.pending = null;
    if (this.options.interrupted()) return false;
    this.inFlight = pending;
    void this.run(pending);
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }

  private current(): boolean {
    return !this.disposed && !this.options.interrupted();
  }

  private async pinnedContext(): Promise<string | null> {
    try {
      return (await this.options.pinnedContext?.())?.trim() || null;
    } catch {
      return null;
    }
  }

  private async run(pending: Pending): Promise<void> {
    let resumed = false;
    try {
      const outcome: CompactionOutcome = pending.satisfied
        ? { status: "nothing", errors: [] }
        : await compactWithRecovery(this.client, { current: () => this.current() });
      if (!this.current()) return;
      this.options.onReport?.(compactionReport("manager", pending.phase, outcome, pending.tokens));
      if (pending.phase === "mid-turn") {
        if (!this.client.prompt) throw new Error("This Pi client cannot resume a paused turn.");
        // Even a failed compaction resumes: the extension waits for real
        // growth before pausing again, and Pi's own trigger stays the backstop.
        // Arm the next settlement before prompt(): a short continuation can
        // settle before the prompt acknowledgement reaches the host.
        const pinned = pending.satisfied || outcome.status === "compacted"
          ? await this.pinnedContext()
          : null;
        if (!this.current()) return;
        this.inFlight = null;
        resumed = true;
        await this.client.prompt(pinned ? `${MANAGER_CONTINUE}\n\n${pinned}` : MANAGER_CONTINUE);
        return;
      }
      if (outcome.status === "failed") {
        this.options.onError(new Error(outcome.errors.at(-1) ?? "Context compaction failed."));
      }
    } catch (error) {
      if (this.current()) this.options.onError(error instanceof Error ? error : new Error(String(error)));
      resumed = false;
    } finally {
      if (!resumed) {
        this.inFlight = null;
        if (!this.disposed) this.options.onSettled();
      }
    }
  }
}
