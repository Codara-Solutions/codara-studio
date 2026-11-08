import type { Terminal } from "@xterm/xterm";
import { openTerminalContextMenu } from "../../quick-commands/terminal-context-menu";

// Native-terminal right-click: copy the current selection if one exists,
// otherwise paste from the clipboard. Matches ConHost / Windows Terminal
// "quick-edit". The OS context menu is always suppressed so the click is
// consumed entirely by the terminal.
//
// The right button belongs to Codara. A program that turned mouse reporting
// on (DECSET 1000/1002/1003) would otherwise also get the press from xterm,
// and the Codex TUI pastes the clipboard itself when it does (it only stands
// down for TERM_PROGRAM=vscode), so one click pasted twice. Claude Code
// stands down for xterm.js (terminalVersion.ts), which is why the report is
// withheld rather than Codara's own paste: the paste must come from Codara
// for both. A report with modifiers is withheld too: Shift+right-click is
// Codara's menu (and is not reported at all off a Mac).

type RightClickTerminal = Pick<Terminal, "getSelection" | "clearSelection">;

export interface TerminalRightClickOptions {
  paneId: string;
  getTerminal: () => RightClickTerminal | null;
  isReadOnly: () => boolean;
  writeClipboard: (text: string) => void;
  paste: () => void;
}

// The report is dropped on its way to the PTY rather than by stopping the
// DOM event: the press still has to reach the pane's ancestors (activating
// the pane, closing popovers) and xterm's own focus handling. xterm sends one
// report per onData call, and only right presses, drags and releases carry
// button 2; wheel (64) and extra buttons (128) are other bits. The default
// X10 encoding goes through onBinary, which Codara never forwards.
const SGR_MOUSE_REPORT = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

export function isRightButtonReport(data: string): boolean {
  const match = SGR_MOUSE_REPORT.exec(data);
  return match !== null && (Number(match[1]) & 0b1100_0011) === 2;
}

export function createTerminalRightClickHandler(
  options: TerminalRightClickOptions,
): (event: MouseEvent) => void {
  return (event) => {
    event.preventDefault();
    const term = options.getTerminal();
    if (!term) return;
    const selection = term.getSelection();
    const copySelection = () => {
      if (!selection) return;
      options.writeClipboard(selection);
      term.clearSelection();
    };
    // Shift+right-click (or a plain one, by preference) opens the quick
    // command menu instead; see quick-commands/terminal-context-menu.ts.
    if (
      openTerminalContextMenu({
        paneId: options.paneId,
        x: event.clientX,
        y: event.clientY,
        shiftKey: event.shiftKey,
        selection,
        readOnly: options.isReadOnly(),
        copy: copySelection,
        paste: options.paste,
      })
    ) {
      return;
    }
    if (selection) {
      copySelection();
      return;
    }
    options.paste();
  };
}
