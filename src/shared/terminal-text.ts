// Text that Codara types into a terminal on someone's behalf. Much of it
// comes from a web page (an element's name and text, a page title, a
// selector) or from the clipboard, and it reaches an agent CLI's prompt as a
// bracketed paste (CSI 200~ ... CSI 201~). The wrap is all that keeps pasted
// text from running as typed keystrokes, so nothing inside it may end it.
// Pure string functions, imported by main and the renderer.

const PASTE_MARKER = /\x1b\[20[01]~/g;

/**
 * The text with every paste marker removed, NULs too (ConPTY corrupts them).
 * Markers are removed until none is left: one pass lets "\x1b[20\x1b[201~1~"
 * close up into a fresh end marker that ends the paste early.
 */
export function pasteBody(text: string): string {
  let body = text.replace(/\x00/g, "");
  for (let previous = ""; previous !== body; ) {
    previous = body;
    body = body.replace(PASTE_MARKER, "");
  }
  return body;
}

/** The bytes that hand text to a terminal program as one bracketed paste. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${pasteBody(text)}\x1b[201~`;
}

/**
 * The text without terminal control characters (C0, DEL and C1), so an
 * escape sequence from a page reads as text instead of acting on the
 * terminal. Line breaks become "\n"; tabs stay.
 */
export function plainTerminalText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
