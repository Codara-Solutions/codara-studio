import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
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
const RESTORE_NOTICE = "[restored from last Spark session]";

// Internal-only union of every agent CLI we can detect from terminal output.
// Spark's public surface (App.tsx, TerminalStack.tsx, run-store, etc.) still
// only models the three first-party runtimes — anything outside that set is
// coerced to `null` at the onAgentState boundary so the UI accent / tab-type
// machinery doesn't need to grow new cases for each new banner we recognise.
// Detection is still useful even when coerced: the running=true edge fires,
// which is enough to keep the activity indicator in sync.
type AgentRuntime =
  | "claude"
  | "codex"
  | "cursor"
  | "aider"
  | "droid"
  | "amp"
  | "opencode"
  | "grok"
  | "hermes"
  | "pi"
  | "antigravity"
  | "kimi"
  | "kiro"
  | "copilot"
  | "cline";

// Public runtime tag emitted through onAgentState. Mirrors the three runtimes
// the rest of the app already knows how to render. The boundary in
// useTerminalSession coerces every other AgentRuntime down to `null`.
type PublicAgentRuntime = "claude" | "codex" | "cursor";

const KNOWN_PUBLIC_RUNTIMES: ReadonlySet<AgentRuntime> = new Set([
  "claude",
  "codex",
  "cursor",
]);

function coercePublicRuntime(runtime: AgentRuntime): PublicAgentRuntime | null {
  return KNOWN_PUBLIC_RUNTIMES.has(runtime) ? (runtime as PublicAgentRuntime) : null;
}

// Banner / first-prompt boilerplate patterns. Order is significant: more
// specific patterns sit before broader ones so a vendor that includes a
// generic keyword (e.g. "Grok") in their banner can't be mis-tagged by a
// looser regex below. Patterns must match launch banner text only — they
// should NOT fire on ordinary shell output (file listings, help text,
// README content, log tails). See research/HERDR_LEARNINGS.md §2 for the
// upstream catalogue these came from.
//
// Caveats per herdr:
//   - pi:     `Pi v` is generic; false positives are plausible in noisy
//             shell output. Documented here rather than dropped because
//             first-mover detection is still useful when we have it.
//   - cline:  detection is unreliable upstream; we keep the banner regex
//             for the running=true edge but expect misses.
//   - copilot: structural-only per herdr (e.g. `esc to cancel` for the
//              working signal). We rely on the banner alone for now.
const RUNTIME_BANNERS: ReadonlyArray<{ runtime: AgentRuntime; pattern: RegExp }> = [
  // First-party runtimes — keep these at the top so they take precedence.
  { runtime: "codex",      pattern: /OpenAI Codex\s*\(?v?\d/ },
  { runtime: "claude",     pattern: /Claude Code\s+v?\d/ },
  { runtime: "cursor",     pattern: /Cursor\s+(?:Agent|CLI)/i },
  // Third-party CLIs (alphabetical within tier). Each pattern is anchored
  // on banner-style text (product name + version, or a vendor-specific
  // header) so README mentions and stray log lines don't trigger them.
  { runtime: "aider",      pattern: /\baider\s+v\d|\baider\s+chat\b/i },
  { runtime: "amp",        pattern: /\bSourcegraph\s+Amp\b|\bAmp\s+CLI\b/i },
  { runtime: "antigravity",pattern: /\bAntigravity\b|\bagy\s+v?\d/i },
  { runtime: "cline",      pattern: /\bCline\s+v\d|\bcline-cli\b/i },
  { runtime: "copilot",    pattern: /\bGitHub\s+Copilot\s+CLI\b|\bcopilot\s+v\d/i },
  { runtime: "droid",      pattern: /\bDroid\s+CLI\b|\bfactory\.ai\b/i },
  { runtime: "grok",       pattern: /\bGrok\s+v\d|\bxAI\s+Grok\b/i },
  { runtime: "hermes",     pattern: /\bHermes\s+v\d|\bhermes-agent\b/i },
  { runtime: "kimi",       pattern: /\bKimi\s+v\d|\bkimi-code\b/i },
  { runtime: "kiro",       pattern: /\bKiro\s+v\d|\bkiro-cli\b/i },
  { runtime: "opencode",   pattern: /\bOpenCode\s+v\d|\bopencode\b/i },
  // `Pi v` is generic enough that it can plausibly fire on unrelated
  // shell output. Keep it last in the iteration order so any more specific
  // pattern above wins first.
  { runtime: "pi",         pattern: /\bPi\s+v\d/ },
];

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
  onAgentState?: (state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean }) => void;
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
  // xterm color palette synchronously when the user switches themes or
  // changes accent color.
  const themeUnsubRef = useRef<(() => void) | null>(null);

  // Background-pane data throttling. When `visible` is false the pane is in
  // an unmounted tab or a non-foreground workspace — the user can't see it,
  // so feeding xterm.write() per PTY chunk is pure renderer-CPU waste
  // (DOM-cell allocation, decode, reflow). Instead, buffer the raw bytes and
  // flush in one big write the moment the pane becomes visible again. The
  // PTY itself keeps running; only the renderer-side write is deferred.
  //
  // The sniffers (URL, agent) are also gated — they update state that's only
  // surfaced via UI affordances on the visible pane, so deferring them while
  // hidden is fine. They resume on the next chunk after the flush.
  const hiddenBufferRef = useRef<Uint8Array[]>([]);
  const hiddenBytesRef = useRef<number>(0);
  // Cap chosen to fit a few screens of dense TUI output (claude/codex full
  // redraws on ~120-col panes are ~30-60 KB each). 256 KB ≈ 4-8 redraws,
  // enough to preserve the most-recent visible state when the user flips
  // back. FIFO trim past the cap — older bytes the user can't see anyway.
  const HIDDEN_BUFFER_CAP = 256 * 1024;
  // Live mirror of the latest `visible` value so the pty.onData closure
  // (which is captured once per sessionId) reads the current flag instead
  // of the stale value from mount time.
  const visibleRef = useRef<boolean>(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

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
        // AI agents blow past 1K-line buffers in a single turn; 50K is the
        // floor for reviewing what claude/codex actually did.
        scrollback: 50_000,
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

      // WebGL renderer with software fallback. The DOM renderer is xterm's
      // default; the WebGL renderer is several × faster on agent-style output
      // (full-screen redraws, scrollback, large bursts). On context loss
      // (driver crash, lost GPU, tab move between displays) we dispose the
      // addon and xterm transparently falls back to DOM.
      let webgl: WebglAddon | null = null;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl?.dispose();
          } catch {
            /* ignore */
          }
          webgl = null;
        });
        term.loadAddon(webgl);
      } catch {
        webgl = null;
      }

      // Terminal copy/paste keybindings.
      //
      // Cross-platform (xterm convention):
      //   Ctrl+Shift+C with selection → copy
      //   Ctrl+Shift+V                → bracketed paste from clipboard
      //
      // Windows-only (Windows Terminal / VS Code terminal convention — what
      // every Windows user expects):
      //   Ctrl+C with selection       → copy (and suppress SIGINT)
      //   Ctrl+C with no selection    → fall through as ^C / SIGINT
      //   Ctrl+V                      → bracketed paste from clipboard
      // Without this branch, plain Ctrl+C on Windows always sends SIGINT,
      // which the shell renders as "the typed line just disappeared." We
      // deliberately don't enable this on Linux/macOS — there Ctrl+V is
      // "quoted-insert" in readline and Ctrl+C copy would break shell muscle
      // memory.
      //
      // Bracketed paste wraps the payload in `\x1b[200~ ... \x1b[201~` so
      // shells with bracketed-paste enabled (pwsh/PSReadLine, bash, zsh, fish)
      // treat multi-line content as a single block instead of executing on
      // every embedded newline. Null bytes are stripped because most shells
      // reject them and ConPTY can corrupt the byte stream around them.
      const isWindows = /Windows/i.test(navigator.userAgent);
      const writePasteFromClipboard = () => {
        void (async () => {
          const text = await window.spark.clipboard.readText();
          if (!text) return;
          const sanitized = text.replace(/\x00/g, "");
          if (!sanitized) return;
          const payload = `\x1b[200~${sanitized}\x1b[201~`;
          void window.spark.pty.write(sessionId, payload);
        })();
      };

      // Inline find overlay (Cmd/Ctrl+F). A chrome bar pinned to the top-right
      // of the xterm host that drives SearchAddon.findNext / findPrevious.
      // Built as a plain DOM tree inside the host div (no React) so it can
      // live entirely inside the useTerminalSession effect.
      let searchOverlay: HTMLDivElement | null = null;
      let searchInput: HTMLInputElement | null = null;
      const searchOpts = { caseSensitive: false, regex: false, wholeWord: false };
      const openSearch = () => {
        if (!container.current) return;
        if (!searchOverlay) {
          const bar = document.createElement("div");
          bar.style.cssText = [
            "position:absolute",
            "top:6px",
            "right:6px",
            "height:24px",
            "display:flex",
            "align-items:center",
            "gap:4px",
            "padding:0 4px",
            "background:var(--panel)",
            "border:1px solid var(--rule-strong)",
            "border-radius:4px",
            "font-family:monospace",
            "font-size:12px",
            "z-index:10",
          ].join(";");
          const input = document.createElement("input");
          input.type = "text";
          input.placeholder = "Find";
          input.style.cssText = [
            "background:transparent",
            "border:none",
            "outline:none",
            "color:inherit",
            "font:inherit",
            "width:160px",
            "padding:0 4px",
          ].join(";");
          const mkBtn = (label: string, title: string) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.title = title;
            b.style.cssText = [
              "background:transparent",
              "border:none",
              "color:inherit",
              "font:inherit",
              "cursor:pointer",
              "padding:0 4px",
              "height:20px",
            ].join(";");
            return b;
          };
          const prevBtn = mkBtn("‹", "Previous match");
          const nextBtn = mkBtn("›", "Next match");
          const closeBtn = mkBtn("×", "Close");
          const runFind = (dir: "next" | "prev") => {
            const term2 = termRef.current;
            const q = input.value;
            if (!term2 || !q) return;
            if (dir === "next") search.findNext(q, searchOpts);
            else search.findPrevious(q, searchOpts);
          };
          input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeSearch();
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              runFind(e.shiftKey ? "prev" : "next");
            }
          });
          prevBtn.addEventListener("click", () => runFind("prev"));
          nextBtn.addEventListener("click", () => runFind("next"));
          closeBtn.addEventListener("click", () => closeSearch());
          bar.appendChild(input);
          bar.appendChild(prevBtn);
          bar.appendChild(nextBtn);
          bar.appendChild(closeBtn);
          // The xterm host needs position:relative for absolute children to
          // anchor correctly. TerminalPane sets width/height inline but not
          // position; set it here so the overlay floats over the terminal.
          if (getComputedStyle(container.current).position === "static") {
            container.current.style.position = "relative";
          }
          container.current.appendChild(bar);
          searchOverlay = bar;
          searchInput = input;
        }
        searchOverlay.style.display = "flex";
        searchInput?.focus();
        searchInput?.select();
      };
      const closeSearch = () => {
        if (searchOverlay) searchOverlay.style.display = "none";
        termRef.current?.focus();
      };
      cleanups.push(() => {
        if (searchOverlay && searchOverlay.parentNode) {
          searchOverlay.parentNode.removeChild(searchOverlay);
        }
        searchOverlay = null;
        searchInput = null;
      });

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        // Cmd/Ctrl+F → open inline find overlay. Checked before the
        // copy/paste branch since that one bails on metaKey.
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          (event.key === "f" || event.key === "F")
        ) {
          event.preventDefault();
          openSearch();
          return false;
        }
        if (!event.ctrlKey || event.altKey || event.metaKey) return true;
        const key = event.key;
        const isC = key === "C" || key === "c";
        const isV = key === "V" || key === "v";
        if (!isC && !isV) return true;

        // Ctrl+Shift+{C,V}: cross-platform xterm bindings.
        if (event.shiftKey) {
          if (isC) {
            const selection = term.getSelection();
            if (!selection) return true;
            void window.spark.clipboard.writeText(selection);
            return false;
          }
          writePasteFromClipboard();
          return false;
        }

        // Plain Ctrl+{C,V}: Windows-only convenience.
        if (!isWindows) return true;
        if (isC) {
          const selection = term.getSelection();
          if (!selection) return true; // no selection → let SIGINT through
          void window.spark.clipboard.writeText(selection);
          return false;
        }
        writePasteFromClipboard();
        return false;
      });

      term.open(container.current);
      try {
        fit.fit();
      } catch {
        /* host may be 0×0 on first paint; ResizeObserver will fix it. */
      }
      const restoredScrollback = initialScrollback?.trimEnd();
      if (restoredScrollback) {
        term.write(
          `${normalizeForTerminalReplay(restoredScrollback)}\r\n\x1b[2m${RESTORE_NOTICE}\x1b[0m\r\n`,
        );
      }

      const prompt = registerPromptTracker(term);
      cleanups.push(
        registerCwdHandler(term, (cwd) => onCwdRef.current?.(cwd)),
        registerSparkOpenHandler(term, (input) => onSparkOpenRef.current?.(input)),
        prompt.dispose,
      );
      onSearchReadyRef.current?.(search);

      // Keep the xterm theme in sync with Spark design tokens so theme switches
      // and accent color changes repaint the terminal chrome live.
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
      const setAgentRunning = (runtime: AgentRuntime) => {
        if (agentPhase === "agent") return;
        agentPhase = "agent";
        // Coerce non-first-party runtimes down to `null` at the boundary so
        // App.tsx / TerminalStack / run-store keep seeing the existing public
        // surface ("claude" | "codex" | "cursor" | null) without growing new
        // cases for every newly detected CLI. running=true still fires so the
        // activity indicator tracks correctly.
        onAgentStateRef.current?.({ runtime: coercePublicRuntime(runtime), running: true });
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
          } else if (
            exe === "agent" ||
            exe?.endsWith("/agent") ||
            exe?.endsWith("\\agent")
          ) {
            // Cursor's CLI ships as the `agent` binary.
            setAgentRunning("cursor");
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

        // Hidden-pane fast path. When the pane isn't on screen, skip the
        // entire hot path — xterm.write (DOM cell churn), URL sniff, agent
        // sniff — and just stash the raw bytes. They'll be flushed in one
        // write on the next visible-transition. PTY keeps streaming; only
        // the renderer-side cost is deferred.
        if (!visibleRef.current) {
          hiddenBufferRef.current.push(bytes);
          hiddenBytesRef.current += bytes.length;
          // FIFO trim past the cap so a long-running background agent
          // streaming MB of output doesn't pin renderer memory.
          while (
            hiddenBytesRef.current > HIDDEN_BUFFER_CAP &&
            hiddenBufferRef.current.length > 1
          ) {
            const dropped = hiddenBufferRef.current.shift();
            if (dropped) hiddenBytesRef.current -= dropped.length;
          }
          onActivityRef.current?.();
          return;
        }

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
      let lastAppliedCols = term.cols;
      let lastAppliedRows = term.rows;
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
            // Cheap dedupe: if proposeDimensions reports the same cell
            // count we already applied, skip the fit + pty resize entirely.
            // Window drags often produce sub-cell pixel deltas that don't
            // change cols/rows; reflowing xterm and SIGWINCH'ing the shell
            // for those is pure waste.
            const proposed = fit.proposeDimensions();
            if (
              proposed &&
              proposed.cols === lastAppliedCols &&
              proposed.rows === lastAppliedRows
            ) {
              return;
            }
            try {
              fit.fit();
            } catch {
              return;
            }
            lastAppliedCols = term.cols;
            lastAppliedRows = term.rows;
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
      // Drop any buffered hidden-pane bytes — the xterm they were destined
      // for is gone. The PTY remains alive (see comment above); a future
      // remount will get fresh chunks from main, not the stale prefix.
      hiddenBufferRef.current = [];
      hiddenBytesRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Flush buffered PTY bytes the moment the pane comes back on screen.
  // Runs BEFORE the fit/focus layout effect below so the visible buffer is
  // populated when xterm reflows. Tracks the previous visibility in a ref
  // so the flush only fires on a real false→true transition — the initial
  // mount (prev=undefined, current=true) is treated as a no-op since the
  // buffer is empty anyway, but the guard keeps that invariant explicit.
  const prevVisibleRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) return;
    if (prev === false && hiddenBufferRef.current.length > 0) {
      const term = termRef.current;
      if (term) {
        // Coalesce all chunks into one write so xterm's parser sees a single
        // contiguous stream — partial ANSI sequences across chunk boundaries
        // still reassemble correctly because the bytes are concatenated in
        // arrival order.
        const total = hiddenBytesRef.current;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const chunk of hiddenBufferRef.current) {
          merged.set(chunk, off);
          off += chunk.length;
        }
        try {
          term.write(merged);
        } catch {
          /* xterm may dispose mid-flush during a fast tab switch */
        }
      }
      hiddenBufferRef.current = [];
      hiddenBytesRef.current = 0;
    }
  }, [visible]);

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
    const buf = t.buffer.normal;
    const total = buf.length;
    const lines: string[] = [];
    const start = Math.max(0, total - maxLines);
    for (let i = start; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.trim() === RESTORE_NOTICE) continue;
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
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

function normalizeForTerminalReplay(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
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

// CSI / OSC stripper. Ink (Claude / Codex / Cursor) often positions individual
// characters with cursor moves, so a banner like "Claude Code v2.1.139"
// arrives in the raw byte stream as `C\x1b[H l\x1b[H a…` and a literal
// regex against the unstripped text would never match. Stripping the
// escapes coalesces the characters back into a normal line.
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Identify which agent CLI is running by scanning a short rolling buffer of
// recent visible text against the RUNTIME_BANNERS table at the top of the
// file. Patterns are specific enough to live launch banners / first-prompt
// boilerplate that ordinary shell output (file listings, commit messages,
// README content, `claude --help`) does NOT trigger them. Examples:
//   - Codex:  `OpenAI Codex (v0.130.0)`
//   - Claude: `Claude Code v2.1.139`
//   - Cursor: `Cursor Agent (composer-2.5-fast)` / `Cursor CLI v…`
//   - Aider:  `aider v0.65.0`
//   - Droid:  `Droid CLI` / `factory.ai`
// Returns null when nothing matched so the caller leaves the pane alone.
// Iteration order mirrors the table: first-party runtimes first, then
// third-party CLIs ordered most-specific to least-specific.
function sniffRuntime(text: string): AgentRuntime | null {
  const stripped = text.replace(CSI_RE, "").replace(OSC_RE, "");
  for (const entry of RUNTIME_BANNERS) {
    if (entry.pattern.test(stripped)) return entry.runtime;
  }
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
