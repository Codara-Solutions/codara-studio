import type { Terminal } from "@xterm/xterm";
import xtermPackage from "@xterm/xterm/package.json";

// XTVERSION (CSI > q): a program asks the terminal for its name and version.
// The xterm.js Codara ships does not answer it, so programs cannot tell they
// run in xterm.js.
//
// That silence pasted twice. Claude Code's full-screen mode reports the
// mouse, and on Linux and Windows it pastes the clipboard itself on a
// right-click unless the terminal is VS Code's or answers XTVERSION with a
// name starting "xterm.js": those paste on a right-click already, as Codara
// does (useTerminalSession.ts). So one right-click pasted once from Codara
// and once from Claude Code.

export const XTVERSION_REPLY = `\x1bP>|xterm.js(${xtermPackage.version})\x1b\\`;

export interface XtversionPane {
  /** True when this pane must not answer: a mirror, or replayed history. */
  silent: () => boolean;
  send: (reply: string) => void;
}

type ParserTerminal = Pick<Terminal, "parser">;

export function registerXtversionReply(term: ParserTerminal, pane: XtversionPane): () => void {
  const disposable = term.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
    // CSI > 0 q and CSI > q ask; any other parameter is not this query.
    if (params.length > 1 || (params.length === 1 && params[0] !== 0)) return true;
    if (!pane.silent()) pane.send(XTVERSION_REPLY);
    return true;
  });
  return () => disposable.dispose();
}
