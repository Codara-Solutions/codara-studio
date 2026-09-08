import type { PiRpcEvent, PiRpcRequestOptions } from "./pi-rpc-client";

interface CompactionClient {
  request(command: { type: string; [key: string]: unknown }, options?: PiRpcRequestOptions): Promise<unknown>;
  prompt(message: string): Promise<unknown>;
}

const HANDOFF = "Preserve the current user objective, exact requirements and identifiers, explicit prohibitions, permitted tools and paths, confirmed facts, completed work and verification, failures, pending tasks, and next actions. Keep a concise continuation handoff. Do not invent new requirements, broaden permissions, or retain stale exploration.";
const CONTINUE = "Continue the original task from the compacted context under the same user constraints, tool restrictions, and permissions. Preserve completed work and prior tool effects; do not repeat successful actions. Complete only the remaining requested work, verify only as permitted by the original instructions, then submit the required result.";

export class PiWorkerCompaction {
  private pending = false;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly client: CompactionClient,
    private readonly options: {
      interrupted: () => boolean;
      taskContract?: () => string;
      onError: (error: Error) => void;
      onProgress?: (phase: "compacting" | "resuming") => void;
    },
  ) {}

  /** Returns true only when this settlement belongs to a requested pause. */
  consume(event: PiRpcEvent): boolean {
    if (this.disposed) return false;
    if (event.type === "entry_appended" && !this.inFlight) {
      const entry = event.entry as { type?: string; customType?: string; data?: { reason?: string } } | undefined;
      if (entry?.type === "custom" && entry.customType === "codara-context-pause" && entry.data?.reason === "threshold") {
        this.pending = true;
      }
    }
    if (event.type !== "agent_settled") return false;
    if (this.inFlight) return true;
    if (!this.pending) return false;
    this.pending = false;
    this.inFlight = true;
    void this.resume().catch((error) => {
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

  private async resume(): Promise<void> {
    this.assertCurrent();
    this.options.onProgress?.("compacting");
    await this.client.request({ type: "compact", customInstructions: HANDOFF }, { timeoutMs: 300_000 });
    this.assertCurrent();
    this.options.onProgress?.("resuming");
    // Arm the next settlement before prompt(): a mocked or very short turn
    // can settle before the prompt acknowledgement reaches the host.
    this.inFlight = false;
    const contract = this.options.taskContract?.().trim();
    await this.client.prompt(contract
      ? `${CONTINUE}\n\nOriginal task contract and subsequent steering (later steering supersedes earlier instructions; completed work stays completed):\n${contract}`
      : CONTINUE);
  }
}
