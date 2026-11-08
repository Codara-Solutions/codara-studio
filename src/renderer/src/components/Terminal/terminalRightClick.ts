import type { Terminal } from "@xterm/xterm";
import { openTerminalContextMenu } from "../../quick-commands/terminal-context-menu";

// Native-terminal right-click: copy the current selection if one exists,
// otherwise paste from the clipboard. Matches ConHost / Windows Terminal
// "quick-edit". The OS context menu is always suppressed so the click is
// consumed entirely by the terminal.
//
// A program that turned mouse reporting on (DECSET 1000/1002/1003, as the
// Codex TUI and Claude Code's fullscreen renderer do) already receives the
// right-click from xterm as a mouse report, and both paste the clipboard
// themselves when they get it. Pasting here as well delivered the clipboard
// twice, so a right-click the program received is left to the program, as
// in a native terminal. Shift+right-click (Option+right-click on a Mac with
// macOptionClickForcesSelection) is never reported and still pastes here.

type RightClickTerminal = Pick<Terminal, "modes" | "options" | "getSelection" | "clearSelection">;

// Mirrors xterm 5.5's mousedown gate (Terminal.bindMouse and
// SelectionService.shouldForceSelection): a press is reported whenever mouse
// tracking is on, unless the modifier that forces a local selection is held.
export function rightClickReachesProgram(
  term: Pick<Terminal, "modes" | "options">,
  event: Pick<MouseEvent, "shiftKey" | "altKey">,
  isMac: boolean,
): boolean {
  if ((term.modes.mouseTrackingMode ?? "none") === "none") return false;
  const forcesSelection = isMac
    ? event.altKey && term.options.macOptionClickForcesSelection === true
    : event.shiftKey;
  return !forcesSelection;
}

export interface TerminalRightClickOptions {
  paneId: string;
  getTerminal: () => RightClickTerminal | null;
  isReadOnly: () => boolean;
  isMac: boolean;
  writeClipboard: (text: string) => void;
  paste: () => void;
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
    if (rightClickReachesProgram(term, event, options.isMac)) return;
    options.paste();
  };
}
