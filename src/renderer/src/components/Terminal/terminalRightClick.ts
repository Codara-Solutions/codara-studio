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
// stands down for xterm.js (terminalVersion.ts), which is why the press is
// withheld rather than Codara's own paste: the paste must come from Codara
// for both. Shift+right-click (Option+right-click on a Mac with
// macOptionClickForcesSelection) is never reported by xterm anyway.

type RightClickTerminal = Pick<Terminal, "modes" | "options" | "getSelection" | "clearSelection" | "focus">;

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

// A capture-phase `mousedown` listener on the element that holds xterm's: it
// runs before xterm's own listener and keeps a right press xterm would report
// from reaching the program. xterm registers its release and drag reporting
// only from a reported press, so the rest of the click is withheld with it.
// Everything xterm's listener would otherwise do for a right press is to
// cancel the default and take focus.
export function createTerminalRightPressGuard(
  options: Pick<TerminalRightClickOptions, "getTerminal" | "isMac">,
): (event: MouseEvent) => void {
  return (event) => {
    if (event.button !== 2) return;
    const term = options.getTerminal();
    if (!term || !rightClickReachesProgram(term, event, options.isMac)) return;
    event.stopPropagation();
    event.preventDefault();
    term.focus();
  };
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
