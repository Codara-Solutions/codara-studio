// Main's side of the rail's Agents view: the terminal notifier's per-pane
// activity, completed with the CLI account each pane was started on, and the
// coalesced "changed" ping (agent-board-signal.ts) sent to the window.
// Cora runs need nothing from here: the renderer already holds every run.

import type { TerminalAgentActivity } from "@shared/agent-board";
import type { IpcHandle } from "./ipc";
import { onAgentBoardChanged } from "./agent-board-signal";
import { activeWindow } from "./notify/deliver";
import * as pty from "./pty-manager";
import { terminalAgentActivitySnapshot } from "./terminal-agent-notify";

function accountProfileId(entry: TerminalAgentActivity): string | null {
  if (entry.runtime === "claude") return pty.nativeClaudeProfileId(entry.paneId) ?? null;
  if (entry.runtime === "codex") return pty.nativeCodexProfileId(entry.paneId) ?? null;
  if (entry.runtime === "grok") return pty.nativeGrokProfileId(entry.paneId) ?? null;
  return null;
}

export function agentBoardActivity(): TerminalAgentActivity[] {
  return terminalAgentActivitySnapshot().map((entry) => ({
    ...entry,
    accountProfileId: accountProfileId(entry),
  }));
}

export function registerAgentBoardIpc(handle: IpcHandle): void {
  handle("agentBoard:activity", async () => agentBoardActivity());
  onAgentBoardChanged(() => {
    const win = activeWindow();
    if (!win || win.webContents.isDestroyed()) return;
    win.webContents.send("agent-board:changed");
  });
}
