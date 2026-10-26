// Which Codara pane an agent socket call comes from, and which process. The
// MCP server sends the pane id its environment names and its own pid. Pane
// ids are listed by codara_terminal_list and an environment variable is easy
// to set, so the id alone proves nothing: with a pid, the caller's pane is the
// one whose shell the pid descends from, and a hint naming another pane is
// ignored. Pane ownership (terminals, browser tabs, codara_tab) rests on this.

const VERIFIED_PANE_TTL_MS = 60_000;
const VERIFIED_PANE_LIMIT = 256;

// Only a holder of the root socket token calls without a pid (Codara's own
// CLI and tests), and that token already runs commands anywhere.
export const ROOT_CALLER_PROCESS = "root";

export interface CallerProcess {
  pid: number;
  // Null when the platform does not say.
  startedMs: number | null;
}

export interface CallerPaneDeps {
  hasSession(paneId: string): boolean;
  // The pid and its ancestors, nearest first; null or a rejection when it
  // cannot be read.
  processChain(pid: number): Promise<readonly CallerProcess[] | null>;
  sessionForProcessChain(chain: readonly number[]): string | null;
  // False where Codara cannot list processes at all (Windows).
  canListProcesses?(): boolean;
  now?(): number;
}

export interface CallerIdentity {
  paneId: string | null;
  // The calling process as `pid@startMs`, so a reused pid is another process
  // (the pid alone where start times are unknown); ROOT_CALLER_PROCESS
  // without a pid; null when the pid is not running.
  process: string | null;
  // When the agent CLI that started the calling MCP server started (its
  // parent). A session captured before then belongs to an earlier agent.
  agentStartedMs: number | null;
}

export class CallerPaneResolver {
  private readonly verified = new Map<number, { at: number; identity: CallerIdentity }>();

  constructor(private readonly deps: CallerPaneDeps) {}

  async resolve(params: { callerPaneId?: unknown; callerPid?: unknown }): Promise<string | null> {
    return (await this.identify(params)).paneId;
  }

  async identify(params: { callerPaneId?: unknown; callerPid?: unknown }): Promise<CallerIdentity> {
    const pid = params.callerPid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      const hinted = typeof params.callerPaneId === "string" ? params.callerPaneId : "";
      return {
        paneId: hinted && this.deps.hasSession(hinted) ? hinted : null,
        process: ROOT_CALLER_PROCESS,
        agentStartedMs: null,
      };
    }
    if (this.deps.canListProcesses?.() === false) {
      // A pid alone still tells two agents' MCP servers apart.
      return { paneId: null, process: String(pid), agentStartedMs: null };
    }
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.verified.get(pid);
    if (cached && now - cached.at < VERIFIED_PANE_TTL_MS && this.deps.hasSession(cached.identity.paneId!)) return cached.identity;
    this.verified.delete(pid);
    const chain = await this.deps.processChain(pid).catch(() => null);
    if (!chain || chain.length === 0 || chain[0].pid !== pid) return { paneId: null, process: null, agentStartedMs: null };
    const self = chain[0];
    const sessionPane = this.deps.sessionForProcessChain(chain.map((entry) => entry.pid));
    const paneId = sessionPane && this.deps.hasSession(sessionPane) ? sessionPane : null;
    const identity: CallerIdentity = {
      paneId,
      process: self.startedMs !== null ? `${pid}@${self.startedMs}` : String(pid),
      agentStartedMs: paneId ? (chain[1] ?? self).startedMs : null,
    };
    if (!paneId) return identity;
    if (this.verified.size >= VERIFIED_PANE_LIMIT) this.verified.clear();
    this.verified.set(pid, { at: now, identity });
    return identity;
  }
}
