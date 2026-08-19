import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyTail,
  coercePublicRuntime,
  countTeammateEvents,
  runtimeFromCommandLine,
  sniffLiveRuntime,
  sniffRuntime,
  stripAnsi,
  unescapeOsc633,
  type PublicAgentRuntime,
} from "@shared/agent-patterns";
import * as pty from "./pty-manager";
import { emitTerminalAgentState, paneSourceKey, publish, rearm } from "./notify";
import type { RuntimeState, TerminalAgentStatePayload } from "@shared/types";

// Terminal-agent notifier: tells the user when a Claude / Codex CLI
// they ran in a NORMAL terminal pane stops working — finished a turn, or
// stopped to ask for permission — while they are looking somewhere else.
// Orchestration runs already alert through run-store events; this module
// covers the "I just typed `claude` in a shell" workflow that previously had
// no completion signal at all.
//
// Why main-process, on the raw pty stream: the renderer's visible-buffer
// state poller (useTerminalSession) freezes the moment a pane is hidden
// (hidden panes skip xterm.write), and gets NO bytes at all when the
// workspace is switched away (pty.pause diverts the stream into main's
// detached backlog). The cases where a notification is useful are exactly
// the cases where the renderer can't see the stream — so detection lives
// here, on pty-manager's tap() fan-out, which observes every chunk
// regardless of renderer attachment.
//
// Detection model (mirrors how WezTerm + cmux-style multiplexers do it):
//   1. Explicit notification escapes — OSC 9 (iTerm2/ConEmu style) and
//      OSC 777;notify (rxvt style). Codex emits OSC 9 natively when
//      `tui.notifications` is enabled; any other CLI tool that emits these
//      gets surfaced too, same as a real terminal emulator would.
//   2. Stream heuristic for the three first-party agent CLIs — while an
//      agent works, its Ink footer ("esc to interrupt" + a ticking timer)
//      repaints at least once a second, so the byte stream continuously
//      re-matches the `working` patterns. When the matches stop for
//      TURN_QUIET_MS the turn is over → "done". A `blocked` pattern match
//      (permission prompt) while working → "needs you". Pattern tables are
//      shared with the renderer poller (src/shared/agent-patterns.ts).
//
// Suppression policy (the WezTerm `SuppressFromFocusedTab` model, per the
// user's ask): an alert is dropped iff the app window is focused AND the
// pane itself is the active split in the workspace + tab the renderer last
// reported. Visible sibling splits still alert because they cannot accept
// keyboard input until selected.
// That rule — plus the same-kind dedup and terminal-completion guard — now
// lives in the unified notify policy (src/main/notify); this module only
// detects turn boundaries and calls publish()/rearm().

const RING_MAX = 8_192;
// Banner-sniff window: while a pane has no detected runtime (every plain
// shell, forever), each chunk is sniffed as fresh-decoded-text + this much
// prior ring — NOT the whole 8 KB ring, whose per-chunk stripAnsi + 14-regex
// scan was a dominant hot-path cost. A banner is detected the moment its
// bytes arrive (attach() replays history through onChunk chunk-by-chunk, so
// pre-attach banners are covered too); the overlap only needs to bridge a
// banner split across a chunk boundary. Longest banner pattern source is 42
// visible chars; 512 covers it even with Ink positioning every character via
// cursor-move escapes (~5 raw bytes per visible char).
const SNIFF_OVERLAP = 512;
// Raw-text carry bridging escape sequences / footer phrases split across
// chunk boundaries. Ink positions characters with cursor moves between
// bytes, so a 16-char phrase can span several hundred raw bytes; 1 KB of
// carry covers that while keeping the per-chunk regex window small.
const CARRY_MAX = 1_024;
// How long the working-pattern repaints must stay silent before we call the
// turn finished. Claude/Codex repaint their status footer (elapsed-seconds
// tick) at least once per second while generating or running tools, so three
// missed repaints is a confident "stopped", while keeping the notification
// within a beat of the actual finish.
const TURN_QUIET_MS = 3_000;
// Stall-aware quiet window. The 3s window above assumed the footer repaints
// at least once per second for the WHOLE turn, but on ConPTY the byte stream
// goes genuinely silent mid-turn whenever nothing visible changes (hidden
// thinking, a long tool run with no output, API backoff) — and each such
// stall used to fire a ghost "finished" (live-observed 2026-07-06: 13 ghost
// dones for one pane in 10 minutes). Discriminator: on a REAL turn end the
// last chunk before silence is the idle repaint (footer erased, input box
// painted — no working pattern), while a stall goes silent with the working
// footer as the last thing painted. Footer-then-silence therefore waits this
// much longer before calling the turn done; idle-frame-then-silence keeps
// the fast 3s window.
const TURN_QUIET_STALL_MS = 15_000;
const SWEEP_MS = 1_000;
// Minimum working-phase duration before heuristic alerts fire. Codex paints
// its full working footer ("(0s • esc to interrupt)") for ~half a second
// while BOOTING (live-captured v0.138.0, 2026-06-10) — without this gate the
// boot blip fires a spurious "finished" whose cooldown then swallows the
// real turn's alert. Real turns comfortably clear it: even a bare "hello"
// to Claude sustains working for ~2.3s. Explicit OSC 9/777 notifications
// are NOT gated — the program announced the stop itself.
const MIN_WORK_MS = 1_500;
// After an explicit OSC 9/777 notification (Codex announces its own turn
// completion), mute the stream heuristic for a while so the same turn end
// can't alert twice.
const OSC_NOTIFY_MUTE_MS = 10_000;
// Self-heal window for a desynced teammate counter (a "finished" line that
// scrolled past unseen, or a full-screen redraw double-counting a stale
// "1 teammate started" from scrollback). A RUNNING teammate repaints its
// strip row at least once a second (live v2.1.201 capture); an IDLE-but-alive
// teammate can go 20s+ between paints — but an idle teammate's turn IS over,
// so clearing the counter on total byte-silence is correct in both cases.
const TEAMMATE_SILENCE_MS = 15_000;
// Late registration is most visible during cold restore: the shell can print
// the resume banner + first busy frame before the renderer has hydrated its
// terminal registry. Replaying a bounded recent tail closes that gap without
// scanning the full 4 MB PTY history on every workspace switch.
const BOOTSTRAP_TAIL_BYTES = 256 * 1024;

interface PaneWatcher {
  paneId: string;
  workspaceId: string;
  // Display name of the owning workspace, for alert copy ("…in workspace
  // X"). Shipped by the renderer with each registry sync; may be empty.
  workspaceName: string;
  tabId: string;
  tabTitle: string;
  // Cora-orchestrated worker panes register excluded — their lifecycle
  // already alerts through run-store status events, and double-notifying
  // every worker turn would be pure noise.
  excluded: boolean;
  attached: boolean;
  // True only while rebuilding state from output that predates this watcher.
  // Historic bytes may contain old completion/permission frames; they are
  // useful for reconstructing the current chip but must never create toasts.
  replayingTail: boolean;
  untap: (() => void) | null;
  offExit: (() => void) | null;
  decoder: TextDecoder;
  // Rolling decoded text used for banner sniffing while no runtime is known.
  ring: string;
  // Tail of the previous chunk's raw text (see CARRY_MAX).
  carry: string;
  runtime: PublicAgentRuntime | null;
  runtimeHint: PublicAgentRuntime | null;
  state: "idle" | "working" | "blocked" | "failed";
  // Set by a real user/injected write or an OSC shell command marker. This
  // lets a launch-time trust/login/permission dialog alert even when the CLI
  // never painted a working footer first. Consumed by the first terminal
  // outcome so startup chrome alone cannot repeatedly notify.
  userTurnArmed: boolean;
  // Renderer-owned close/dispose in progress. A killed PTY can report a
  // non-zero exit even though the user intentionally closed the pane; never
  // mislabel that as an agent crash.
  disposing: boolean;
  // When the current working phase began (state transition into "working").
  workingSince: number;
  lastWorkingAt: number;
  lastOscNotifyAt: number;
  // Whether the most recent chunk positively asserted "working" (footer
  // pattern / structured OSC busy signal), as opposed to merely sustaining
  // the phase with unclassified bytes. Drives the stall-aware quiet window:
  // silence that began with the working footer still painting reads as a
  // mid-turn stall, not a finish (see TURN_QUIET_STALL_MS).
  lastChunkAssertedWorking: boolean;
  // Net count of live background teammates (Task-tool / background agents),
  // fed by countTeammateEvents on the transcript stream. While > 0, the main
  // REPL's turn-stopped signals (progress clear, idle status, quiet window)
  // are held — the pane is still busy even though the main turn ended.
  teammatesActive: number;
  // When the last non-empty decoded chunk arrived, any content. Backs the
  // teammate counter's silence self-heal in the sweep.
  lastOutputAt: number;
  // Last RuntimeState pushed to the renderer chip via emitPaneState. Distinct
  // from `state` (the 3-value notifier vocabulary idle/working/blocked) — this
  // is the translated chip RuntimeState and exists purely to dedup the chip
  // channel so identical states aren't re-sent every chunk. null = nothing
  // emitted yet.
  lastEmittedState: RuntimeState | null;
}

const watchers = new Map<string, PaneWatcher>();
let sweepTimer: NodeJS.Timeout | null = null;

// Diagnostic trail (state transitions only, never raw bytes). The notifier's
// whole job happens while nobody is looking at the pane, so when an expected
// alert doesn't fire there is no UI evidence to inspect — this file is the
// flight recorder. Best-effort: truncated when oversized, errors swallowed.
const LOG_PATH = path.join(os.tmpdir(), "spark-terminal-notify.log");
let logChecked = false;
function tanLog(msg: string): void {
  // Off by default: the flight recorder only writes when explicitly opted in
  // via SPARK_TERMINAL_NOTIFY_LOG. Call sites stay unconditional; this is a
  // no-op unless the env var is set (truthy).
  if (!process.env.SPARK_TERMINAL_NOTIFY_LOG) return;
  try {
    if (!logChecked) {
      logChecked = true;
      try {
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 2_000_000) {
          fs.truncateSync(LOG_PATH, 0);
        }
      } catch {
        /* ignore */
      }
    }
    fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, () => {});
  } catch {
    /* ignore */
  }
}

export interface TerminalNotifyPaneEntry {
  paneId: string;
  tabId: string;
  tabTitle: string;
  excluded: boolean;
  // Restore already knows which CLI owns this pane from its durable session
  // pointer. Supplying that fact avoids depending on a banner that may have
  // been printed before the watcher attached (or omitted by a resume redraw).
  runtimeHint?: PublicAgentRuntime | null;
}

// Renderer-driven registry sync, one call per workspace layout change. The
// renderer is the only side that knows which pty sessions are user-facing
// terminal panes (vs chat backends / headless eval ptys) and which tab each
// pane lives in, so it ships the full desired set for the workspace and we
// reconcile: upsert routing metadata for live panes, drop watchers for panes
// that no longer exist in that workspace's tabs.
export function syncTerminalNotifyPanes(input: {
  workspaceId: string;
  workspaceName?: string;
  panes: TerminalNotifyPaneEntry[];
}): TerminalAgentStatePayload[] {
  if (!input || typeof input.workspaceId !== "string" || !Array.isArray(input.panes)) return [];
  const workspaceName = typeof input.workspaceName === "string" ? input.workspaceName : "";
  const seen = new Set<string>();
  for (const entry of input.panes) {
    if (!entry || typeof entry.paneId !== "string" || entry.paneId.length === 0) continue;
    seen.add(entry.paneId);
    const existing = watchers.get(entry.paneId);
    if (existing) {
      existing.workspaceId = input.workspaceId;
      existing.workspaceName = workspaceName;
      existing.tabId = String(entry.tabId ?? "");
      existing.tabTitle = String(entry.tabTitle ?? "Terminal");
      existing.excluded = Boolean(entry.excluded);
      existing.runtimeHint =
        entry.runtimeHint === "claude" ||
        entry.runtimeHint === "codex" ||
        entry.runtimeHint === "grok"
          ? entry.runtimeHint
          : null;
      if (!existing.runtime && existing.runtimeHint) existing.runtime = existing.runtimeHint;
      if (!existing.attached) attach(existing);
      continue;
    }
    const watcher: PaneWatcher = {
      paneId: entry.paneId,
      workspaceId: input.workspaceId,
      workspaceName,
      tabId: String(entry.tabId ?? ""),
      tabTitle: String(entry.tabTitle ?? "Terminal"),
      excluded: Boolean(entry.excluded),
      attached: false,
      replayingTail: false,
      untap: null,
      offExit: null,
      decoder: new TextDecoder("utf-8", { fatal: false }),
      ring: "",
      carry: "",
      runtime:
        entry.runtimeHint === "claude" ||
        entry.runtimeHint === "codex" ||
        entry.runtimeHint === "grok"
          ? entry.runtimeHint
          : null,
      runtimeHint:
        entry.runtimeHint === "claude" ||
        entry.runtimeHint === "codex" ||
        entry.runtimeHint === "grok"
          ? entry.runtimeHint
          : null,
      state: "idle",
      userTurnArmed: false,
      disposing: false,
      workingSince: 0,
      lastWorkingAt: 0,
      lastOscNotifyAt: 0,
      lastChunkAssertedWorking: false,
      teammatesActive: 0,
      lastOutputAt: 0,
      lastEmittedState: null,
    };
    watchers.set(entry.paneId, watcher);
    attach(watcher);
  }
  // Panes that disappeared from this workspace's layout were closed (a pane
  // that merely moved tabs is still in the list with its new tabId). Other
  // workspaces' watchers are untouched — their layouts can't change while
  // unmounted, so their routing metadata stays valid.
  for (const [paneId, watcher] of watchers) {
    if (watcher.workspaceId === input.workspaceId && !seen.has(paneId)) {
      removeWatcher(paneId);
    }
  }
  tanLog(
    `sync ws=${input.workspaceId} panes=${input.panes
      .map((p) => `${p?.paneId}(tab=${p?.tabId}${p?.excluded ? ",excluded" : ""})`)
      .join(" ")} watchers=${watchers.size}`,
  );
  ensureSweep();
  return terminalAgentStateSnapshot(input.workspaceId);
}

function attach(w: PaneWatcher): void {
  if (w.attached) return;
  // pty.tap/onExit deliberately accept ids before the underlying session
  // exists. Register immediately so a cold-restored agent cannot print its
  // one-shot banner between pty:spawn and a waitForSpawn continuation.
  tanLog(`pane=${w.paneId} tap attached (excluded=${w.excluded})`);
  w.untap = pty.tap(w.paneId, (chunk) => {
    try {
      onChunk(w, chunk);
    } catch (err) {
      console.warn("[terminal-agent-notify] chunk handler failed:", err);
    }
  });
  w.offExit = pty.onExit(w.paneId, (info) => {
    // The renderer owns the red chip because it has the authoritative PTY
    // exit. The notifier owns off-screen attention: if a live manual agent's
    // terminal process dies non-zero, tell the user instead of silently
    // removing the watcher.
    if (!w.excluded && !w.disposing && w.runtime && info.exitCode !== 0) {
      deliver(
        w,
        "failed",
        `${runtimeLabel(w.runtime)} terminal exited with code ${info.exitCode}.`,
      );
    }
    if (w.disposing) {
      removeWatcher(w.paneId);
      return;
    }

    // Clear the rail spinner immediately. The renderer's pty:exit handler
    // remains authoritative for the chip's clean-vs-crash presentation; this
    // state event is also what prevents a dead pane from leaving its workspace
    // activity ring spinning indefinitely.
    emitPaneState(w, info.exitCode === 0 ? "done" : "error");

    // Keep the desired watcher registration alive across an unexpected
    // same-id respawn. useTerminalSession can auto-resume a live agent after a
    // PTY death; deleting the watcher here meant the replacement went unseen
    // whenever no tab-state mutation happened to trigger another registry
    // sync. pty.tap/onExit both support pre-registration, so reset the parser
    // and attach again immediately, before the replacement process exists.
    try {
      w.untap?.();
    } catch {
      /* ignore */
    }
    w.untap = null;
    w.offExit = null;
    w.attached = false;
    w.decoder = new TextDecoder("utf-8", { fatal: false });
    w.ring = "";
    w.carry = "";
    w.runtime = w.runtimeHint;
    w.state = "idle";
    w.userTurnArmed = false;
    w.workingSince = 0;
    w.lastWorkingAt = 0;
    w.lastOscNotifyAt = 0;
    w.lastChunkAssertedWorking = false;
    w.teammatesActive = 0;
    w.lastOutputAt = 0;
    w.lastEmittedState = null;
    attach(w);
  });
  w.attached = true;

  // The tap is installed first. Node's event loop cannot interleave another
  // pty onData callback while the synchronous snapshot below is replayed, so
  // bytes are observed exactly once with no read→subscribe race. Preserve the
  // original chunks: onChunk's carry/fresh-boundary logic then reconstructs
  // the same state transitions it would have seen live.
  const recent = pty.readTailChunks(w.paneId, BOOTSTRAP_TAIL_BYTES) ?? [];
  if (recent.length > 0) {
    w.replayingTail = true;
    try {
      for (const chunk of recent) onChunk(w, chunk);
    } catch (err) {
      console.warn("[terminal-agent-notify] tail replay failed:", err);
    } finally {
      w.replayingTail = false;
      // Replayed user-input / command markers belong to history. They may
      // identify the foreground runtime, but must not arm a future alert as if
      // the user had just typed into the pane now.
      w.userTurnArmed = false;
      w.lastOscNotifyAt = 0;
    }
  }
}

function removeWatcher(paneId: string): void {
  const w = watchers.get(paneId);
  if (!w) return;
  tanLog(`pane=${paneId} watcher removed`);
  watchers.delete(paneId);
  // Free the notify policy's per-source dedup state for the dead pane.
  rearm(paneSourceKey(paneId));
  try {
    w.untap?.();
  } catch {
    /* ignore */
  }
  try {
    w.offExit?.();
  } catch {
    /* ignore */
  }
  if (watchers.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function ensureSweep(): void {
  if (sweepTimer || watchers.size === 0) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const w of watchers.values()) {
      // Self-heal a watcher whose transport was reset by an unexpected PTY
      // exit or a transient attach failure instead of waiting for another
      // renderer layout change.
      if (!w.attached) attach(w);
      if (w.excluded || !w.runtime) continue;
      if (w.teammatesActive > 0) {
        if (now - w.lastOutputAt >= TEAMMATE_SILENCE_MS) {
          // A RUNNING teammate repaints its strip row at least once a second
          // (live capture); total byte-silence this long means the counter is
          // stale — clear it and let the normal quiet window resolve the turn.
          tanLog(`pane=${w.paneId} teammate counter stale (silence) — cleared`);
          w.teammatesActive = 0;
        } else {
          continue;
        }
      }
      if (w.state !== "working") continue;
      // Stall-aware window: silence right after a working-footer paint is a
      // mid-turn stall until proven otherwise; silence after an idle repaint
      // (no working pattern in the final chunk) is a confident finish.
      const quietMs = w.lastChunkAssertedWorking ? TURN_QUIET_STALL_MS : TURN_QUIET_MS;
      if (now - w.lastWorkingAt < quietMs) continue;
      w.state = "idle";
      tanLog(
        `pane=${w.paneId} turn finished (quiet ${quietMs}ms elapsed, stall-like=${w.lastChunkAssertedWorking}, worked ${w.lastWorkingAt - w.workingSince}ms)`,
      );
      // The turn ended (no working repaints for the quiet window) → chip ready.
      // Emit BEFORE the workedLongEnough/OSC-mute toast gates below: those gate
      // the toast (a boot blip shouldn't ping the user), but the chip should
      // still flip off "working" the instant the stream goes quiet — this is
      // the core fix for the stuck-on-WORKING banner when the pane is hidden.
      emitPaneState(w, "idle");
      if (!workedLongEnough(w)) continue;
      if (now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) continue;
      deliver(w, "done", null);
      w.userTurnArmed = false;
    }
  }, SWEEP_MS);
  sweepTimer.unref();
}

// ── Per-chunk stream scanning ────────────────────────────────────────────

// Explicit desktop-notification escapes, exactly the set WezTerm renders:
//   OSC 9  — `ESC ] 9 ; message BEL`   (iTerm2/growl style; Codex emits this)
//   OSC 777 — `ESC ] 777 ; notify ; title ; body BEL` (rxvt extension)
// `ESC ] 9 ; 4 ; …` is the ConEmu taskbar-progress protocol, not a
// notification — filtered below.
const OSC9_G = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC777_G = /\x1b\]777;notify;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC633E_G = /\x1b\]633;E;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// ConEmu/Windows-Terminal progress protocol — `ESC ] 9 ; 4 ; state ; pct BEL`
// with state 0=clear 1=set 2=error 3=indeterminate. Claude Code emits this
// when `terminalProgressBarEnabled` is on: indeterminate/set while a turn
// runs, clear when it stops — a machine-readable busy/idle signal that beats
// the footer heuristic when present.
const OSC9_PROGRESS_G = /\x1b\]9;4(?:;(\d*))?(?:;\d*)?(?:\x07|\x1b\\)/g;
// iTerm2 tab-status extension (OSC 21337). Claude Code emits it when
// `showStatusInTerminalTab` is on, with exactly three statuses: "Working…",
// "Idle", "Waiting" (waiting = permission prompt). Another free upgrade over
// the heuristic when the user has it enabled.
const OSC21337_G = /\x1b\]21337;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Same prompt-back markers the renderer keys off (OSC 633 A/B/D/P + OSC
// 133;A / 133;D), made global so matches can be position-checked against the
// carry. Kept byte-for-byte in sync with the shared PROMPT_MARKER_RE: accepts
// the ST (`\x1b\\`) terminator after 633 markers and treats 133;D (command
// finished) as a prompt-return signal alongside 133;A. The carry-aware scan
// (`text = w.carry + decoded`, CARRY_MAX=1024) already bridges a marker split
// across PTY chunk boundaries, so no further carry change is needed here.
const PROMPT_MARKER_G = /\x1b\]633;[ABDP](?:;|\x07|\x1b\\)|\x1b\]133;[AD](?:\x07|\x1b\\)/g;
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

// High-confidence terminal problems that deserve a richer outcome than the
// generic working→idle heuristic. Keep these deliberately narrow: agent
// transcripts regularly contain words such as "error" and "authentication"
// in ordinary prose, so only recognizable CLI failure/login copy qualifies.
const CREDENTIAL_PROBLEM_RE = /(?:not\s*(?:logged|signed)\s*in|authentication\s*(?:is\s*)?(?:required|failed)|oauth\s*(?:token\s*)?(?:expired|invalid)|unauthorized\s*(?:request|account)?|invalid\s*(?:api\s*)?key)/i;
const HARD_FAILURE_RE = /(?:you(?:'|’)ve\s*hit\s*your\s*(?:usage|rate)\s*limit|(?:usage|rate)\s*limit\s*(?:reached|exceeded|exhausted)|(?:credit|quota)\s*(?:is\s*)?(?:exhausted|exceeded)|(?:request|connection)\s*failed\s*after\s*\d+\s*retr(?:y|ies)|(?:fatal|unrecoverable)\s*error)/i;

function regexEndsPast(re: RegExp, text: string, freshFrom: number): boolean {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    if (match.index + match[0].length > freshFrom) return true;
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return false;
}

// `plain` is the ALREADY-STRIPPED carry+chunk text (onChunk strips once and
// shares it across every detector); `freshFrom` is an offset into it.
function detectTerminalProblem(
  plain: string,
  freshFrom: number,
): { kind: "blocked" | "failed"; body: string } | null {
  if (regexEndsPast(CREDENTIAL_PROBLEM_RE, plain, freshFrom)) {
    return {
      kind: "blocked",
      body: "Authentication is required before the agent can continue.",
    };
  }
  if (regexEndsPast(HARD_FAILURE_RE, plain, freshFrom)) {
    return {
      kind: "failed",
      body: "The agent stopped because it hit a usage, quota, or unrecoverable service error.",
    };
  }
  return null;
}

// Collect regex matches that END inside the newly arrived text (index >=
// minEnd). Matches fully contained in the carry were already processed on a
// previous chunk; without this guard a notification escape sitting in the
// carry window would fire once per chunk until it scrolled out.
function newMatches(re: RegExp, text: string, minEnd: number): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index + m[0].length > minEnd) out.push(m);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

// Enter (or stay in) the working state, stamping the phase start on the
// idle/blocked → working transition.
//
// Deliberately does NOT rearm the notify policy: a stream re-match of the
// working footer is not proof of a NEW turn — a mid-turn output stall (>
// quiet window of byte silence, common on ConPTY during hidden thinking or
// silent tool runs) resumes through here too, and rearming on it let one
// long turn fire a "finished" ghost per stall (the 2026-07-06 spam loop).
// A new turn in a manual pane always starts with user input, so the rearm
// lives in noteTerminalUserInput() instead; the policy's same-kind dedup
// then caps heuristic dones at one per user interaction.
function enterWorking(w: PaneWatcher, now: number): void {
  if (w.state !== "working") {
    w.workingSince = now;
    tanLog(`pane=${w.paneId} state -> working (was ${w.state})`);
    // Push the working chip state on the transition only (emitPaneState dedups
    // repeats anyway, so the per-chunk lastWorkingAt sustain below is cheap).
    emitPaneState(w, "working");
  }
  w.state = "working";
  w.lastWorkingAt = now;
}

// User keystrokes / injected input reached this pane's pty. This is the one
// signal that genuinely means "a fresh turn may start" for a manual terminal
// pane, so it (not the stream heuristic) clears the notify policy's dedup +
// completion guard. Excluded (Cora worker) panes are driven programmatically
// and alert through run-store instead, so they're skipped. Unknown panes
// (chat backends, orchestration ptys) are a cheap Map-miss no-op.
export function noteTerminalUserInput(paneId: string): void {
  const w = watchers.get(paneId);
  if (!w || w.excluded) return;
  if (w.state !== "working") {
    w.workingSince = 0;
    w.lastWorkingAt = 0;
  }
  w.userTurnArmed = true;
  rearm(paneSourceKey(paneId));
}

export function noteTerminalWillDispose(paneId: string): void {
  const w = watchers.get(paneId);
  if (w) w.disposing = true;
}

// Snapshot foreground agent panes before app-level PTY teardown begins. The
// main watcher reads raw PTY bytes even for hidden panes, so it is a stronger
// quit-time liveness signal than the renderer's visibility-gated xterm poller.
export function activeTerminalAgentPaneIds(): string[] {
  const active: string[] = [];
  for (const watcher of watchers.values()) {
    if (!watcher.disposing && watcher.runtime && pty.hasSession(watcher.paneId)) {
      active.push(watcher.paneId);
    }
  }
  return active;
}

// True when the current/just-ended working phase ran long enough to be a
// real turn rather than a boot blip or pattern flap (see MIN_WORK_MS).
function workedLongEnough(w: PaneWatcher): boolean {
  return w.lastWorkingAt - w.workingSince >= MIN_WORK_MS;
}

function onChunk(w: PaneWatcher, chunk: Buffer): void {
  if (w.excluded) return;
  const decoded = w.decoder.decode(chunk, { stream: true });
  if (decoded.length === 0) return;
  w.lastOutputAt = Date.now();
  const carryLen = w.carry.length;
  const text = w.carry + decoded;

  // 1) Explicit notification escapes — honored for ANY foreground program,
  // agent or not, mirroring a real terminal emulator.
  for (const m of newMatches(OSC9_G, text, carryLen)) {
    const message = m[1] ?? "";
    // ConEmu overloaded OSC 9 with numeric subcommands (1..12): `9;4` is the
    // progress protocol, `9;9;<cwd>` is cwd reporting (emitted per prompt by
    // Windows Terminal shell-integration snippets and oh-my-posh), etc. None
    // of them are toasts. A real iTerm2/growl notification is free text, so
    // a bare 1–2 digit first param marks the ConEmu family; a message that
    // merely STARTS with digits ("3 tests failed") doesn't match.
    if (/^\d{1,2}(?:;|$)/.test(message)) continue;
    handleExplicitNotify(w, message.trim());
  }
  for (const m of newMatches(OSC777_G, text, carryLen)) {
    const parts = (m[1] ?? "").split(";");
    const message = parts.filter((p) => p.trim().length > 0).join(" — ");
    handleExplicitNotify(w, message.trim());
  }

  // 2) Agent lifecycle. Runtime identification first (shell-integration
  // command marker beats banner sniffing), then live-state classification
  // while a first-party runtime is in the foreground.
  w.ring = (w.ring + decoded).slice(-RING_MAX);
  let launchedRuntime: PublicAgentRuntime | null = null;
  for (const m of newMatches(OSC633E_G, text, carryLen)) {
    const fromCmd = runtimeFromCommandLine(unescapeOsc633(m[1] ?? ""));
    const publicRuntime = fromCmd ? coercePublicRuntime(fromCmd) : null;
    if (publicRuntime) launchedRuntime = publicRuntime;
  }
  if (launchedRuntime) {
    // A shell command marker is stronger than heuristic output: the user has
    // explicitly launched an agent in this pane. Arm startup prompts and clear
    // any prior turn's completion guard.
    w.userTurnArmed = true;
    if (w.state !== "working") {
      w.workingSince = 0;
      w.lastWorkingAt = 0;
    }
    rearm(paneSourceKey(w.paneId));
  }
  if (!w.runtime) {
    let sniffed: PublicAgentRuntime | null = launchedRuntime;
    if (!sniffed) {
      // The ring was just updated above, so its tail is exactly the fresh
      // decoded text plus the bounded overlap (see SNIFF_OVERLAP).
      const window = w.ring.slice(-(decoded.length + SNIFF_OVERLAP));
      const banner = sniffRuntime(window);
      if (banner) sniffed = coercePublicRuntime(banner);
      if (!sniffed) sniffed = sniffLiveRuntime(w.ring.slice(-2048));
    }
    if (sniffed) {
      w.runtime = sniffed;
      w.state = "idle";
      w.workingSince = 0;
      w.lastWorkingAt = 0;
      w.lastChunkAssertedWorking = false;
      tanLog(`pane=${w.paneId} runtime sniffed: ${sniffed}`);
      // An agent was just detected but no working/idle pattern has classified
      // yet — show the chip as "starting" until the first real signal. The
      // first enterWorking / blocked / idle below promotes it within a beat.
      emitPaneState(w, "launching");
    }
  }

  if (w.runtime) {
    const now = Date.now();
    // Set true below when THIS chunk positively asserts working (footer
    // pattern / structured busy signal); the per-chunk value feeds the
    // stall-aware quiet window in the sweep.
    let chunkAssertedWorking = false;
    // Offset into the STRIPPED text where the fresh bytes begin — shared by
    // classifyTail and countTeammateEvents below so only matches that end in
    // the newly arrived bytes count (see the classifyTail comment further
    // down).
    const fresh = carryLen === 0 ? 0 : stripAnsi(w.carry).length;
    // Strip carry+chunk ONCE and share it: countTeammateEvents,
    // detectTerminalProblem and classifyTail below all consume the same
    // stripped text, and each used to re-run stripAnsi over it per chunk.
    const plain = stripAnsi(text);

    // Activity sustain: while a turn is running, ANY pty output counts as
    // "still working". Codex (live-captured v0.138.0) repaints its full
    // footer rarely — between repaints it only shimmers the word "Working",
    // which matches no pattern — so pattern matches alone would go quiet
    // mid-turn and fire a premature "done". Both Claude and Codex TUIs are
    // byte-silent when genuinely idle (verified in all three live captures),
    // so output while working is a safe liveness signal. Entering "working"
    // still requires a real pattern/OSC match.
    if (w.state === "working") w.lastWorkingAt = now;

    // Teammate lifecycle bookkeeping (Claude only). Must run BEFORE the
    // turn-stopped handlers below: a "1 teammate started" transcript line and
    // the main turn's progress-clear can land in the same chunk, and the
    // clear must see the incremented counter to know the pane is still busy.
    //
    // Fresh-offset slack: stripAnsi leaves a PARTIAL escape at the carry's end
    // unstripped, so stripAnsi(carry).length can overshoot the carry content's
    // true offset within the stripped combined text — and unlike classifyTail's
    // patterns (repainted every second), a teammate event is ONE-SHOT: a match
    // rejected as "stale" by the overshoot is lost forever, and a lost
    // "started" resurrects the false done. The slack biases the error the safe
    // way — an event near the boundary may be counted twice (a spurious
    // started only DELAYS the alert and the silence self-heal clears it) but
    // is never dropped.
    // KNOWN LIMITATION (accepted): the counter reads a lossy visual stream, so
    // it can desync — a full-screen redraw (resize, /clear) can re-count a
    // stale started/finished line still on screen, printing this repo's own
    // test fixtures in a transcript counts their literal phrases, and the
    // boundary slack above can double-count. Every desync is bounded:
    //   counter too HIGH → the done alert is HELD, until the sweep's
    //     15s-total-silence self-heal or Claude's own OSC 9 "waiting for your
    //     input" (arrives within ~60s of true idle, live-captured) clears it —
    //     worst case a delayed notification, never a lost one;
    //   counter too LOW → the hold releases early and that one turn reverts to
    //     exactly the pre-fix behavior (a premature "finished"), never worse.
    if (w.runtime === "claude") {
      const tm = countTeammateEvents(plain, Math.max(0, fresh - 16), { preStripped: true });
      if (tm.started || tm.finished) {
        w.teammatesActive = Math.max(0, w.teammatesActive + tm.started - tm.finished);
        tanLog(`pane=${w.paneId} teammates ${tm.started}+/${tm.finished}- -> ${w.teammatesActive}`);
      }
    }

    // Structured busy/idle signals (both opt-in Claude Code settings; both
    // strictly more reliable than the footer heuristic when present).
    for (const m of newMatches(OSC9_PROGRESS_G, text, carryLen)) {
      const state = m[1] ?? "";
      if (state === "" || state === "0") {
        // Progress cleared — the MAIN turn stopped. A live background
        // teammate keeps the pane busy, though: hold the alert AND the chip
        // until the teammate count drains (or the sweep's silence self-heal
        // clears a stale counter). Keeping w.state on "working" is
        // load-bearing — the any-output sustain above then rides the teammate
        // strip's per-second ticks, so the quiet-window sweep stays quiet
        // while a teammate genuinely runs.
        if (w.teammatesActive > 0) {
          tanLog(
            `pane=${w.paneId} progress-clear held — ${w.teammatesActive} teammate(s) active`,
          );
          // A blocked chip stays blocked — a pending permission prompt is the
          // actionable cue and must not be repainted as mere busyness.
          if (w.state !== "blocked") emitPaneState(w, "working");
          continue;
        }
        if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
          deliver(w, "done", null);
        }
        if (w.state === "working") w.state = "idle";
        w.userTurnArmed = false;
        // Turn done = ready for input → chip "idle". Emit regardless of the
        // toast gate; the chip is focus-independent.
        emitPaneState(w, "idle");
      } else {
        enterWorking(w, now);
        chunkAssertedWorking = true;
      }
    }
    for (const m of newMatches(OSC21337_G, text, carryLen)) {
      const status = /(?:^|;)status=([^;]*)/.exec(m[1] ?? "")?.[1] ?? "";
      if (/working/i.test(status)) {
        enterWorking(w, now);
        chunkAssertedWorking = true;
      } else if (/waiting/i.test(status) && w.runtime === "claude") {
        if (
          w.state !== "blocked" &&
          (w.state === "working" || w.userTurnArmed) &&
          now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
        ) {
          // A positive "waiting on the user" signal is never the previous
          // turn's tail — stand the completion guard down (a prior done on
          // this source would otherwise swallow it) so the alert delivers.
          rearm(paneSourceKey(w.paneId));
          deliver(w, "blocked", null);
          w.userTurnArmed = false;
        }
        w.state = "blocked";
        emitPaneState(w, "blocked");
      } else if (/idle/i.test(status)) {
        // Same teammate hold as the progress-clear path: "Idle" describes the
        // main REPL, not a background teammate still running.
        if (w.teammatesActive > 0) {
          tanLog(
            `pane=${w.paneId} idle status held — ${w.teammatesActive} teammate(s) active`,
          );
          // Same blocked-chip precedence as the progress-clear hold above.
          if (w.state !== "blocked") emitPaneState(w, "working");
          continue;
        }
        if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
          deliver(w, "done", null);
        }
        w.state = "idle";
        w.userTurnArmed = false;
        emitPaneState(w, "idle");
      }
    }

    const problem = detectTerminalProblem(plain, fresh);
    const applyProblem =
      problem !== null && !(problem.kind === "blocked" && w.runtime !== "claude");
    if (applyProblem && problem) {
      const priorState = w.state;
      const shouldAlert =
        priorState !== problem.kind &&
        (priorState === "working" || w.userTurnArmed);
      w.state = problem.kind;
      emitPaneState(w, problem.kind === "failed" ? "error" : "blocked");
      if (shouldAlert && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
        // This is a positive new terminal outcome, not the tail of a prior
        // completion. Let it replace that state in policy + center history.
        rearm(paneSourceKey(w.paneId));
        deliver(w, problem.kind, problem.body);
        w.userTurnArmed = false;
      }
    }

    // Only pattern matches that END in the freshly arrived bytes count —
    // the carry exists to bridge phrases split across chunk boundaries, but
    // a footer merely sitting in it (painted seconds ago) must not keep
    // re-asserting "working" off the back of unrelated idle repaints.
    const cls = applyProblem ? null : classifyTail(w.runtime, plain, fresh, { preStripped: true });
    if (cls === "blocked" && w.runtime === "claude") {
      if (w.state !== "blocked") tanLog(`pane=${w.paneId} state -> blocked (was ${w.state})`);
      // Deliberately NOT gated on workedLongEnough: a permission prompt can
      // appear within the first second of a turn, and missing a real
      // "needs you" is worse than an occasional boot-menu alert (which the
      // suppress-while-watching rule already swallows in the common case).
      if (
        w.state !== "blocked" &&
        (w.state === "working" || w.userTurnArmed) &&
        now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
      ) {
        // Same reasoning as the OSC 21337 waiting path: a blocked prompt in
        // a live working phase means the agent genuinely stopped for the
        // user, even if an earlier (possibly stall-ghost) done armed the
        // completion guard on this source. Missing a real "needs you" is
        // worse than an occasional duplicate, so rearm before delivering.
        rearm(paneSourceKey(w.paneId));
        deliver(w, "blocked", null);
        w.userTurnArmed = false;
      }
      w.state = "blocked";
      emitPaneState(w, "blocked");
    } else if (cls === "working") {
      enterWorking(w, now);
      chunkAssertedWorking = true;
    } else if (cls === "done") {
      // Positive completion line (e.g. "Session ended.") — alert without
      // waiting out the quiet window. Unlike the progress-clear / idle-status
      // holds above, this is a REAL session end: any teammate bookkeeping
      // dies with the session, so reset it and deliver as usual.
      w.teammatesActive = 0;
      if (
        w.state === "working" &&
        workedLongEnough(w) &&
        now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
      ) {
        deliver(w, "done", null);
      }
      w.state = "idle";
      w.userTurnArmed = false;
      // Turn complete (positive done line) → chip ready, not exited. The TUI is
      // still up; the real "done" (TUI gone) is the exited block below.
      emitPaneState(w, "idle");
    }

    // Remember whether this chunk's bytes positively asserted working — the
    // sweep reads it to pick the normal vs stall quiet window.
    w.lastChunkAssertedWorking = chunkAssertedWorking;

    // Agent exit: the shell prompt is back (spark.ps1's OSC 633/133 markers)
    // or the TUI left the alt screen. A turn that was still mid-work when the
    // TUI vanished ended *somehow* — surface it; the suppression policy
    // swallows the alert when the user themselves quit the agent (they're
    // looking at that tab, by definition).
    const exited =
      newMatches(PROMPT_MARKER_G, text, carryLen).length > 0 ||
      text.indexOf(ALT_SCREEN_LEAVE, Math.max(0, carryLen - ALT_SCREEN_LEAVE.length + 1)) !== -1;
    if (exited) {
      tanLog(`pane=${w.paneId} agent exited (prompt marker / alt-screen leave); state was ${w.state}`);
      if (
        w.state === "working" &&
        workedLongEnough(w) &&
        now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
      ) {
        deliver(w, "done", null);
      }
      // The foreground TUI handed control back to the shell → chip "done".
      // Emit while w.runtime is still set so the payload names the agent, then
      // reset lastEmittedState so a fresh agent re-launched in this same pane
      // re-emits "launching"/"working" rather than being deduped against the
      // stale value.
      emitPaneState(w, "done");
      w.lastEmittedState = null;
      w.runtime = null;
      w.state = "idle";
      w.workingSince = 0;
      w.lastWorkingAt = 0;
      w.lastChunkAssertedWorking = false;
      w.teammatesActive = 0;
      w.ring = "";
      w.userTurnArmed = false;
    }
  }

  w.carry = text.slice(-CARRY_MAX);
}

// An explicit OSC 9/777 from the foreground program. Codex's own copy says
// what happened ("Codex: turn completed", "approval requested"), so prefer it
// as the body. Classify needs-you vs done from the message text, in order:
// "Claude is waiting for your input" is Claude Code's TURN-COMPLETE
// notification (live-captured v2.1.201), NOT a permission prompt — real
// permission prompts read "Claude needs your permission to use X" — so the
// waiting-for-your-input shape must be recognised as "done" BEFORE the
// blocked-keyword scan (whose "waiting"/"input" terms would otherwise
// misread it). Default to done since turn-complete is the overwhelmingly
// common emission.
function handleExplicitNotify(w: PaneWatcher, message: string): void {
  const now = Date.now();
  const kind = /waiting\s*for\s*your\s*input/i.test(message)
    ? ("done" as const)
    : w.runtime === "claude" &&
        /approv|permission|review|needs|attention|confirm|waiting|input/i.test(message)
      ? ("blocked" as const)
      : ("done" as const);
  // A DONE announcement while background teammates run is held like the
  // progress-clear: Claude Code fires "waiting for your input" off the MAIN
  // REPL's idleness ~60s after the turn ends and IGNORES running teammates
  // (live-captured 2026-07-06: emitted at T+60 while a teammate's sleep-100
  // turn was mid-flight) — honoring it would just move the false "finished"
  // from turn-end to turn-end+60s. No state change, no lastOscNotifyAt stamp
  // (nothing was delivered, so there is nothing to mute), chip stays on
  // working unless a permission prompt owns it. The real done arrives when
  // the teammate count drains (progress-clear / quiet window), and a STALE
  // counter still resolves through the sweep's 15s-silence self-heal — a user
  // actively typing in the pane defers that heal, but someone typing there is
  // watching it, which is exactly the case the suppress-while-watching policy
  // mutes anyway.
  if (kind === "done" && w.teammatesActive > 0) {
    tanLog(
      `pane=${w.paneId} explicit done held — ${w.teammatesActive} teammate(s) active`,
    );
    if (w.state !== "blocked") emitPaneState(w, "working");
    return;
  }
  w.lastOscNotifyAt = now;
  // The program announced the stop itself; stand the heuristic down so the
  // quiet-window sweep doesn't re-alert the same turn end.
  if (kind === "blocked") {
    // A permission/approval announcement says NOTHING about background
    // teammates — leaving the counter alone is load-bearing: wiping it here
    // let the post-approval turn's progress-clear fire the false "done" the
    // teammate hold exists to prevent (approve → resume → turn end → alert
    // while the teammate still runs).
    w.state = "blocked";
  } else {
    // A DONE announcement with no live teammates is the program declaring the
    // whole pane idle — any residual teammate bookkeeping is stale beside it.
    w.state = "idle";
    w.teammatesActive = 0;
  }
  // Chip state mirrors the announced state, focus-independent: an explicit
  // "done" notification means the turn finished and the agent is ready for
  // input → "idle"; an "approval/permission" announcement → "blocked". The TUI
  // is still up (this is not a process exit), so we never emit "done" here.
  emitPaneState(w, kind === "blocked" ? "blocked" : "idle");
  // An explicit OSC notification is the program authoritatively announcing its
  // current state — it is never the previous turn's heuristic footer tail — so
  // it stands the policy's completion guard down and always toasts, exactly
  // like a real terminal renders every OSC 9. The ONE exception: an agent's
  // "waiting for your input" is Claude Code's idle ECHO — it re-announces the
  // same turn end long after the progress-clear already alerted (60s later in
  // the live v2.1.201 capture) — so it keeps the guard armed and lets the
  // policy's same-kind dedup fold the repeat. A genuinely new turn's echo
  // still passes because the user input that started the turn rearmed via
  // noteTerminalUserInput.
  const isAgentIdleEcho =
    kind === "done" && w.runtime !== null && /waiting\s*for\s*your\s*input/i.test(message);
  if (!isAgentIdleEcho) rearm(paneSourceKey(w.paneId));
  deliver(w, kind, message.length > 0 ? message : null);
  w.userTurnArmed = false;
}

function runtimeLabel(runtime: PublicAgentRuntime | null): string {
  if (runtime === "claude") return "Claude Code";
  if (runtime === "codex") return "Codex";
  return "Terminal";
}

// Push a translated chip RuntimeState to the renderer, focus-independent. This
// is the SEPARATE-from-alert path the chip needs: deliver() (the toast/rail dot)
// is gated by isUserWatchingPane, but the chip must update even while the user
// is looking elsewhere — that hidden case is exactly when the renderer's own
// visible-buffer poller is frozen and the banner gets stuck on "working". We
// dedup on lastEmittedState so a repeated state (e.g. "working" re-asserted by
// every footer repaint) doesn't spam IPC. Excluded panes (Cora workers) carry
// their own run-store-driven chip and are skipped. Note we deliberately do NOT
// emit for the worker-pane case; manual panes are the audience.
function emitPaneState(w: PaneWatcher, chipState: RuntimeState): void {
  if (w.excluded) return;
  if (w.lastEmittedState === chipState) return;
  w.lastEmittedState = chipState;
  tanLog(`pane=${w.paneId} chip-state -> ${chipState} (runtime=${w.runtime})`);
  emitTerminalAgentState({
    workspaceId: w.workspaceId,
    tabId: w.tabId,
    paneId: w.paneId,
    runtime: w.runtime,
    state: chipState,
  });
}

// Level-triggered companion to the live terminal-agent:state event. Renderer
// reloads and cold hydration can subscribe after a transition already fired;
// querying this snapshot lets them reconcile to the daemon's current truth
// instead of waiting for a future edge that may never come.
export function terminalAgentStateSnapshot(workspaceId?: string): TerminalAgentStatePayload[] {
  const out: TerminalAgentStatePayload[] = [];
  for (const w of watchers.values()) {
    if (w.excluded || w.lastEmittedState === null) continue;
    if (workspaceId && w.workspaceId !== workspaceId) continue;
    out.push({
      workspaceId: w.workspaceId,
      tabId: w.tabId,
      paneId: w.paneId,
      runtime: w.runtime,
      state: w.lastEmittedState,
    });
  }
  return out;
}

// Publish a turn-boundary alert into the unified pipeline. Suppression
// (user operating this exact pane, same-kind re-emits, the terminal-completion
// guard) is the notify policy's job; enterWorking()/handleExplicitNotify()
// rearm the pane's sourceKey where real new activity begins.
function compactDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 10_000) return null;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function deliver(
  w: PaneWatcher,
  kind: "done" | "blocked" | "failed",
  body: string | null,
): void {
  if (w.excluded) return;
  if (w.replayingTail) {
    tanLog(`pane=${w.paneId} replay suppressed alert kind=${kind}`);
    return;
  }
  tanLog(`pane=${w.paneId} ALERT kind=${kind} runtime=${w.runtime} ws=${w.workspaceId} tab=${w.tabId}`);
  const label = runtimeLabel(w.runtime);
  const where = w.tabTitle ? `“${w.tabTitle}”` : "a terminal";
  const inWorkspace = w.workspaceName ? ` in workspace “${w.workspaceName}”` : "";
  const duration = compactDuration(w.lastWorkingAt - w.workingSince);
  const kindName =
    kind === "done"
      ? "terminal.agent.done"
      : kind === "failed"
        ? "terminal.agent.failed"
        : "terminal.agent.needs-input";
  publish({
    kind: kindName,
    sourceKey: paneSourceKey(w.paneId),
    // A prompt/question reads amber, a successful turn reads green, and a
    // high-confidence limit/crash reads red. Generic heuristic silence never
    // becomes failure; only explicit terminal evidence does.
    tone: kind === "done" ? "success" : kind === "failed" ? "danger" : "warning",
    title:
      kind === "done"
        ? `${label} — finished`
        : kind === "failed"
          ? `${label} — stopped`
          : `${label} — needs you`,
    body: body
      ? w.workspaceName
        ? `${body}${duration ? ` · worked ${duration}` : ""} — workspace “${w.workspaceName}”`
        : `${body}${duration ? ` · worked ${duration}` : ""}`
      : kind === "done"
        ? `Finished${duration ? ` after ${duration}` : ""} in ${where}${inWorkspace}. Click to jump to the terminal.`
        : kind === "failed"
          ? `Stopped unexpectedly in ${where}${inWorkspace}. Click to inspect the terminal.`
          : `Waiting for your input in ${where}${inWorkspace}. Click to jump to the terminal.`,
    soundKind: kind === "done" ? "done" : "needs-you",
    target: { type: "terminal", workspaceId: w.workspaceId, tabId: w.tabId, paneId: w.paneId },
  });
}

// Test/maintenance escape hatch: drop every watcher (e.g. before a full
// pty disposeAll on quit). Safe to call repeatedly.
export function disposeAllTerminalAgentWatchers(): void {
  for (const paneId of [...watchers.keys()]) removeWatcher(paneId);
}
