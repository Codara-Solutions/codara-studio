import { Terminal } from "@xterm/headless";
import { classifyCodexScreen } from "@shared/agent-patterns";

// Retain terminal cells, not a concatenation of repaint bytes. A shimmer may
// update one letter or timer digit while the rest of the busy footer stays put.
export class CodexTerminalScreen {
  private readonly terminal: Terminal;
  private pending = 0;
  private disposed = false;
  private revision = 0;

  constructor(cols: number, rows: number, private readonly onIdleFrame?: () => void) {
    this.terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) return;
    const revision = this.revision;
    this.pending += 1;
    this.terminal.write(data, () => {
      if (revision !== this.revision) return;
      this.pending -= 1;
      if (this.readState() === "idle") this.onIdleFrame?.();
    });
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) this.terminal.resize(cols, rows);
  }

  state(): "working" | "idle" | null {
    if (this.disposed || this.pending > 0) return null;
    return this.readState();
  }

  private readState(): "working" | "idle" | null {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return classifyCodexScreen(lines.join("\n"));
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    this.terminal.dispose();
  }
}
