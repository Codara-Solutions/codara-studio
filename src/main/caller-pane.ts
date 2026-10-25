// Which Codara pane an agent socket call comes from. The MCP server sends the
// pane id its environment names and its own pid. Pane ids are listed by
// codara_terminal_list and an environment variable is easy to set, so the id
// alone proves nothing: with a pid, the caller's pane is the one whose shell
// the pid descends from, and a hint naming another pane is ignored. Pane
// ownership (terminals, browser tabs, codara_tab) rests on this.

const VERIFIED_PANE_TTL_MS = 60_000;
const VERIFIED_PANE_LIMIT = 256;

export interface CallerPaneDeps {
  hasSession(paneId: string): boolean;
  // The pid and its ancestors, nearest first; null or a rejection when it
  // cannot be read.
  processChain(pid: number): Promise<readonly number[] | null>;
  sessionForProcessChain(chain: readonly number[]): string | null;
  now?(): number;
}

export class CallerPaneResolver {
  private readonly verified = new Map<number, { at: number; paneId: string }>();

  constructor(private readonly deps: CallerPaneDeps) {}

  async resolve(params: { callerPaneId?: unknown; callerPid?: unknown }): Promise<string | null> {
    const pid = params.callerPid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
      // Only a holder of the root socket token calls without a pid (Codara's
      // own CLI and tests), and that token already runs commands anywhere.
      const hinted = typeof params.callerPaneId === "string" ? params.callerPaneId : "";
      return hinted && this.deps.hasSession(hinted) ? hinted : null;
    }
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.verified.get(pid);
    if (cached && now - cached.at < VERIFIED_PANE_TTL_MS && this.deps.hasSession(cached.paneId)) return cached.paneId;
    this.verified.delete(pid);
    const chain = await this.deps.processChain(pid).catch(() => null);
    const paneId = chain ? this.deps.sessionForProcessChain(chain) : null;
    if (!paneId || !this.deps.hasSession(paneId)) return null;
    if (this.verified.size >= VERIFIED_PANE_LIMIT) this.verified.clear();
    this.verified.set(pid, { at: now, paneId });
    return paneId;
  }
}
