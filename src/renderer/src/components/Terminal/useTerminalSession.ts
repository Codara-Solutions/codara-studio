import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ShellInfo } from "@shared/types";
import { detectMonoFontFamily } from "../../lib/fonts";
import { subscribeAppTokens } from "../../lib/theme-tokens";
import {
  registerCwdHandler,
  registerPromptTracker,
  registerSparkOpenHandler,
  type SparkOpenInput,
} from "./osc-handlers";
import { buildTerminalTheme } from "./terminalTheme";

export type { SparkOpenInput };

const FONT_SIZE = 13;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
// Module-level guard so a sessionId can only ever have one autorun scheduled.
// Survives component re-mounts (StrictMode dev, HMR) since the PTY itself
// persists past the renderer-side React tree. See the autorun block below.
const autorunFiredSessions = new Set<string>();
// Matches dev-server-style local URLs (vite, next dev, webpack, ...). Anchors
// on a word boundary so we do not capture substrings of longer paths. The
// `\x1b` exclusion stops ANSI escape bytes from being absorbed when a URL
// is followed immediately by a color reset sequence.
const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s\x1b]*)?/g;

interface Options {
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  sessionId: string;
  shell: ShellInfo;
  initialCwd?: string;
  initialScrollback?: string;
  // One-shot shell command auto-typed into the PTY once the shell prompt has
  // settled (rough heuristic: after spawn + ~1500ms). Used by the worker
  // entries in the in-pane add-pane menu to launch claude/codex without the
  // user typing the flags. Fires at most once per sessionId.
  initialCommand?: string;
  // Per-spawn env overrides forwarded to pty.spawn. Used to flip
  // SPARK_NO_SHELL_INTEGRATION=1 on worker panes so spark.ps1 returns
  // early (its PSReadLine Enter hook would otherwise echo the autorun
  // command as an OSC 633;E marker that the running TUI then reads as a
  // user prompt — see resources/shell-integration/spark.ps1:22).
  extraEnv?: Record<string, string>;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onCwd?: (cwd: string) => void;
  onDetectedLocalUrl?: (url: string) => void;
  onSparkOpen?: (input: SparkOpenInput) => void;
  // Fires on every PTY data chunk (input or output activity). Used by the
  // orchestration claim logic to decide whether a pane is "doing nothing"
  // and therefore safe to take over for a worker. Throttled implicitly by
  // PTY chunk rate; consumers should still debounce if they push to React.
  onActivity?: () => void;
  // Fires when the pane transitions in or out of an Ink-style TUI (claude /
  // codex). `running=true` is emitted on the first alt-screen-enter
  // (ESC[?1049h) of the session AND whenever a banner suggests a new
  // runtime has taken over; `running=false` is emitted on alt-screen-leave
  // (ESC[?1049l), which fires when the user Ctrl+Cs out and the TUI
  // restores the main screen. `runtime` is best-effort sniffed from
  // surrounding banner text; `null` means the TUI started but we couldn't
  // identify which one.
  onAgentState?: (state: { runtime: "claude" | "codex" | null; running: boolean }) => void;
}

export interface TerminalSessionApi {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
}

export function useTerminalSession({
  container,
  visible,
  sessionId,
  shell,
  initialCwd,
  initialScrollback,
  initialCommand,
  extraEnv,
  onSearchReady,
  onExit,
  onCwd,
  onDetectedLocalUrl,
  onSparkOpen,
  onActivity,
  onAgentState,
}: Options): TerminalSessionApi {
  const detectedRef = useRef<string | null>(null);
  // Latest-callback refs so the effect can run exactly once per `sessionId`
  // while still calling the freshest closures from the parent.
  const onDetectedRef = useRef(onDetectedLocalUrl);
  const onCwdRef = useRef(onCwd);
  const onExitRef = useRef(onExit);
  const onSearchReadyRef = useRef(onSearchReady);
  const onSparkOpenRef = useRef(onSparkOpen);
  const onActivityRef = useRef(onActivity);
  const onAgentStateRef = useRef(onAgentState);
  useEffect(() => {
    onDetectedRef.current = onDetectedLocalUrl;
    onCwdRef.current = onCwd;
    onExitRef.current = onExit;
    onSearchReadyRef.current = onSearchReady;
    onSparkOpenRef.current = onSparkOpen;
    onActivityRef.current = onActivity;
    onAgentStateRef.current = onAgentState;
  }, [onDetectedLocalUrl, onCwd, onExit, onSearchReady, onSparkOpen, onActivity, onAgentState]);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Holds the unsubscribe for the theme-token observer so we can refresh the
  // xterm color palette synchronously when the user toggles dark/light or
  // changes accent color.
  const themeUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    let spawned = false;
    let startupCommandHandled = false;

    // Defer one tick so a strict-mode mount → unmount → mount sequence cancels
    // the first spawn before it reaches main. Without this, dev rebuilds leak
    // a phantom PTY per HMR cycle.
    const startTimer = window.setTimeout(() => {
      if (disposed || !container.current) return;
      void start();
    }, 0);

    const start = async () => {
      if (disposed || !container.current) return;

      const term = new Terminal({
        fontFamily: detectMonoFontFamily(),
        fontSize: FONT_SIZE,
        lineHeight: 1.2,
        theme: buildTerminalTheme(),
        cursorBlink: false,
        cursorStyle: "bar",
        cursorInactiveStyle: "none",
        // 5k lines × 80 cols × ~16 B per cell ~= 6 MB per session. 10k doubled
        // that for output almost no one scrolls back to.
        scrollback: 5_000,
        allowProposedApi: true,
        allowTransparency: true,
        convertEol: false,
      });
      termRef.current = term;

      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);

      const search = new SearchAddon();
      term.loadAddon(search);

      term.loadAddon(
        new WebLinksAddon((_e, uri) => {
          // Routed through the preload's openExternal — Electron's shell.open
          // is the only hop that survives Chrome's external navigation block.
          void window.spark.openExternal?.(uri);
        }),
      );

      term.open(container.current);
      const restoredScrollback = initialScrollback?.trimEnd();
      if (restoredScrollback) {
        term.write(
          `${restoredScrollback}\r\n\x1b[2m[restored from last Spark session]\x1b[0m\r\n`,
        );
      }
      try {
        fit.fit();
      } catch {
        /* host may be 0×0 on first paint; ResizeObserver will fix it. */
      }

      const prompt = registerPromptTracker(term);
      cleanups.push(
        registerCwdHandler(term, (cwd) => onCwdRef.current?.(cwd)),
        registerSparkOpenHandler(term, (input) => onSparkOpenRef.current?.(input)),
        prompt.dispose,
      );
      onSearchReadyRef.current?.(search);

      // Keep the xterm theme in sync with Spark design tokens so dark/light
      // toggles (and accent color changes) repaint the terminal chrome live.
      themeUnsubRef.current = subscribeAppTokens(() => {
        if (termRef.current) termRef.current.options.theme = buildTerminalTheme();
      });

      // Per-session UTF-8 decoder so interleaved chunks across panes never
      // splice a multi-byte codepoint between unrelated streams.
      const urlDecoder = new TextDecoder("utf-8", { fatal: false });
      // Separate decoder for the agent-TUI sniffer so its stream state can't
      // interleave with the URL sniffer's.
      //
      // Phase machine:
      //   "idle"  → no agent running
      //   "agent" → a Claude / Codex CLI is in the foreground; running=true
      //             has been emitted. We stay here until an exit signal.
      //
      // Detection is multi-source because no single signal covers both
      // runtimes and both shell-integration states:
      //   - OSC 633;E (from spark.ps1's PSReadLine Enter hook) — instant
      //     detection the moment the user presses Enter on a claude/codex
      //     command line. Works for every shell with integration loaded
      //     (every pane except SPARK_NO_SHELL_INTEGRATION=1 autorun panes).
      //   - Banner text in the rolling buffer — covers autorun panes
      //     without shell integration. ANSI escapes are stripped before
      //     matching, because Ink positions individual characters with
      //     cursor moves between bytes, so the raw byte stream sees
      //     "Claude" interleaved with `\x1b[H` and a literal regex never
      //     matches.
      //   - alt-screen-leave (`ESC[?1049l`) — Codex's exit signal.
      //   - OSC 633;A (prompt start) — canonical "agent quit, pwsh prompt
      //     is back" signal. Works for any pane with integration loaded.
      //   - PTY exit — handled by onTerminalPaneExit in App.tsx (it nulls
      //     manual chips so they don't linger as stale "DONE" badges).
      const agentDecoder = new TextDecoder("utf-8", { fatal: false });
      let agentTextRing = "";
      let agentPhase: "idle" | "agent" = "idle";
      const setAgentRunning = (runtime: "claude" | "codex") => {
        if (agentPhase === "agent") return;
        agentPhase = "agent";
        onAgentStateRef.current?.({ runtime, running: true });
      };
      const resetAgentPhase = () => {
        if (agentPhase === "agent") {
          onAgentStateRef.current?.({ runtime: null, running: false });
        }
        agentPhase = "idle";
        agentTextRing = "";
      };
      const handleOsc633 = (data: string): boolean => {
        if (data.startsWith("E;")) {
          // Explicit command-line marker. spark.ps1 emits this with the
          // unescaped argv-joined line; we just need the first token to
          // recognise the runtime executable.
          const cmdLine = unescapeOsc633(data.slice(2));
          const exe = cmdLine
            .trim()
            .split(/\s+/)[0]
            ?.toLowerCase()
            .replace(/\.exe$/, "");
          if (exe === "claude" || exe?.endsWith("/claude") || exe?.endsWith("\\claude")) {
            setAgentRunning("claude");
          } else if (
            exe === "codex" ||
            exe?.endsWith("/codex") ||
            exe?.endsWith("\\codex")
          ) {
            setAgentRunning("codex");
          }
          return false;
        }
        // Any other 633 subcode (A=prompt start, B=prompt end, D=execution
        // finished, P=property update) is emitted by spark.ps1's Prompt
        // function — which only fires once pwsh is back at the read-line
        // state. So if we're in "agent" phase and ANY of these arrive, the
        // agent has quit and the shell prompt is showing again.
        if (data && !data.startsWith("C") && !data.startsWith("E")) {
          resetAgentPhase();
        }
        return false;
      };
      const osc633Dispose = term.parser.registerOscHandler(633, handleOsc633);
      cleanups.push(() => osc633Dispose.dispose());
      // FinalTerm OSC 133;A is the generic "prompt start" marker emitted by
      // spark.ps1 alongside 633;A. Treating it as a second source means a
      // missed or out-of-order 633 sequence doesn't strand the chip in
      // "running" forever.
      const osc133Dispose = term.parser.registerOscHandler(133, (data) => {
        if (data.startsWith("A")) resetAgentPhase();
        return false;
      });
      cleanups.push(() => osc133Dispose.dispose());

      const offData = window.spark.pty.onData(sessionId, (data) => {
        // Main ships Uint8Array. xterm.js's parser reassembles partial ANSI
        // sequences across writes when fed Uint8Array, which is what TUIs
        // (claude/codex/Ink) need to render cursor sequences without smearing.
        const bytes =
          data instanceof Uint8Array
            ? data
            : new TextEncoder().encode(String(data));
        term.write(bytes);
        onActivityRef.current?.();

        // URL sniffer. Byte-level prefilter (':' '/' '/') skips decode+regex
        // for the overwhelming majority of chunks (ordinary terminal output,
        // log tails, test runs).
        if (onDetectedRef.current && containsSchemeSeparator(bytes)) {
          const text = urlDecoder.decode(bytes, { stream: true });
          const matches = text.match(LOCAL_URL_RE);
          if (matches && matches.length > 0) {
            const url = stripTrailingPunct(matches[matches.length - 1]);
            if (url && url !== detectedRef.current) {
              detectedRef.current = url;
              onDetectedRef.current(url);
            }
          }
        }

        // Banner-text fallback for start detection + byte-level fallbacks
        // for exit detection. Belt-and-braces: if xterm's parser chain
        // doesn't dispatch our OSC 633/133 handlers for any reason, we
        // still catch the markers by scanning the raw byte stream.
        if (onAgentStateRef.current) {
          const chunkText = agentDecoder.decode(bytes, { stream: true });
          if (chunkText.length > 0) {
            agentTextRing = (agentTextRing + chunkText).slice(-8192);
          }
          if (agentPhase === "idle") {
            const runtime = sniffRuntime(agentTextRing);
            if (runtime) setAgentRunning(runtime);
          } else {
            // In agent phase. Watch for any of these and reset:
            //   - alt-screen-leave (Codex's exit signal)
            //   - OSC 633;A / 633;D / 633;B / 633;P (spark.ps1's Prompt)
            //   - OSC 133;A (generic FinalTerm prompt-start)
            // Also reset on byte-level matches as a parser-bypass safety
            // net, since xterm's OSC handler chain has caused us issues
            // before with code 633.
            if (
              chunkText.includes("\x1b[?1049l") ||
              hasPromptMarker(chunkText)
            ) {
              resetAgentPhase();
            }
          }
        }
      });
      const offExit = window.spark.pty.onExit(sessionId, (info) => {
        term.write(`\r\n\x1b[2m[process exited (${info.exitCode})]\x1b[0m\r\n`);
        term.options.disableStdin = true;
        onExitRef.current?.(info);
      });
      cleanups.push(offData, offExit);

      const inputDisposable = term.onData((data) => {
        void window.spark.pty.write(sessionId, data);
        onActivityRef.current?.();
      });
      cleanups.push(() => inputDisposable.dispose());

      // Spawn the PTY. We pass the pre-fit cols/rows so the shell starts at
      // the real visible size — without this, ConPTY paints at 80×24 then
      // reflows once the renderer reports the actual size, which the user
      // perceives as a flicker on first prompt.
      const cols = Math.max(1, term.cols);
      const rows = Math.max(1, term.rows);
      const cwd = initialCwd && initialCwd.trim().length > 0 ? initialCwd : "";
      try {
        const spawnResult = await window.spark.pty.spawn({
          id: sessionId,
          shell,
          cwd,
          cols,
          rows,
          env: extraEnv,
          startupCommand: initialCommand?.trim() || undefined,
        });
        if (disposed) {
          return;
        }
        spawned = true;
        startupCommandHandled = Boolean(spawnResult.startupCommandHandled);
        if (startupCommandHandled) autorunFiredSessions.add(sessionId);
      } catch (err) {
        term.write(`\r\n\x1b[31mfailed to spawn: ${(err as Error).message}\x1b[0m\r\n`);
        return;
      }

      // Two-stage debounce, ported from the terax design.
      //  - FIT runs on a tight (~one frame) timer so xterm visually keeps up
      //    with the window during drag. Local, no IPC.
      //  - PTY_RESIZE only fires on the trailing edge of the drag, because
      //    SIGWINCH is what makes shells / fancy prompts (powerlevel10k,
      //    starship) redraw mid-resize, which the user perceives as blinking.
      //    The shell only cares about the FINAL size.
      let lastSentCols = term.cols;
      let lastSentRows = term.rows;
      let lastW = container.current?.clientWidth ?? 0;
      let lastH = container.current?.clientHeight ?? 0;
      let fitTimer: number | null = null;
      let ptyTimer: number | null = null;

      const el = container.current;
      const flushPtyResize = () => {
        ptyTimer = null;
        if (disposed || !spawned) return;
        if (term.cols === lastSentCols && term.rows === lastSentRows) return;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        void window.spark.pty.resize(sessionId, term.cols, term.rows);
      };

      if (el) {
        const observer = new ResizeObserver(() => {
          if (fitTimer !== null) window.clearTimeout(fitTimer);
          fitTimer = window.setTimeout(() => {
            fitTimer = null;
            if (disposed) return;
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w === lastW && h === lastH) return;
            lastW = w;
            lastH = h;
            try {
              fit.fit();
            } catch {
              return;
            }
            if (ptyTimer !== null) window.clearTimeout(ptyTimer);
            ptyTimer = window.setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS);
          }, FIT_DEBOUNCE_MS);
        });
        observer.observe(el);
        cleanups.push(() => {
          observer.disconnect();
          if (fitTimer !== null) window.clearTimeout(fitTimer);
          if (ptyTimer !== null) window.clearTimeout(ptyTimer);
        });
      }

      // Initial size is now real — ship it once explicitly so the shell prompt
      // paints at the correct width on first render.
      try {
        fit.fit();
      } catch {
        /* host transitioned to display:none between mount and now */
      }
      if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        void window.spark.pty.resize(sessionId, term.cols, term.rows);
      }

      if (visible) term.focus();

      // One-shot autorun: type the requested command + CR into the PTY once
      // the shell has had a moment to render its first prompt. The 1500ms
      // delay matches src/main/orchestration/run-store.ts runWorkerSession —
      // anything shorter and on Windows ConPTY the keystrokes can land
      // before pwsh is ready to read, so the command appears to be eaten or
      // (when a TUI started in the meantime) gets typed INTO the TUI as a
      // prompt instead of running as a shell command.
      //
      // The autorunFiredSessions set guards against re-mounts (StrictMode in
      // dev, HMR, route changes) re-arming the timer for a sessionId that
      // already kicked off — the PTY persists across remounts, so a second
      // arming would type the command a second time after the first has
      // already launched the TUI. Once we commit to writing, we mark the id
      // permanently so no later remount can resurrect the timer.
      const cmd = initialCommand?.trim();
      if (cmd && cmd.length > 0 && !startupCommandHandled && !autorunFiredSessions.has(sessionId)) {
        const autorunTimer = window.setTimeout(() => {
          if (disposed) return;
          autorunFiredSessions.add(sessionId);
          void window.spark.pty.write(sessionId, `${cmd}\r`);
        }, 1500);
        cleanups.push(() => window.clearTimeout(autorunTimer));
      }
    };

    return () => {
      disposed = true;
      window.clearTimeout(startTimer);
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* best-effort */
        }
      }
      if (themeUnsubRef.current) {
        try {
          themeUnsubRef.current();
        } catch {
          /* ignore */
        }
        themeUnsubRef.current = null;
      }
      // Detach the renderer-side xterm from the PTY, but do not kill the
      // process. Terminal panes unmount during workspace switches and hidden
      // tab restoration; those are view lifecycle events, not user intent to
      // close the shell. Explicit close actions dispose the PTY in useTabs.
      try {
        termRef.current?.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useLayoutEffect(() => {
    if (!visible) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* host may be hidden during the transition */
    }
    termRef.current?.focus();
  }, [visible]);

  const write = useCallback((data: string) => {
    void window.spark.pty.write(sessionId, data);
  }, [sessionId]);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const getBuffer = useCallback((maxLines = 200): string | null => {
    const t = termRef.current;
    if (!t) return null;
    const buf = t.buffer.active;
    const total = buf.length;
    const lines: string[] = [];
    const start = Math.max(0, total - maxLines);
    for (let i = start; i < total; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }, []);

  const getSelection = useCallback((): string | null => {
    const sel = termRef.current?.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, []);

  return { write, focus, getBuffer, getSelection };
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,);\]]+$/, "");
}

// Looks for the literal byte sequence ":" "/" "/" — the cheapest signal that
// a chunk *might* contain a URL. Avoids per-chunk UTF-8 decode + regex scan
// when running noisy commands (build outputs, test runs, log tails).
function containsSchemeSeparator(bytes: Uint8Array): boolean {
  const n = bytes.length;
  for (let i = 0; i < n - 2; i++) {
    if (bytes[i] === 0x3a && bytes[i + 1] === 0x2f && bytes[i + 2] === 0x2f) {
      return true;
    }
  }
  return false;
}

// CSI / OSC stripper. Ink (Claude / Codex) often positions individual
// characters with cursor moves, so a banner like "Claude Code v2.1.139"
// arrives in the raw byte stream as `C\x1b[H l\x1b[H a…` and a literal
// regex against the unstripped text would never match. Stripping the
// escapes coalesces the characters back into a normal line.
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Identify which agent CLI is running by scanning a short rolling buffer of
// recent visible text. Patterns are specific enough to the live banners
// that ordinary shell output (file listings, commit messages, README
// content, `claude --help`) does NOT trigger them — only the actual
// launch banners do:
//   - Codex:  `OpenAI Codex (v0.130.0)`
//   - Claude: `Claude Code v2.1.139`
// Returns null when nothing matched so the caller leaves the pane alone.
function sniffRuntime(text: string): "claude" | "codex" | null {
  const stripped = text.replace(CSI_RE, "").replace(OSC_RE, "");
  if (/OpenAI Codex\s*\(?v?\d/.test(stripped)) return "codex";
  if (/Claude Code\s+v?\d/.test(stripped)) return "claude";
  return null;
}

// Reverse spark.ps1's __Spark-Esc encoding (control chars, ';' and '\'
// are emitted as `\xHH`). Best-effort: unknown escapes are passed through.
function unescapeOsc633(value: string): string {
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

// Detects any "shell is back at a prompt" boundary marker — both VS Code
// OSC 633 (A/B/D/P; deliberately NOT E or C which fire DURING command
// execution) and FinalTerm OSC 133;A. Matches the raw text so it works
// even if xterm's OSC handler chain dropped the dispatch on the floor.
const PROMPT_MARKER_RE = /\x1b\]633;[ABDP](?:;|\x07)|\x1b\]133;A(?:\x07|\x1b\\)/;
function hasPromptMarker(text: string): boolean {
  return PROMPT_MARKER_RE.test(text);
}
