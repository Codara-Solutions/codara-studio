import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ShellInfo } from "@shared/types";
import {
  useTerminalSession,
  type SparkOpenInput,
} from "./useTerminalSession";

// TerminalPane wraps a single xterm pane in a forwardRef component so the
// parent strip can imperatively `write`, `focus`, copy the visible buffer,
// or read the current selection — useful for paste-into-terminal UX, tests,
// and reusing a pane to bootstrap a new agent worker.
//
// Visibility is controlled by the parent: hidden panes stay mounted (so the
// PTY survives tab switches) but get visibility:hidden + pointer-events:none
// so they can't accidentally steal focus from the active pane.

export interface TerminalPaneHandle {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
}

interface Props {
  sessionId: string;
  shell: ShellInfo;
  visible: boolean;
  scrollbackLineLimit: number;
  initialCwd?: string;
  initialScrollback?: string;
  initialCommand?: string;
  extraEnv?: Record<string, string>;
  // Mirror-pane mode. When true the xterm attaches to the PTY's data stream
  // (so output renders) but the pane does NOT forward keystrokes or send
  // pty.resize calls. Use when a second pane needs to observe the same PTY
  // whose canonical xterm is mounted in TerminalStack — without this, two
  // ResizeObservers race and the smaller cols/rows wins, garbling the
  // canonical pane's display.
  readOnly?: boolean;
  // Input-only mirror. Forwards no keystrokes (like readOnly) but DOES send
  // pty.resize calls. Use when this is the only view of the PTY (e.g. the
  // chat panel's backend-terminal tab) so the PTY tracks the xterm's actual
  // dimensions instead of staying at a tiny default size.
  inputBlocked?: boolean;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onSparkOpen?: (input: SparkOpenInput) => void;
  onActivity?: () => void;
  onUserInput?: () => void;
  onAgentState?: (state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean }) => void;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      sessionId,
      shell,
      visible,
      scrollbackLineLimit,
      initialCwd,
      initialScrollback,
      initialCommand,
      extraEnv,
      readOnly,
      inputBlocked,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
      onUserInput,
      onAgentState,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);

    const session = useTerminalSession({
      container: containerRef,
      visible,
      sessionId,
      shell,
      scrollbackLineLimit,
      initialCwd,
      initialScrollback,
      initialCommand,
      extraEnv,
      readOnly,
      inputBlocked,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
      onUserInput,
      onAgentState,
    });

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    return (
      <div
        ref={containerRef}
        className="xterm-host"
        style={{
          display: "flex",
          flex: 1,
          alignSelf: "stretch",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
        onMouseDown={() => {
          // Defer to the next microtask so xterm's own click-to-position
          // selection logic runs first. Without this, the focus call
          // collapses the click into a single-cell selection.
          queueMicrotask(() => session.focus());
        }}
      />
    );
  },
);
