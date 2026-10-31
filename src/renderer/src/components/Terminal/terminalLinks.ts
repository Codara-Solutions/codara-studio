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

/**
 * Whether an OSC 8 hyperlink may be followed. Its visible text can be
 * anything while the target stays hidden, so only web pages and Codara's
 * own tab links are followed; a file or mail target behind innocent text is
 * not.
 */
export function followsHiddenTargetLink(uri: string): boolean {
  try {
    const protocol = new URL(uri).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "codara:";
  } catch {
    return false;
  }
}

export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

/**
 * The local file an OSC 8 `file://` hyperlink names (Claude Code prints its
 * markdown links to files this way), or null for anything else. The path is
 * percent-decoded, so a folder with spaces arrives exactly. A `#L12` or
 * `#L12C3` fragment, the form editors use, picks the line. A link to another
 * host names no file on this computer.
 */
export function fileLinkTarget(uri: string): FileLinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  if (url.hostname !== "" && url.hostname !== "localhost") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Windows: file:///C:/Users/x arrives as /C:/Users/x.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (!path || path.includes("\0")) return null;
  const fragment = /^#L(\d+)(?:C(\d+))?$/i.exec(url.hash);
  return {
    path,
    ...(fragment ? { line: Number(fragment[1]) } : {}),
    ...(fragment?.[2] ? { column: Number(fragment[2]) } : {}),
  };
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
