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
  initialCwd?: string;
  initialCommand?: string;
  extraEnv?: Record<string, string>;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onSparkOpen?: (input: SparkOpenInput) => void;
  onActivity?: () => void;
  onAgentState?: (state: { runtime: "claude" | "codex" | null; running: boolean }) => void;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      sessionId,
      shell,
      visible,
      initialCwd,
      initialCommand,
      extraEnv,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
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
      initialCwd,
      initialCommand,
      extraEnv,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
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
          width: "100%",
          height: "100%",
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
