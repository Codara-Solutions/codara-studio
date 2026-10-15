// OSC 52: a program in the terminal asks the terminal to put text on the
// system clipboard. It is how a yank in tmux or Neovim, or a copy made on a
// machine reached over SSH, gets to the clipboard of the computer in front of
// the user. xterm.js does not implement it; this module decides what to do
// with each request, and terminalClipboard.ts wires it to a pane.
//
// Wire format, after xterm strips the leading ESC ] 52 ; and the BEL or ST:
//
//     <targets> ; <base64 text>
//
// <targets> is zero or more of c (clipboard), p (primary), q (secondary),
// s (selection) and 0-7 (cut buffers); tmux sends none at all. Every target
// lands on the one system clipboard. A payload of "?" asks the terminal to
// send the clipboard back to the program: that is never answered, because
// any process that can print to the pane (a log line, a file being cat'ed, a
// remote host) would then read whatever the user copied last.
//
// Writes are the classic clipboard-overwrite vector too, so the caller only
// lets one through for live output of a pane the user can see and type into
// (see blockedBy), and a setting turns them off altogether.

/** Base64 characters accepted in one request: about 768 KB of text. */
export const OSC52_MAX_BASE64_CHARS = 1024 * 1024;

export type Osc52Request =
  | { kind: "write"; text: string }
  /** The program asked to read the clipboard. Never answered. */
  | { kind: "query" }
  /** An empty payload, which xterm reads as "clear the selection". Declined. */
  | { kind: "clear" }
  | { kind: "too-large"; base64Chars: number }
  | { kind: "invalid" };

const TARGETS = /^[cpqs0-7]*$/;

export function parseOsc52(
  data: string,
  maxBase64Chars: number = OSC52_MAX_BASE64_CHARS,
): Osc52Request {
  const separator = data.indexOf(";");
  if (separator === -1) return { kind: "invalid" };
  if (!TARGETS.test(data.slice(0, separator))) return { kind: "invalid" };
  const payload = data.slice(separator + 1);
  if (payload === "?") return { kind: "query" };
  // Measured before decoding, so a flood never costs more than this check.
  if (payload.length > maxBase64Chars) {
    return { kind: "too-large", base64Chars: payload.length };
  }
  const text = decodeBase64Text(payload);
  if (text === null) return { kind: "invalid" };
  if (text === "") return { kind: "clear" };
  return { kind: "write", text };
}

function decodeBase64Text(payload: string): string | null {
  // Some programs wrap long payloads; whitespace is not part of the data.
  const compact = payload.replace(/[\t\n\v\f\r ]+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // NUL ends the string in some native clipboard APIs, cutting the copy short.
  return new TextDecoder("utf-8").decode(bytes).replace(/\0/g, "");
}

/**
 * Why a request must not reach the clipboard right now:
 * - "unknown": the setting has not loaded yet
 * - "disabled": the user turned the setting off
 * - "replay": the bytes are history being written back into a rebuilt pane,
 *   not something a program just asked for
 * - "background": the pane is not on screen
 * - "mirror": a second view of a terminal, or one the user cannot type into
 */
export type Osc52Block = "unknown" | "disabled" | "replay" | "background" | "mirror";

export interface Osc52HandlerDeps {
  /** Null lets the request through. Read once per request, at parse time. */
  blockedBy: () => Osc52Block | null;
  writeText: (text: string) => Promise<void> | void;
  /** A real copy was refused because the setting is off. */
  onDisabled?: () => void;
  /** A copy the user could have wanted was over the size cap. */
  onTooLarge?: (base64Chars: number) => void;
  maxBase64Chars?: number;
}

/**
 * An xterm OSC 52 handler. It always returns true: the sequence is consumed
 * either way and nothing of it is drawn.
 *
 * A burst of requests in one parse pass collapses to the last one. Each
 * request is a dozen bytes, so one chunk of output can carry thousands, and
 * only the last would survive on the clipboard anyway.
 */
export function createOsc52Handler(deps: Osc52HandlerDeps): (data: string) => boolean {
  let pending: string | null = null;
  const flush = () => {
    const text = pending;
    pending = null;
    if (text === null) return;
    try {
      void Promise.resolve(deps.writeText(text)).catch(() => undefined);
    } catch {
      /* the clipboard bridge is best effort, like every other copy */
    }
  };
  return (data) => {
    const block = deps.blockedBy();
    if (block === "unknown" || block === "replay" || block === "background" || block === "mirror") {
      return true;
    }
    const request = parseOsc52(data, deps.maxBase64Chars);
    if (request.kind === "write") {
      if (block === "disabled") {
        deps.onDisabled?.();
        return true;
      }
      if (pending === null) queueMicrotask(flush);
      pending = request.text;
    } else if (request.kind === "too-large" && block !== "disabled") {
      deps.onTooLarge?.(request.base64Chars);
    }
    return true;
  };
}

/**
 * Brackets writes of replayed history so OSC 52 requests inside them are
 * dropped. xterm parses writes in order and runs each write's callback right
 * after its bytes, so empty writes queued around the history raise and lower
 * the depth exactly while those bytes are parsed, whatever else is queued.
 */
export function writeAsReplay(
  term: { write(data: string | Uint8Array, callback?: () => void): void },
  depth: { current: number },
  write: () => void,
): void {
  term.write("", () => {
    depth.current += 1;
  });
  try {
    write();
  } finally {
    term.write("", () => {
      depth.current = Math.max(0, depth.current - 1);
    });
  }
}
