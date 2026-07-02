import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  normalizeTerminalScrollbackLineLimit,
  trimTerminalScrollbackLines,
  type RuntimeState,
  type ShellInfo,
} from "@shared/types";
import {
  absenceResetSafe,
  agentUiPresent,
  classifyTail,
  coercePublicRuntime,
  hasPromptMarker,
  sniffOsc633CommandRuntime,
  sniffRuntime,
  unescapeOsc633,
  type AgentRuntime,
  type PublicAgentRuntime,
} from "@shared/agent-patterns";
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

// Shell-escape a dropped file path for insertion at the terminal cursor,
// replicating iTerm2's default drag-and-drop behavior.
//
// POSIX (macOS/Linux): backslash-escape every character outside a conservative
// safe set, matching iTerm2's default "escape special characters" mode. This
// turns `/Users/x/My Photos/a b.png` into `/Users/x/My\ Photos/a\ b.png` and
// escapes quotes, parens, `$`, `&`, `;`, `*`, etc.
//
// Windows (win32): backslash is the path separator, so backslash-escaping would
// corrupt the path. Wrap the whole path in double quotes instead and double any
// embedded `"` (rare in Windows paths). cmd.exe and PowerShell both accept a
// double-quoted path.
function shellEscapePath(path: string, isWindows: boolean): string {
  if (!path) return "";
  if (isWindows) {
    return `"${path.replace(/"/g, '""')}"`;
  }
  // POSIX: backslash-escape every character outside a conservative safe set,
  // exactly like iTerm2's default drag-and-drop "escape special characters"
  // mode. `/Users/x/My Photos/a b.png` becomes `/Users/x/My\ Photos/a\ b.png`,
  // and spaces, quotes, parens, `$`, `&`, `;`, `*`, etc. all get a leading
  // backslash. A backslash before an ordinary shell character is a harmless
  // no-op, so escaping conservatively is always safe. This matches the
  // iTerm2-verified form Claude Code's image-path detection expects (backslash-
  // escaped path ending in an image extension), and it still lands as one
  // usable token at a plain shell prompt.
  return path.replace(/[^A-Za-z0-9_./-]/g, "\\$&");
}
// After an agent turn is interrupted with Ctrl+C, Codex/Claude/Cursor often
// keep their TUI input box open without re-emitting the launch banner or
// alt-screen-enter sequence. Keep Shift+Enter routed as an agent newline for a
// bounded grace window, while prompt/alt-screen exit markers clear it sooner.
const RECENT_AGENT_INPUT_GRACE_MS = 10_000;

// Agent runtime detection tables (AgentRuntime, RUNTIME_BANNERS, the live
// working/blocked/done pattern tables, and their helpers) live in
// src/shared/agent-patterns.ts so the main-process terminal agent notifier
// shares the exact same detection logic as this hook.

// Module-level guard so a sessionId can only ever have one autorun scheduled.
// Survives component re-mounts (StrictMode dev, HMR) since the PTY itself
// persists past the renderer-side React tree. See the autorun block below.
const autorunFiredSessions = new Set<string>();
// In-memory cache of the full xterm buffer captured right before a TerminalPane
// unmounts. Workspace switches unmount every pane of the previous workspace,
// which disposes its xterm scrollback while the PTY keeps running in main. The
// leaf-level `initialScrollback` persisted into localStorage is capped at ~40 KB
// and sampled only every 2s — too small to hold a Claude session's worth of
// output. Stashing the full buffer here on unmount and replaying it on the next
// mount lets a workspace round-trip restore the scrollback the user was looking
// at. One-shot per sessionId: consumed by the next mount. Capped per session by
// the user-configured scrollback line limit so a chatty PTY can't pin arbitrary
// RAM if the user never returns to its workspace.
const MAX_XTERM_BUFFER_SNAPSHOTS = 64;
// A snapshot is the xterm buffer text captured at unmount PLUS any raw bytes
// that arrived while the pane was hidden (and therefore never reached xterm,
// so `captureXtermBuffer` by construction can't see them). On the next mount
// the text is replayed first, then `pendingBytes` is written verbatim, then
// pty.resume() drains main's post-pause backlog — preserving the ordering
// pre-hide snapshot → hidden-era bytes → post-pause backlog.
interface XtermBufferSnapshot {
  text: string;
  pendingBytes: Uint8Array | null;
}
const xtermBufferSnapshots = new Map<string, XtermBufferSnapshot>();

function rememberXtermBufferSnapshot(
  sessionId: string,
  snapshot: XtermBufferSnapshot,
): void {
  // Keep the cache finite across many closed/switched panes. Each snapshot is
  // already line-limited; this caps the number of sessions that can retain one.
  xtermBufferSnapshots.delete(sessionId);
  xtermBufferSnapshots.set(sessionId, snapshot);
  while (xtermBufferSnapshots.size > MAX_XTERM_BUFFER_SNAPSHOTS) {
    const oldest = xtermBufferSnapshots.keys().next().value;
    if (!oldest) break;
    xtermBufferSnapshots.delete(oldest);
  }
}
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
  scrollbackLineLimit: number;
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
  // (ESC[?1049l), prompt markers, or a forwarded Ctrl+C in a detected
  // first-party agent pane. `runtime` is best-effort sniffed from surrounding
  // banner text; `null` means the TUI started but we couldn't identify which
  // one.
  onAgentState?: (state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean }) => void;
  // Fires whenever the live-state poller confirms a new RuntimeState for the
  // foreground agent (working / blocked / idle / done). This is the SAME value
  // the hook reports to main via window.spark.terminalState.report — surfaced
  // to the renderer so a manual pane's worker chip can show the finer state
  // (e.g. "waiting for you" when the agent printed a permission/input prompt)
  // instead of a binary running/done. `blocked` means the agent is waiting on
  // the user. Reuses the poller's debounced output — no second detector.
  onRuntimeState?: (state: RuntimeState) => void;
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
  scrollbackLineLimit,
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
  onRuntimeState,
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
  const onRuntimeStateRef = useRef(onRuntimeState);
  useEffect(() => {
    onDetectedRef.current = onDetectedLocalUrl;
    onCwdRef.current = onCwd;
    onExitRef.current = onExit;
    onSearchReadyRef.current = onSearchReady;
    onSparkOpenRef.current = onSparkOpen;
    onActivityRef.current = onActivity;
    onUserInputRef.current = onUserInput;
    onAgentStateRef.current = onAgentState;
    onRuntimeStateRef.current = onRuntimeState;
  }, [onDetectedLocalUrl, onCwd, onExit, onSearchReady, onSparkOpen, onActivity, onUserInput, onAgentState, onRuntimeState]);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const normalizedScrollbackLineLimit = normalizeTerminalScrollbackLineLimit(scrollbackLineLimit);
  const scrollbackLineLimitRef = useRef<number>(normalizedScrollbackLineLimit);
  useEffect(() => {
    scrollbackLineLimitRef.current = normalizedScrollbackLineLimit;
    const term = termRef.current;
    if (term) term.options.scrollback = normalizedScrollbackLineLimit;
  }, [normalizedScrollbackLineLimit]);
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
  const hiddenLineBreaksRef = useRef<number>(0);
  // Cap chosen to fit a few screens of dense TUI output (claude/codex full
  // redraws on ~120-col panes are ~30-60 KB each). 256 KB ≈ 4-8 redraws,
  // enough to preserve the most-recent visible state when the user flips
  // back. FIFO trim past the cap — older bytes the user can't see anyway.
  const HIDDEN_BUFFER_CAP = 256 * 1024;
  // Hysteresis slack above the byte cap before we pay for a precise merge. The
  // cheap FIFO path (shift whole chunks) keeps us under cap+slack amortized
  // O(1); without slack, once a chatty hidden pane sits exactly at the cap
  // every new chunk would re-trigger the full allocate+memcpy+rescan merge.
  const HIDDEN_BUFFER_SLACK = 64 * 1024;
  const trimHiddenBufferToLimits = useCallback(() => {
    const maxLineBreaks = Math.max(0, scrollbackLineLimitRef.current);

    // ── Cheap path: drop whole leading chunks while we're over the byte cap.
    // FIFO shift is amortized O(1) per data event vs the full merge below.
    // We only shift when there's more than one chunk so a single oversized
    // chunk still falls through to the precise byte trim.
    while (
      hiddenBytesRef.current > HIDDEN_BUFFER_CAP + HIDDEN_BUFFER_SLACK &&
      hiddenBufferRef.current.length > 1
    ) {
      const dropped = hiddenBufferRef.current.shift();
      if (!dropped) break;
      hiddenBytesRef.current -= dropped.length;
      hiddenLineBreaksRef.current -= countLineFeeds(dropped);
    }

    if (
      hiddenBytesRef.current <= HIDDEN_BUFFER_CAP + HIDDEN_BUFFER_SLACK &&
      hiddenLineBreaksRef.current <= maxLineBreaks
    ) {
      // Within the byte hysteresis band and within the line budget — leave the
      // chunk list alone. The precise merge only runs when the LINE limit
      // still binds (rare) or a lone chunk overflows the hard byte cap.
      return;
    }

    const total = hiddenBytesRef.current;
    if (total <= 0) {
      hiddenBufferRef.current = [];
      hiddenBytesRef.current = 0;
      hiddenLineBreaksRef.current = 0;
      return;
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of hiddenBufferRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Precise trim: clamp to the hard byte cap (single oversized chunk case)
    // and back-scan for the line limit. Reached only when the cheap shift
    // above couldn't satisfy the limits.
    let start = Math.max(0, total - HIDDEN_BUFFER_CAP);
    if (hiddenLineBreaksRef.current > maxLineBreaks) {
      let seen = 0;
      for (let i = total - 1; i >= 0; i--) {
        if (merged[i] !== 10) continue;
        seen += 1;
        if (seen > maxLineBreaks) {
          start = Math.max(start, i + 1);
          break;
        }
      }
    }

    const trimmed = start > 0 ? merged.slice(start) : merged;
    hiddenBufferRef.current = trimmed.length > 0 ? [trimmed] : [];
    hiddenBytesRef.current = trimmed.length;
    hiddenLineBreaksRef.current = countLineFeeds(trimmed);
  }, []);
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
    // True between issuing the snapshot replay term.write(...) and its write
    // callback completing. While set, the unmount cleanup skips re-snapshotting
    // so a mid-parse remount can't overwrite the cached full buffer with a
    // partially-populated one (see the snapshot replay block below).
    let replayPending = false;

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
        // AI agents can emit huge transcripts; the user setting keeps xterm's
        // retained scrollback finite so renderer memory cannot grow unbounded.
        scrollback: scrollbackLineLimitRef.current,
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
      // Deliver a token (a shell-escaped file path, or a dropped-paths list) to
      // the PTY, framing it as a bracketed paste ONLY when the foreground app
      // has bracketed-paste mode (DECSET 2004) enabled. iTerm2 does exactly
      // this: a drag-dropped filename is wrapped in `\x1b[200~ … \x1b[201~`
      // when the app requested the mode, and Claude Code's image-path detection
      // keys on precisely that bracketed-paste framing to emit an `[Image #N]`
      // chip. A plain shell that has NOT enabled the mode (e.g. a bare command
      // line, or one mid-typing) gets the raw bytes so the token still lands at
      // the cursor like typed input. Null bytes are stripped because shells
      // reject them and ConPTY can corrupt the stream around them.
      const writeTokenRespectingBracketMode = (raw: string) => {
        if (readOnlyRef.current || inputBlockedRef.current) return;
        const sanitized = raw.replace(/\x00/g, "");
        if (!sanitized) return;
        const bracketed = termRef.current?.modes.bracketedPasteMode ?? false;
        const payload = bracketed ? `\x1b[200~${sanitized}\x1b[201~` : sanitized;
        void window.spark.pty.write(sessionId, payload);
      };
      const writePasteFromClipboard = () => {
        // Read-only mirror panes must not paste into the PTY — the canonical
        // pane owns input. Clipboard read is also skipped so a paste shortcut
        // in a mirror tile is a true no-op rather than a phantom read.
        if (readOnlyRef.current || inputBlockedRef.current) return;
        void (async () => {
          const text = await window.spark.clipboard.readText();
          const sanitized = (text ?? "").replace(/\x00/g, "");
          if (sanitized.trim()) {
            // Usable text on the clipboard → paste it as a bracketed block, the
            // long-standing behavior for text paste (unchanged).
            const payload = `\x1b[200~${sanitized}\x1b[201~`;
            void window.spark.pty.write(sessionId, payload);
            return;
          }
          // No usable text — the clipboard may hold an image (a screenshot,
          // "copy image"). Materialise it to a temp PNG in main and paste its
          // shell-escaped path so an agent TUI turns it into an `[Image #N]`
          // chip. Mode-aware, same as a Finder drag-drop.
          const imagePath = await window.spark.clipboard.readImageAsTempFile?.();
          if (!imagePath) return;
          writeTokenRespectingBracketMode(shellEscapePath(imagePath, isWindows));
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
        //     Use this for actively detected and recently interrupted agent
        //     panes because Ctrl+C can clear the running chip while leaving
        //     the TUI input box focused. Sending backslash + LF there renders
        //     a literal `\`.
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
            const payload = shouldUseAgentNewline() ? "\x1b\r" : "\\\n";
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

        // Plain Ctrl+C: Windows copies an active selection; every other
        // no-selection path falls through as ^C / SIGINT. If a detected
        // first-party agent is running, clear Spark's chip/state first but do
        // not preventDefault — xterm still forwards the actual interrupt to
        // the PTY.
        if (isC) {
          if (isWindows) {
            const selection = term.getSelection();
            if (selection) {
              event.preventDefault();
              void window.spark.clipboard.writeText(selection);
              return false;
            }
          }
          handleAgentInterruptKey();
          return true;
        }

        // Plain Ctrl+V: Windows-only convenience.
        if (!isWindows) return true;
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

        // iTerm2-style Finder drag-and-drop: dropping files from Finder onto a
        // terminal pane inserts their shell-escaped absolute paths at the cursor
        // (space-separated for multiple files). Scoped strictly to this terminal
        // `host` element so the chat composer's own image drop-zone (a different
        // component) is untouched.
        const dragContainsFiles = (event: DragEvent): boolean =>
          Array.from(event.dataTransfer?.types ?? []).includes("Files");

        // preventDefault on dragenter/dragover is REQUIRED both to mark the
        // element a valid drop target and to stop Electron from navigating the
        // webContents to the dropped file:// URL.
        const handleDragOver = (event: DragEvent) => {
          if (!dragContainsFiles(event)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        };

        const handleDrop = (event: DragEvent) => {
          // No files dropped (e.g. selected text drag): don't preventDefault so
          // xterm / the browser handle the text drop normally.
          if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          // Read-only / mirror panes must not write into the PTY — mirror the
          // onData input gate exactly. Activity still pings (the drop is a real
          // "not idle" signal) but nothing is forwarded.
          if (readOnlyRef.current || inputBlockedRef.current) {
            onActivityRef.current?.();
            return;
          }
          const paths = Array.from(event.dataTransfer.files)
            .map((file) => window.spark.fs.getPathForFile(file))
            .filter((path) => path && path.length > 0);
          if (paths.length === 0) return;
          // Escape each path and join with a single space. No leading/trailing
          // space (iTerm parity). Framed as a bracketed paste when the app has
          // bracketed-paste mode enabled — that's what iTerm2 does, and it's the
          // signal Claude Code (and Codex) use to detect a dropped image path
          // and turn it into an `[Image #N]` chip. A plain shell without the
          // mode enabled receives the raw escaped path at the cursor, exactly
          // like typed input.
          const payload = paths
            .map((path) => shellEscapePath(path, isWindows))
            .join(" ");
          writeTokenRespectingBracketMode(payload);
          onActivityRef.current?.();
          onUserInputRef.current?.();
          termRef.current?.focus();
        };

        host.addEventListener("dragenter", handleDragOver);
        host.addEventListener("dragover", handleDragOver);
        host.addEventListener("drop", handleDrop);
        cleanups.push(() => {
          host.removeEventListener("dragenter", handleDragOver);
          host.removeEventListener("dragover", handleDragOver);
          host.removeEventListener("drop", handleDrop);
        });

        // Image-only clipboard paste (macOS Cmd+V, Linux Ctrl+V). Those paths
        // bypass the custom key handler (the metaKey early-return, and the
        // Linux `!isWindows` fall-through) and hit xterm's native textarea
        // paste — which is text-only, so an image-only clipboard produces
        // nothing (xterm's onData never fires). Intercept the DOM `paste` event
        // in the capture phase: if the clipboard carries an image but no usable
        // text, preventDefault and run the same temp-file → escaped-path →
        // bracketed-paste flow so Claude Code shows an `[Image #N]` chip. When
        // there IS text we do nothing and let xterm handle the paste normally
        // (which also avoids the double-paste the Ctrl+Shift+V branch guards
        // against — we only ever consume image-only pastes here).
        const handlePaste = (event: ClipboardEvent) => {
          if (readOnlyRef.current || inputBlockedRef.current) return;
          const data = event.clipboardData;
          if (!data) return;
          // Any usable text on the clipboard → defer to xterm's native paste.
          if (data.getData("text")?.trim()) return;
          const hasImage =
            Array.from(data.items ?? []).some(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            ) ||
            Array.from(data.files ?? []).some((file) =>
              file.type.startsWith("image/"),
            );
          if (!hasImage) return;
          event.preventDefault();
          event.stopPropagation();
          void (async () => {
            const imagePath = await window.spark.clipboard.readImageAsTempFile?.();
            if (!imagePath) return;
            writeTokenRespectingBracketMode(shellEscapePath(imagePath, isWindows));
            onActivityRef.current?.();
            onUserInputRef.current?.();
          })();
        };
        host.addEventListener("paste", handlePaste, true);
        cleanups.push(() => {
          host.removeEventListener("paste", handlePaste, true);
        });
      }

      term.open(container.current);
      try {
        fit.fit();
      } catch {
        /* host may be 0×0 on first paint; ResizeObserver will fix it. */
      }
      // Prefer the in-memory snapshot captured during the previous unmount —
      // it's the full visible+scrollback buffer (capped by the configured line
      // limit) and exists only for workspace-switch round-trips. Falls back to the leaf's
      // localStorage-persisted scrollback (smaller, sampled) for the cold-start
      // app-restart path; that one still carries the RESTORE_NOTICE so the user
      // knows the prompt below is fresh.
      const liveSnapshot = xtermBufferSnapshots.get(sessionId);
      if (liveSnapshot) {
        // Replay the cached buffer, then any bytes that arrived while the pane
        // was hidden during its last life (pendingBytes). Keep the cache entry
        // until the async term.write callback fires (replayPending): if the
        // pane unmounts mid-parse — fast drag/drop remount or workspace
        // double-toggle — the cleanup must NOT overwrite the cache with the
        // half-parsed buffer, or scrollback truncates a little more each cycle.
        // The cache still holds the full original, so a skipped capture is the
        // correct choice there.
        const replay = trimTerminalScrollbackLines(
          liveSnapshot.text,
          scrollbackLineLimitRef.current,
        ).trimEnd();
        const pendingBytes = liveSnapshot.pendingBytes;
        replayPending = true;
        const finishReplay = () => {
          replayPending = false;
          xtermBufferSnapshots.delete(sessionId);
        };
        if (replay) {
          term.write(`${normalizeForTerminalReplay(replay)}\r\n`, () => {
            // Write the hidden-era bytes verbatim after the text replay has
            // parsed, then clear the pending flag in the final callback so the
            // ordering (text → hidden bytes) is preserved even under chunked
            // parsing.
            if (pendingBytes && pendingBytes.length > 0) {
              term.write(pendingBytes, finishReplay);
            } else {
              finishReplay();
            }
          });
        } else if (pendingBytes && pendingBytes.length > 0) {
          term.write(pendingBytes, finishReplay);
        } else {
          finishReplay();
        }
      } else {
        const restoredScrollback = trimTerminalScrollbackLines(
          initialScrollback?.trimEnd() ?? "",
          scrollbackLineLimitRef.current,
        ).trimEnd();
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
        const t = termRef.current;
        if (!t) return;
        t.options.theme = buildTerminalTheme();
        // Reassigning the theme clears the WebGL glyph atlas but does NOT
        // repaint rows already on screen — they keep their old colors until
        // fresh output arrives. After a dark→light switch that strands the
        // visible buffer as washed-out light-on-light text. Force every
        // visible row to re-render with the new palette.
        try {
          t.refresh(0, t.rows - 1);
        } catch {
          /* terminal may be mid-dispose during a fast theme + unmount race */
        }
      });

      // Per-session UTF-8 decoder so interleaved chunks across panes never
      // splice a multi-byte codepoint between unrelated streams.
      const urlDecoder = new TextDecoder("utf-8", { fatal: false });
      // Separate decoder for the agent-TUI sniffer so its stream state can't
      // interleave with the URL sniffer's.
      //
      // Phase machine:
      //   "idle"  → no agent running chip/state is currently advertised
      //   "agent" → a Claude / Codex / Cursor CLI is in the foreground;
      //             running=true has been emitted. We stay here until an exit
      //             signal or a forwarded Ctrl+C interrupts the active turn.
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
      //   - local Ctrl+C keydown — clears first-party manual chips promptly
      //     while returning true so xterm still forwards SIGINT to the PTY.
      //   - PTY exit — handled by onTerminalPaneExit in App.tsx (it nulls
      //     manual chips so they don't linger as stale "DONE" badges).
      const agentDecoder = new TextDecoder("utf-8", { fatal: false });
      let agentTextRing = "";
      // Tail of the previous PTY chunk's decoded text, prepended to the next
      // chunk before scanning for prompt / alt-screen markers. spark.ps1's OSC
      // 633;A / 133;A sequences (and `ESC[?1049l`) can land split across two
      // PTY chunks; testing the lone chunk would miss a marker whose ESC opener
      // arrived in the previous chunk and whose terminator arrives in this one.
      // 64 bytes comfortably spans any single OSC prompt marker or the 8-byte
      // alt-screen-leave sequence. Mirrors the main-process notifier's carry.
      let agentMarkerCarry = "";
      const MARKER_CARRY_MAX = 64;
      let agentPhase: "idle" | "agent" = "idle";
      // Tracks the first-party runtime ("claude"|"codex"|"cursor") if the
      // detected runtime maps to one — drives the state poller below, which
      // only has regex tables for those three. Non-first-party runtimes still
      // fire onAgentState (running=true) but skip the poller.
      let activeRuntime: "claude" | "codex" | "cursor" | null = null;
      // Separate input-routing memory from the chip/running phase. Ctrl+C can
      // end the active turn (so the chip must clear) while leaving an agent TUI
      // focused on its prompt; Shift+Enter should still insert a TUI newline
      // there instead of a shell continuation backslash.
      let recentAgentInputRuntime: PublicAgentRuntime | null = null;
      let recentAgentInputUntilMs = 0;
      const markRecentAgentInput = (runtime: PublicAgentRuntime | null) => {
        if (!runtime) return;
        recentAgentInputRuntime = runtime;
        recentAgentInputUntilMs = Date.now() + RECENT_AGENT_INPUT_GRACE_MS;
      };
      const clearRecentAgentInput = () => {
        recentAgentInputRuntime = null;
        recentAgentInputUntilMs = 0;
      };
      const hasRecentAgentInput = () => {
        if (!recentAgentInputRuntime) return false;
        if (Date.now() <= recentAgentInputUntilMs) return true;
        clearRecentAgentInput();
        return false;
      };
      // The three first-party runtimes the chrome detector / state poller have
      // anchors for. Iterated by the live-presence checks below (Fix 1
      // re-detection and Fix 3 Shift+Enter) so a still-visible idle agent is
      // recognised even when agentPhase has (wrongly or after a remount) lapsed
      // back to "idle" and activeRuntime is therefore null.
      const KNOWN_RUNTIMES = ["claude", "codex", "cursor"] as const;
      // Which first-party runtime's persistent chrome is currently visible in
      // `tail` (the BOTTOM rows), if any. Returns null when no agent chrome is
      // on the bottom of the screen. Deliberately checks the bottom tail only:
      // a stale footer sitting up in scrollback after a REAL exit (shell prompt
      // now at the bottom) must NOT read as a live agent.
      const liveRuntimeFromTail = (tail: string): PublicAgentRuntime | null => {
        for (const runtime of KNOWN_RUNTIMES) {
          if (agentUiPresent(runtime, tail)) return runtime;
        }
        return null;
      };
      // Fix 1 guard — a LATCH (not a timer) that suppresses level-triggered
      // re-detection after a POSITIVE exit. Set only when resetAgentPhase fired
      // on a positive exit signal (OSC prompt marker, alt-screen-leave, or the
      // UI-verified Ctrl+C exit probe — i.e. the agent really left). On a real
      // exit the agent's last footer frame lingers in the bottom tail far longer
      // than any fixed timer would cover: a returning shell prompt is only 1-2
      // lines, so a ~5-8-line Claude footer stays inside the bottom
      // STATE_TAIL_ROWS for a long time (potentially forever on an idle shell).
      // A wall-clock window therefore can't tell "stale footer after a real
      // exit" from "live footer of a still-running agent" — so we instead stay
      // suppressed until agentUiPresent has gone false AT LEAST ONCE since the
      // exit (the footer actually left the bottom tail). The poller's
      // ABSENCE-reset deliberately does NOT set this — and since that reset only
      // ever fires when agentUiPresent is ALREADY false, the latch it would set
      // is immediately satisfied, so a FALSE teardown still self-heals the
      // instant the footer reappears (the whole point of Fix 1).
      let redetectSuppressedAfterExit = false;
      const shouldUseAgentNewline = () => {
        if (agentPhase === "agent") return true;
        if (hasRecentAgentInput()) return true;
        // Fix 3 — gate on LIVE on-screen presence, not just lapsing phase/grace
        // state. If an agent's persistent footer chrome is visible on the bottom
        // rows RIGHT NOW, a Shift+Enter must insert the clean TUI newline
        // (\x1b\r) regardless of whether agentPhase happened to lapse back to
        // "idle" or the 10 s grace window expired. This decouples Shift+Enter
        // correctness from the fragile phase + grace state so a still-visible
        // idle Claude (e.g. paused 30 s+ between turns) never gets the literal
        // backslash. Reads the same bottom tail the poller uses so a stale
        // footer in scrollback (shell prompt back at the bottom) does NOT count.
        // Skip while post-exit-suppressed: right after a real `/exit` the agent's
        // footer can still sit in the bottom tail, and matching it here would send
        // the TUI newline at a bare shell prompt instead of the `\` continuation.
        const term = termRef.current;
        if (term && !redetectSuppressedAfterExit) {
          const liveRuntime = liveRuntimeFromTail(readTerminalTail(term, STATE_TAIL_ROWS));
          if (liveRuntime) {
            markRecentAgentInput(liveRuntime);
            return true;
          }
        }
        const sniffedRuntime = sniffRuntime(agentTextRing);
        const publicRuntime = sniffedRuntime ? coercePublicRuntime(sniffedRuntime) : null;
        if (publicRuntime) {
          markRecentAgentInput(publicRuntime);
          return true;
        }
        return false;
      };

      // ── Runtime state poller (the live working / blocked / idle / done
      // sniffer that drives chip tone and notifications). Polls the visible
      // xterm buffer every STATE_POLL_MS ms; only runs while an agent has
      // been detected in the pane (gated by agentPhase). All flags live in
      // this closure so they reset cleanly across agent enter/exit cycles.
      let stateTimer: number | null = null;
      let pendingState: RuntimeState | null = null;
      let confirmedState: RuntimeState | null = null;
      let idleSinceMs: number | null = null;
      // D4 (stale-footer false "working"): Claude/Codex leave their last footer
      // frame frozen on screen after a turn ends; classifyTail keeps matching
      // "working" off that static frame, so the working→idle debounce (gated on
      // raw===null) never arms and the chip stays stuck on "working" even while
      // the pane is visible. We remember the tail the poller last saw and, once
      // confirmedState==="working", only TREAT a "working" classification as
      // live if the tail actually CHANGED since last tick — a live turn repaints
      // its ticking-seconds footer every ~second, a finished one is byte-static.
      // A byte-identical tail is coerced to null so the existing idle debounce
      // arms promptly. Reset across agent enter/exit so a new turn starts clean.
      let lastWorkingTail: string | null = null;
      // Bug B (baseline idle): a launched-but-never-worked agent (the user
      // typed `claude`, the idle box is up, nothing run yet) classifies as
      // null forever, so confirmedState stays null and the chip would fall
      // back to a pulsing "running" tone. Once null has held for the debounce
      // window with no prior working confirmation, resolve to a calm "idle".
      let baselineIdleSinceMs: number | null = null;
      // Bug A (poller-driven exit detection): how many consecutive ticks the
      // persistent agent UI chrome has been ABSENT from the visible tail. Inline
      // Claude Code v2 renders no alt-screen and may emit no prompt marker on a
      // Ctrl+C exit, so the only reliable "agent is gone" signal left is its UI
      // chrome disappearing and the shell prompt returning. Requires several
      // consecutive absent ticks (UI_GONE_TICKS) to ride out scroll/redraw
      // flicker; an idle Claude box keeps the chrome present so it never trips.
      let uiGoneTicks = 0;
      // Bug A (Ctrl+C fast path): one-shot timer armed on a forwarded Ctrl+C in
      // an active agent pane. When it fires we reset ONLY if the agent UI is
      // truly gone (a real exit) — a mere turn-interrupt leaves the idle box up,
      // so agentUiPresent stays true and we leave the chip alone. Tracked here
      // so a fresh working signal or unmount can cancel it.
      let ctrlCExitTimer: number | null = null;
      const clearCtrlCExitTimer = () => {
        if (ctrlCExitTimer !== null) {
          window.clearTimeout(ctrlCExitTimer);
          ctrlCExitTimer = null;
        }
      };
      const reportRuntimeState = (state: RuntimeState) => {
        void window.spark.terminalState?.report?.({ paneId: sessionId, state });
        // Surface the same debounced state to the renderer so a manual pane's
        // worker chip can render the finer label/tone. Main still gets the
        // report above (used for Spark-owned attempts / notifications); this is
        // purely the renderer-side mirror.
        onRuntimeStateRef.current?.(state);
      };
      const stopStatePoller = () => {
        if (stateTimer !== null) {
          window.clearInterval(stateTimer);
          stateTimer = null;
        }
        pendingState = null;
        confirmedState = null;
        idleSinceMs = null;
        baselineIdleSinceMs = null;
        uiGoneTicks = 0;
        lastWorkingTail = null;
        clearCtrlCExitTimer();
      };
      const tickStatePoller = () => {
        const t = termRef.current;
        if (!t || !activeRuntime) return;
        const tail = readTerminalTail(t, STATE_TAIL_ROWS);
        const raw = classifyTail(activeRuntime, tail);
        const now = Date.now();

        // D4 (stale-footer false "working"). Once a turn is confirmed working,
        // a live turn keeps repainting its footer (the ticking elapsed-seconds
        // counter) so the tail changes every tick; a FINISHED turn leaves the
        // last footer frame frozen on screen, and classifyTail keeps matching
        // "working" off that static frame forever. Downgrade such a frozen-frame
        // "working" to null so the working→idle debounce below can arm and the
        // visible chip flips to "ready" promptly. Only kicks in once we're
        // already confirmed working — a fresh, not-yet-confirmed turn is left to
        // the pendingState confirm path untouched. We compare against the tail
        // captured on the previous tick; the UI-gone / exit-detection block keeps
        // using the unmodified `raw` so its semantics are unchanged.
        //
        // CLAUDE ONLY. Claude repaints its footer's elapsed-seconds counter at
        // least once a second while working, so a live turn's tail always changes
        // within the 1.2s idle debounce — a byte-identical tail reliably means the
        // turn finished. Codex/Cursor repaint their footer RARELY (Codex only
        // shimmers the word "Working" between full repaints; see the note in
        // terminal-agent-notify.ts), so a quiet 20-30s tool call would go
        // byte-identical mid-turn and false-flip to "ready". For those runtimes we
        // do NOT use absence-of-tail-change as an idle signal — the focus-
        // independent notifier (emitPaneState) drives their turn-complete instead.
        let effectiveRaw = raw;
        if (activeRuntime === "claude" && confirmedState === "working" && raw === "working") {
          if (lastWorkingTail !== null && tail === lastWorkingTail) {
            // Byte-identical footer for a full tick → not live working anymore.
            effectiveRaw = null;
          }
        }
        // Remember the current tail whenever working is in play so the next tick
        // can detect a frozen footer. Cleared elsewhere on agent enter/exit.
        if (raw === "working" || confirmedState === "working") {
          lastWorkingTail = tail;
        } else {
          lastWorkingTail = null;
        }

        // Bug A — poller-driven exit detection. The agent's persistent UI
        // chrome (input box / footer hints / statusline) stays on screen the
        // whole time the TUI is up, idle OR working; it vanishes only once the
        // agent has exited and the plain shell prompt is back. Inline Claude
        // Code v2 emits neither an alt-screen-leave nor (reliably) an OSC
        // prompt marker on a Ctrl+C exit, so a sustained chrome-absence is the
        // backstop "agent is gone" signal. Require several consecutive absent
        // ticks to ride out scroll/redraw flicker, and only reset when nothing
        // is actively classifying as working/blocked — a still-running turn (or
        // a permission prompt) must never be torn down. An idle Claude box keeps
        // the chrome present, so a turn-interrupt that leaves the box up never
        // trips this. NOTE the poller is frozen while the pane is hidden (no
        // visible xterm to read); a pane that exits while hidden is cleared by
        // the carry-aware byte-level prompt-marker / alt-screen-leave path in
        // processAgentChunkText instead, and otherwise resolves once refocused.
        //
        // FAIL-SAFE: this pure-absence reset only runs for runtimes whose IDLE
        // chrome is VERIFIED (absenceResetSafe — Claude only today). For Codex /
        // Cursor, whose idle-composer anchors are unverified, anchor-absence
        // alone must NOT clear the chip: an idle agent with mismatched anchors
        // would otherwise be killed ~1.2s after a turn. Those clear via positive
        // signals (OSC prompt markers, alt-screen-leave, pty exit) instead.
        //
        // Fix 2 — this absence backstop is deliberately PATIENT and only runs on
        // a VISIBLE pane, because firing it early is the root cause of the
        // "chip vanishes while the agent is still alive" bug:
        //   • VISIBLE-ONLY: the poller runs on its interval even while hidden,
        //     but a hidden pane skips term.write so its xterm buffer is FROZEN —
        //     reading that stale tail can show no chrome and falsely trip the
        //     reset. A pane that genuinely exits while hidden is cleared by the
        //     carry-aware byte-level prompt-marker / alt-screen-leave path in
        //     processAgentChunkText, and otherwise resolves once refocused.
        //   • PATIENT THRESHOLD: a single anchor dropout — a full-screen redraw,
        //     a brief user scroll, a split/resize reflow, or a quiet idle frame
        //     that pushes the footer out of the 40-row tail — must not tear down
        //     a live agent. UI_GONE_TICKS is therefore several SECONDS of
        //     SUSTAINED absence, not ~1s. The only cost of waiting longer is a
        //     slightly late chip-clear on a marker-less real exit (e.g. typed
        //     `exit` / `/exit`); the cost of firing early is the reported
        //     vanishing-while-alive bug, so we bias strongly toward patience.
        //   • SELF-HEALING: even if this does fire a false reset, Fix 1's
        //     level-triggered re-detection restores the chip on the very next
        //     footer repaint, so the two fixes together are robust.
        // The FAST positive exit signals stay authoritative and prompt: the
        // Ctrl+C-armed exit probe (CTRL_C_EXIT_PROBE_MS, gated on
        // agentUiPresent===false) and the OSC prompt-marker / alt-screen-leave
        // resets handle real exits within ~2s. This absence reset is only the
        // slow backstop for exits that emit no marker at all.
        if (
          absenceResetSafe(activeRuntime) &&
          visibleRef.current &&
          raw === null &&
          !agentUiPresent(activeRuntime, tail)
        ) {
          uiGoneTicks += 1;
          if (uiGoneTicks >= UI_GONE_TICKS) {
            resetAgentPhase();
            return;
          }
        } else {
          // Any classifiable state, returned chrome, or a hidden pane resets the
          // counter to 0 so absence must be SUSTAINED and uninterrupted before
          // the backstop can fire — a transient dropout never accumulates.
          uiGoneTicks = 0;
        }

        if (confirmedState === "working" && effectiveRaw === null) {
          if (idleSinceMs === null) idleSinceMs = now;
          if (now - idleSinceMs >= IDLE_DEBOUNCE_MS) {
            confirmedState = "idle";
            pendingState = null;
            idleSinceMs = null;
            lastWorkingTail = null;
            reportRuntimeState("idle");
          }
          return;
        }
        idleSinceMs = null;
        if (effectiveRaw === null) {
          pendingState = null;
          // Bug B — baseline idle. A launched-but-never-worked agent (idle box
          // up, nothing run yet) classifies as null indefinitely, so without
          // this it would stay runtimeState=undefined and the chip would render
          // the pulsing "running" fallback. Once null has held for the debounce
          // window with no prior working confirmation, resolve it to a calm
          // "idle" so the chip reads as a present-but-quiet agent. The UI-gone
          // branch above runs first, so a vanished agent is reset rather than
          // reported idle here. After the first real working confirmation this
          // branch is inert (confirmedState !== null); the working→idle debounce
          // above owns the idle transition from then on.
          if (confirmedState === null) {
            if (baselineIdleSinceMs === null) baselineIdleSinceMs = now;
            if (now - baselineIdleSinceMs >= IDLE_DEBOUNCE_MS) {
              confirmedState = "idle";
              baselineIdleSinceMs = null;
              reportRuntimeState("idle");
            }
          }
          return;
        }
        baselineIdleSinceMs = null;
        if (pendingState !== effectiveRaw) {
          pendingState = effectiveRaw;
          return;
        }
        if (confirmedState !== effectiveRaw) {
          confirmedState = effectiveRaw;
          // A confirmed working/blocked signal means the agent is alive and
          // active — stand down the Ctrl+C exit one-shot so it can't fire after
          // a new turn started post-interrupt.
          if (effectiveRaw === "working" || effectiveRaw === "blocked") clearCtrlCExitTimer();
          reportRuntimeState(effectiveRaw);
        }
      };
      const startStatePoller = (runtime: "claude" | "codex" | "cursor") => {
        activeRuntime = runtime;
        pendingState = null;
        confirmedState = null;
        idleSinceMs = null;
        baselineIdleSinceMs = null;
        uiGoneTicks = 0;
        lastWorkingTail = null;
        clearCtrlCExitTimer();
        if (stateTimer !== null) window.clearInterval(stateTimer);
        stateTimer = window.setInterval(tickStatePoller, STATE_POLL_MS);
      };

      const setAgentRunning = (runtime: AgentRuntime | null) => {
        if (agentPhase === "agent") return;
        agentPhase = "agent";
        // A fresh launch/relaunch re-arms re-detection: any prior post-exit
        // suppression latch is now stale.
        redetectSuppressedAfterExit = false;
        // Start agent-phase marker scanning from a clean carry. The carry is
        // advanced on every chunk INCLUDING the idle-phase chunks before launch,
        // so its up-to-64-byte tail can still hold the pre-launch shell prompt's
        // own OSC 133;A / 633;A marker. Without this reset, the very next chunk's
        // `markerScan = agentMarkerCarry + chunkText` would re-match that stale
        // prompt marker and immediately fire resetAgentPhase() — killing the
        // just-launched agent's chip one chunk after launch. Most reproducible
        // when the runtime is detected from a tiny 633;E command chunk while the
        // carry still holds the idle prompt's marker.
        agentMarkerCarry = "";
        // Coerce non-first-party runtimes down to `null` at the boundary so
        // App.tsx / TerminalStack / run-store keep seeing the existing public
        // surface ("claude" | "codex" | "cursor" | null) without growing new
        // cases for every newly detected CLI. running=true still fires so the
        // activity indicator tracks correctly. A null `runtime` argument
        // means "something is interactive but we don't know what" — used by
        // the alt-screen fallback below for unrecognised TUIs.
        const publicRuntime = runtime ? coercePublicRuntime(runtime) : null;
        markRecentAgentInput(publicRuntime);
        onAgentStateRef.current?.({ runtime: publicRuntime, running: true });
        // Only the three first-party runtimes have regex tables in
        // RUNTIME_PATTERNS — others rely on hook reports from E1 or no state
        // signal at all.
        if (publicRuntime) {
          startStatePoller(publicRuntime);
          // D5 (launching). The agent was just detected but the poller hasn't
          // classified working/idle yet (confirmedState is null after the
          // startStatePoller reset). Report "launching" so the chip reads
          // "starting" rather than falling back to the lifecycle-derived tone.
          // We do NOT set confirmedState, so the baseline-idle path in
          // tickStatePoller still resolves this to "idle" once the agent settles
          // at its input box, and a real working signal still overrides it.
          reportRuntimeState("launching");
        }
      };
      const resetAgentPhase = (
        options: { keepRecentAgentInput?: boolean; exitSignal?: boolean } = {},
      ) => {
        // A POSITIVE exit signal (prompt marker / alt-screen-leave / UI-verified
        // Ctrl+C exit) means the agent genuinely left — briefly suppress Fix 1's
        // re-detection so a footer frame still lingering in the bottom tail can't
        // resurrect the chip. Absence-poller teardowns omit this flag so they
        // stay freely self-healing.
        if (options.exitSignal) {
          redetectSuppressedAfterExit = true;
        }
        const runtimeForRecentInput = activeRuntime ?? recentAgentInputRuntime;
        if (agentPhase === "agent") {
          onAgentStateRef.current?.({ runtime: null, running: false });
          // The TUI just exited or the active turn was interrupted; flip the
          // live state to "done" so any UI subscriber sees the transition
          // immediately. The poller stops here — we don't keep scanning a
          // pwsh prompt for blocked/working patterns.
          if (confirmedState !== "done") {
            confirmedState = "done";
            reportRuntimeState("done");
          }
        }
        if (options.keepRecentAgentInput) {
          markRecentAgentInput(runtimeForRecentInput);
        } else {
          clearRecentAgentInput();
        }
        activeRuntime = null;
        stopStatePoller();
        agentPhase = "idle";
        agentTextRing = "";
        agentMarkerCarry = "";
      };
      const handleAgentInterruptKey = () => {
        if (readOnlyRef.current || inputBlockedRef.current) return;
        if (agentPhase !== "agent" || !activeRuntime) return;
        // A single Ctrl+C in Claude Code / Codex / Cursor almost never exits
        // the TUI — it clears the input box, interrupts the current turn, or
        // prints "press again to exit". Flipping agentPhase to idle here used
        // to fire reportRuntimeState('done'), which run-store persisted as a
        // false runtimeState='done' on the worker attempt with no reliable
        // recovery (banner not reprinted, alt-screen not re-entered). So do
        // NOT reset on keydown: the output-based exit signals (ESC[?1049l,
        // OSC 633/133 prompt markers, pty exit) and the poller's UI-gone
        // backstop are the resetAgentPhase triggers. We still refresh the
        // agent-newline grace window so a following Shift+Enter inserts a TUI
        // newline rather than a shell continuation backslash while the
        // interrupted prompt stays focused.
        markRecentAgentInput(activeRuntime);
        // Bug A — Ctrl+C-armed, UI-gated confirmation (fast path). A single
        // Ctrl+C usually only interrupts the turn (idle box stays up) but it is
        // ALSO how the user exits the agent back to the shell — twice in quick
        // succession, or once when the input box is already empty. Arm a bounded
        // one-shot: when it fires, reset ONLY if the agent's UI chrome is gone
        // by then (a real exit). A turn-interrupt leaves the idle box up →
        // agentUiPresent stays true → we leave the chip alone. This clears the
        // chip a beat after a real Ctrl+C exit; the poller's UI-gone debounce is
        // the backstop if the timer's single sample lands mid-teardown. Re-arm
        // on each Ctrl+C so a double-tap measures from the last press.
        //
        // FAIL-SAFE: this fires resetAgentPhase off an agentUiPresent===false
        // sample, so it carries the same "unverified idle anchors → false UI
        // gone → kill a live agent" risk as the poller path. Only arm it for
        // runtimes whose idle chrome is verified (absenceResetSafe — Claude).
        // Codex / Cursor clear via positive exit signals only.
        if (!absenceResetSafe(activeRuntime)) return;
        clearCtrlCExitTimer();
        ctrlCExitTimer = window.setTimeout(() => {
          ctrlCExitTimer = null;
          if (agentPhase !== "agent" || !activeRuntime) return;
          const term = termRef.current;
          if (!term) return;
          const tail = readTerminalTail(term, STATE_TAIL_ROWS);
          // Gate strictly on UI-absent: a still-present box (turn-interrupt)
          // must never reset. A live working footer also keeps us out — if the
          // agent resumed a turn after the interrupt, its chrome/footer is back.
          if (agentUiPresent(activeRuntime, tail)) return;
          if (classifyTail(activeRuntime, tail) !== null) return;
          // Positive exit (UI verified gone) — suppress re-detection briefly.
          resetAgentPhase({ exitSignal: true });
        }, CTRL_C_EXIT_PROBE_MS);
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
          // Positive prompt-return marker — suppress re-detection briefly so a
          // lingering footer frame can't resurrect the just-cleared chip.
          resetAgentPhase({ exitSignal: true });
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
        if (data.startsWith("A")) resetAgentPhase({ exitSignal: true });
        return false;
      });
      cleanups.push(() => osc133Dispose.dispose());

      const processAgentChunkText = (chunkText: string) => {
        if (!onAgentStateRef.current) return;
        if (chunkText.length > 0) {
          agentTextRing = (agentTextRing + chunkText).slice(-8192);
        }
        // Carry-aware marker scan: prepend the previous chunk's tail so a
        // prompt marker / alt-screen-leave split across the PTY chunk boundary
        // is still caught. Using just `chunkText` would miss a `633;A`/`133;A`
        // whose ESC opener arrived last chunk and terminator arrives this one
        // (and vice-versa). The carry is updated at the end of this function.
        const markerScan = agentMarkerCarry + chunkText;
        // Advance the carry now (before any early return) so the next chunk
        // always sees this chunk's tail, regardless of which branch we exit by.
        agentMarkerCarry = markerScan.slice(-MARKER_CARRY_MAX);
        const sawAltScreenLeave = markerScan.includes("\x1b[?1049l");
        const sawPromptMarker = hasPromptMarker(markerScan);
        if (
          agentPhase === "idle" &&
          recentAgentInputRuntime &&
          (sawAltScreenLeave || sawPromptMarker)
        ) {
          clearRecentAgentInput();
        }
        if (agentPhase === "idle") {
          const runtime = sniffOsc633CommandRuntime(agentTextRing) ?? sniffRuntime(agentTextRing);
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
          } else if (
            !sawAltScreenLeave &&
            !sawPromptMarker &&
            visibleRef.current
          ) {
            // Fix 1 (linchpin) — self-healing, LEVEL-triggered re-detection.
            // The signals above (launch banner, 633;E command line,
            // alt-screen-enter) are EDGE-triggered: they only fire on a fresh
            // launch. So if a still-running agent's chip was ever torn down —
            // by the poller's absence-reset firing early on a transient anchor
            // dropout, or by any pane remount that reset agentPhase to "idle" —
            // it would never recover, leaving the chip gone and Shift+Enter
            // sending a literal backslash. Re-detect an already-running agent
            // from its PERSISTENT footer chrome: if the bottom tail still shows
            // a known runtime's chrome, re-enter agent phase. setAgentRunning
            // early-returns once agentPhase==="agent", so this only fires from
            // idle and won't re-trigger every chunk.
            //
            // Guards:
            //  - BOTTOM tail only (readTerminalTail → last STATE_TAIL_ROWS rows,
            //    same as the poller). A stale footer sitting up in scrollback
            //    after a REAL exit — shell prompt now at the bottom — reads as
            //    UI-absent, so a genuinely-exited agent is NOT resurrected.
            //  - Skip when this chunk carried a prompt-marker / alt-screen-leave:
            //    those are exit signals, and re-detecting on the same chunk that
            //    a real exit arrived on would immediately undo the reset.
            //  - Post-exit LATCH (set only by a POSITIVE exit signal): right
            //    after a real `/exit`/`exit` the agent's footer lingers in the
            //    bottom tail far longer than any timer — a 1-2 line shell prompt
            //    barely pushes a 5-8 line footer up, so it stays inside the tail
            //    (forever on an idle shell). So we stay suppressed until the
            //    footer has left the tail at least once (liveRuntime === null),
            //    then re-arm. Absence-poller teardowns omit the flag AND only
            //    fire when the UI was already absent, so a FALSE teardown
            //    self-heals immediately when the footer reappears.
            //  - VISIBLE panes only: a hidden pane's xterm buffer is frozen
            //    (hidden panes skip term.write), so its tail is stale and could
            //    re-detect against an old frame.
            const term = termRef.current;
            if (term) {
              const liveRuntime = liveRuntimeFromTail(
                readTerminalTail(term, STATE_TAIL_ROWS),
              );
              if (!liveRuntime) {
                // Agent chrome is gone from the bottom tail — a real exit's
                // stale footer has finally scrolled out (or a false teardown was
                // already UI-absent). Re-arm: future repaints may re-detect.
                redetectSuppressedAfterExit = false;
              } else if (!redetectSuppressedAfterExit) {
                setAgentRunning(liveRuntime);
              }
              // else: footer present but still post-exit-suppressed (lingering
              // stale frame) → do nothing until it leaves the tail once.
            }
          }
          return;
        }

        // In agent phase. Watch for any of these and reset:
        //   - alt-screen-leave (Codex's exit signal)
        //   - OSC 633;A / 633;D / 633;B / 633;P (spark.ps1's Prompt)
        //   - OSC 133;A / 133;D (generic FinalTerm prompt-start / command-done)
        // Also reset on byte-level matches as a parser-bypass safety
        // net, since xterm's OSC handler chain has caused us issues
        // before with code 633. This path also runs while panes are hidden,
        // where xterm parser OSC handlers intentionally do not run.
        if (sawAltScreenLeave || sawPromptMarker) {
          // Positive byte-level exit signal — suppress re-detection briefly so a
          // lingering footer frame can't resurrect the just-cleared chip.
          resetAgentPhase({ exitSignal: true });
        }
      };

      const offData = window.spark.pty.onData(sessionId, (data) => {
        // Main ships Uint8Array. xterm.js's parser reassembles partial ANSI
        // sequences across writes when fed Uint8Array, which is what TUIs
        // (claude/codex/Ink) need to render cursor sequences without smearing.
        const bytes =
          data instanceof Uint8Array
            ? data
            : new TextEncoder().encode(String(data));

        // Keep the agent lifecycle sniffer running even while the pane is
        // hidden. Hidden panes skip xterm.write(), so parser OSC handlers do
        // not run; byte-level detection is what clears stale Codex/Claude chips
        // and preserves agent Shift+Enter behavior when the user returns.
        if (onAgentStateRef.current) {
          processAgentChunkText(agentDecoder.decode(bytes, { stream: true }));
        }

        // Hidden-pane fast path. When the pane isn't on screen, skip the
        // visual hot path — xterm.write (DOM cell churn) and URL sniff — and
        // just stash the raw bytes. They'll be flushed in one write on the
        // next visible-transition. PTY keeps streaming; only the renderer-side
        // rendering cost is deferred.
        if (!visibleRef.current) {
          hiddenBufferRef.current.push(bytes);
          hiddenBytesRef.current += bytes.length;
          hiddenLineBreaksRef.current += countLineFeeds(bytes);
          // Trim by both bytes and the user line-limit so a long-running
          // hidden pane can't pin arbitrary renderer memory or retain more
          // hidden output lines than the terminal is configured to display.
          trimHiddenBufferToLimits();
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
        // for exit detection ran above, before the hidden-pane early return.
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
      // If a snapshot replay is still mid-parse, the xterm buffer is only
      // partially populated — capturing it now would store a truncated
      // snapshot and progressively erode scrollback across fast remount
      // cycles. The cache still holds the full original (we delete it only in
      // the replay write callback), so skip re-snapshotting entirely here.
      if (dyingTerm && !replayPending) {
        try {
          const text = captureXtermBuffer(dyingTerm, scrollbackLineLimitRef.current);
          // Bytes that streamed in while this pane was hidden never reached
          // xterm (the hidden fast path stashes them instead), so the captured
          // text by construction lacks them. Stash them alongside the text as
          // pendingBytes so the next mount can replay: text → hidden bytes →
          // post-pause backlog from main. Honor the configured scrollback line
          // limit on the stashed combination too, reusing the same trim helper
          // the hot path uses.
          const pendingBytes = mergeHiddenBuffer(
            hiddenBufferRef.current,
            hiddenBytesRef.current,
            scrollbackLineLimitRef.current,
          );
          if (text.length > 0 || (pendingBytes && pendingBytes.length > 0)) {
            rememberXtermBufferSnapshot(sessionId, { text, pendingBytes });
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
      // The hidden-pane bytes have been folded into the snapshot's pendingBytes
      // above (when we snapshotted); clear the live buffer now. main's pause()
      // only preserves not-yet-flushed pendingChunks, so already-delivered
      // hidden bytes exist nowhere else — the snapshot is their only home.
      hiddenBufferRef.current = [];
      hiddenBytesRef.current = 0;
      hiddenLineBreaksRef.current = 0;
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
      hiddenLineBreaksRef.current = 0;
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
    const requested = Number.isFinite(maxLines) ? Math.max(0, Math.trunc(maxLines)) : 200;
    const limit = Math.min(scrollbackLineLimitRef.current, requested);
    if (limit <= 0) return "";
    const buf = t.buffer.normal;
    const total = buf.length;
    const lines: string[] = [];
    const start = Math.max(0, total - limit);
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

function countLineFeeds(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 10) count += 1;
  }
  return count;
}

// Coalesce the FIFO list of hidden-pane chunks into one contiguous buffer,
// trimmed from the front to honor the configured scrollback line limit (so the
// stashed pendingBytes never carry more lines than the terminal would retain).
// Returns null when there's nothing to stash. Mirrors the line-limit backward
// scan in trimHiddenBufferToLimits — kept here so the unmount snapshot path
// applies the same semantics as the live hot path.
function mergeHiddenBuffer(
  chunks: Uint8Array[],
  totalBytes: number,
  scrollbackLineLimit: number,
): Uint8Array | null {
  if (totalBytes <= 0 || chunks.length === 0) return null;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const maxLineBreaks = Math.max(0, scrollbackLineLimit);
  let start = 0;
  let seen = 0;
  for (let i = totalBytes - 1; i >= 0; i--) {
    if (merged[i] !== 10) continue;
    seen += 1;
    if (seen > maxLineBreaks) {
      start = i + 1;
      break;
    }
  }
  const trimmed = start > 0 ? merged.slice(start) : merged;
  return trimmed.length > 0 ? trimmed : null;
}

// Read up to `maxLines` lines from the end of the xterm buffer (visible rows
// + scrollback) as plain text. Wrapped logical lines are stitched back
// together so a long Claude/Codex response that line-wrapped in the original
// width still replays as one line. Loses ANSI styling — replay is intended
// to give the user readable scrollback after a workspace round-trip, not
// pixel-perfect re-rendering of an Ink TUI's last frame. Trailing empty
// rows are trimmed so the replayed text doesn't open with blank space.
function captureXtermBuffer(term: Terminal, maxLines: number): string {
  const limit = Number.isFinite(maxLines) ? Math.max(0, Math.trunc(maxLines)) : 0;
  if (limit <= 0) return "";
  const buf = term.buffer.normal;
  const total = buf.length;
  const start = Math.max(0, total - limit);
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
// Bug A / Fix 2 — consecutive poller ticks the persistent agent UI chrome must
// be ABSENT from the VISIBLE tail before this slow backstop treats the agent as
// exited and clears the chip. At STATE_POLL_MS (300 ms) this is 14 × 300 ≈
// 4.2 s of SUSTAINED, uninterrupted absence.
//
// Raised from 4 (~1.2 s) because the old window fired falsely whenever an idle
// (still-running) Claude's footer briefly drifted out of the 40-row tail — a
// long response on screen, a user scroll, or a split/resize reflow — tearing
// down a LIVE agent's chip after ~1.2 s (the reported "chip vanishes while
// alive" bug) and flipping Shift+Enter to the literal-backslash path. The
// backstop only needs to catch marker-less exits (typed `exit` / `/exit`),
// which are not latency-sensitive, so we bias strongly toward patience: the
// downside of waiting longer is a slightly late chip-clear on those rare exits;
// the downside of firing early is killing a live agent. The fast positive exit
// signals (Ctrl+C exit probe, OSC prompt markers, alt-screen-leave, pty exit)
// still clear real exits within ~2 s, and Fix 1's level-triggered re-detection
// self-heals any residual false reset on the next footer repaint.
const UI_GONE_TICKS = 14;
// Bug A — delay before the Ctrl+C-armed one-shot samples the tail to decide
// whether the agent actually exited. Long enough for Claude/Codex to finish
// tearing down their TUI and the shell prompt to repaint after a real exit,
// short enough to feel snappy. If this single sample lands mid-teardown the
// UI_GONE_TICKS poller debounce is the backstop.
const CTRL_C_EXIT_PROBE_MS = 2_000;

// unescapeOsc633 / hasPromptMarker now come from @shared/agent-patterns.
