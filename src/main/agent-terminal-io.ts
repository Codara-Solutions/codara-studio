import { Terminal } from "@xterm/headless";
import { stripVTControlCharacters } from "node:util";
import { applyUnicode11Widths } from "@shared/terminal-unicode";

// Terminal reads and runs for the codara-studio MCP tools (terminal.read,
// terminal.run, terminal.list in agent-socket.ts). Kept free of Electron and
// pty-manager imports so it can be exercised against a fake pane.

export interface PaneIo {
  exists(paneId: string): boolean;
  readTail(paneId: string, maxBytes: number): Buffer | null;
  tap(paneId: string, handler: (chunk: Buffer) => void): () => void;
  onExit(paneId: string, handler: () => void): () => void;
  inject(paneId: string, text: string, opts: { submit: boolean }): void;
}

/**
 * Byte counters per pane, so an agent can poll "what is new since my last
 * read" with a number instead of re-reading and diffing the tail. A counter
 * starts the first time a pane is read; the cursor is only meaningful for the
 * pane and app session that issued it.
 */
export class PaneOutputCursors {
  private readonly counters = new Map<string, { total: number; dispose: () => void }>();

  constructor(private readonly io: PaneIo) {}

  current(paneId: string): number {
    const existing = this.counters.get(paneId);
    if (existing) return existing.total;
    const counter = { total: 0, dispose: () => undefined as void };
    const offTap = this.io.tap(paneId, (chunk) => {
      counter.total += chunk.length;
    });
    const offExit = this.io.onExit(paneId, () => this.forget(paneId));
    counter.dispose = () => {
      offTap();
      offExit();
    };
    this.counters.set(paneId, counter);
    return 0;
  }

  /**
   * The raw bytes written after `cursor`. The pane's ring buffer is finite, so
   * output older than it is reported as missedBytes rather than returned.
   */
  readSince(
    paneId: string,
    cursor: number,
    maxBytes: number,
  ): { bytes: Buffer; cursor: number; missedBytes: number; truncated: boolean } | null {
    const total = this.current(paneId);
    const wanted = cursor >= 0 && cursor <= total ? total - cursor : 0;
    if (wanted === 0) return { bytes: Buffer.alloc(0), cursor: total, missedBytes: 0, truncated: false };
    const requested = Math.min(wanted, maxBytes);
    const available = this.io.readTail(paneId, requested);
    if (available === null) return null;
    return {
      bytes: available,
      cursor: total,
      missedBytes: Math.max(0, requested - available.length),
      truncated: wanted > maxBytes,
    };
  }

  forget(paneId: string): void {
    const counter = this.counters.get(paneId);
    if (!counter) return;
    this.counters.delete(paneId);
    counter.dispose();
  }
}

/**
 * Plain text for an agent: escape sequences removed and carriage-return
 * rewrites (progress bars, spinners) collapsed to the text that stayed on
 * screen, which is what a person would have read.
 */
export function cleanTerminalText(raw: Buffer | string): string[] {
  const text = stripVTControlCharacters(typeof raw === "string" ? raw : raw.toString("utf8"));
  const lines = text.split("\n").map((line) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    const lastReturn = trimmed.lastIndexOf("\r");
    return applyBackspaces(lastReturn >= 0 ? trimmed.slice(lastReturn + 1) : trimmed);
  });
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Line editors redraw with backspaces, and bash prints the \x01/\x02 prompt
// delimiters of PS0 literally; neither belongs in text an agent reads.
function applyBackspaces(line: string): string {
  if (!/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) return line;
  const out: string[] = [];
  for (const char of line) {
    if (char === "\b") out.pop();
    else if (char === "\t" || (char >= " " && char !== "\x7f")) out.push(char);
  }
  return out.join("");
}

/**
 * Render raw pane bytes through a headless xterm and return the rows a person
 * would see. Full-screen programs (Claude Code, Codex, vim, top) repaint with
 * cursor moves, which a plain strip turns into overlapping garbage.
 */
export async function renderTerminalScreen(
  bytes: Buffer,
  cols: number,
  rows: number,
  lines: number,
): Promise<{ lines: string[]; altScreen: boolean }> {
  const terminal = new Terminal({
    cols: Math.max(20, Math.min(cols, 500)),
    rows: Math.max(5, Math.min(rows, 300)),
    scrollback: Math.max(0, lines),
    allowProposedApi: true,
  });
  applyUnicode11Widths(terminal);
  try {
    await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    const buffer = terminal.buffer.active;
    const out: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    return { lines: out.slice(-lines), altScreen: buffer.type === "alternate" };
  } finally {
    terminal.dispose();
  }
}

// OSC 133 (FinalTerm) and OSC 633 (VS Code) prompt markers, as printed by
// resources/shell-integration: C before a command runs, D;<exit> after it.
const SHELL_MARKER = /\x1b\](?:133|633);([ABCD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

export type ShellActivity = "running" | "idle" | null;

/** Whether the pane's shell last reported a running command or a prompt. */
export function shellActivity(tail: Buffer | null): ShellActivity {
  if (!tail || tail.length === 0) return null;
  const text = tail.toString("latin1");
  let last: string | null = null;
  SHELL_MARKER.lastIndex = 0;
  for (let match = SHELL_MARKER.exec(text); match; match = SHELL_MARKER.exec(text)) {
    last = match[1];
  }
  if (last === null) return null;
  return last === "C" ? "running" : "idle";
}

export interface RunInPaneOptions {
  timeoutMs: number;
  quietMs: number;
  maxLines: number;
  signal?: AbortSignal;
}

export interface RunInPaneResult {
  status: "exited" | "timeout" | "quiet" | "pane_exited" | "cancelled";
  exitCode: number | null;
  shellIntegration: boolean;
  durationMs: number;
  lines: number;
  truncated: boolean;
  output: string;
}

const RUN_CAPTURE_MAX_CHARS = 1024 * 1024;

/**
 * Type `command` into an idle shell and wait for it to finish. With shell
 * integration the shell's own exit marker ends the wait and supplies the exit
 * code; without it (another shell, an SSH session) the wait ends once output
 * has been quiet for quietMs. A timeout leaves the command running.
 */
export function runInPane(
  io: PaneIo,
  paneId: string,
  command: string,
  options: RunInPaneOptions,
): Promise<RunInPaneResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // latin1 keeps one char per byte, so marker offsets are byte offsets and a
    // multi-byte character split across chunks survives until the final decode.
    let captured = "";
    let dropped = false;
    let scanFrom = 0;
    let commandStart: number | null = null;
    let settled = false;
    let quietTimer: NodeJS.Timeout | null = null;

    const finish = (status: RunInPaneResult["status"], exitCode: number | null, end?: number) => {
      if (settled) return;
      settled = true;
      offTap();
      offExit();
      clearTimeout(deadline);
      if (quietTimer) clearTimeout(quietTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const body = captured.slice(commandStart ?? 0, end ?? captured.length);
      const all = cleanTerminalText(Buffer.from(body, "latin1"));
      const lines = all.slice(-options.maxLines);
      resolve({
        status,
        exitCode,
        shellIntegration: commandStart !== null,
        durationMs: Date.now() - startedAt,
        lines: lines.length,
        truncated: dropped || all.length > lines.length,
        output: lines.join("\n"),
      });
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (commandStart !== null) return;
      quietTimer = setTimeout(() => finish("quiet", null), options.quietMs);
    };

    const offTap = io.tap(paneId, (chunk) => {
      if (settled) return;
      captured += chunk.toString("latin1");
      if (captured.length > RUN_CAPTURE_MAX_CHARS) {
        const cut = captured.length - RUN_CAPTURE_MAX_CHARS;
        captured = captured.slice(cut);
        scanFrom = Math.max(0, scanFrom - cut);
        if (commandStart !== null) commandStart = Math.max(0, commandStart - cut);
        dropped = true;
      }
      // Re-scan a short overlap so a marker split across two chunks is found.
      SHELL_MARKER.lastIndex = Math.max(0, scanFrom - 64);
      for (let match = SHELL_MARKER.exec(captured); match; match = SHELL_MARKER.exec(captured)) {
        const end = match.index + match[0].length;
        if (end <= scanFrom) continue;
        if (match[1] === "C" && commandStart === null) {
          commandStart = end;
        } else if (match[1] === "D" && commandStart !== null && match.index >= commandStart) {
          const code = Number.parseInt(match[2] ?? "", 10);
          finish("exited", Number.isFinite(code) ? code : null, match.index);
          return;
        }
      }
      scanFrom = captured.length;
      armQuiet();
    });
    const offExit = io.onExit(paneId, () => finish("pane_exited", null));
    const deadline = setTimeout(() => finish("timeout", null), options.timeoutMs);
    const onAbort = () => finish("cancelled", null);
    if (options.signal?.aborted) {
      finish("cancelled", null);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    io.inject(paneId, command, { submit: true });
    armQuiet();
  });
}
