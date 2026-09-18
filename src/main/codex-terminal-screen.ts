import { Terminal } from "@xterm/headless";
import { classifyCodexScreen } from "@shared/agent-patterns";

// Retain terminal cells, not a concatenation of repaint bytes. A shimmer may
// update one letter or timer digit while the rest of the busy footer stays put.
export class CodexTerminalScreen {
  private readonly terminal: Terminal;
  private pending = 0;
  private disposed = false;
  private revision = 0;
  private completionRevision = 0;
  private completionPending = false;
  private completedFrame: string | null = null;

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

  markCompleted(): void {
    if (this.disposed) return;
    const revision = ++this.completionRevision;
    this.completionPending = true;
    // Completion can share a chunk with the final repaint. Capture after its
    // parser write, so that repaint cannot masquerade as the next turn.
    this.terminal.write("", () => {
      if (this.disposed || revision !== this.completionRevision) return;
      this.completedFrame = this.progressFrame();
      this.completionPending = false;
    });
  }

  hasProgressSinceCompletion(): boolean {
    return !this.disposed && this.pending === 0 && !this.completionPending &&
      this.completedFrame !== null && this.progressFrame() !== this.completedFrame;
  }

  private progressFrame(): string {
    // Composer sparkles and reflow are not evidence of another turn. Timer,
    // status and transcript changes are, even if no idle frame was observed.
    const lines = this.readFrame().split("\n");
    let composer = lines.length - 1;
    while (composer >= 0 && !/^\s*›/.test(lines[composer])) composer -= 1;
    return lines.slice(0, composer < 0 ? lines.length : composer)
      .join("\n").replace(/[\s⠁⠂⠄⠈⠐⠠⡀⢀]/g, "");
  }

  private readState(): "working" | "idle" | null {
    return classifyCodexScreen(this.readFrame());
  }

  private readFrame(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      // Cursor-addressed repaints can leave old transcript wrap flags on the
      // composer and footer rows. Keep the composer boundary even when xterm
      // still considers those cells part of an earlier wrapped paragraph.
      if (line.isWrapped && lines.length > 0 && !/^\s*›/.test(text) && !/^\s*›/.test(lines[lines.length - 1])) {
        lines[lines.length - 1] += text;
      } else lines.push(text);
    }
    return lines.join("\n");
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    this.terminal.dispose();
  }
}
