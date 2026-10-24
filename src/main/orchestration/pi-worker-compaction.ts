import type { PiRpcEvent, PiRpcRequestOptions } from "./pi-rpc-client";
import {
  CODARA_COMPACTION_INSTRUCTIONS,
  compactionReport,
  compactWithRecovery,
  contextPause,
  type CompactionReport,
} from "./pi-compaction-pipeline";

interface CompactionClient {
  request(command: { type: string; [key: string]: unknown }, options?: PiRpcRequestOptions): Promise<unknown>;
  prompt(message: string): Promise<unknown>;
}

const HANDOFF = `${CODARA_COMPACTION_INSTRUCTIONS} This is a worker: keep the task contract's acceptance criteria and the final report's required path and keys exact, and drop stale exploration.`;
const CONTINUE = "Continue the original task from the compacted context under the same user constraints, tool restrictions, and permissions. Preserve completed work and prior tool effects; do not repeat successful actions. Complete only the remaining requested work, verify only as permitted by the original instructions, then submit the required result.";

export class PiWorkerCompaction {
  private pending: { tokens: number | null } | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly client: CompactionClient,
    private readonly options: {
      interrupted: () => boolean;
      taskContract?: () => string;
      /** The worker's persisted scratchpad note, read at resume time. */
      scratchpad?: () => Promise<string>;
      onError: (error: Error) => void;
      onProgress?: (phase: "compacting" | "resuming") => void;
      onReport?: (report: CompactionReport) => void;
    },
  ) {}

  /** Returns true only when this settlement belongs to a requested pause. */
  consume(event: PiRpcEvent): boolean {
    if (this.disposed) return false;
    const pause = contextPause(event);
    if (pause && !this.inFlight) this.pending = { tokens: pause.tokens };
    if (event.type !== "agent_settled") return false;
    if (this.inFlight) return true;
    if (!this.pending) return false;
    const pending = this.pending;
    this.pending = null;
    this.inFlight = true;
    void this.resume(pending.tokens).catch((error) => {
      if (!this.disposed) this.options.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }

  private assertCurrent(): void {
    if (this.disposed || this.options.interrupted()) throw new Error("Pi worker was interrupted during context compaction.");
  }

  private async resume(pausedAtTokens: number | null): Promise<void> {
    this.assertCurrent();
    this.options.onProgress?.("compacting");
    const outcome = await compactWithRecovery(this.client, {
      current: () => !this.disposed && !this.options.interrupted(),
      instructions: HANDOFF,
    });
    this.assertCurrent();
    // A worker whose summarizer keeps failing still resumes: the extension
    // waits for real growth before pausing again, and Pi's own trigger stays
    // the backstop. Failing the attempt here would throw away its work.
    this.options.onReport?.(compactionReport("worker", "mid-turn", outcome, pausedAtTokens));
    this.options.onProgress?.("resuming");
    // Arm the next settlement before prompt(): a mocked or very short turn
    // can settle before the prompt acknowledgement reaches the host.
    this.inFlight = false;
    const contract = this.options.taskContract?.().trim();
    // The scratchpad is the worker's own continuity note, written precisely
    // so it survives compaction; a read failure only loses the hint.
    const notes = (await this.options.scratchpad?.().catch(() => "") ?? "").trim();
    await this.client.prompt([
      CONTINUE,
      ...(contract
        ? [`Original task contract and subsequent steering (later steering supersedes earlier instructions; completed work stays completed):\n${contract}`]
        : []),
      ...(notes ? [`Your scratchpad note from before compaction:\n${notes}`] : []),
    ].join("\n\n"));
  }
}
