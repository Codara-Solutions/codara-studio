// window.spark.terminalScrollback: the renderer side of
// src/main/terminal-scrollback.ts (each pane's output kept across restarts).

import { ipcRenderer } from "electron";

export interface TerminalScrollbackRestoreRequest {
  paneId: string;
  /** The pane's scrollback line limit; main never returns more. */
  maxLines?: number;
  /** Rows of the xterm the text goes into (Windows moves the replay above them). */
  rows?: number;
  /** Replay even if the pane already ran this session (agent hibernation). */
  force?: boolean;
}

export interface TerminalScrollbackReplay {
  /**
   * Lines with colors and CRLF endings, ending in a dim marker line. On
   * Windows it then moves them into the scrollback and the cursor to the top
   * left, where the new ConPTY session starts drawing.
   */
  text: string;
  savedAt: string;
}

export interface TerminalScrollbackUsage {
  files: number;
  bytes: number;
}

export const terminalScrollbackApi = {
  /** How much saved terminal output is on disk. */
  usage: (): Promise<TerminalScrollbackUsage> => ipcRenderer.invoke("terminalScrollback:usage"),
  /** Deletes all saved terminal output; returns what was removed. */
  clear: (): Promise<TerminalScrollbackUsage> => ipcRenderer.invoke("terminalScrollback:clear"),

  /**
   * The output a pane had before Codara restarted, to write into its xterm
   * before the PTY spawns. Null when there is none, the setting is off, or the
   * pane already has a live process.
   */
  restore: (request: TerminalScrollbackRestoreRequest): Promise<TerminalScrollbackReplay | null> =>
    ipcRenderer.invoke("terminalScrollback:restore", request),
};
