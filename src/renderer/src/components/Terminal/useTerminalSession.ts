import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RuntimeState, ShellInfo } from "@shared/types";
import { detectMonoFontFamily } from "../../lib/fonts";
import { subscribeAppTokens } from "../../lib/theme-tokens";
import { createFileLinkProvider } from "./file-link-provider";
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
// In-memory cache of the full xterm buffer captured right before a TerminalPane
// unmounts. Workspace switches unmount every pane of the previous workspace,
// which disposes its xterm (and the 50K-line scrollback inside it) while the
// PTY keeps running in main. The leaf-level `initialScrollback` persisted into
// localStorage is capped at ~40 KB and sampled only every 2s — too small to
// hold a Claude session's worth of output. Stashing the full buffer here on
// unmount and replaying it on the next mount lets a workspace round-trip
// restore the scrollback the user was looking at. One-shot per sessionId:
// consumed by the next mount. Capped per session so a chatty PTY can't pin
// arbitrary RAM if the user never returns to its workspace.
const xtermBufferSnapshots = new Map<string, string>();
const SNAPSHOT_MAX_LINES = 10_000;
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
  // Mirror-pane mode. When true the xterm still attaches to the PTY's data
  // stream (so the user sees output), but the hook does NOT send pty.resize
  // calls and does NOT forward keystrokes via pty.write. Use when a second
  // xterm needs to observe the same PTY whose canonical pane lives in
  // TerminalStack — without this flag, two ResizeObservers race and the
  // smaller cols/rows wins, garbling the canonical pane. Explicit pty.write
  // calls bypass this hook entirely and still work.
  readOnly?: boolean;
  // Input-only mirror: forward NO keystrokes (like readOnly) but DO send
  // pty.resize so the underlying PTY tracks this xterm's cols/rows. Used
  // when this pane is the SOLE view of the PTY (no canonical sibling pane
  // exists), so resizing is safe — the alternative is the PTY staying at
  // its tiny default size while the user's xterm fills the panel, leaving
  // most of the visible area unpainted.
  inputBlocked?: boolean;
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
  // Fires only when the user actually types into the pane (xterm onData,
  // which is a keyboard-only signal — programmatic pty.write, clipboard
  // paste via bracketed-paste, and the one-shot autorun all bypass it).
  // Used by the worker keybind to recognise a fresh shell pane as "unused"
  // and inject the launch command into it instead of splitting next to it.
  onUserInput?: () => void;
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
  readOnly = false,
  inputBlocked = false,
  onSearchReady,
  onExit,
  onCwd,
  onDetectedLocalUrl,
  onSparkOpen,
  onActivity,
  onUserInput,
  onAgentState,
}: Options): TerminalSessionApi {
  // Latest-value ref so the input/resize closures (captured once per
  // sessionId) see the freshest readOnly flag without re-running the
  // expensive xterm setup effect.
  const readOnlyRef = useRef<boolean>(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  // Same pattern for inputBlocked. The closures below decide on each event
  // whether to forward keystrokes — checking the ref lets the parent flip
  // the prop without forcing the xterm setup effect to re-run.
  const inputBlockedRef = useRef<boolean>(inputBlocked);
  useEffect(() => {
    inputBlockedRef.current = inputBlocked;
  }, [inputBlocked]);

  const detectedRef = useRef<string | null>(null);
  // Latest-callback refs so the effect can run exactly once per `sessionId`
  // while still calling the freshest closures from the parent.
  const onDetectedRef = useRef(onDetectedLocalUrl);
  const onCwdRef = useRef(onCwd);
  const onExitRef = useRef(onExit);
  const onSearchReadyRef = useRef(onSearchReady);
  const onSparkOpenRef = useRef(onSparkOpen);
  const onActivityRef = useRef(onActivity);
  const onUserInputRef = useRef(onUserInput);
  const onAgentStateRef = useRef(onAgentState);
  useEffect(() => {
    onDetectedRef.current = onDetectedLocalUrl;
    onCwdRef.current = onCwd;
    onExitRef.current = onExit;
    onSearchReadyRef.current = onSearchReady;
    onSparkOpenRef.current = onSparkOpen;
    onActivityRef.current = onActivity;
    onUserInputRef.current = onUserInput;
    onAgentStateRef.current = onAgentState;
  }, [onDetectedLocalUrl, onCwd, onExit, onSearchReady, onSparkOpen, onActivity, onUserInput, onAgentState]);

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

      // ── Ctrl/Cmd+click on file paths → open in editor ─────────────────────
      // Sister to the WebLinksAddon above. Detects path-shaped tokens in
      // the buffer, verifies existence against the renderer's allowed-roots
      // sandbox, and on activation routes through the same onSparkOpen
      // callback the OSC 8888 `spark_open` shell command uses. Modifier
      // gating (VS Code convention) lives in the activate handler so the
      // link's underline still shows on hover, but plain clicks don't
      // hijack the user's selection drag.
      //
      // Latest-cwd ref is updated by the OSC 7 handler below; the link
      // provider re-reads it on every match so a `cd`'d pane resolves
      // relatives correctly without re-registering the provider.
      let latestCwd: string | null = initialCwd?.trim() || null;
      const fileLinkProvider = createFileLinkProvider(term, {
        getCwd: () => latestCwd,
        resolveExisting: async (target, baseDir) => {
          const result = await window.spark.fs.pathExists?.({
            target,
            baseDir: baseDir ?? undefined,
          });
          return result?.exists && result.isFile ? result.resolved : null;
        },
        onActivate: ({ file, event }) => {
          // Modifier gate: Ctrl on Win/Linux, Cmd on macOS — accept either
          // so a Mac user on an external Windows keyboard still gets the
          // right behavior. Plain click is a no-op so xterm's selection
          // drag continues to work over the underlined region.
          if (!event.ctrlKey && !event.metaKey) return;
          onSparkOpenRef.current?.({ file });
        },
      });
      const linkProviderDispose = term.registerLinkProvider(fileLinkProvider);
      cleanups.push(() => linkProviderDispose.dispose());

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
        // Read-only mirror panes must not paste into the PTY — the canonical
        // pane owns input. Clipboard read is also skipped so a paste shortcut
        // in a mirror tile is a true no-op rather than a phantom read.
        if (readOnlyRef.current || inputBlockedRef.current) return;
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
        // Shift+Enter: insert a line break instead of submitting. The right
        // byte sequence depends on what's reading the PTY:
        //   - Ink-based agent TUIs (Claude Code / Codex / Cursor) read
        //     `\x1b\r` (ESC + CR — the standard Alt+Enter / iTerm2
        //     shift-enter convention, same thing claude's `/terminal-setup`
        //     binds Shift+Enter to) as "insert newline in input box".
        //     Sending backslash + LF here makes Claude render a literal `\`
        //     (Codex happened to swallow the trailing `\` as a continuation,
        //     which is what masked the bug).
        //   - Bare shells (bash/zsh/pwsh) treat backslash + LF as a
        //     multi-line continuation marker, which is the muscle-memory
        //     behaviour at a shell prompt.
        if (
          event.key === "Enter" &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          if (!readOnlyRef.current && !inputBlockedRef.current) {
            const payload = agentPhase === "agent" ? "\x1b\r" : "\\\n";
            void window.spark.pty.write(sessionId, payload);
          }
          return false;
        }
        if (!event.ctrlKey || event.altKey || event.metaKey) return true;
        const key = event.key;
        const isC = key === "C" || key === "c";
        const isV = key === "V" || key === "v";
        if (!isC && !isV) return true;

        // Ctrl+Shift+{C,V}: cross-platform xterm bindings.
        // preventDefault is required on the paste branches: without it the
        // browser still fires a native `paste` event on xterm's hidden
        // textarea, xterm wraps it in bracketed-paste a second time, and the
        // shell receives the clipboard twice.
        if (event.shiftKey) {
          if (isC) {
            const selection = term.getSelection();
            if (!selection) return true;
            event.preventDefault();
            void window.spark.clipboard.writeText(selection);
            return false;
          }
          event.preventDefault();
          writePasteFromClipboard();
          return false;
        }

        // Plain Ctrl+{C,V}: Windows-only convenience.
        if (!isWindows) return true;
        if (isC) {
          const selection = term.getSelection();
          if (!selection) return true; // no selection → let SIGINT through
          event.preventDefault();
          void window.spark.clipboard.writeText(selection);
          return false;
        }
        event.preventDefault();
        writePasteFromClipboard();
        return false;
      });

      // Native-terminal right-click: copy current selection if one exists,
      // otherwise paste from clipboard. Matches ConHost / Windows Terminal
      // "quick-edit" behavior the user expects. preventDefault suppresses
      // the OS context menu so the click is consumed entirely by the
      // terminal.
      const host = container.current;
      if (host) {
        const handleContextMenu = (event: MouseEvent) => {
          event.preventDefault();
          const term2 = termRef.current;
          if (!term2) return;
          const selection = term2.getSelection();
          if (selection) {
            void window.spark.clipboard.writeText(selection);
            term2.clearSelection();
            return;
          }
          writePasteFromClipboard();
        };
        host.addEventListener("contextmenu", handleContextMenu);
        cleanups.push(() => {
          host.removeEventListener("contextmenu", handleContextMenu);
        });
      }

      term.open(container.current);
      try {
        fit.fit();
      } catch {
        /* host may be 0×0 on first paint; ResizeObserver will fix it. */
      }
      // Prefer the in-memory snapshot captured during the previous unmount —
      // it's the full visible+scrollback buffer (up to SNAPSHOT_MAX_LINES) and
      // exists only for workspace-switch round-trips. Falls back to the leaf's
      // localStorage-persisted scrollback (smaller, sampled) for the cold-start
      // app-restart path; that one still carries the RESTORE_NOTICE so the user
      // knows the prompt below is fresh.
      const liveSnapshot = xtermBufferSnapshots.get(sessionId);
      if (liveSnapshot) {
        xtermBufferSnapshots.delete(sessionId);
        term.write(`${normalizeForTerminalReplay(liveSnapshot)}\r\n`);
      } else {
        const restoredScrollback = initialScrollback?.trimEnd();
        if (restoredScrollback) {
          term.write(
            `${normalizeForTerminalReplay(restoredScrollback)}\r\n\x1b[2m${RESTORE_NOTICE}\x1b[0m\r\n`,
          );
        }
      }

      const prompt = registerPromptTracker(term);
      cleanups.push(
        registerCwdHandler(term, (cwd) => {
          // Mirror to the link-provider closure first so the very next
          // hover-driven match resolves relatives against the freshest
          // cwd, then forward to the parent callback (which usually drops
          // it into tab state).
          latestCwd = cwd;
          onCwdRef.current?.(cwd);
        }),
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
      // Tracks the first-party runtime ("claude"|"codex"|"cursor") if the
      // detected runtime maps to one — drives the state poller below, which
      // only has regex tables for those three. Non-first-party runtimes still
      // fire onAgentState (running=true) but skip the poller.
      let activeRuntime: "claude" | "codex" | "cursor" | null = null;

      // ── Runtime state poller (the live working / blocked / idle / done
      // sniffer that drives chip tone and notifications). Polls the visible
      // xterm buffer every STATE_POLL_MS ms; only runs while an agent has
      // been detected in the pane (gated by agentPhase). All flags live in
      // this closure so they reset cleanly across agent enter/exit cycles.
      let stateTimer: number | null = null;
      let pendingState: RuntimeState | null = null;
      let confirmedState: RuntimeState | null = null;
      let idleSinceMs: number | null = null;
      const reportRuntimeState = (state: RuntimeState) => {
        void window.spark.terminalState?.report?.({ paneId: sessionId, state });
      };
      const stopStatePoller = () => {
        if (stateTimer !== null) {
          window.clearInterval(stateTimer);
          stateTimer = null;
        }
        pendingState = null;
        confirmedState = null;
        idleSinceMs = null;
      };
      const tickStatePoller = () => {
        const t = termRef.current;
        if (!t || !activeRuntime) return;
        const tail = readTerminalTail(t, STATE_TAIL_ROWS);
        const raw = classifyTail(activeRuntime, tail);
        const now = Date.now();
        if (confirmedState === "working" && raw === null) {
          if (idleSinceMs === null) idleSinceMs = now;
          if (now - idleSinceMs >= IDLE_DEBOUNCE_MS) {
            confirmedState = "idle";
            pendingState = null;
            idleSinceMs = null;
            reportRuntimeState("idle");
          }
          return;
        }
        idleSinceMs = null;
        if (raw === null) {
          pendingState = null;
          return;
        }
        if (pendingState !== raw) {
          pendingState = raw;
          return;
        }
        if (confirmedState !== raw) {
          confirmedState = raw;
          reportRuntimeState(raw);
        }
      };
      const startStatePoller = (runtime: "claude" | "codex" | "cursor") => {
        activeRuntime = runtime;
        pendingState = null;
        confirmedState = null;
        idleSinceMs = null;
        if (stateTimer !== null) window.clearInterval(stateTimer);
        stateTimer = window.setInterval(tickStatePoller, STATE_POLL_MS);
      };

      const setAgentRunning = (runtime: AgentRuntime | null) => {
        if (agentPhase === "agent") return;
        agentPhase = "agent";
        // Coerce non-first-party runtimes down to `null` at the boundary so
        // App.tsx / TerminalStack / run-store keep seeing the existing public
        // surface ("claude" | "codex" | "cursor" | null) without growing new
        // cases for every newly detected CLI. running=true still fires so the
        // activity indicator tracks correctly. A null `runtime` argument
        // means "something is interactive but we don't know what" — used by
        // the alt-screen fallback below for unrecognised TUIs.
        const publicRuntime = runtime ? coercePublicRuntime(runtime) : null;
        onAgentStateRef.current?.({ runtime: publicRuntime, running: true });
        // Only the three first-party runtimes have regex tables in
        // RUNTIME_PATTERNS — others rely on hook reports from E1 or no state
        // signal at all.
        if (publicRuntime) startStatePoller(publicRuntime);
      };
      const resetAgentPhase = () => {
        if (agentPhase === "agent") {
          onAgentStateRef.current?.({ runtime: null, running: false });
          // The TUI just exited; flip the live state to "done" so any UI
          // subscriber sees the transition immediately (the orchestration
          // worker may still be writing its final report, but the agent is
          // off-screen). The poller stops here — we don't keep scanning a
          // pwsh prompt for blocked/working patterns.
          if (confirmedState !== "done") {
            confirmedState = "done";
            reportRuntimeState("done");
          }
        }
        activeRuntime = null;
        stopStatePoller();
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
      // Tear down the state poller on unmount. The closure-bound `stateTimer`
      // is the only owner — main has no per-pane handle to clean up, so a
      // missed clearInterval here would leak a timer for the lifetime of the
      // (now-disposed) hook.
      cleanups.push(() => stopStatePoller());
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
            if (runtime) {
              setAgentRunning(runtime);
            } else if (chunkText.includes("\x1b[?1049h")) {
              // Generic alt-screen TUI fallback. Every Ink-based CLI
              // (Claude / Codex / Cursor) and every classic fullscreen tool
              // (vim, less, htop, fzf) emits `ESC[?1049h` on entry. If banner
              // detection hasn't matched, fall back to this byte signal so
              // the pane still reports running=true. The worker keybind
              // relies on this: without it, an unrecognised Claude build or
              // a vim session would look "unused" and the keybind would
              // happily inject the launch command into the running TUI's
              // input box. The exit path (\x1b[?1049l in the else branch
              // below) already restores idle phase, so this fallback rides
              // the same lifecycle as banner-based detection.
              setAgentRunning(null);
            }
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
        // Read-only / mirror panes must not forward keystrokes — the
        // canonical xterm for the same PTY lives elsewhere and accepts user
        // input there. Activity still pings since hover/focus on the mirror
        // is a meaningful "this PTY isn't idle" signal for the orchestrator.
        // `inputBlocked` is the sole-view variant — same input-suppression,
        // but resize stays enabled.
        if (readOnlyRef.current || inputBlockedRef.current) {
          onActivityRef.current?.();
          return;
        }
        void window.spark.pty.write(sessionId, data);
        onActivityRef.current?.();
        onUserInputRef.current?.();
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

      // Drain any bytes the pty emitted while the previous TerminalPane was
      // unmounted (workspace switched away). Main holds those bytes in a
      // detached backlog per pause()/resume() in pty-manager.ts; this call
      // flushes them back through the same data channel as live output, so
      // the user sees everything the agent printed during the gap. On a
      // fresh session this is a no-op (backlog empty, already attached).
      void window.spark.pty.resume(sessionId);

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
      let rafFits = 0;
      let rafHandle: number | null = null;

      const scheduleFitRetry = () => {
        if (disposed || !spawned) return;
        if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
        rafFits = 0;
        const tick = () => {
          rafHandle = null;
          if (disposed || !spawned) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          lastAppliedCols = term.cols;
          lastAppliedRows = term.rows;
          if (!readOnlyRef.current && (term.cols !== lastSentCols || term.rows !== lastSentRows)) {
            lastSentCols = term.cols;
            lastSentRows = term.rows;
            void window.spark.pty.resize(sessionId, term.cols, term.rows);
          }
          rafFits += 1;
          if (rafFits < 3) {
            rafHandle = window.requestAnimationFrame(tick);
          }
        };
        rafHandle = window.requestAnimationFrame(tick);
      };

      const el = container.current;
      const flushPtyResize = () => {
        ptyTimer = null;
        if (disposed || !spawned) return;
        // Read-only mirror panes must not send pty.resize — the canonical
        // pane owns the PTY's dimensions. Without this guard, two mounts
        // of the same sessionId would each fit() to their own container
        // size and race their pty.resize calls; the last (often smaller)
        // one would win and garble the larger xterm's display.
        if (readOnlyRef.current) return;
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
            scheduleFitRetry();
          }, FIT_DEBOUNCE_MS);
        });
        observer.observe(el);
        window.addEventListener("resize", scheduleFitRetry);
        cleanups.push(() => {
          observer.disconnect();
          if (fitTimer !== null) window.clearTimeout(fitTimer);
          if (ptyTimer !== null) window.clearTimeout(ptyTimer);
          window.removeEventListener("resize", scheduleFitRetry);
          if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
        });
      }

      // Initial size is now real — ship it once explicitly so the shell prompt
      // paints at the correct width on first render. Skip on read-only mirror
      // panes; the canonical pane already sized this PTY.
      try {
        fit.fit();
      } catch {
        /* host transitioned to display:none between mount and now */
      }
      scheduleFitRetry();
      if (
        !readOnlyRef.current &&
        (term.cols !== lastSentCols || term.rows !== lastSentRows)
      ) {
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
      if (
        cmd &&
        cmd.length > 0 &&
        !startupCommandHandled &&
        !autorunFiredSessions.has(sessionId) &&
        !readOnlyRef.current
      ) {
        const autorunTimer = window.setTimeout(() => {
          if (disposed) return;
          if (readOnlyRef.current) return;
          autorunFiredSessions.add(sessionId);
          void window.spark.pty.write(sessionId, `${cmd}\r`);
        }, 1500);
        cleanups.push(() => window.clearTimeout(autorunTimer));
      }
    };

    return () => {
      disposed = true;
      window.clearTimeout(startTimer);
      // Tell main to stop firing pty bytes at the about-to-be-dead IPC
      // listener and instead accumulate them in a per-session backlog. The
      // very next mount of this sessionId calls resume() to drain it. Done
      // BEFORE running the cleanups (which include offData) so the window
      // between "listener removed" and "main processes pause" is as short
      // as possible — any chunk that slips through during that one-tick
      // gap is also absorbed by pause() itself, which moves the pending
      // flush queue into the backlog.
      if (!readOnlyRef.current) {
        void window.spark.pty.pause?.(sessionId);
      }
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
      // Snapshot the full xterm buffer (visible + scrollback) into the
      // module-level cache so the next mount of this sessionId — typically the
      // user returning to this workspace — can replay what was on screen
      // instead of starting from an empty terminal plus whatever short
      // 40 KB snippet the periodic onActivity sampler last persisted.
      const dyingTerm = termRef.current;
      if (dyingTerm) {
        try {
          const snapshot = captureXtermBuffer(dyingTerm, SNAPSHOT_MAX_LINES);
          if (snapshot.length > 0) {
            xtermBufferSnapshots.set(sessionId, snapshot);
          }
        } catch {
          /* best-effort; an inaccessible buffer just means no scrollback restore */
        }
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
    // The host can finish expanding one paint later when it sits inside a
    // flex/absolute stack or a tab transition. Re-fit on the next frame so
    // xterm doesn't stay pinned to the smaller first-pass row count.
    const raf = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore late layout churn */
      }
    });
    termRef.current?.focus();
    return () => window.cancelAnimationFrame(raf);
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

// Read up to `maxLines` lines from the end of the xterm buffer (visible rows
// + scrollback) as plain text. Wrapped logical lines are stitched back
// together so a long Claude/Codex response that line-wrapped in the original
// width still replays as one line. Loses ANSI styling — replay is intended
// to give the user readable scrollback after a workspace round-trip, not
// pixel-perfect re-rendering of an Ink TUI's last frame. Trailing empty
// rows are trimmed so the replayed text doesn't open with blank space.
function captureXtermBuffer(term: Terminal, maxLines: number): string {
  const buf = term.buffer.normal;
  const total = buf.length;
  const start = Math.max(0, total - maxLines);
  const lines: string[] = [];
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

// Per-runtime "what is the agent doing right now" pattern tables. Each entry
// owns three sets of regexes that run against the same plain-text tail of the
// xterm buffer.
//
//   `working`: the agent is generating / streaming. Match anything the live
//              status line prints while thinking — most CLIs paint a spinner
//              with text like "esc to interrupt" or "(thinking)".
//   `blocked`: the agent is waiting on the user for permission or
//              confirmation. These prompts are the whole point of the
//              detection — Spark surfaces them as the "needs you" signal.
//   `done`   : the agent has actively printed a completion line (vs simply
//              going quiet, which is `idle`). Today we mostly fall back to
//              the OSC 633;A "prompt is back" boundary (handled elsewhere),
//              but a positive completion match lets us cut over without
//              waiting for the debounce window.
//
// Patterns were lifted from herdr's hand-tuned table (research/HERDR_LEARNINGS
// quick-win B), trimmed to the three runtimes Spark spawns today. The patterns
// match against the CSI/OSC-stripped tail string so Ink's per-character cursor
// moves do not interleave bytes inside the literal we're looking for.
interface RuntimePatterns {
  working: RegExp[];
  blocked: RegExp[];
  done: RegExp[];
}

const RUNTIME_PATTERNS: Record<"claude" | "codex" | "cursor", RuntimePatterns> = {
  // Claude Code (Anthropic). The "esc to interrupt" footer is on screen the
  // entire time it's streaming a turn, and the permission prompt is the
  // canonical "blocked on you" UI.
  claude: {
    working: [
      /esc to interrupt/i,
      /\(?\s*esc to cancel\s*\)?/i,
      /thinking[…\.]/i,
      /\bworking[…\.]/i,
      /\bcompacting[…\.]/i,
    ],
    blocked: [
      /Do you want to (?:proceed|continue|allow)/i,
      /Allow .* to (?:edit|run|read)/i,
      /\bWaiting for your input\b/i,
      /Press (?:y|n|enter|esc) to/i,
      /Enter your (?:response|answer|choice):/i,
    ],
    done: [
      /Session ended\./i,
      /\bGoodbye\b!?/i,
    ],
  },
  // OpenAI Codex CLI. Lower-case "thinking" / "working" footer lines, and a
  // "shell command" approval prompt that mirrors Claude's permission flow.
  codex: {
    working: [
      /esc to interrupt/i,
      /\(thinking\)/i,
      /\(working\)/i,
      /Generating/i,
      /Streaming/i,
    ],
    blocked: [
      /Approve shell command/i,
      /Approve this (?:edit|patch|command)/i,
      /Do you want to (?:proceed|continue)/i,
      /\[y\/N\]/i,
      /\(y\/n\)/i,
    ],
    done: [
      /Session complete\./i,
      /\bExiting\b\./i,
    ],
  },
  // Cursor Agent / Cursor CLI. Similar Ink TUI patterns; "press enter" and
  // explicit "waiting for confirmation" copy when blocked.
  cursor: {
    working: [
      /esc to interrupt/i,
      /\(generating\)/i,
      /thinking[…\.]/i,
    ],
    blocked: [
      /Waiting for (?:confirmation|approval)/i,
      /Approve (?:edit|patch|tool)/i,
      /Press enter to/i,
      /Continue\? \(y\/n\)/i,
    ],
    done: [
      /Conversation ended\./i,
    ],
  },
};

// Match plain-text tail against a runtime's pattern table. Returns the first
// state that fires, in priority order: blocked > working > done. Blocked wins
// over working because a TUI can paint "esc to interrupt" inside a permission
// dialog (the dialog is still rendered above the streaming footer); the
// blocked prompt is the actionable one for the user.
function classifyTail(
  runtime: "claude" | "codex" | "cursor",
  tail: string,
): RuntimeState | null {
  const table = RUNTIME_PATTERNS[runtime];
  if (!table) return null;
  const stripped = tail.replace(CSI_RE, "").replace(OSC_RE, "");
  for (const re of table.blocked) {
    if (re.test(stripped)) return "blocked";
  }
  for (const re of table.working) {
    if (re.test(stripped)) return "working";
  }
  for (const re of table.done) {
    if (re.test(stripped)) return "done";
  }
  return null;
}

// Read the last `maxRows` lines of an xterm Terminal buffer as plain text.
// Concatenates wrapped logical lines back together so a banner the agent
// printed across two physical rows still matches a single regex. Cheap by
// design — we only walk the active buffer (no scrollback) and skip empty
// trailing rows, which is what the regex would scan anyway.
function readTerminalTail(term: Terminal, maxRows: number): string {
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - maxRows);
  const parts: string[] = [];
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && parts.length > 0) {
      parts[parts.length - 1] += text;
    } else {
      parts.push(text);
    }
  }
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.join("\n");
}

// Polling cadence for the live-state sniffer. 300 ms is the cheapest interval
// that still reads as "instant" in a chat UI (one frame of cognitive delay).
// xterm's `buffer.active.getLine().translateToString(true)` is a couple-µs
// operation per row; reading 40 rows per tick across a dozen panes is well
// under 1 ms of renderer work per second.
const STATE_POLL_MS = 300;
// Number of rows of the visible buffer we feed into the regex match.
const STATE_TAIL_ROWS = 40;
// Working → Idle transition requires this many ms of consecutive empty ticks
// before flipping. Codex and Claude both have ~700 ms gaps mid-turn where no
// status line is on screen (between Ink redraws); a flat 1.2 s window covers
// those without making the indicator feel laggy. The 2-tick confirm on every
// other transition is also applied (one tick is the minimum to debounce the
// occasional regex bounce when the TUI is mid-redraw).
const IDLE_DEBOUNCE_MS = 1_200;

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
