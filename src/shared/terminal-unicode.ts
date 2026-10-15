import { Unicode11Addon } from "@xterm/addon-unicode11";

// xterm.js measures characters with Unicode 6 width tables unless told
// otherwise, so an emoji or any symbol newer than 2010 takes one cell where
// Claude Code, Codex, nvim and tmux reserved two, and everything after it on
// the row lands one column early: borders break and status lines overlap.
// Version 11 is what the add-on built for this xterm release provides, and its
// widths match those programs closely enough for their layouts to line up.
//
// Widths are fixed into the buffer as bytes are parsed, so this must run
// before the first write: a restored snapshot written under the old tables
// keeps the old widths. The headless terminals in main use it too, so a
// screen read by an agent wraps where the user's pane does.

export interface UnicodeWidthTerminal {
  loadAddon(addon: Unicode11Addon): void;
  readonly unicode: { activeVersion: string };
}

export const TERMINAL_UNICODE_VERSION = "11";

export function applyUnicode11Widths(terminal: UnicodeWidthTerminal): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
