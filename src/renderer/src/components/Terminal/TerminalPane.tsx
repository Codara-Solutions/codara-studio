import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  RuntimeState,
  ShellInfo,
  TerminalAgentForegroundState,
} from "@shared/types";
import {
  useTerminalSession,
  type SparkOpenInput,
} from "./useTerminalSession";
import type { TerminalAgentSession } from "../../tabs/types";

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

// Codara's intro is renderer-only: never write it into xterm or the PTY. That
// keeps shell cursor state, SSH sessions, agent TUIs, and scrollback untouched.
const CODARA_TERMINAL_INTRO = String.raw` ██████╗ ██████╗ ██████╗  █████╗ ██████╗  █████╗
██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗
██║     ██║   ██║██║  ██║███████║██████╔╝███████║
██║     ██║   ██║██║  ██║██╔══██║██╔══██╗██╔══██║
╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║  ██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝`;
const introShownSessions = new Set<string>();
const INTRO_HOLD_MS = 1_800;
const INTRO_FADE_MS = 400;

interface Props {
  sessionId: string;
  shell: ShellInfo;
  visible: boolean;
  scrollbackLineLimit: number;
  initialCwd?: string;
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
  // pty.resize calls. Use when this pane owns the PTY's dimensions: the only
  // view of the PTY (e.g. the chat panel's backend-terminal tab) or the
  // canonical pane of a watch-only surface (the automation Workers grid). All
  // other canonical duties (raw-tail replay, runtime-state reports) are kept.
  inputBlocked?: boolean;
  // Raw-tail reattach mode. Opt-in, default off — only ChatPanel's backend
  // terminal sets it. Makes every re-attach behave like the first attach
  // (unmount → pty.detach, remount → replay main's raw pty tail) so a live Ink
  // TUI reattaches cleanly instead of garbling under a flattened-text snapshot
  // replay. See the option's WHY-comment in useTerminalSession.ts.
  rawTailReattach?: boolean;
  // Write PTY bytes into xterm even while hidden. Opt-in, default off. Used by
  // persistent live-TUI hosts and normal workspace terminals whose rendered
  // buffer must remain immediately ready across tab/workspace switches.
  writeWhileHidden?: boolean;
  // Decorative renderer-only intro for ordinary Codara shell panes. Other
  // terminal hosts omit it so worker/backend/mirror TUIs stay unobstructed.
  showCodaraIntro?: boolean;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onSparkOpen?: (input: SparkOpenInput) => void;
  onActivity?: () => void;
  onUserInput?: () => void;
  onAgentState?: (state: TerminalAgentForegroundState) => void;
  // Forwarded straight to useTerminalSession: fires when the live-state poller
  // confirms a new RuntimeState (working / blocked / idle / done) for the
  // foreground agent. Lets the owning stack surface the finer state on a chip.
  onRuntimeState?: (state: RuntimeState) => void;
  // Durable Claude/Codex session pointer for this pane; drives capture (fresh
  // Codex) and restore (reopened panes). See useTerminalSession.
  agentSession?: TerminalAgentSession | null;
  // One-shot hydration marker: true only on the pane's first mount after app
  // boot when its agent was running at quit. Gates the restore in
  // useTerminalSession; consumed via onBootResumeConsumed.
  bootResume?: boolean;
  onResumeUnavailable?: () => void;
  // Fires when a failed Claude restore self-heals into a fresh forced-id
  // session so the owner can persist the replacement pointer.
  onResumeFallback?: (session: TerminalAgentSession) => void;
  // Fires once the boot restore was attempted (any outcome) so the owner can
  // clear the leaf's `bootResume` marker.
  onBootResumeConsumed?: () => void;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      sessionId,
      shell,
      visible,
      scrollbackLineLimit,
      initialCwd,
      initialCommand,
      extraEnv,
      readOnly,
      inputBlocked,
      rawTailReattach,
      writeWhileHidden,
      showCodaraIntro = false,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
      onUserInput,
      onAgentState,
      onRuntimeState,
      agentSession,
      bootResume,
      onResumeUnavailable,
      onResumeFallback,
      onBootResumeConsumed,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const introEligible =
      showCodaraIntro &&
      !readOnly &&
      !inputBlocked &&
      !rawTailReattach &&
      !initialCommand;
    const [introState, setIntroState] = useState<"hidden" | "visible" | "fading">(
      "hidden",
    );
    const showIntro = useCallback(() => {
      if (introEligible) setIntroState("visible");
    }, [introEligible]);
    const dismissIntro = useCallback(() => {
      setIntroState((current) => (current === "visible" ? "fading" : current));
    }, []);

    useEffect(() => {
      if (!introEligible) setIntroState("hidden");
    }, [introEligible]);

    useEffect(() => {
      if (!visible || !introEligible || introShownSessions.has(sessionId)) return;
      introShownSessions.add(sessionId);
      setIntroState("visible");
    }, [introEligible, sessionId, visible]);

    useEffect(() => {
      if (introState !== "visible") return;
      const fadeTimer = window.setTimeout(() => setIntroState("fading"), INTRO_HOLD_MS);
      return () => window.clearTimeout(fadeTimer);
    }, [introState]);

    useEffect(() => {
      if (introState !== "fading") return;
      const hideTimer = window.setTimeout(() => setIntroState("hidden"), INTRO_FADE_MS);
      return () => window.clearTimeout(hideTimer);
    }, [introState]);

    const handleUserInput = useCallback(() => {
      dismissIntro();
      onUserInput?.();
    }, [dismissIntro, onUserInput]);

    const session = useTerminalSession({
      container: containerRef,
      visible,
      sessionId,
      shell,
      scrollbackLineLimit,
      initialCwd,
      initialCommand,
      extraEnv,
      readOnly,
      inputBlocked,
      rawTailReattach,
      writeWhileHidden,
      onSearchReady,
      onExit,
      onCwd,
      onDetectedLocalUrl,
      onSparkOpen,
      onActivity,
      onClear: showIntro,
      onUserInput: handleUserInput,
      onAgentState,
      onRuntimeState,
      agentSession,
      bootResume,
      onResumeUnavailable,
      onResumeFallback,
      onBootResumeConsumed,
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
        className="codara-terminal-session"
        style={{
          display: "flex",
          flex: 1,
          alignSelf: "stretch",
          position: "relative",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
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
          }}
          onMouseDown={() => {
            dismissIntro();
            // Defer to the next microtask so xterm's own click-to-position
            // selection logic runs first. Without this, the focus call
            // collapses the click into a single-cell selection.
            queueMicrotask(() => session.focus());
          }}
        />
        {introState !== "hidden" ? (
          <pre
            aria-hidden="true"
            className={`codara-terminal-intro${introState === "fading" ? " is-fading" : ""}`}
            data-testid="codara-terminal-intro"
          >
            {CODARA_TERMINAL_INTRO}
          </pre>
        ) : null}
      </div>
    );
  },
);
