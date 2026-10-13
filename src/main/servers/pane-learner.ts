// Learns dev servers started in terminal panes: the user's own shell, one an
// agent opened with codara_terminal_create, or an agent CLI's pane whose own
// shell tool started one. When a local URL shows up in a pane's output and
// the process listening on that port runs in that same pane, the keeper
// remembers how to start it again (command, folder, port, URL), and a pane an
// agent created passes from the agent's run to the workspace, so that agent
// ending or restarting no longer closes it.
//
// The command comes from the shell's own report (OSC 633;E, sent by zsh and
// PowerShell) when there is one, and otherwise from the listening process's
// command line (bash sends no report, and an agent's tool runs no prompt).

import { runtimeFromCommandLine } from "@shared/agent-patterns";

import { completeLines, findLocalUrls, shellReports } from "./detect";

export interface LearnerPane {
  paneId: string;
  workspaceId: string;
  cwd?: string;
  /** "shell" for a plain shell, else the agent CLI the pane was opened for. */
  profile?: string;
}

/** Who listens on a port: its process, and the pane that process runs in (null for none). */
export interface PortHolder {
  pid: number;
  paneId: string | null;
}

export interface PaneLearnerDeps {
  listPanes(): Promise<LearnerPane[]>;
  tap(paneId: string, listener: (chunk: string) => void): () => void;
  sessionCwd(paneId: string): string | null;
  /** The pane's latest output, for a pane the learner starts watching late. */
  recentOutput(paneId: string): string;
  isKeeperSession(paneId: string): boolean;
  portAnswers(port: number): Promise<boolean>;
  /** Undefined when the platform cannot tell. */
  portHolder(port: number): Promise<PortHolder | undefined>;
  /** A process's command line as one shell line, and its working folder. */
  processCommand(pid: number): Promise<{ command: string; cwd: string | null } | null>;
  learn(input: {
    workspaceId: string;
    paneId: string;
    command: string;
    cwd: string;
    url: string;
    port: number;
    pid: number | null;
    source: "agent" | "user";
  }): Promise<string | null>;
  /** Created through terminal.create: hand it to the workspace and report true. */
  adoptAgentPane(paneId: string): boolean;
  sleep(ms: number): Promise<void>;
}

const SCAN_KEEP = 4_096;
const READY_PROBES = 12;
const READY_PROBE_MS = 250;
const MAX_SEEN_PORTS = 32;
// A command finished (OSC 133;D or 633;D): what it printed no longer runs.
const COMMAND_DONE_G = /\x1b\](?:133|633);D(?:;|\x07|\x1b\\)/g;

function lastMatchIndex(text: string, pattern: RegExp): number {
  let index = -1;
  for (const match of text.matchAll(pattern)) index = match.index ?? index;
  return index;
}

interface Watched {
  workspaceId: string;
  /** The pane was opened for an agent CLI. */
  agentPane: boolean;
  cwd: string | null;
  /** The command line the shell last reported, unless it started an agent CLI. */
  command: string | null;
  /** The shell's last report was an agent CLI. */
  agentCommand: boolean;
  /** Ports already learned or found to be another process's, since the last command. */
  seen: Set<number>;
  pending: boolean;
  carry: string;
  scan: string;
  off: () => void;
}

export function createPaneLearner(deps: PaneLearnerDeps) {
  const watched = new Map<string, Watched>();

  async function confirm(paneId: string, pane: Watched, url: string, port: number): Promise<void> {
    const reported = pane.agentCommand ? null : pane.command;
    for (let attempt = 0; attempt < READY_PROBES; attempt += 1) {
      if (watched.get(paneId) !== pane) return;
      if (await deps.portAnswers(port).catch(() => false)) {
        const holder = await deps.portHolder(port).catch(() => undefined);
        // A URL an agent or a log merely printed belongs to some other process.
        if (holder && holder.paneId !== paneId) return;
        // Without knowing the listener, only a shell's own report ties the
        // URL to this pane, and an agent pane never makes one.
        if (!holder && (!reported || pane.agentPane)) return;
        let command = reported;
        let cwd = pane.cwd ?? deps.sessionCwd(paneId);
        if (!command && holder) {
          const info = await deps.processCommand(holder.pid).catch(() => null);
          if (!info) return;
          command = info.command;
          cwd = info.cwd ?? cwd;
        }
        if (!command || !cwd) return;
        const adopted = deps.adoptAgentPane(paneId);
        await deps.learn({
          workspaceId: pane.workspaceId,
          paneId,
          command,
          cwd,
          url,
          port,
          pid: holder?.pid ?? null,
          source: adopted || pane.agentPane || pane.agentCommand ? "agent" : "user",
        });
        return;
      }
      await deps.sleep(READY_PROBE_MS);
    }
    // Never answered: a later mention may come once it does.
    pane.seen.delete(port);
  }

  function onChunk(paneId: string, pane: Watched, chunk: string): void {
    let text = pane.carry + chunk;
    // An OSC report split across chunks waits for its terminator.
    const open = text.lastIndexOf("\x1b]");
    if (open >= 0 && !/[\x07]|\x1b\\/.test(text.slice(open + 2))) {
      pane.carry = text.slice(open).slice(-SCAN_KEEP);
      text = text.slice(0, open);
    } else {
      pane.carry = "";
    }
    const reports = shellReports(text);
    if (reports.cwds.length) pane.cwd = reports.cwds[reports.cwds.length - 1];
    const started = text.lastIndexOf("\x1b]633;E;");
    const done = lastMatchIndex(text, COMMAND_DONE_G);
    if (done > started) {
      pane.command = null;
      pane.agentCommand = false;
      pane.seen.clear();
      pane.scan = text.slice(done).slice(-SCAN_KEEP);
    } else if (reports.commands.length) {
      const command = reports.commands[reports.commands.length - 1];
      // An agent CLI typed in a shell prints URLs of servers it did not start.
      pane.agentCommand = runtimeFromCommandLine(command) !== null;
      pane.command = pane.agentCommand ? null : command;
      pane.seen.clear();
      pane.scan = text.slice(Math.max(started, 0)).slice(-SCAN_KEEP);
    } else {
      pane.scan = (pane.scan + text).slice(-SCAN_KEEP);
    }
    if (pane.pending) return;
    const next = findLocalUrls(completeLines(pane.scan)).find((found) => !pane.seen.has(found.port));
    if (!next) return;
    if (pane.seen.size >= MAX_SEEN_PORTS) pane.seen.clear();
    pane.seen.add(next.port);
    pane.pending = true;
    void confirm(paneId, pane, next.url, next.port)
      .catch(() => undefined)
      .finally(() => {
        pane.pending = false;
      });
  }

  /** Watches new panes and lets go of closed ones. */
  async function sync(): Promise<void> {
    const panes = await deps.listPanes();
    const live = new Set<string>();
    for (const pane of panes) {
      if (deps.isKeeperSession(pane.paneId)) continue;
      live.add(pane.paneId);
      if (watched.has(pane.paneId)) continue;
      const entry: Watched = {
        workspaceId: pane.workspaceId,
        agentPane: !!pane.profile && pane.profile !== "shell",
        cwd: pane.cwd ?? null,
        command: null,
        agentCommand: false,
        seen: new Set(),
        pending: false,
        carry: "",
        scan: "",
        off: () => undefined,
      };
      watched.set(pane.paneId, entry);
      entry.off = deps.tap(pane.paneId, (chunk) => onChunk(pane.paneId, entry, chunk));
      const recent = deps.recentOutput(pane.paneId);
      if (recent) onChunk(pane.paneId, entry, recent);
    }
    for (const [paneId, entry] of watched) {
      if (live.has(paneId)) continue;
      entry.off();
      watched.delete(paneId);
    }
  }

  function dispose(): void {
    for (const entry of watched.values()) entry.off();
    watched.clear();
  }

  return { sync, dispose, watchedCount: () => watched.size };
}
