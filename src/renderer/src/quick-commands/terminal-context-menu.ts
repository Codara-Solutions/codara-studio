// The terminal's right-click hands off here before its own quick edit (copy
// the selection, otherwise paste). App's quick command host installs the
// handler; it opens the quick command menu and returns true when the click
// is a menu click (terminalRightClickAction), so the terminal itself does
// nothing more. Without a handler, as in a pane rendered outside App, the
// terminal keeps its quick edit.

export interface TerminalContextMenuRequest {
  /** The pane's session id (its leaf's paneId). */
  paneId: string;
  x: number;
  y: number;
  shiftKey: boolean;
  /** The terminal's selected text, empty when nothing is selected. */
  selection: string;
  /** A mirror pane that takes no input keeps its quick edit. */
  readOnly: boolean;
  copy: () => void;
  paste: () => void;
}

type Handler = (request: TerminalContextMenuRequest) => boolean;

let handler: Handler | null = null;

export function setTerminalContextMenuHandler(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

export function openTerminalContextMenu(request: TerminalContextMenuRequest): boolean {
  try {
    return handler?.(request) ?? false;
  } catch {
    return false;
  }
}
