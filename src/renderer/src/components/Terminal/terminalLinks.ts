// What a click on a terminal link does, and what the link menu offers for it.
// Pure so the rules are testable without xterm or a window.

export type TerminalLinkClick = "menu" | "open" | "ignore";

export interface TerminalLinkClickInput {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** The link menu setting (on by default). */
  menuEnabled: boolean;
  /** Text was selected when the click ended: the user dragged, not clicked. */
  hasSelection: boolean;
}

export function resolveTerminalLinkClick(input: TerminalLinkClickInput): TerminalLinkClick {
  if (input.button !== undefined && input.button !== 0) return "ignore";
  // Ctrl+click on Windows and Linux, Cmd+click on a Mac, as in VS Code and
  // iTerm2. Either modifier is accepted everywhere, like file links, so a Mac
  // user on a Windows keyboard gets the same result.
  if (input.ctrlKey || input.metaKey) return "open";
  // xterm activates a link when the mouse goes down and up inside it, which a
  // drag selecting part of the URL also does.
  if (input.hasSelection) return "ignore";
  return input.menuEnabled ? "menu" : "open";
}

export type TerminalLinkActionId = "codara" | "system" | "copy";

export interface TerminalLinkAction {
  id: TerminalLinkActionId;
  label: string;
}

/**
 * The menu rows for a link. Web pages offer both browsers; a local file only
 * opens in Codara (handing a file to the system would run it); mail goes to
 * the system; anything else can only be copied, because main drops schemes
 * it does not know rather than launch an arbitrary handler.
 */
export function terminalLinkActions(url: string): TerminalLinkAction[] {
  const copy: TerminalLinkAction = { id: "copy", label: "Copy link" };
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    return [copy];
  }
  if (protocol === "http:" || protocol === "https:") {
    return [
      { id: "codara", label: "Open in Codara browser" },
      { id: "system", label: "Open in default browser" },
      copy,
    ];
  }
  if (protocol === "file:") return [{ id: "codara", label: "Open in Codara" }, copy];
  if (protocol === "mailto:") return [{ id: "system", label: "Open in mail app" }, copy];
  return [copy];
}

/** Long links are shortened in the middle so both the host and the end stay readable. */
export function shortenLinkForDisplay(url: string, max = 64): string {
  if (url.length <= max) return url;
  const keep = max - 3;
  const head = Math.ceil(keep * 0.6);
  return `${url.slice(0, head)}...${url.slice(url.length - (keep - head))}`;
}
