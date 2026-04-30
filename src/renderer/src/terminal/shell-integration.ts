import type { Terminal as XTerm } from "@xterm/xterm";

// Spark Agent's shell-integration layer. Implements the public FinalTerm OSC
// 133 sequences and the VS Code OSC 633 extensions so we can group a shell's
// output into per-command blocks (Warp/Wave-style) without forking either.
//
// Specs: OSC 133 ; A | B | C | D [; <exit>] ST  (FinalTerm)
//        OSC 633 ; A | B | C | D [; <exit>] ST  (VS Code, identical semantics)
//        OSC 633 ; E ; <commandline> [; <nonce>] ST  (explicit commandline)
//        OSC 633 ; P ; <key>=<value> ST  (Cwd, IsWindows, ...)
//
// xterm's parser.registerOscHandler hands the data after the OSC identifier
// and ';' (e.g. "A", "D;0", "E;ls -la"). Returning true tells xterm we owned
// the sequence so it does not try to render it.

export type BlockStatus = "running" | "done" | "aborted";

export interface ShellBlock {
  id: number;
  command: string;
  status: BlockStatus;
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
  cwd?: string;
}

export interface ShellIntegrationState {
  blocks: ShellBlock[];
  altScreen: boolean;
  cwd?: string;
}

type Listener = (state: ShellIntegrationState) => void;

const ESC_HEX_RE = /\\x([0-9A-Fa-f]{2})/g;

// VS Code's OSC 633 ; E uses backslash-hex (\xAB) for ; and chars below 0x20.
function decodeCommandLine(value: string): string {
  return value.replace(ESC_HEX_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export class ShellIntegration {
  private readonly terminal: XTerm;
  private readonly listeners = new Set<Listener>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private blocks: ShellBlock[] = [];
  private nextId = 1;
  private currentCommand: string = "";
  private currentCwd?: string;
  private state: "idle" | "in_prompt" | "running" = "idle";
  private altScreen = false;

  constructor(terminal: XTerm) {
    this.terminal = terminal;
    this.attach();
  }

  private attach(): void {
    const t = this.terminal;
    const oscIds: Array<133 | 633> = [133, 633];
    for (const id of oscIds) {
      const d = t.parser.registerOscHandler(id, (data) => {
        this.handleOsc(id, data);
        return true;
      });
      this.disposables.push(d);
    }

    // Track alt-screen so the BlockStrip can collapse to a single "TUI session"
    // pill while Claude / Codex / vim hold the alternate buffer.
    this.altScreen = t.buffer.active.type === "alternate";
    const onCursorMove = t.onCursorMove(() => this.refreshAltScreen());
    this.disposables.push(onCursorMove);
  }

  private handleOsc(_oscId: 133 | 633, data: string): void {
    const semi = data.indexOf(";");
    const op = semi === -1 ? data : data.slice(0, semi);
    const rest = semi === -1 ? "" : data.slice(semi + 1);

    switch (op) {
      case "A":
        // Prompt start. Roll over from any in-flight running block whose D
        // marker we never received (e.g. shell crashed mid-command).
        if (this.state === "running") {
          this.finishCurrent(undefined, "aborted");
        }
        this.state = "in_prompt";
        return;

      case "B":
        // Prompt end. The user is now editing the command line.
        this.state = "in_prompt";
        return;

      case "C":
        // Pre-execution. Command was submitted, output is about to begin.
        this.startBlock();
        return;

      case "D": {
        const exit = rest.length > 0 ? parseInt(rest.split(";")[0], 10) : undefined;
        this.finishCurrent(Number.isFinite(exit) ? exit : undefined, "done");
        return;
      }

      case "E": {
        // Explicit commandline. We trust this over screen-scraped input.
        const [encoded] = rest.split(";");
        if (encoded) this.currentCommand = decodeCommandLine(encoded);
        return;
      }

      case "P": {
        // Property assignment. Only Cwd is interesting today.
        const eq = rest.indexOf("=");
        if (eq === -1) return;
        const key = rest.slice(0, eq);
        const value = rest.slice(eq + 1);
        if (key === "Cwd") this.currentCwd = value;
        return;
      }

      default:
        // Unknown subcommand — ignore but still claim ownership.
        return;
    }
  }

  private startBlock(): void {
    const block: ShellBlock = {
      id: this.nextId++,
      command: this.currentCommand.trim(),
      status: "running",
      startedAt: Date.now(),
      cwd: this.currentCwd,
    };
    this.blocks = [...this.blocks, block];
    this.currentCommand = "";
    this.state = "running";
    this.emit();
  }

  private finishCurrent(exitCode: number | undefined, status: BlockStatus): void {
    const last = this.blocks[this.blocks.length - 1];
    if (!last || last.status !== "running") {
      this.state = "idle";
      return;
    }
    const updated: ShellBlock = {
      ...last,
      status,
      exitCode,
      finishedAt: Date.now(),
    };
    this.blocks = [...this.blocks.slice(0, -1), updated];
    this.state = "idle";
    this.emit();
  }

  private refreshAltScreen(): void {
    const next = this.terminal.buffer.active.type === "alternate";
    if (next === this.altScreen) return;
    this.altScreen = next;
    this.emit();
  }

  getState(): ShellIntegrationState {
    return {
      blocks: this.blocks,
      altScreen: this.altScreen,
      cwd: this.currentCwd,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.getState();
    for (const l of this.listeners) l(state);
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
    this.listeners.clear();
  }
}
