import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  normalizeTerminalScrollbackLineLimit,
  trimTerminalScrollbackLines,
  type PtyExitInfo,
  type RuntimeState,
  type ShellInfo,
  type TerminalAgentForegroundState,
} from "@shared/types";
import {
  absenceResetSafe,
  advanceGenericArm,
  agentUiPresent,
  classifyTail,
  coercePublicRuntime,
  hasPromptMarker,
  promoteGenericArm,
  runtimeFromCommandLine,
  sniffLiveRuntime,
  sniffOsc633CommandRuntime,
  stripAnsi,
  unescapeOsc633,
  CLAUDE_RESUME_FAILED_RE,
  TUI_ALT_SCREEN_ENTER,
  type AgentRuntime,
  type PublicAgentRuntime,
} from "@shared/agent-patterns";
import { formatPaneExitLine } from "@shared/pane-format";
import { detectMonoFontFamily } from "../../lib/fonts";
import { subscribeAppTokens } from "../../lib/theme-tokens";
import { createFileLinkProvider } from "./file-link-provider";
import { createReplayTracker } from "./replayTracker";
import {
  registerCwdHandler,
  registerPromptTracker,
  registerSparkOpenHandler,
  type SparkOpenInput,
} from "./osc-handlers";
import { buildTerminalTheme } from "./terminalTheme";
import {
  buildAgentResumeCommand,
  buildClaudeLaunch,
  buildGrokLaunch,
  isAgentSessionLaunchCommand,
} from "../../workers/launch-commands";
import type { TerminalAgentSession } from "../../tabs/types";
import {
  canAutoResume,
  decideResume,
  mergeSessionStart,
  pruneAttempts,
  type ResumeProbe,
  type SessionStartRecord,
} from "./resume-policy";
import { isAppTearingDown } from "../../lib/app-lifecycle";
import { subscribeExternalTerminalSize } from "./terminalRegistry";
import { preserveTerminalViewport } from "./terminalViewport";

export type { SparkOpenInput };

const FONT_SIZE = 13;
const FIT_DEBOUNCE_MS = 8;
// Cap on consecutive WebGL addon reloads triggered by a lost GL context when a
// pane is re-shown. Past this we stop reloading and let xterm ride the DOM
// renderer, so a machine that can't hold a context (GPU eviction storms, driver
// flake) doesn't thrash a new addon on every tab switch.
const WEBGL_MAX_RELOADS = 3;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const PTY_MANAGER_RESET_SEQUENCE = "\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l";

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
  // A backslash cannot escape a control character: backslash-newline is shell
  // LINE CONTINUATION (the newline is deleted), so a CR/LF-bearing filename
  // would silently round-trip to a different path. Single quotes preserve
  // control characters literally — fall back to quote-wrapping for those.
  if (/[\r\n]/.test(path)) {
    return `'${path.replace(/'/g, "'\\''")}'`;
  }
  // POSIX: backslash-escape ASCII shell specials only, exactly like iTerm2's
  // drag-and-drop "escape special characters" mode. `/Users/x/My Photos/a
  // b.png` becomes `/Users/x/My\ Photos/a\ b.png` — spaces, quotes, parens,
  // `$`, `&`, `;`, `*`, etc. get a leading backslash. Everything non-ASCII
  // (é, CJK, emoji) stays BARE, also matching iTerm2: bash/zsh don't need it
  // escaped, and Claude Code's image-path unescaper is only known to strip
  // backslashes before ASCII specials.
  //
  // The `u` flag keeps the class matching whole code points (belt-and-braces;
  // the \u{0080}-\u{10FFFF} carve-out already exempts all multi-byte characters,
  // so no backslash can land between surrogate halves).
  return path.replace(/[^A-Za-z0-9_./\-\u{0080}-\u{10FFFF}]/gu, "\\$&");
}
// After an agent turn is interrupted with Ctrl+C, Claude/Codex often
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
// Prepared native-account login tokens are one-shot. A React/HMR remount may
// attach to the same PTY, but it must never submit the consumed token again.
const nativeCliLoginTokenFiredSessions = new Set<string>();
// Per-sessionId timestamps of in-place auto-resume attempts (a PTY that died
// while an agent was live got its shell respawned with `--resume`). Module-level
// so the crash-loop guard survives StrictMode/HMR remounts, like the set above.
// See the pty onExit re-arm below and canAutoResume().
const autoResumeAttempts = new Map<string, number[]>();
// Panes that already printed the "previous session available" hint this app
// run — the hint fires once per pane, not on every workspace-switch remount.
const resumeHintShown = new Set<string>();

// These registries are remount guards, not durable terminal state. App calls
// this only after a pane disappears from every active/inactive workspace
// layout. Exact lifecycle cleanup keeps them bounded without an arbitrary cap
// that could evict a still-live terminal in an unusually large workspace.
export function forgetTerminalSessionMemory(sessionId: string): void {
  autorunFiredSessions.delete(sessionId);
  nativeCliLoginTokenFiredSessions.delete(sessionId);
  autoResumeAttempts.delete(sessionId);
  resumeHintShown.delete(sessionId);
}

// Persistent diagnostic trail for restore decisions (<codaraHome>/logs/main.log
// via main). "Some panes resume, some don't" is undebuggable from memory alone.
function logRestore(line: string): void {
  try {
    window.spark.agentSession.logRestore?.(line);
  } catch {
    /* stale preload without the channel; diagnostics only */
  }
}
interface ResumePlan {
  // The command to hand pty.spawn's startupCommand: a `--resume`/`resume` for a
  // healthy session, a fresh forced-id `claude` launch for a Claude self-heal,
  // or null for Codex-with-a-dead-rollout (nothing deterministic to relaunch).
  resumeCommand: string | null;
  // True when resumeCommand is a FRESH launch (Claude self-heal), not a resume —
  // suppresses the refusal watch, which only makes sense for a real resume.
  resumeIsFreshFallback: boolean;
  // One-line dim notice to print after spawn (self-heal / clear-pointer cases).
  fallbackNotice: string | null;
  // Replacement pointer to persist (fresh Claude self-heal), else null.
  fallbackSession: TerminalAgentSession | null;
}

// Heal a pane's restore pointer from the SessionStart hook trail before any
// resume/hint decision. In-TUI `/resume` and `/clear` switch the session id
// with no filesystem signal discovery can see, so the persisted pointer may
// name a session the user long since left — the registry in main holds the
// EXACT id of the last session that ran in this pane. Returns the healed
// pointer, or null when the pointer is already current (or no hook record
// exists — hooks not installed, python missing, pre-hook sessions).
async function fetchSessionStartHeal(
  paneId: string,
  pointer: TerminalAgentSession | null | undefined,
): Promise<TerminalAgentSession | null> {
  let start: SessionStartRecord | null = null;
  try {
    // Optional chaining: a stale preload without the channel just skips healing.
    start = (await window.spark.agentSession.latestStart?.(paneId)) ?? null;
  } catch {
    start = null;
  }
  return mergeSessionStart(pointer, start);
}

// Decide how to (re)start a saved Claude/Codex session: probe the transcript,
// repair a sleep-truncated Claude tail so `--resume` accepts it (instead of
// silently losing the conversation to a fresh session), and return the command
// + self-heal bookkeeping. Shared by the boot-once restore path and the in-place
// death re-arm path. The pure branch choice lives in decideResume (resume-policy).
async function computeResumePlan(restore: TerminalAgentSession): Promise<ResumePlan> {
  const probe = await window.spark.agentSession
    .probe({
      runtime: restore.runtime,
      sessionId: restore.sessionId,
      cwd: restore.cwd,
      transcriptPath: restore.transcriptPath ?? undefined,
      nativeCodexProfileId: restore.nativeCodexProfileId,
      nativeClaudeProfileId: restore.nativeClaudeProfileId,
      nativeGrokProfileId: restore.nativeGrokProfileId,
    })
    .catch(() => ({ exists: false as const }));
  const decision = decideResume(probe as ResumeProbe, restore.runtime);
  const p = probe as ResumeProbe;
  logRestore(
    `plan ${restore.runtime} id=${restore.sessionId} cwd=${restore.cwd} ` +
      `probe(exists=${p.exists} resumable=${p.resumable ?? "-"} repairable=${p.repairable ?? "-"}) -> ${decision.kind}`,
  );
  if (decision.kind === "resume" || decision.kind === "repair-resume") {
    if (restore.runtime === "codex") {
      await window.spark.agentSession
        .ensureCodexTrust(
          restore.cwd,
          restore.nativeCodexProfileId,
        )
        .catch(() => undefined);
    } else if (decision.kind === "repair-resume") {
      // The transcript's last line is a truncated partial write (sleep/crash).
      // Repair it in place (keeps a .bak) so `claude --resume` accepts it and
      // the conversation is preserved.
      await window.spark.agentSession
        .repairTranscript({
          runtime: "claude",
          cwd: restore.cwd,
          sessionId: restore.sessionId,
          nativeClaudeProfileId: restore.nativeClaudeProfileId,
        })
        .catch(() => undefined);
    }
    return {
      resumeCommand: buildAgentResumeCommand(restore),
      resumeIsFreshFallback: false,
      fallbackNotice: null,
      fallbackSession: null,
    };
  }
  if (decision.kind === "fresh") {
    if (restore.runtime === "grok") {
      const fresh = buildGrokLaunch();
      return {
        resumeCommand: fresh.command,
        resumeIsFreshFallback: true,
        fallbackNotice: "previous Grok session couldn't be resumed — starting a fresh one",
        fallbackSession: {
          runtime: "grok",
          sessionId: fresh.sessionId,
          cwd: restore.cwd,
          nativeGrokProfileId: restore.nativeGrokProfileId,
          capturedAt: new Date().toISOString(),
          active: true,
        },
      };
    }
    // Claude self-heal: the transcript is gone or stillborn. Launch a FRESH
    // forced-id Claude in the same cwd so the pane is immediately useful, and
    // hand the owner the replacement pointer to persist.
    const fresh = buildClaudeLaunch();
    return {
      resumeCommand: fresh.command,
      resumeIsFreshFallback: true,
      fallbackNotice: "previous Claude session couldn't be resumed — starting a fresh one",
      fallbackSession: {
        runtime: "claude",
        sessionId: fresh.sessionId,
        cwd: restore.cwd,
        nativeClaudeProfileId: restore.nativeClaudeProfileId,
        capturedAt: new Date().toISOString(),
        active: true,
      },
    };
  }
  // Codex can't force session ids, so there's nothing to relaunch
  // deterministically — surface the notice, clear the pointer, plain shell.
  return {
    resumeCommand: null,
    resumeIsFreshFallback: false,
    fallbackNotice: "previous Codex session couldn't be resumed",
    fallbackSession: null,
  };
}
// In-memory cache of the full xterm buffer captured right before a TerminalPane
// unmounts. Workspace switches can dispose a pane's xterm while its PTY keeps
// running in main. Stashing the full buffer here and replaying it on the next
// mount preserves same-process workspace continuity. Cold app hydration
// deliberately ignores persisted scrollback.
const MAX_XTERM_BUFFER_SNAPSHOTS = 16;
const MAX_XTERM_SNAPSHOT_TEXT_CHARS = 512 * 1024;
const MAX_XTERM_SNAPSHOT_PENDING_BYTES = 1024 * 1024;
const MAX_XTERM_SNAPSHOT_CACHE_BYTES = 16 * 1024 * 1024;
// A snapshot is the xterm buffer text captured at unmount PLUS any raw bytes
// that arrived while the pane was hidden (and therefore never reached xterm,
// so `captureXtermBuffer` by construction can't see them). On the next mount
// the text is replayed first, then `pendingBytes` is written verbatim, then
// pty.resume() drains main's post-pause backlog — preserving the ordering
// pre-hide snapshot → hidden-era bytes → post-pause backlog.
interface XtermBufferSnapshot {
  text: string;
  pendingBytes: Uint8Array | null;
  viewportFromBottom: number;
}
const xtermBufferSnapshots = new Map<string, XtermBufferSnapshot>();
let xtermBufferSnapshotBytes = 0;

function xtermBufferSnapshotSize(snapshot: XtermBufferSnapshot): number {
  // V8 commonly stores JS strings as one- or two-byte strings. Count two so
  // the cache remains bounded even when terminal output contains non-Latin
  // text, then add the typed-array payload exactly.
  return snapshot.text.length * 2 + (snapshot.pendingBytes?.byteLength ?? 0);
}

function forgetXtermBufferSnapshot(sessionId: string): void {
  const previous = xtermBufferSnapshots.get(sessionId);
  if (!previous) return;
  xtermBufferSnapshotBytes = Math.max(
    0,
    xtermBufferSnapshotBytes - xtermBufferSnapshotSize(previous),
  );
  xtermBufferSnapshots.delete(sessionId);
}

function rememberXtermBufferSnapshot(
  sessionId: string,
  snapshot: XtermBufferSnapshot,
): void {
  // A line limit alone is not a memory limit: a tool can print a single
  // multi-megabyte JSON line. Cap both halves of a snapshot before retaining
  // it, then enforce a process-wide byte budget as well as an entry count.
  const text = snapshot.text.length > MAX_XTERM_SNAPSHOT_TEXT_CHARS
    ? snapshot.text.slice(-MAX_XTERM_SNAPSHOT_TEXT_CHARS)
    : snapshot.text;
  const pendingBytes =
    snapshot.pendingBytes &&
    snapshot.pendingBytes.byteLength > MAX_XTERM_SNAPSHOT_PENDING_BYTES
      ? snapshot.pendingBytes.slice(-MAX_XTERM_SNAPSHOT_PENDING_BYTES)
      : snapshot.pendingBytes;
  const bounded = { ...snapshot, text, pendingBytes };
  forgetXtermBufferSnapshot(sessionId);
  xtermBufferSnapshots.set(sessionId, bounded);
  xtermBufferSnapshotBytes += xtermBufferSnapshotSize(bounded);
  while (
    xtermBufferSnapshots.size > MAX_XTERM_BUFFER_SNAPSHOTS ||
    xtermBufferSnapshotBytes > MAX_XTERM_SNAPSHOT_CACHE_BYTES
  ) {
    const oldest = xtermBufferSnapshots.keys().next().value;
    if (!oldest) break;
    forgetXtermBufferSnapshot(oldest);
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
  // when this pane OWNS the PTY's dimensions — either the sole view (no
  // canonical sibling pane exists) or the CANONICAL pane of a watch-only
  // surface (the automation Workers grid; its LiveBoard mirrors are readOnly
  // and never resize) — so resizing is safe. The alternative is the PTY
  // staying at its tiny default size while the user's xterm fills the panel,
  // leaving most of the visible area unpainted. Everything else stays
  // canonical: raw-tail replay, snapshot capture, and runtime-state reports
  // are unaffected by this flag.
  inputBlocked?: boolean;
  // Keep this xterm interactive and lifecycle-canonical, but let an external
  // client own PTY geometry. Phone-origin tabs use this so Studio remains a
  // usable mirror while the measured phone viewport determines cols/rows.
  externalSizeOwner?: boolean;
  initialExternalCols?: number;
  initialExternalRows?: number;
  // Raw-tail reattach mode. Opt-in, default off — used by the hosts that attach
  // an xterm onto a live Ink TUI (Claude/Codex): the automation Workers panes.
  // Such a TUI
  // repaints with cursor-relative sequences assuming its own prior frame is on
  // screen. In this mode every re-attach is made to behave exactly like the
  // known-good FIRST attach: on unmount we call pty.detach (not pty.pause) so
  // main keeps only its RAW tail bytes, and on remount we skip the flattened-
  // text snapshot / scrollback replay entirely and let main replay that raw tail
  // (spawn()'s `previouslyDetached` branch) — raw bytes reproduce the TUI frame
  // exactly, whereas a flattened-text snapshot replayed under an incrementally-
  // redrawing TUI garbles the screen.
  // Leave OFF for ordinary shell panes (TerminalStack): their output is not a
  // full-screen TUI, so the snapshot/backlog replay path is correct for them.
  rawTailReattach?: boolean;
  // Write PTY bytes into xterm even while the pane is hidden. Opt-in, default
  // off. Persistent live-TUI hosts use this because they eager-attach before
  // their first reveal; normal TerminalStack panes also opt in so every opened
  // workspace terminal stays a fully live in-memory surface. That trades some
  // background renderer work for instant, lossless tab/workspace returns.
  writeWhileHidden?: boolean;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (info: PtyExitInfo) => void;
  onCwd?: (cwd: string) => void;
  // A dev-server-style local URL appeared on this pane's byte stream.
  // `meta.replayed` is true when the bytes carrying it were history main
  // re-sent (post-sleep backlog drain, raw-tail reattach frame) rather than
  // fresh child output — the difference between "a server just started" and
  // "a server started before the laptop slept", which callers that act on the
  // URL (auto-opening a preview tab) must not confuse.
  onDetectedLocalUrl?: (url: string, meta?: { replayed?: boolean }) => void;
  onSparkOpen?: (input: SparkOpenInput) => void;
  // Fires on every PTY data chunk (input or output activity). Used by the
  // orchestration claim logic to decide whether a pane is "doing nothing"
  // and therefore safe to take over for a worker. Throttled implicitly by
  // PTY chunk rate; consumers should still debounce if they push to React.
  onActivity?: () => void;
  // A live, visible normal-screen CSI 2 J was parsed. Presentation stays
  // renderer-owned; replayed output and internal PTY reset traffic are excluded.
  onClear?: () => void;
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
  onAgentState?: (state: TerminalAgentForegroundState) => void;
  // Fires whenever the live-state poller confirms a new RuntimeState for the
  // foreground agent (working / blocked / idle / done). This is the SAME value
  // the hook reports to main via window.spark.terminalState.report — surfaced
  // to the renderer so a manual pane's worker chip can show the finer state
  // (e.g. "waiting for you" when the agent printed a permission/input prompt)
  // instead of a binary running/done. `blocked` means the agent is waiting on
  // the user. Reuses the poller's debounced output — no second detector.
  onRuntimeState?: (state: RuntimeState) => void;
  // Durable Claude/Codex session pointer for this pane (TerminalLeaf.agentSession),
  // used for RESTORE: on a reopened pane that has NO initialCommand (its launch
  // autorun was stripped on save), the hook probes that the transcript still
  // exists and, if so, types the `--resume` command to relaunch the session.
  // Fresh launches are captured elsewhere (the App-level agent-detection hook).
  agentSession?: TerminalAgentSession | null;
  /** Frozen profile while capture has not produced agentSession yet. */
  nativeCodexProfileId?: string;
  nativeClaudeProfileId?: string;
  nativeGrokProfileId?: string;
  nativeCliLoginToken?: string;
  // One-shot boot-restore marker, minted on the leaf ONLY at hydration
  // (useTabs.loadPersisted) when the persisted pointer was `active` (agent
  // running at quit). The restore precompute below requires it, so a restore
  // can only fire on the pane's first mount after app boot — later remounts
  // (workspace switches, pty death) see the consumed flag and stay quiet.
  bootResume?: boolean;
  // Fires when a restore's saved transcript is gone (pruned / cwd moved) so the
  // owner can clear the stale pointer; the pane stays a plain shell.
  onResumeUnavailable?: () => void;
  // Fires when a failed Claude restore self-heals by launching a FRESH session
  // (new --session-id uuid) in the same cwd, so the owner can point the leaf's
  // agentSession at the replacement. Codex can't force ids, so its failed
  // restores go through onResumeUnavailable instead.
  onResumeFallback?: (session: TerminalAgentSession) => void;
  // Fires exactly once when the boot restore was attempted — for EVERY outcome
  // (resume typed, fresh fallback, pointer cleared, prefs-disabled, probe
  // failure) — so the owner clears the leaf's one-shot `bootResume` marker.
  onBootResumeConsumed?: () => void;
}

export interface TerminalSessionApi {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
}

// A modal dialog owns the keyboard for as long as it is open. Reveal-focus
// must not pull focus out of one: mounting a dialog over a pane can make that
// pane "visible" again in React's terms, and grabbing focus back would send
// the user's next arrow/Enter/Escape to the terminal underneath instead of to
// the dialog they are looking at. Observed with the worker session picker,
// which focuses itself on mount and then lost focus to the pane behind it.
//
// Every dialog in the app marks itself aria-modal, so this needs no registry
// and no plumbing — and it self-clears, because the attribute goes away with
// the dialog.
function modalDialogIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

export function useTerminalSession({
  container,
  visible,
  sessionId,
  shell,
  scrollbackLineLimit,
  initialCwd,
  initialCommand,
  extraEnv,
  readOnly = false,
  inputBlocked = false,
  externalSizeOwner = false,
  initialExternalCols,
  initialExternalRows,
  rawTailReattach = false,
  writeWhileHidden = false,
  onSearchReady,
  onExit,
  onCwd,
  onDetectedLocalUrl,
  onSparkOpen,
  onActivity,
  onClear,
  onUserInput,
  onAgentState,
  onRuntimeState,
  agentSession,
  nativeCodexProfileId,
  nativeClaudeProfileId,
  nativeGrokProfileId,
  nativeCliLoginToken,
  bootResume,
  onResumeUnavailable,
  onResumeFallback,
  onBootResumeConsumed,
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
  const externalSizeOwnerRef = useRef<boolean>(externalSizeOwner);
  const externalGridRef = useRef<{ cols: number; rows: number } | null>(
    initialExternalCols && initialExternalRows
      ? { cols: initialExternalCols, rows: initialExternalRows }
      : null,
  );
  useEffect(() => {
    externalSizeOwnerRef.current = externalSizeOwner;
  }, [externalSizeOwner]);
  // Same latest-value pattern for rawTailReattach. The unmount cleanup and the
  // mount replay both branch on this; a ref lets the parent flip it without
  // forcing the once-per-sessionId xterm setup effect to re-run (in practice
  // ChatPanel sets it statically true, but the ref keeps the two read sites
  // consistent with the freshest value).
  const rawTailReattachRef = useRef<boolean>(rawTailReattach);
  useEffect(() => {
    rawTailReattachRef.current = rawTailReattach;
  }, [rawTailReattach]);
  // Same latest-value pattern for writeWhileHidden. Read on the pty-onData hot
  // path (captured once per sessionId), so a ref keeps it fresh without
  // re-running the setup effect. Persistent terminal hosts set it statically.
  const writeWhileHiddenRef = useRef<boolean>(writeWhileHidden);
  useEffect(() => {
    writeWhileHiddenRef.current = writeWhileHidden;
  }, [writeWhileHidden]);

  // Latest agentSession pointer. The mount effect's closure captures the pointer
  // as of first mount, but capture rewrites it over the pane's life — the death
  // re-arm below must resume the FRESHEST pointer, so it reads this ref.
  const agentSessionRef = useRef<TerminalAgentSession | null | undefined>(agentSession);
  useEffect(() => {
    agentSessionRef.current = agentSession;
  }, [agentSession]);
  // Whether an agent TUI is CURRENTLY foreground in this pane (alt-screen). Set
  // from the same running/not-running signal the owner derives `active` from, so
  // reading it at pty-exit time answers "did the agent die, or did the user
  // cleanly leave the TUI first?" — the crash-vs-clean discriminator that gates
  // the in-place auto-resume.
  const agentRunningRef = useRef(false);

  const detectedRef = useRef<string | null>(null);
  // Latest-callback refs so the effect can run exactly once per `sessionId`
  // while still calling the freshest closures from the parent.
  const onDetectedRef = useRef(onDetectedLocalUrl);
  const onCwdRef = useRef(onCwd);
  const onExitRef = useRef(onExit);
  const onSearchReadyRef = useRef(onSearchReady);
  const onSparkOpenRef = useRef(onSparkOpen);
  const onActivityRef = useRef(onActivity);
  const onClearRef = useRef(onClear);
  const onUserInputRef = useRef(onUserInput);
  const onAgentStateRef = useRef(onAgentState);
  const onRuntimeStateRef = useRef(onRuntimeState);
  const onResumeUnavailableRef = useRef(onResumeUnavailable);
  const onResumeFallbackRef = useRef(onResumeFallback);
  const onBootResumeConsumedRef = useRef(onBootResumeConsumed);
  useEffect(() => {
    onDetectedRef.current = onDetectedLocalUrl;
    onCwdRef.current = onCwd;
    onExitRef.current = onExit;
    onSearchReadyRef.current = onSearchReady;
    onSparkOpenRef.current = onSparkOpen;
    onActivityRef.current = onActivity;
    onClearRef.current = onClear;
    onUserInputRef.current = onUserInput;
    onAgentStateRef.current = onAgentState;
    onRuntimeStateRef.current = onRuntimeState;
    onResumeUnavailableRef.current = onResumeUnavailable;
    onResumeFallbackRef.current = onResumeFallback;
    onBootResumeConsumedRef.current = onBootResumeConsumed;
  }, [onDetectedLocalUrl, onCwd, onExit, onSearchReady, onSparkOpen, onActivity, onClear, onUserInput, onAgentState, onRuntimeState, onResumeUnavailable, onResumeFallback, onBootResumeConsumed]);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeXtermForOwner = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const externalGrid = externalGridRef.current;
    if (externalSizeOwnerRef.current && externalGrid) {
      if (term.cols !== externalGrid.cols || term.rows !== externalGrid.rows) {
        preserveTerminalViewport(term, () => {
          term.resize(externalGrid.cols, externalGrid.rows);
        });
      }
      return;
    }
    const fit = fitRef.current;
    if (!fit) return;
    preserveTerminalViewport(term, () => fit.fit());
  }, []);
  useEffect(() => {
    if (
      typeof initialExternalCols !== "number" ||
      typeof initialExternalRows !== "number"
    ) {
      return;
    }
    externalGridRef.current = {
      cols: Math.max(2, Math.trunc(initialExternalCols)),
      rows: Math.max(2, Math.trunc(initialExternalRows)),
    };
    if (externalSizeOwner) resizeXtermForOwner();
  }, [
    externalSizeOwner,
    initialExternalCols,
    initialExternalRows,
    resizeXtermForOwner,
  ]);
  // Bridge to the effect-local `scheduleFitRetry` (defined once the PTY is
  // spawned) so the WebGL onContextLoss handler — which is created much earlier
  // in the same effect — can trigger a re-fit + pty.resize after xterm falls
  // back to the DOM renderer. See the onContextLoss handler for why.
  const refitAfterRendererSwapRef = useRef<(() => void) | null>(null);
  // Bridge to the effect-local `scheduleFitRetry` so the visibility layout
  // effect (defined outside the setup closure) can re-fit AND push a trailing-
  // edge pty.resize the moment a hidden pane returns to screen. A pane resized
  // while hidden re-fits xterm on reveal, but nothing else re-syncs the pty, so
  // without this the TUI keeps painting at its pre-hide cols. See the reveal
  // useLayoutEffect below.
  const refitAndResizeRef = useRef<(() => void) | null>(null);
  // Bridge to the effect-local renderer-recovery routine so the visibility
  // layout effect can force a full repaint — and reload a dead WebGL context —
  // the moment a hidden pane returns to screen. See recoverRendererOnShow.
  const recoverRendererRef = useRef<(() => void) | null>(null);
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
  // A visible pane can still be catching up on output accumulated while its
  // workspace was hidden. Keep newly arriving bytes behind that backlog until
  // the deferred replay has been enqueued, otherwise fresh output could reach
  // xterm before the older bytes and render out of order.
  const hiddenReplayPendingRef = useRef<boolean>(false);
  // Keep a deep hidden-output reserve. A laptop can remain locked/asleep for
  // hours while a remote PTY or buffered local process still has output ready
  // on wake; a few full-screen TUI redraws are not enough to reconstruct the
  // frame reliably. The larger bounded cap is an intentional durability-over-
  // memory tradeoff (up to 4 MB for each busy hidden terminal).
  const HIDDEN_BUFFER_CAP = 4 * 1024 * 1024;
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
  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  // Non-null only while xterm is parsing bytes that must not be treated as a
  // fresh visible clear (a hidden-buffer flush or pty-manager's internal reset).
  // Tokens prevent a late callback from an old write/session clearing a newer
  // suppression window.
  const clearNotificationSuppressionRef = useRef<object | null>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    let spawned = false;
    let startupCommandHandled = false;
    // True when pty.spawn bound to an EXISTING session (pane remount) instead
    // of creating a fresh pty — a live shell/TUI owns it, so an undelivered
    // resume must stay silent rather than print a manual-run notice.
    let attachedExistingSession = false;
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

      // Route every terminal link activation through the preload's
      // openExternal — Electron's shell.open is the only hop that survives
      // Chrome's external navigation block, and it keeps browser URLs inside
      // Codara's preview tab. Shared by the WebLinksAddon (plain-text URLs)
      // and the linkHandler below (OSC 8 hyperlinks).
      const openTerminalUri = (uri: string) => {
        void window.spark.openExternal?.(uri);
      };

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
        // OSC 8 hyperlinks (CLIs like Claude Code emit their localhost URLs
        // this way) are activated by xterm's core, not WebLinksAddon. With no
        // linkHandler, xterm falls back to a window.confirm("navigate to …?")
        // whose OK branch calls window.open() with no URL — so the click just
        // shows a scary dialog and opens nothing. Handle it ourselves so these
        // links open the in-app preview like plain-text URLs do.
        linkHandler: {
          activate: (_event, uri) => openTerminalUri(uri),
        },
      });
      termRef.current = term;

      // Observe the erase sequence xterm actually parses rather than guessing
      // from keyboard input or shell command names. Returning false keeps xterm's
      // built-in erase handler in the chain, so painting remains unchanged.
      const eraseDisplayDispose = term.parser.registerCsiHandler(
        { final: "J" },
        (params) => {
          if (params[0] !== 2) return false;
          if (
            replayPending ||
            clearNotificationSuppressionRef.current !== null ||
            !visibleRef.current
          ) {
            return false;
          }
          if (term.buffer.active.type === "normal") onClearRef.current?.();
          return false;
        },
      );
      cleanups.push(() => eraseDisplayDispose.dispose());

      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);

      const search = new SearchAddon();
      term.loadAddon(search);

      term.loadAddon(new WebLinksAddon((_e, uri) => openTerminalUri(uri)));

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
      // Consecutive reloads triggered by a lost GL context on re-show (see
      // recoverRendererOnShow). Reset once a live context is observed.
      let webglReloads = 0;
      const attachWebglLossHandler = (addon: WebglAddon) => {
        addon.onContextLoss(() => {
          try {
            addon.dispose();
          } catch {
            /* ignore */
          }
          if (webgl === addon) webgl = null;
          // Disposing the WebGL addon makes xterm fall back to the DOM renderer.
          // The DOM renderer derives a WIDER css cell width than WebGL (it does
          // NOT floor device char width the way WebglRenderer does), and the
          // fallback resizes the row grid to the CURRENT `cols` without re-running
          // FitAddon. The grid therefore becomes wider than the pane and the
          // rightmost columns — a TUI's right border, right-aligned statusline
          // items — get clipped by .xterm-host's overflow:hidden (an Ink/Claude
          // Code box appears to "overflow" the pane's right edge). The host size
          // is unchanged so the ResizeObserver never fires on its own. Re-fit
          // explicitly so cols is recomputed for the new cell metrics and the new
          // size is pushed to the pty (SIGWINCH → the TUI repaints to fit).
          refitAfterRendererSwapRef.current?.();
        });
      };
      const loadWebgl = (): boolean => {
        try {
          const addon = new WebglAddon();
          attachWebglLossHandler(addon);
          term.loadAddon(addon);
          webgl = addon;
          return true;
        } catch {
          webgl = null;
          return false;
        }
      };
      loadWebgl();

      // Renderer recovery on pane re-activation. Two failure modes are healed
      // here, both invisible until the pane is shown again — this is the fix for
      // a terminal rendering ALL BLACK after chat↔terminal tab switches:
      //   1. The WebGL addon is created with preserveDrawingBuffer:false, so
      //      after a visibility:hidden → visible toggle the browser may composite
      //      the canvas as BLACK until the next draw. xterm only repaints DIRTIED
      //      rows, so a pane shown with no new output (an idle claude/codex TUI)
      //      — or one where only a few rows changed — keeps the stale black
      //      buffer. A full-viewport refresh forces every row to redraw and
      //      repopulate the drawing buffer.
      //   2. The GL context itself can be evicted while offscreen (too many live
      //      contexts, GPU memory pressure) WITHOUT the webglcontextlost event
      //      firing on the hidden canvas, so the addon never falls back. A
      //      refresh can't repaint a dead context — detect the loss via
      //      gl.isContextLost() and reload the addon (re-establishing a live
      //      context, or dropping to the DOM renderer once the reload budget is
      //      spent).
      const recoverRendererOnShow = () => {
        const t = termRef.current;
        if (!t) return;
        if (webgl) {
          // Find the WebGL renderer's OWN canvas. .xterm-screen also holds the
          // renderer's link layer — a 2D canvas (class xterm-link-layer) that is
          // appended BEFORE the WebGL canvas — so a plain ".xterm-screen canvas"
          // query returns the 2D one, and getContext("webgl2") on a canvas that
          // already owns a 2D context is null. Probe each canvas and keep the one
          // that actually yields a webgl2 context (the addon's own); a lost-but-
          // live context is still returned, so isContextLost() is the real signal.
          let gl: WebGL2RenderingContext | null = null;
          const canvases = container.current?.querySelectorAll<HTMLCanvasElement>(
            ".xterm-screen canvas",
          );
          if (canvases) {
            for (const c of canvases) {
              const ctx = c.getContext("webgl2");
              if (ctx) {
                gl = ctx;
                break;
              }
            }
          }
          if (!gl || gl.isContextLost()) {
            try {
              webgl.dispose();
            } catch {
              /* ignore */
            }
            webgl = null;
            if (webglReloads < WEBGL_MAX_RELOADS && loadWebgl()) {
              webglReloads += 1;
              // Fresh addon: re-fit so cols/atlas re-establish for the reloaded
              // renderer, then the refresh below paints the first frame.
              refitAfterRendererSwapRef.current?.();
            }
            // else: reload budget spent — xterm is on the DOM renderer now, and
            // the refresh below repaints it.
          } else {
            // Live context — clear any prior reload debt so a single future loss
            // still gets the full reload budget.
            webglReloads = 0;
          }
        }
        try {
          t.refresh(0, t.rows - 1);
        } catch {
          /* terminal may be mid-dispose during a fast switch */
        }
      };
      recoverRendererRef.current = recoverRendererOnShow;
      cleanups.push(() => {
        if (recoverRendererRef.current === recoverRendererOnShow) {
          recoverRendererRef.current = null;
        }
      });

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
        onActivityRef.current?.();
        onUserInputRef.current?.();
        void (async () => {
          const text = await window.spark.clipboard.readText();
          const sanitized = (text ?? "").replace(/\x00/g, "");
          const pasteText = () => {
            void window.spark.pty.write(sessionId, `\x1b[200~${sanitized}\x1b[201~`);
          };
          if (sanitized.trim()) {
            // Usable text on the clipboard → paste it as a bracketed block, the
            // long-standing behavior for text paste (unchanged).
            pasteText();
            return;
          }
          // No meaningful text — the clipboard may hold an image (a screenshot,
          // "copy image"). Materialise it to a temp PNG in main and paste its
          // shell-escaped path so an agent TUI turns it into an `[Image #N]`
          // chip. Mode-aware, same as a Finder drag-drop.
          const imagePath = await window.spark.clipboard.readImageAsTempFile?.();
          if (imagePath) {
            writeTokenRespectingBracketMode(shellEscapePath(imagePath, isWindows));
            return;
          }
          // No image either. If the clipboard held whitespace-only text (e.g.
          // copied indentation), still paste it — preserving the prior "paste
          // any non-empty text" behavior for the explicit paste shortcuts.
          if (sanitized) pasteText();
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
        //   - Ink-based agent TUIs (Claude Code / Codex) read
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
        // first-party agent is running, clear Cora's chip/state first but do
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
          // The Cmd/Ctrl+F find-overlay input lives inside this same `host`, so
          // its paste events bubble through this capture listener. Never divert
          // a paste aimed at the find box into the PTY — let it paste normally.
          if (searchInput && event.target === searchInput) return;
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
        resizeXtermForOwner();
      } catch {
        /* host may be 0×0 on first paint; ResizeObserver will fix it. */
      }
      if (externalSizeOwnerRef.current) {
        const unsubscribeExternalSize = subscribeExternalTerminalSize(
          sessionId,
          ({ cols, rows }) => {
            externalGridRef.current = { cols, rows };
            try {
              resizeXtermForOwner();
              term.refresh(0, Math.max(0, term.rows - 1));
            } catch {
              /* xterm may be disposing while the shared terminal closes */
            }
          },
        );
        cleanups.push(unsubscribeExternalSize);
      }
      // Raw-tail reattach mode (chat backend terminal): the reattach is driven
      // ENTIRELY by main replaying the raw pty tail bytes into this fresh xterm
      // (spawn()'s existing-session `previouslyDetached` branch, below), exactly
      // like the known-good first attach. Skip BOTH the flattened-text snapshot
      // replay and the localStorage scrollback restore — a flattened-text replay
      // reflows the old frame as plain text, and the live Ink TUI's next
      // incremental cursor-relative repaint assumes ITS prior frame is on screen;
      // the two don't compose, which is the reported garble (scattered
      // transcript, huge gaps, a detached input box near the bottom). Also delete
      // any stale snapshot for this id so an old flattened frame can never replay
      // — including on a future non-raw mount of the same session.
      //
      // INVARIANT: the data listener (offData) is registered before the spawn()
      // call further down, so the raw tail main sends during spawn is received by
      // this xterm. This already holds — first attach works — so raw mode just
      // relies on the same ordering. No resume() is issued in this mode (see the
      // guarded resume below): detach() left nothing paused, so the raw tail is
      // the sole source of replayed bytes and can't be double-delivered.
      // Read-only mirror panes also skip the snapshot replay: any snapshot at
      // this sessionId belongs to a CANONICAL pane's lifecycle, and replaying a
      // flattened-text frame under a live TUI's incremental repaints is the
      // documented garble. Mirrors neither consume nor delete it — the entry is
      // left for whichever canonical mount owns it.
      const liveSnapshot = rawTailReattachRef.current || readOnlyRef.current
        ? null
        : xtermBufferSnapshots.get(sessionId);
      if (rawTailReattachRef.current) {
        forgetXtermBufferSnapshot(sessionId);
      }
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
          forgetXtermBufferSnapshot(sessionId);
          const frame = window.requestAnimationFrame(() => {
            try {
              const buffer = term.buffer.active;
              const target = Math.max(
                0,
                buffer.baseY - liveSnapshot.viewportFromBottom,
              );
              term.scrollToLine(target);
            } catch {
              /* the pane may have unmounted again before replay finished */
            }
          });
          cleanups.push(() => window.cancelAnimationFrame(frame));
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

      // Keep the xterm theme in sync with Codara design tokens so theme switches
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
      //   "agent" → a Claude / Codex CLI is in the foreground;
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
      // Runtime-promotion bookkeeping, set on ANY arm that leaves the pane
      // without a first-party runtime — the generic ESC[?1049h alt-screen
      // fallback (setAgentRunning(null)) AND a recognised-but-non-public CLI
      // (aider/opencode/… → coercePublicRuntime===null). `genericArmRingFrom` is
      // the ring offset at that arm: the promotion sniff only considers bytes
      // appended AFTER it, so pre-arm output already in the ring (a cat'd
      // changelog naming "Claude Code v2.x", the third-party CLI's own banner)
      // can't false-promote the pane. `genericArmBudget` (>0 = promotion still
      // eligible) burns down by each chunk's size so an unrecognised long-lived
      // TUI isn't sniffed forever. Both are advanced/floored by advanceGenericArm
      // as the ring slides under its cap, and reset to 0 on a first-party arm or
      // a successful promotion. See agent-patterns.ts advanceGenericArm/
      // promoteGenericArm for the pure bookkeeping (unit-tested there).
      let genericArmRingFrom = 0;
      let genericArmBudget = 0;
      let agentPhase: "idle" | "agent" = "idle";
      // Tracks the first-party runtime ("claude"|"codex") if the
      // detected runtime maps to one — drives the state poller below, which
      // only has regex tables for those three. Non-first-party runtimes still
      // fire onAgentState (running=true) but skip the poller.
      let activeRuntime: PublicAgentRuntime | null = null;
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
      const KNOWN_RUNTIMES = ["claude", "codex"] as const;
      // Which first-party runtime's persistent chrome is currently visible in
      // `tail` (the BOTTOM rows), if any. Returns null when no agent chrome is
      // on the bottom of the screen. Deliberately checks the bottom tail only:
      // a stale footer sitting up in scrollback after a REAL exit (shell prompt
      // now at the bottom) must NOT read as a live agent.
      const liveRuntimeFromTail = (tail: string): PublicAgentRuntime | null => {
        const live = sniffLiveRuntime(tail);
        if (live) return live;
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
        const publicRuntime = sniffLiveRuntime(agentTextRing);
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
      // Flicker fix (idle→working re-promotion off the SAME frozen footer). D4
      // above resolves a confirmed-working chip to "idle" once its footer freezes,
      // but the frozen frame keeps classifying as "working" — so two ticks later
      // the pending-confirm path drags the chip BACK to "working", D4 debounces it
      // to "idle" again ~1.2s on, and the chip oscillates working↔ready forever.
      // We snapshot the exact tail at the moment we settle on "idle" and refuse to
      // re-promote to "working" while the tail is byte-identical to it: a genuine
      // new turn repaints the footer (fresh spinner / "(0s ·" / the echoed prompt)
      // so the tail differs and promotion proceeds normally. Cleared when we leave
      // idle and reset across agent enter/exit. Claude-only, mirroring D4:
      // Codex turn-completion is driven by the focus-independent notifier, and
      // its idle composer doesn't classify as "working" anyway.
      let idleFrozenTail: string | null = null;
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
      // While the document is hidden we drop ticks down to
      // HIDDEN_STATE_POLL_MS — nobody is looking at the chip, and hidden-window
      // NOTIFICATIONS are driven by main's terminal-agent-notify watcher, not
      // this poller, so slower sampling here only delays the chip. (Do not
      // rely on this poller for background notifications.) The next
      // STATE_POLL_MS tick after refocus resumes full speed on its own, so the
      // timer lifecycle is untouched.
      let lastProcessedTickMs = 0;
      const clearCtrlCExitTimer = () => {
        if (ctrlCExitTimer !== null) {
          window.clearTimeout(ctrlCExitTimer);
          ctrlCExitTimer = null;
        }
      };
      const reportRuntimeState = (state: RuntimeState) => {
        // Read-only mirrors never report to main: their xterm buffer lacks the
        // canonical pane's history, so their classification can diverge and
        // would flap the run-store attempt state the canonical pane reports.
        if (!readOnlyRef.current) {
          void window.spark.terminalState?.report?.({ paneId: sessionId, state });
        }
        // Surface the same debounced state to the renderer so a manual pane's
        // worker chip can render the finer label/tone. Main still gets the
        // report above (used for Cora-owned attempts / notifications); this is
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
        idleFrozenTail = null;
        lastProcessedTickMs = 0;
        clearCtrlCExitTimer();
      };
      const tickStatePoller = () => {
        const t = termRef.current;
        if (!t || !activeRuntime) return;
        const now = Date.now();
        if (
          document.visibilityState !== "visible" &&
          now - lastProcessedTickMs < HIDDEN_STATE_POLL_MS
        ) {
          return;
        }
        lastProcessedTickMs = now;
        const tail = readTerminalTail(t, STATE_TAIL_ROWS);
        let raw = classifyTail(activeRuntime, tail);
        if (activeRuntime === "codex" && raw === "blocked") raw = null;

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
        // turn finished. Codex repaints its footer rarely (it only
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

        // Flicker fix — do NOT re-promote an already-idle chip to "working" off
        // the exact frozen footer we already resolved to idle. classifyTail keeps
        // matching the frozen "(12s · … tokens)" summary as "working" forever
        // (freshFrom=0 snapshot), so without this the pending-confirm path would
        // drag the chip back to "working" ~600ms after every idle, and D4 would
        // debounce it back to "idle" ~1.2s later — the reported working↔ready
        // oscillation. A genuine new turn repaints the footer, so tail differs
        // from idleFrozenTail and promotion proceeds. Claude-only, mirroring D4.
        if (
          activeRuntime === "claude" &&
          confirmedState === "idle" &&
          raw === "working" &&
          idleFrozenTail !== null &&
          tail === idleFrozenTail
        ) {
          effectiveRaw = null;
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
        // chrome is VERIFIED (absenceResetSafe — Claude only today). For Codex,
        // whose idle-composer anchors are unverified, anchor-absence
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
            // Snapshot the frozen footer so it can't re-promote us to "working".
            idleFrozenTail = tail;
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
              idleFrozenTail = tail;
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
          // Left idle for a real, fresh signal — drop the frozen-footer snapshot
          // so a later idle re-captures the current frame.
          idleFrozenTail = null;
          // A confirmed working/blocked signal means the agent is alive and
          // active — stand down the Ctrl+C exit one-shot so it can't fire after
          // a new turn started post-interrupt.
          if (effectiveRaw === "working" || effectiveRaw === "blocked") clearCtrlCExitTimer();
          reportRuntimeState(effectiveRaw);
        }
      };
      const startStatePoller = (runtime: PublicAgentRuntime) => {
        activeRuntime = runtime;
        pendingState = null;
        confirmedState = null;
        idleSinceMs = null;
        baselineIdleSinceMs = null;
        uiGoneTicks = 0;
        lastWorkingTail = null;
        idleFrozenTail = null;
        lastProcessedTickMs = 0;
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
        // surface ("claude" | "codex" | null) without growing new
        // cases for every newly detected CLI. running=true still fires so the
        // activity indicator tracks correctly. A null `runtime` argument
        // means "something is interactive but we don't know what" — used by
        // the alt-screen fallback below for unrecognised TUIs.
        const publicRuntime = runtime ? coercePublicRuntime(runtime) : null;
        // Arm the runtime-promotion bookkeeping whenever this arm leaves the pane
        // WITHOUT a first-party runtime — the generic alt-screen fallback
        // (runtime===null) OR a recognised non-public CLI (aider/opencode/… that
        // coerces to null). In both cases activeRuntime stays null and the
        // promotion sniff below stays live, so it must anchor to post-arm bytes
        // (genericArmRingFrom) and run under a byte budget (genericArmBudget).
        // Without this, a non-public arm left the offset/budget unset and the
        // promotion sniffed the WHOLE ring forever — a pre-arm "Claude Code v2.x"
        // in the ring would false-promote a third-party pane. A first-party arm
        // starts its own poller (activeRuntime set), so promotion never runs —
        // clear the bookkeeping.
        if (publicRuntime) {
          genericArmRingFrom = 0;
          genericArmBudget = 0;
        } else {
          genericArmRingFrom = agentTextRing.length;
          genericArmBudget = POST_ARM_PROMOTE_BUDGET_BYTES;
        }
        markRecentAgentInput(publicRuntime);
        agentRunningRef.current = true;
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
          agentRunningRef.current = false;
          onAgentStateRef.current?.({
            runtime: null,
            running: false,
            exitConfirmed: options.exitSignal === true,
          });
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
        genericArmRingFrom = 0;
        genericArmBudget = 0;
      };
      const handleAgentInterruptKey = () => {
        if (readOnlyRef.current || inputBlockedRef.current) return;
        if (agentPhase !== "agent" || !activeRuntime) return;
        // A single Ctrl+C in Claude Code / Codex almost never exits
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
        // Codex clears via positive exit signals only.
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
          const runtime = runtimeFromCommandLine(cmdLine);
          if (runtime === "claude" || runtime === "codex") {
            setAgentRunning(runtime);
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
      const presenceTimer = window.setInterval(() => {
        if (agentPhase !== "idle") return;
        if (!visibleRef.current || redetectSuppressedAfterExit) return;
        if (!onAgentStateRef.current) return;
        const host = termRef.current;
        if (!host) return;
        const live = liveRuntimeFromTail(readTerminalTail(host, STATE_TAIL_ROWS));
        if (live) setAgentRunning(live);
      }, 1_000);
      cleanups.push(() => window.clearInterval(presenceTimer));
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
          const ringLenBefore = agentTextRing.length;
          agentTextRing = (agentTextRing + chunkText).slice(-8192);
          if (genericArmBudget > 0) {
            // Walk the post-arm slice boundary back by whatever the capped ring
            // shed off its front, and burn the chunk off the promotion budget.
            ({ ringFrom: genericArmRingFrom, budget: genericArmBudget } =
              advanceGenericArm(
                genericArmRingFrom,
                genericArmBudget,
                ringLenBefore,
                agentTextRing.length,
                chunkText.length,
              ));
          }
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
          const runtime =
            sniffOsc633CommandRuntime(agentTextRing) ?? sniffLiveRuntime(agentTextRing);
          if (runtime) {
            setAgentRunning(runtime);
          } else if (chunkText.includes("\x1b[?1049h")) {
            // Generic alt-screen TUI fallback. Every Ink-based CLI
            // (Claude / Codex) and every classic fullscreen tool
            // (vim, less, htop, fzf) emits `ESC[?1049h` on entry. If banner
            // detection hasn't matched, fall back to this byte signal so
            // the pane still reports running=true. The worker keybind
            // relies on this: without it, an unrecognised Claude build or
            // a vim session would look "unused" and the keybind would
            // happily inject the launch command into the running TUI's
            // input box. The exit path (\x1b[?1049l in the else branch
            // below) already restores idle phase, so this fallback rides
            // the same lifecycle as banner-based detection. setAgentRunning
            // arms the runtime-promotion bookkeeping for this null arm.
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

        // Runtime PROMOTION (generic/non-public arm → first-party runtime).
        // A pane in agent phase with activeRuntime===null and NO state poller
        // (running=true fires but no chip) reached that state one of two ways:
        // the generic ESC[?1049h fallback above (`setAgentRunning(null)`), or a
        // recognised non-first-party CLI (aider/opencode/… → coercePublicRuntime
        // ===null). Either way the working/ready chip never appears (App.tsx
        // suppresses the chip for runtime===null TUIs, treating them like
        // vim/less), and the idle-branch sniff above (gated on
        // agentPhase==="idle") never runs again, so a banner arriving later can't
        // fix it. Result (for the alt-screen case): a fresh Claude pane shows
        // no chip at all.
        //
        // How the fallback wins the race: Claude enters the alt screen at boot
        // (`ESC[?1049h`) a beat BEFORE it paints its "Claude Code v…" banner box,
        // whereas Codex renders inline (no `ESC[?1049h`) and so never trips this
        // fallback — which is exactly why Codex chips survive and Claude's vanish.
        // The alt-screen boot is not new: live pty captures (2026-07-09) confirm
        // it in every locally-available build, 2.1.202 / 2.1.203 / 2.1.204 /
        // 2.1.205 (each emits `ESC[?1049h` at boot and stays in the alt screen
        // until exit); older Claude v2 (≤ ~2.1.18x) rendered inline per the
        // earlier captures documented in agent-patterns.ts. So this race has been
        // latent for a while — it only STARTS biting once two things line up:
        //   1. The main process coalesces PTY reads over a 16 ms flush window
        //      (pty-manager flushDataNow → one Uint8Array per batch). A fast boot
        //      (empty cwd) has only a ~3 ms alt-enter→banner gap, so both land in
        //      the same batch and sniffRuntime arms "claude" from the banner —
        //      no fallback. A heavy boot (real workspace: repo CLAUDE.md + MCP
        //      servers + hooks) pushes that gap PAST 16 ms (measured ~36 ms), so
        //      the alt-enter flushes in a batch by itself, trips the fallback,
        //      and the banner arrives in a LATER batch — never re-sniffed.
        //   2. The pane has NO shell integration (SPARK_NO_SHELL_INTEGRATION=1
        //      worker/agent panes — no OSC 633;E command line to arm from).
        //      Integrated panes arm via 633;E before the alt-screen enter and are
        //      immune. (This is why it reads as "the 2.1.205 update broke it":
        //      nothing in the terminal output changed — 2.1.204 and 2.1.205 are
        //      byte-identical — the boot timing merely drifted across the 16 ms
        //      threshold on the real workspace.)
        //
        // Fix: keep sniffing while armed-but-generic and upgrade to the real
        // runtime the moment its banner (or an OSC 633;E command line) lands
        // (promoteGenericArm). Only ever promotes null→known — a genuine
        // vim/less/fzf/aider session (no first-party banner) stays as it armed,
        // so no first-party chip sprouts on it. Skipped on a chunk carrying an
        // exit signal so the reset below wins cleanly. Two guards keep it safe
        // and cheap: the sniff runs over ONLY the post-arm ring slice
        // (genericArmRingFrom) so pre-arm output — a cat'd changelog naming a
        // Claude version, a third-party CLI's own banner — can't promote; and it
        // stops after genericArmBudget post-arm bytes (POST_ARM_PROMOTE_BUDGET_
        // BYTES) so a long-lived unrecognised TUI isn't sniffed every chunk.
        if (
          agentPhase === "agent" &&
          activeRuntime === null &&
          genericArmBudget > 0 &&
          !sawAltScreenLeave &&
          !sawPromptMarker
        ) {
          const promoted = promoteGenericArm(
            agentTextRing,
            genericArmRingFrom,
            genericArmBudget,
          );
          if (promoted) {
            // startStatePoller sets activeRuntime, so this promotion fires at
            // most once per generic arm. Mirrors setAgentRunning's known-runtime
            // tail: re-emit onAgentState with the now-known runtime (App.tsx
            // sprouts the CLAUDE/CODEX chip in place of the suppressed
            // null one), refresh the recent-input grace so Shift+Enter keeps
            // sending the TUI newline, start the state poller, and report
            // "launching" so the chip reads "starting" until the first real
            // working/idle classification lands.
            markRecentAgentInput(promoted);
            agentRunningRef.current = true;
            onAgentStateRef.current?.({ runtime: promoted, running: true });
            startStatePoller(promoted);
            reportRuntimeState("launching");
            genericArmRingFrom = 0;
            genericArmBudget = 0;
          }
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

      // Replayed history main is about to re-send on the live data channel
      // (reattach frame, post-sleep backlog). Only the URL sniffer consults
      // this — replayed bytes must still reach xterm exactly like live ones.
      const replayTracker = createReplayTracker();
      const offReplay =
        window.spark.pty.onReplay?.(sessionId, ({ bytes }) => {
          replayTracker.announce(bytes);
        }) ?? (() => undefined);

      const offData = window.spark.pty.onData(sessionId, (data) => {
        // Main ships Uint8Array. xterm.js's parser reassembles partial ANSI
        // sequences across writes when fed Uint8Array, which is what TUIs
        // (claude/codex/Ink) need to render cursor sequences without smearing.
        const bytes =
          data instanceof Uint8Array
            ? data
            : new TextEncoder().encode(String(data));

        // Attribute this chunk to the announced replay before anything
        // downstream reads the flag — including the hidden-pane early returns,
        // which must still consume the bytes or the replay would leak its
        // "history" marking onto the live output that follows.
        const isReplayedChunk = replayTracker.consume(bytes.length);

        // Keep the agent lifecycle sniffer running even while the pane is
        // hidden. Some hosts defer hidden xterm writes, so byte-level detection
        // remains the reliable path for clearing stale Codex/Claude chips and
        // preserving agent Shift+Enter behavior when the user returns.
        if (onAgentStateRef.current) {
          processAgentChunkText(agentDecoder.decode(bytes, { stream: true }));
        }

        // Hidden-pane fast path. When the pane isn't on screen, skip the
        // visual hot path — xterm.write (DOM cell churn) and URL sniff — and
        // just stash the raw bytes. They'll be flushed in one write on the
        // next visible-transition. PTY keeps streaming; only the renderer-side
        // rendering cost is deferred.
        if (!visibleRef.current || hiddenReplayPendingRef.current) {
          // writeWhileHidden: keep the real xterm buffer authoritative instead
          // of accumulating a bounded replay queue. We deliberately do NOT flip
          // visibleRef.current: real visibility still gates focus and URL UI.
          // INVARIANT: hiddenBufferRef stays empty, so reveal is a repaint of the
          // same xterm instance rather than a replay step.
          if (writeWhileHiddenRef.current) {
            term.write(bytes);
            onActivityRef.current?.();
            return;
          }
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

        const suppressInternalReset = containsPtyManagerReset(bytes);
        if (suppressInternalReset) {
          const token = {};
          clearNotificationSuppressionRef.current = token;
          try {
            term.write(bytes, () => {
              if (clearNotificationSuppressionRef.current === token) {
                clearNotificationSuppressionRef.current = null;
              }
            });
          } catch (error) {
            if (clearNotificationSuppressionRef.current === token) {
              clearNotificationSuppressionRef.current = null;
            }
            throw error;
          }
        } else {
          term.write(bytes);
        }
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
              // `replayed` tells the owner this URL was scraped out of history
              // main just re-sent (post-sleep backlog, reattach frame), not out
              // of something the child printed just now. The URL is still real —
              // it still earns the click-to-open chip — but it is not evidence
              // that a server came up, so nothing may auto-open from it.
              onDetectedRef.current(url, { replayed: isReplayedChunk });
            }
          }
        }

        // Banner-text fallback for start detection + byte-level fallbacks
        // for exit detection ran above, before the hidden-pane early return.
      });
      // Watch the first ~20s of a resumed Claude's output for a resume-refusal
      // signature and self-heal (fresh forced-id launch + replacement pointer).
      // Shared by the boot restore path (below) and the in-place death re-arm
      // (above via respawnWithResume). Arms ONLY for a genuine, delivered resume
      // — never a fresh fallback or an attached existing session, where
      // "self-healing" would clobber a live conversation.
      const armClaudeRefusalWatch = (restoreCwd: string) => {
        let watchTail = "";
        let rawWatchTail = "";
        let watchDone = false;
        const watchDecoder = new TextDecoder();
        const stopWatch = window.spark.pty.onData(sessionId, (data) => {
          if (watchDone || disposed) return;
          const bytes =
            data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
          const text = watchDecoder.decode(bytes, { stream: true });
          const rawScan = rawWatchTail + text;
          rawWatchTail = rawScan.slice(1 - TUI_ALT_SCREEN_ENTER.length);
          if (rawScan.includes(TUI_ALT_SCREEN_ENTER)) {
            watchDone = true;
            return;
          }
          watchTail = (watchTail + stripAnsi(text)).slice(-512);
          if (!CLAUDE_RESUME_FAILED_RE.test(watchTail)) return;
          watchDone = true;
          const fresh = buildClaudeLaunch();
          logRestore(`pane=${sessionId} claude REFUSED resume; self-healing to fresh id=${fresh.sessionId}`);
          term.write(
            `\r\n\x1b[2m[couldn't resume the previous Claude session — starting a fresh one]\x1b[0m\r\n`,
          );
          onResumeFallbackRef.current?.({
            runtime: "claude",
            sessionId: fresh.sessionId,
            cwd: restoreCwd,
            capturedAt: new Date().toISOString(),
            active: true,
          });
          window.setTimeout(() => {
            if (disposed) return;
            void window.spark.pty.write(sessionId, `${fresh.command}\r`);
          }, 400);
        });
        const watchTimer = window.setTimeout(() => {
          watchDone = true;
          stopWatch();
        }, 20_000);
        cleanups.push(() => {
          watchDone = true;
          stopWatch();
          window.clearTimeout(watchTimer);
        });
      };

      // In-place auto-resume after an UNEXPECTED pty death (see the onExit
      // re-arm below). Reuses the SAME session id + xterm: main deleted the old
      // session on exit, so a same-id spawn is a fresh PTY that DOES deliver the
      // resume via startupCommand, and the pane's already-registered onData /
      // onExit listeners keep working. Reads the FRESHEST pointer (agentSessionRef),
      // since capture may have rewritten it since first mount.
      const respawnWithResume = async () => {
        if (disposed) return;
        let session = agentSessionRef.current;
        if (!session?.sessionId) return;
        if (readOnlyRef.current || inputBlockedRef.current) return;
        const prefs = await window.spark.preferences.load().catch(() => null);
        if (prefs?.restoreAgentSessions !== true) return;
        if (disposed) return;
        // Heal from the SessionStart hook trail: the live-event path usually
        // keeps agentSessionRef current, but an id change that happened while
        // this pane's workspace was hidden only exists in the registry.
        const healed = await fetchSessionStartHeal(sessionId, session);
        if (disposed) return;
        if (healed) {
          logRestore(
            `pane=${sessionId} pointer healed from SessionStart hook (${session.sessionId} -> ${healed.sessionId})`,
          );
          session = healed;
          agentSessionRef.current = healed;
          onResumeFallbackRef.current?.(healed);
        }
        logRestore(`pane=${sessionId} in-place re-arm after pty death (${session.runtime} id=${session.sessionId})`);
        const plan = await computeResumePlan(session);
        if (disposed) return;
        if (!plan.resumeCommand) {
          // Codex with an unresumable rollout → nothing deterministic to relaunch.
          if (plan.fallbackNotice) term.write(`\x1b[2m[${plan.fallbackNotice}]\x1b[0m\r\n`);
          onResumeUnavailableRef.current?.();
          return;
        }
        // Re-enable the input the onExit handler disabled, and announce it.
        term.options.disableStdin = false;
        term.write(
          `\r\n\x1b[2m[resuming previous ${session.runtime} session after it exited]\x1b[0m\r\n`,
        );
        const rcols = Math.max(1, term.cols);
        const rrows = Math.max(1, term.rows);
        try {
          const spawnResult = await window.spark.pty.spawn({
            id: sessionId,
            shell,
            cwd: session.cwd,
            cols: rcols,
            rows: rrows,
            env: { ...(extraEnv ?? {}), SPARK_NO_SHELL_INTEGRATION: "1" },
            startupCommand: plan.resumeCommand,
            nativeCodexProfileId:
              session.nativeCodexProfileId ?? nativeCodexProfileId,
            nativeClaudeProfileId:
              session.nativeClaudeProfileId ?? nativeClaudeProfileId,
          });
          if (disposed) return;
          if (!spawnResult.startupCommandHandled) {
            // The pty just died and was deleted, so a fresh spawn should deliver;
            // if it somehow attached to a live session, mutate nothing, otherwise
            // the shell family couldn't run a startup command — print the manual line.
            if (!spawnResult.attached) {
              term.write(`\x1b[2m[couldn't auto-resume — run: ${plan.resumeCommand}]\x1b[0m\r\n`);
            }
            return;
          }
          autorunFiredSessions.add(sessionId);
          if (plan.fallbackSession) {
            if (plan.fallbackNotice) term.write(`\x1b[2m[${plan.fallbackNotice}]\x1b[0m\r\n`);
            onResumeFallbackRef.current?.(plan.fallbackSession);
          } else if (session.runtime === "claude" && !plan.resumeIsFreshFallback) {
            armClaudeRefusalWatch(session.cwd);
          }
        } catch (err) {
          term.write(`\r\n\x1b[31mfailed to resume: ${(err as Error).message}\x1b[0m\r\n`);
        }
      };

      const offExit = window.spark.pty.onExit(sessionId, (info) => {
        // `info.sanctioned` is set by pty-manager for teardowns Codara asked
        // for (a finished worker's host shell, the app-quit sweep), and the
        // status chip already renders those calm-grey "done" vs red "crashed".
        // The pane text now says the same thing instead of showing every exit
        // as the same bare "[process exited (N)]": sanctioned reads as a
        // sentence, an unexpected death keeps the raw banner so a real crash
        // still looks like one. See formatPaneExitLine.
        term.write(formatPaneExitLine(info));
        term.options.disableStdin = true;
        onExitRef.current?.(info);
        // In-place auto-resume: if an agent TUI was live in this pane when its
        // PTY died unexpectedly — NOT an app quit/reload (appTearingDown), and
        // NOT a clean TUI exit (a clean quit emits the alt-screen-leave the
        // poller turns into running:false, so agentRunningRef would already be
        // false) — silently relaunch it with `--resume`. The pref is checked in
        // respawnWithResume; a crash-loop guard caps repeated attempts.
        if (disposed || isAppTearingDown()) return;
        if (readOnlyRef.current || inputBlockedRef.current) return;
        if (!agentRunningRef.current) return;
        const session = agentSessionRef.current;
        if (!session?.sessionId) return;
        const now = Date.now();
        const prior = pruneAttempts(autoResumeAttempts.get(sessionId) ?? [], now);
        if (!canAutoResume(prior, now)) {
          term.write(
            `\x1b[2m[auto-resume paused after repeated exits — run: ${buildAgentResumeCommand(session)}]\x1b[0m\r\n`,
          );
          return;
        }
        autoResumeAttempts.set(sessionId, [...prior, now]);
        // Small settle delay: lets a genuine app-teardown flip appTearingDown
        // first, and lets the shell/ConPTY drain before the respawn.
        window.setTimeout(() => {
          if (disposed || isAppTearingDown()) return;
          void respawnWithResume();
        }, 400);
      });
      cleanups.push(offData, offReplay, offExit);

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

      // ── Claude/Codex restore precompute (probe BEFORE spawn) ────────────
      // A restored pane has no autorun (stripped on save) but carries a saved
      // agentSession pointer. Restore is boot-once and active-at-close only:
      // it additionally requires the leaf's `bootResume` marker, which useTabs
      // mints at hydration — once per workspace per app run — and only for
      // pointers whose agent was RUNNING when the app quit (active===true).
      // The owner clears the marker after this attempt (any outcome), so
      // remounts within the app's lifetime (workspace switches, pty death) can
      // never auto-type a resume again. Deciding the outcome BEFORE the PTY
      // exists lets the resume command ride pty.spawn's startupCommand —
      // delivered by the shell itself as its first action (see
      // withStartupCommand in src/main/pty-manager.ts). That is the ONLY
      // delivery path for a resume: if spawn reports it unhandled (attached
      // to an EXISTING session, or a shell family without startup-command
      // support), the resume is dropped rather than typed by the 1500ms
      // autorun fallback — so it is structurally impossible to type a resume
      // into a live TUI. (Boot hydration means no pty can pre-exist anyway —
      // main just started — but the delivery gate doesn't rely on that.)
      // The probe is one fs.access-grade IPC, so this delays spawn by
      // milliseconds, and only for panes that actually restore.
      const cmd = initialCommand?.trim();
      let resumeCommand: string | null = null;
      let resumeIsFreshFallback = false;
      let fallbackNotice: string | null = null;
      let fallbackSession: TerminalAgentSession | null = null;
      // Set when the restore gate below was entered; consumeBootResume fires
      // the owner callback at most once no matter which exit path runs.
      let bootResumeEntered = false;
      const consumeBootResume = () => {
        if (!bootResumeEntered) return;
        bootResumeEntered = false;
        onBootResumeConsumedRef.current?.();
      };
      if (
        bootResume === true &&
        agentSession?.sessionId &&
        !cmd &&
        !readOnlyRef.current &&
        !inputBlockedRef.current &&
        !autorunFiredSessions.has(sessionId)
      ) {
        bootResumeEntered = true;
        let restore = agentSession;
        logRestore(`pane=${sessionId} boot-resume gate entered (${restore.runtime} id=${restore.sessionId})`);
        const prefs = await window.spark.preferences.load().catch(() => null);
        if (prefs?.restoreAgentSessions === true) {
          // Heal the pointer from the SessionStart hook trail first, so the
          // resume targets the session that ACTUALLY last ran here (in-TUI
          // `/resume` and `/clear` moved the id without discovery noticing).
          const healed = await fetchSessionStartHeal(sessionId, restore);
          if (healed) {
            logRestore(
              `pane=${sessionId} pointer healed from SessionStart hook (${restore.sessionId} -> ${healed.sessionId})`,
            );
            restore = healed;
            agentSessionRef.current = healed;
            onResumeFallbackRef.current?.(healed);
          }
          // computeResumePlan owns the probe → repair/self-heal/clear decision;
          // it is shared verbatim with the in-place death re-arm below.
          const plan = await computeResumePlan(restore);
          resumeCommand = plan.resumeCommand;
          resumeIsFreshFallback = plan.resumeIsFreshFallback;
          fallbackNotice = plan.fallbackNotice;
          fallbackSession = plan.fallbackSession;
        } else {
          logRestore(`pane=${sessionId} restore pref off; pointer deactivated`);
          // Pref off: the pane stays a plain shell, but the hydrated pointer
          // must not stay frozen at active:true — an idle shell emits no agent
          // events to flip it back, so it would re-persist as "running" on
          // every quit, and re-enabling the pref weeks later would resume this
          // ancient session. Deactivate it now (same persist chain as the
          // fallback pointer); it re-earns `active` the next time its agent is
          // actually seen running.
          if (restore.active) {
            onResumeFallbackRef.current?.({ ...restore, active: false });
          }
        }
      }
      if (disposed) return;

      // Spawn the PTY. We pass the pre-fit cols/rows so the shell starts at
      // the real visible size — without this, ConPTY paints at 80×24 then
      // reflows once the renderer reports the actual size, which the user
      // perceives as a flicker on first prompt.
      const cols =
        externalSizeOwnerRef.current && initialExternalCols
          ? initialExternalCols
          : Math.max(1, term.cols);
      const rows =
        externalSizeOwnerRef.current && initialExternalRows
          ? initialExternalRows
          : Math.max(1, term.rows);
      const cwd = initialCwd && initialCwd.trim().length > 0 ? initialCwd : "";
      // Agent panes — a claude/codex autorun or any restore/resume — flip
      // SPARK_NO_SHELL_INTEGRATION=1: spark.ps1's OSC 633;E echo would feed
      // the TUI stray input, the user $PROFILE only adds latency and error
      // spam before the banner, and (critically) it lets pwsh take the
      // startup command over args in main — race-free delivery, no pwsh
      // spawn-lock queueing.
      const agentPane = resumeCommand !== null || isAgentSessionLaunchCommand(cmd);
      const spawnEnv = agentPane
        ? { ...(extraEnv ?? {}), SPARK_NO_SHELL_INTEGRATION: "1" }
        : extraEnv;
      const preparedNativeCliLoginToken =
        nativeCliLoginToken &&
        !nativeCliLoginTokenFiredSessions.has(sessionId)
          ? nativeCliLoginToken
          : undefined;
      if (preparedNativeCliLoginToken) {
        nativeCliLoginTokenFiredSessions.add(sessionId);
      }
      try {
        const spawnResult = await window.spark.pty.spawn({
          id: sessionId,
          shell,
          cwd,
          cols,
          rows,
          env: spawnEnv,
          startupCommand: cmd || resumeCommand || undefined,
          nativeCodexProfileId:
            agentSessionRef.current?.nativeCodexProfileId ??
            agentSession?.nativeCodexProfileId ??
            nativeCodexProfileId,
          nativeClaudeProfileId:
            agentSessionRef.current?.nativeClaudeProfileId ??
            agentSession?.nativeClaudeProfileId ??
            nativeClaudeProfileId,
          nativeGrokProfileId:
            agentSessionRef.current?.nativeGrokProfileId ??
            agentSession?.nativeGrokProfileId ??
            nativeGrokProfileId,
          nativeCliLoginToken: preparedNativeCliLoginToken,
          // Read-only mirror panes attach to a session whose canonical xterm
          // lives elsewhere. The mirror flag makes main's existing-session
          // branch a pure no-op — critically it skips the pty resize to OUR
          // cols/rows, which would SIGWINCH the live TUI at the mirror's size
          // and garble the canonical pane's display. It also refuses to
          // create a session, so a mirror can never spawn the noop shell.
          mirror: readOnlyRef.current || undefined,
          // A phone-origin pane is still Studio's canonical renderer sink, but
          // reattaching it must not overwrite the phone's measured PTY grid.
          preserveSizeOnAttach: externalSizeOwnerRef.current || undefined,
        });
        if (disposed) {
          // The spawn attempt happened — consume the one-shot marker even
          // though this mount is already dead, so the next mount can't
          // re-deliver the resume on top of the PTY this spawn created.
          consumeBootResume();
          return;
        }
        spawned = true;
        startupCommandHandled = Boolean(spawnResult.startupCommandHandled);
        attachedExistingSession = Boolean(spawnResult.attached);
        if (startupCommandHandled) {
          autorunFiredSessions.add(sessionId);
        }
        // Cold hydration deliberately strips the transient worker chip, but a
        // successfully delivered resume already gives us authoritative runtime
        // identity from the durable session pointer. Re-arm the renderer state
        // immediately instead of waiting to rediscover a banner/alt-screen
        // frame that may have been emitted before onData was attached. The
        // normal poller promotes this launching state to working/idle/blocked.
        if (resumeCommand !== null && startupCommandHandled) {
          const restoredRuntime = agentSessionRef.current?.runtime ?? agentSession?.runtime;
          if (
            restoredRuntime === "claude" ||
            restoredRuntime === "codex" ||
            restoredRuntime === "grok"
          ) {
            setAgentRunning(restoredRuntime);
          }
        }
      } catch (err) {
        term.write(`\r\n\x1b[31mfailed to spawn: ${(err as Error).message}\x1b[0m\r\n`);
        consumeBootResume();
        return;
      }

      // A computed resume/fresh command that spawn did NOT deliver
      // (startupCommandHandled=false). Nothing ran, so nothing may self-heal
      // or mutate the pointer — no replacement, no refusal watch. Two shapes:
      //   - attached: spawn bound to an EXISTING session (pane remount while
      //     a live shell/TUI owns the pty) — stay completely silent.
      //   - fresh spawn on a shell family withStartupCommand can't drive
      //     (fish etc.) — this recurs every boot, so tell the user how to
      //     resume by hand; the pointer stays intact.
      // The codex clear-pointer case (resumeCommand null, notice only) is
      // unaffected: it never had anything to deliver.
      const resumeUndelivered = resumeCommand !== null && !startupCommandHandled;
      if (bootResumeEntered || resumeCommand !== null) {
        logRestore(
          `pane=${sessionId} spawn: delivered=${startupCommandHandled} attached=${attachedExistingSession}` +
            (resumeCommand ? ` cmd="${resumeCommand}"` : " cmd=none"),
        );
      }

      // Manual-resume hint: this pane carries a session pointer but no restore
      // fired (the agent was NOT running at quit — the deliberate "running-at-
      // close only" design — or the one-shot marker was already consumed). The
      // conversation still exists on disk; without the exact command the user
      // has to dig the session id out by hand, so print it once per app run.
      if (
        !bootResumeEntered &&
        resumeCommand === null &&
        !cmd &&
        agentSession?.sessionId &&
        !attachedExistingSession &&
        !readOnlyRef.current &&
        !inputBlockedRef.current &&
        !resumeHintShown.has(sessionId)
      ) {
        resumeHintShown.add(sessionId);
        const hintPrefs = await window.spark.preferences.load().catch(() => null);
        if (hintPrefs?.restoreAgentSessions === true && !disposed) {
          // Heal before hinting, so the printed command reopens the session
          // the user actually left here (not one they `/resume`d away from).
          let hintSession = agentSession;
          const healed = await fetchSessionStartHeal(sessionId, hintSession);
          if (healed && !disposed) {
            logRestore(
              `pane=${sessionId} inactive pointer healed from SessionStart hook (${hintSession.sessionId} -> ${healed.sessionId})`,
            );
            hintSession = healed;
            agentSessionRef.current = healed;
            onResumeFallbackRef.current?.(healed);
          }
          if (!disposed) {
            logRestore(`pane=${sessionId} hint: inactive pointer (${hintSession.runtime} id=${hintSession.sessionId})`);
            term.write(
              `\x1b[2m[previous ${hintSession.runtime} session available — resume: ${buildAgentResumeCommand(hintSession)}]\x1b[0m\r\n`,
            );
          }
        }
      }

      // Restore self-heal bookkeeping (decided in the precompute above):
      // surface the one-line notice and hand the owner the replacement
      // pointer (fresh Claude) or the clear signal (codex, transcript gone).
      if (!resumeUndelivered) {
        if (fallbackNotice) {
          term.write(`\x1b[2m[${fallbackNotice}]\x1b[0m\r\n`);
        }
        if (fallbackSession) {
          onResumeFallbackRef.current?.(fallbackSession);
        } else if (fallbackNotice) {
          onResumeUnavailableRef.current?.();
        }
      } else if (!attachedExistingSession) {
        term.write(
          `\x1b[2m[couldn't auto-resume the previous ${agentSession?.runtime ?? "agent"} session in this shell — run: ${resumeCommand}]\x1b[0m\r\n`,
        );
      }
      // Boot restore attempted — every outcome lands here (resume riding the
      // spawn, undelivered resume, fresh fallback, codex clear-pointer,
      // prefs-disabled, probe failure), so the marker is consumed exactly
      // once per boot.
      //
      // "Exactly once" has a caveat: a pane mounted in a HIDDEN workspace
      // layer gets a noop'd consumption callback (App's isActive gate), so the
      // leaf's marker survives that mount. Safety then rests on two other
      // guards — autorunFiredSessions (a delivered resume marks the id, so a
      // re-entered gate can't type again) and the attach gate above (the pty
      // now exists, so a later mount's spawn attaches and delivers nothing).
      // Do not weaken either without revisiting this.
      consumeBootResume();

      // Drain any bytes the pty emitted while the previous TerminalPane was
      // unmounted (workspace switched away). Main holds those bytes in a
      // detached backlog per pause()/resume() in pty-manager.ts; this call
      // flushes them back through the same data channel as live output, so
      // the user sees everything the agent printed during the gap. On a
      // fresh session this is a no-op (backlog empty, already attached).
      //
      // SKIP in raw-tail reattach mode: unmount called pty.detach (not pause),
      // which cleared the backlog and left the session attached, so nothing was
      // ever paused. The raw tail replayed by spawn() above is the sole source
      // of replayed bytes; calling resume would risk re-delivering tail bytes,
      // so we make the "no double-delivery" invariant explicit by not calling it.
      // Read-only mirrors also skip it: they never pause on unmount, and a
      // resume issued here would drain a backlog the CANONICAL pane paused for,
      // stealing its bytes onto the shared channel at the wrong moment.
      if (!rawTailReattachRef.current && !readOnlyRef.current) {
        void window.spark.pty.resume(sessionId);
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
      let rafFits = 0;
      let rafHandle: number | null = null;

      const scheduleFitRetry = () => {
        if (disposed || !spawned) return;
        if (externalSizeOwnerRef.current) {
          resizeXtermForOwner();
          return;
        }
        if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
        rafFits = 0;
        const tick = () => {
          rafHandle = null;
          if (disposed || !spawned) return;
          // Defer (don't drop) while the host is unmeasurable. A pane sitting
          // under a display:none ancestor — a non-zoomed leaf while a sibling is
          // zoomed, or a not-yet-laid-out tab — reports clientWidth/Height 0, and
          // FitAddon would then read the specified "100%"/"auto" as bogus pixels
          // and shrink the grid to a tiny column count. Skipping leaves term.cols
          // at its last good value; the reveal path re-runs this once the host is
          // measurable again.
          const host = container.current;
          if (!host || host.clientWidth === 0 || host.clientHeight === 0) {
            // Unmeasurable this frame — a display:none sibling (zoom), or the host
            // mid-transition (tab/flex settle). Keep the retry alive for the
            // remaining frames so a one-frame 0 still lands a fit once layout
            // settles, instead of stranding the pane until the next resize event.
            rafFits += 1;
            if (rafFits < 3) rafHandle = window.requestAnimationFrame(tick);
            return;
          }
          try {
            resizeXtermForOwner();
          } catch {
            return;
          }
          lastAppliedCols = term.cols;
          lastAppliedRows = term.rows;
          // Fit is local + cheap and runs every frame so xterm visually tracks a
          // drag-resize; the pty.resize (SIGWINCH) only fires on the trailing edge
          // via the shared debounce below. Sending a SIGWINCH per intermediate
          // column count is what breaks worker CLIs: Claude Code / Codex Ink TUIs
          // mishandle a burst of expanding SIGWINCHes (anthropics/claude-code#46462
          // — the old narrower frame isn't cleared, so the input box strands in a
          // left-hand sub-column, the reported symptom). Coalescing to one resize
          // at the final size sidesteps that and restores the two-stage-debounce
          // contract the ResizeObserver path already honors.
          if (
            !readOnlyRef.current &&
            !externalSizeOwnerRef.current &&
            (term.cols !== lastSentCols || term.rows !== lastSentRows)
          ) {
            if (ptyTimer !== null) window.clearTimeout(ptyTimer);
            ptyTimer = window.setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS);
          }
          rafFits += 1;
          if (rafFits < 3) {
            rafHandle = window.requestAnimationFrame(tick);
          }
        };
        rafHandle = window.requestAnimationFrame(tick);
      };
      // Expose the re-fit path to the WebGL onContextLoss handler (created
      // earlier in this effect). On a GPU context loss xterm swaps to the DOM
      // renderer, whose wider cell metrics leave the grid overflowing the pane
      // unless we re-fit; scheduleFitRetry recomputes cols and pushes the new
      // size to the pty.
      refitAfterRendererSwapRef.current = scheduleFitRetry;
      // Same bridge for the visibility reveal path (outside this closure), so a
      // pane resized while hidden re-fits AND re-syncs the pty the instant it
      // returns to screen. Nulled on cleanup so a stale closure can't run after
      // unmount (scheduleFitRetry also self-guards on `disposed`).
      refitAndResizeRef.current = scheduleFitRetry;
      cleanups.push(() => {
        if (refitAndResizeRef.current === scheduleFitRetry) {
          refitAndResizeRef.current = null;
        }
      });

      const el = container.current;
      const flushPtyResize = () => {
        ptyTimer = null;
        if (disposed || !spawned) return;
        // Read-only mirrors and externally-sized phone panes must not send
        // pty.resize. The former has another renderer owner; the latter is
        // deliberately sized by the phone's measured terminal viewport.
        if (readOnlyRef.current || externalSizeOwnerRef.current) return;
        if (term.cols === lastSentCols && term.rows === lastSentRows) return;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        void window.spark.pty.resize(sessionId, term.cols, term.rows);
      };

      if (el) {
        const observer = new ResizeObserver(() => {
          if (externalSizeOwnerRef.current) {
            resizeXtermForOwner();
            return;
          }
          if (fitTimer !== null) window.clearTimeout(fitTimer);
          fitTimer = window.setTimeout(() => {
            fitTimer = null;
            if (disposed) return;
            const w = el.clientWidth;
            const h = el.clientHeight;
            // Unmeasurable host (display:none ancestor — e.g. a non-zoomed
            // leaf behind a zoomed sibling): FitAddon would misread the
            // specified "100%" as 100px and shrink the grid to ~11 cols, then
            // SIGWINCH the worker TUI at that width (the narrow-left-column
            // garble). Skip WITHOUT recording lastW/lastH, so the observer
            // fire on the display:none→block transition still sees a size
            // change and lands the real fit.
            if (w === 0 || h === 0) return;
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
              resizeXtermForOwner();
            } catch {
              return;
            }
            lastAppliedCols = term.cols;
            lastAppliedRows = term.rows;
            if (!externalSizeOwnerRef.current) {
              if (ptyTimer !== null) window.clearTimeout(ptyTimer);
              ptyTimer = window.setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS);
            }
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
        resizeXtermForOwner();
      } catch {
        /* host transitioned to display:none between mount and now */
      }
      scheduleFitRetry();
      if (
        !readOnlyRef.current &&
        !externalSizeOwnerRef.current &&
        (term.cols !== lastSentCols || term.rows !== lastSentRows)
      ) {
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        void window.spark.pty.resize(sessionId, term.cols, term.rows);
      }

      // Same gate as the reveal effect: mirrors AND input-blocked watch panes
      // never auto-focus — both drop every keystroke, so stealing focus would
      // silently eat the user's typing. Nor does anything auto-focus while a
      // modal dialog is up, for the same reason from the other direction.
      if (
        visible &&
        !readOnlyRef.current &&
        !inputBlockedRef.current &&
        !modalDialogIsOpen()
      ) {
        term.focus();
      }

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
      //
      // Deliberately cmd ONLY — never resumeCommand. A resume is delivered
      // exclusively by a fresh spawn's startupCommand; if spawn instead
      // attached to an EXISTING session (startupCommandHandled=false), typing
      // the resume here would land it inside the live TUI's input box.
      const typedCommand = cmd;
      if (
        typedCommand &&
        typedCommand.length > 0 &&
        !startupCommandHandled &&
        !autorunFiredSessions.has(sessionId) &&
        !readOnlyRef.current
      ) {
        const autorunTimer = window.setTimeout(() => {
          if (disposed) return;
          // inputBlocked gates USER keyboard/paste bytes, not the pane's
          // renderer-owned startup command. A protected Cora worker must still
          // launch when the PTY host asks this fallback path to type autorun.
          if (readOnlyRef.current) return;
          autorunFiredSessions.add(sessionId);
          void window.spark.pty.write(sessionId, `${typedCommand}\r`);
        }, 1500);
        cleanups.push(() => window.clearTimeout(autorunTimer));
      }

      // ── Resume-refusal watch ────────────────────────────────────────────
      // The pre-spawn probe can pass and `claude --resume <id>` still refuse
      // (transcript truncated past repair, CLI version quirks). Claude then
      // prints its refusal and exits to the prompt; armClaudeRefusalWatch
      // watches the first ~20s of output for the signature and self-heals with a
      // fresh forced-id launch + replacement pointer. Arms ONLY when the resume
      // was actually delivered (startupCommandHandled) and is a genuine resume
      // (not a fresh fallback) — watching an existing/live session's output
      // would "self-heal" a conversation that was never asked to resume.
      if (
        resumeCommand &&
        !resumeIsFreshFallback &&
        startupCommandHandled &&
        agentSession?.runtime === "claude"
      ) {
        armClaudeRefusalWatch(agentSession.cwd);
      }
    };

    return () => {
      disposed = true;
      clearNotificationSuppressionRef.current = null;
      window.clearTimeout(startTimer);
      // Tell main to stop firing pty bytes at the about-to-be-dead IPC
      // listener and instead accumulate them in a per-session backlog. The
      // very next mount of this sessionId calls resume() to drain it. Done
      // BEFORE running the cleanups (which include offData) so the window
      // between "listener removed" and "main processes pause" is as short
      // as possible — any chunk that slips through during that one-tick
      // gap is also absorbed by pause() itself, which moves the pending
      // flush queue into the backlog.
      if (rawTailReattachRef.current) {
        // Raw-tail reattach (chat backend terminal): DETACH instead of pause.
        // detach() nulls main's renderer sink and DISCARDS the pause/backlog
        // state; bytes keep accumulating in main's raw tail (a superset of what
        // this pane saw), which the next spawn() replays verbatim into a fresh
        // xterm — reproducing the live Ink TUI frame exactly like a first
        // attach. We deliberately do NOT capture a flattened xterm-text snapshot
        // below in this mode (see the guarded snapshot block): a text snapshot
        // replayed under an incrementally-redrawing TUI is precisely what garbles
        // the screen on remount.
        void window.spark.pty.detach?.(sessionId);
      } else if (!readOnlyRef.current) {
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
      // Raw-tail reattach mode skips the snapshot entirely: main's raw tail is
      // the sole replay source on remount (a flattened-text snapshot would
      // garble the live TUI), so capturing one here would be dead weight and,
      // worse, could replay on a later non-raw mount of the same session. The
      // hidden-buffer refs are dropped unconditionally below — their bytes are in
      // main's tail and come back via the raw replay.
      // Read-only mirrors never capture a snapshot either: the cache is keyed
      // by sessionId and consumed by the next CANONICAL mount — a mirror's
      // partial buffer stored there would replay a flattened frame under the
      // canonical pane's live TUI (or under a later mirror), the exact garble
      // the raw-tail path exists to prevent.
      if (dyingTerm && !replayPending && !rawTailReattachRef.current && !readOnlyRef.current) {
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
            const buffer = dyingTerm.buffer.active;
            rememberXtermBufferSnapshot(sessionId, {
              text,
              pendingBytes,
              viewportFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
            });
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
  }, [resizeXtermForOwner, sessionId]);

  // Mark a hidden→visible transition synchronously with the commit so PTY
  // bytes arriving before the post-paint drain stay ordered behind the hidden
  // backlog. Crucially, this layout effect does NO merging or xterm writes:
  // those were previously on React's pre-paint path, and a few busy panes with
  // multi-megabyte backlogs made workspace clicks visibly stall.
  const prevVisibleRef = useRef<boolean | null>(null);
  const viewportBeforeHideRef = useRef<{ line: number; atBottom: boolean } | null>(null);
  useLayoutEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) {
      const term = termRef.current;
      if (term) {
        const buffer = term.buffer.active;
        viewportBeforeHideRef.current = {
          line: buffer.viewportY,
          atBottom: buffer.viewportY >= buffer.baseY,
        };
      } else if (!viewportBeforeHideRef.current) {
        // A pane can mount for the first time underneath an inactive tab or a
        // background workspace. It has no visible viewport to capture yet, but
        // its xterm may already be receiving a Codex/Claude startup frame.
        // First reveal should follow that live output, not expose row zero.
        viewportBeforeHideRef.current = { line: 0, atBottom: true };
      }
      hiddenReplayPendingRef.current = false;
      return;
    }
    if (prev === false && hiddenBufferRef.current.length > 0) {
      hiddenReplayPendingRef.current = true;
    }
  }, [visible]);

  // Let the newly selected workspace paint once, then coalesce and enqueue its
  // hidden output. requestAnimationFrame + a zero-delay task is intentional:
  // an rAF callback itself still runs before paint, while the following task
  // runs after that frame has been presented. xterm preserves write ordering,
  // and the pending flag above keeps live bytes in this same batch until the
  // replay has entered xterm's queue.
  useEffect(() => {
    if (!visible || !hiddenReplayPendingRef.current) return;
    let timer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        timer = null;
        if (!visibleRef.current || !hiddenReplayPendingRef.current) return;
        const term = termRef.current;
        const total = hiddenBytesRef.current;
        if (!term || total <= 0 || hiddenBufferRef.current.length === 0) {
          hiddenReplayPendingRef.current = false;
          return;
        }

        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of hiddenBufferRef.current) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        hiddenBufferRef.current = [];
        hiddenBytesRef.current = 0;
        hiddenLineBreaksRef.current = 0;

        const token = {};
        clearNotificationSuppressionRef.current = token;
        try {
          term.write(merged, () => {
            if (clearNotificationSuppressionRef.current === token) {
              clearNotificationSuppressionRef.current = null;
            }
          });
        } catch {
          if (clearNotificationSuppressionRef.current === token) {
            clearNotificationSuppressionRef.current = null;
          }
          /* xterm may dispose mid-flush during a fast workspace switch */
        } finally {
          hiddenReplayPendingRef.current = false;
        }
      }, 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    const savedViewport = viewportBeforeHideRef.current;
    try {
      resizeXtermForOwner();
    } catch {
      /* host may be hidden during the transition */
    }
    // Re-sync the pty to the pane's CURRENT size on every reveal. If the app
    // window was resized while this pane sat on a hidden tab (or it was just
    // un-zoomed from behind a display:none sibling), xterm re-fits above, but
    // nothing pushed the new cols/rows to the pty — so the TUI would keep
    // painting at the size it had when hidden. scheduleFitRetry re-fits across
    // the next few frames (late flex/tab layout) and schedules a single
    // trailing-edge pty.resize only when the size actually changed; it no-ops
    // while the host is still unmeasurable, so a mid-transition reveal defers
    // rather than pushing a bogus size.
    refitAndResizeRef.current?.();
    // The host can finish expanding one paint later when it sits inside a
    // flex/absolute stack or a tab transition. Re-fit on the next frame so
    // xterm doesn't stay pinned to the smaller first-pass row count.
    // scheduleFitRetry deliberately runs for three animation frames because a
    // flex/absolute terminal host can report an intermediate size. FitAddon can
    // reset xterm's viewport on ANY of those frames, so restoring scroll only
    // after frame one still left Codex at the top. Restore after each matching
    // frame; the last callback wins after the final fit while the whole sequence
    // remains under ~50 ms.
    let raf: number | null = null;
    let remainingRestoreFrames = 3;
    let rendererRecovered = false;
    const restoreAfterFit = () => {
      raf = null;
      try {
        resizeXtermForOwner();
      } catch {
        /* ignore late layout churn */
      }
      if (!rendererRecovered) {
        rendererRecovered = true;
        // Force a full repaint and recreate a lost WebGL context before
        // restoring the viewport into the final renderer.
        recoverRendererRef.current?.();
      }
      const term = termRef.current;
      if (term && savedViewport) {
        if (savedViewport.atBottom) term.scrollToBottom();
        else term.scrollToLine(savedViewport.line);
      }
      remainingRestoreFrames -= 1;
      if (remainingRestoreFrames > 0) {
        raf = window.requestAnimationFrame(restoreAfterFit);
      }
    };
    raf = window.requestAnimationFrame(restoreAfterFit);
    // Read-only mirrors and input-blocked watch panes don't grab keyboard
    // focus on reveal: they drop every keystroke, so stealing focus from e.g.
    // a blocked-worker answer input would silently eat the user's typing. An
    // open modal dialog is the same hazard: it focused itself deliberately and
    // this must not take that back. Click-to-focus (the explicit focus() API)
    // still works for copy/scroll in every case.
    if (!readOnlyRef.current && !inputBlockedRef.current && !modalDialogIsOpen()) {
      termRef.current?.focus();
    }
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [resizeXtermForOwner, visible]);

  // System sleep does not necessarily toggle React's `visible` prop, so the
  // normal reveal recovery above may never run. Listen to Electron's explicit
  // host-resume signal and browser focus/visibility as fallbacks. Repair the
  // WebGL/DOM renderer first, re-fit the grid, force a full repaint, and only
  // then acknowledge main's sleep pause so queued PTY bytes cannot race a
  // blank or context-lost canvas.
  useEffect(() => {
    let recoveryFrame: number | null = null;
    let recoveryTimer: number | null = null;
    let recoveryGeneration = 0;
    const recoverAfterHostWake = () => {
      recoveryGeneration += 1;
      const generation = recoveryGeneration;
      if (recoveryFrame !== null) window.cancelAnimationFrame(recoveryFrame);
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      const finishRecovery = () => {
        if (generation !== recoveryGeneration) return;
        if (recoveryFrame !== null) window.cancelAnimationFrame(recoveryFrame);
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        recoveryFrame = null;
        recoveryTimer = null;
        try {
          resizeXtermForOwner();
        } catch {
          /* the host can still be transitioning from lock-screen geometry */
        }
        refitAndResizeRef.current?.();
        recoverRendererRef.current?.();
        const term = termRef.current;
        if (term) {
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
          } catch {
            /* terminal may be disposing during a simultaneous tab close */
          }
        }
        if (!readOnlyRef.current) void window.spark.pty.resume(sessionId);
      };
      // Prefer the next paint so xterm repairs before queued bytes drain. A
      // Chromium may throttle a fully occluded window; never let that leave the
      // PTY backlog paused indefinitely. The timer drains data into xterm's
      // buffer and a later focus/visibility recovery repaints it if necessary.
      recoveryFrame = window.requestAnimationFrame(finishRecovery);
      recoveryTimer = window.setTimeout(finishRecovery, 250);
    };
    const offHostResume = window.spark.pty.onHostResume(recoverAfterHostWake);
    const onFocus = () => recoverAfterHostWake();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        recoverAfterHostWake();
      } else if (!readOnlyRef.current) {
        // Stop IPC/xterm churn while the whole window is minimized, hidden to
        // tray, or frozen by the OS. Main keeps a bounded ordered backlog and
        // recoverAfterHostWake resumes it only after xterm has repaired/refit.
        void window.spark.pty.pause(sessionId);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // A pane can mount after the document is already hidden; no transition
    // event will follow in that case, so apply the current state immediately.
    onVisibility();
    return () => {
      recoveryGeneration += 1;
      offHostResume();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (recoveryFrame !== null) window.cancelAnimationFrame(recoveryFrame);
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
    };
  }, [resizeXtermForOwner, sessionId]);

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

function containsPtyManagerReset(bytes: Uint8Array): boolean {
  const sequenceLength = PTY_MANAGER_RESET_SEQUENCE.length;
  for (let i = 0; i <= bytes.length - sequenceLength; i++) {
    let matches = true;
    for (let j = 0; j < sequenceLength; j++) {
      if (bytes[i + j] !== PTY_MANAGER_RESET_SEQUENCE.charCodeAt(j)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
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
// Effective cadence while the app window is hidden. The poller keeps running
// (background panes must still transition so turn-complete notifications fire)
// but at a fraction of the cost — nobody is watching the chip, and the tick-
// count backstops below only get more conservative when ticks are rarer.
const HIDDEN_STATE_POLL_MS = 2_000;
// How many post-arm bytes the runtime-promotion sniff will scan before giving
// up on a generic/non-public arm. A first-party launch banner appears within
// the first few KB of boot output, so 64 KB is far past any real banner while
// still cheap — after this the promotion sniff is disabled for that arm so a
// long-lived vim / less / third-party-agent pane isn't sniffed on every chunk
// for its whole lifetime. Reset on the next arm.
const POST_ARM_PROMOTE_BUDGET_BYTES = 64 * 1024;
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
