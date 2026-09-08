import type { PiRpcEvent, PiRpcRequestOptions } from "./pi-rpc-client";

interface CompactionClient {
  request(command: { type: string; [key: string]: unknown }, options?: PiRpcRequestOptions): Promise<unknown>;
}

export class PiManagerCompaction {
  private pending = false;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly client: CompactionClient,
    private readonly options: {
      interrupted: () => boolean;
      onSettled: () => void;
      onError: (error: Error) => void;
    },
  ) {}

  consume(event: PiRpcEvent): boolean {
    if (this.disposed) return false;
    if (event.type === "entry_appended" && !this.inFlight) {
      const entry = event.entry as { type?: string; customType?: string; data?: { reason?: string } } | undefined;
      if (entry?.type === "custom" && entry.customType === "codara-context-pause" && entry.data?.reason === "threshold") this.pending = true;
    }
    // Pi's native-window compaction can satisfy the early request before the
    // agent settles. A failed native attempt must not trigger an immediate retry.
    if (event.type === "compaction_end" && !this.inFlight) this.pending = false;
    if (event.type !== "agent_settled") return false;
    if (this.inFlight) return true;
    if (!this.pending) return false;
    this.pending = false;
    if (this.options.interrupted()) return false;
    this.inFlight = true;
    void this.compact();
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async compact(): Promise<void> {
    try {
      await this.client.request({
        type: "compact",
        customInstructions: "Preserve the newest user objective, exact requirements, explicit prohibitions, permitted tools and paths, completed decisions and tool effects, active operation IDs, unresolved outcomes, corrections, pending work, and next actions. Do not repeat completed actions, invent requirements, or broaden permissions. Keep a concise continuation handoff.",
      }, { timeoutMs: 300_000 });
    } catch (error) {
      if (!this.disposed && !this.options.interrupted()) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.inFlight = false;
      if (!this.disposed) this.options.onSettled();
    }
  }
}
