import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyTail,
  coercePublicRuntime,
  runtimeFromCommandLine,
  sniffRuntime,
  stripAnsi,
  unescapeOsc633,
  type PublicAgentRuntime,
} from "@shared/agent-patterns";
import * as pty from "./pty-manager";
import { emitTerminalAgentState, paneSourceKey, publish, rearm } from "./notify";
import type { RuntimeState } from "@shared/types";

// Terminal-agent notifier: tells the user when a Claude / Codex / Cursor CLI
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
// pane's workspace + tab are the active ones the renderer last reported.
// That rule — plus the same-kind dedup and terminal-completion guard — now
// lives in the unified notify policy (src/main/notify); this module only
// detects turn boundaries and calls publish()/rearm().

const RING_MAX = 8_192;
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
// How long to wait for the renderer-side TerminalPane to actually spawn the
// pty after the pane registers. Panes spawn on mount, so this is generous.
const SPAWN_WAIT_MS = 120_000;

interface PaneWatcher {
  paneId: string;
  workspaceId: string;
  // Display name of the owning workspace, for alert copy ("…in workspace
  // X"). Shipped by the renderer with each registry sync; may be empty.
  workspaceName: string;
  tabId: string;
  tabTitle: string;
  // Spark-orchestrated worker panes register excluded — their lifecycle
  // already alerts through run-store status events, and double-notifying
  // every worker turn would be pure noise.
  excluded: boolean;
  attached: boolean;
  awaitingSpawn: boolean;
  untap: (() => void) | null;
  offExit: (() => void) | null;
  decoder: TextDecoder;
  // Rolling decoded text used for banner sniffing while no runtime is known.
  ring: string;
  // Tail of the previous chunk's raw text (see CARRY_MAX).
  carry: string;
  runtime: PublicAgentRuntime | null;
  state: "idle" | "working" | "blocked";
  // When the current working phase began (state transition into "working").
  workingSince: number;
  lastWorkingAt: number;
  lastOscNotifyAt: number;
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
}): void {
  if (!input || typeof input.workspaceId !== "string" || !Array.isArray(input.panes)) return;
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
      awaitingSpawn: false,
      untap: null,
      offExit: null,
      decoder: new TextDecoder("utf-8", { fatal: false }),
      ring: "",
      carry: "",
      runtime: null,
      state: "idle",
      workingSince: 0,
      lastWorkingAt: 0,
      lastOscNotifyAt: 0,
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
}

function attach(w: PaneWatcher): void {
  if (w.attached || w.awaitingSpawn) return;
  if (!pty.hasSession(w.paneId)) {
    // Registration usually lands before useTerminalSession's pty:spawn call.
    // waitForSpawn cleans its own waiter list on timeout, so a pane that
    // never spawns costs nothing past the timeout.
    w.awaitingSpawn = true;
    tanLog(`pane=${w.paneId} awaiting pty spawn`);
    void pty.waitForSpawn(w.paneId, SPAWN_WAIT_MS).then((ok) => {
      const current = watchers.get(w.paneId);
      if (!current || current !== w) return;
      w.awaitingSpawn = false;
      tanLog(`pane=${w.paneId} spawn wait resolved ok=${ok}`);
      if (ok) attach(w);
    });
    return;
  }
  tanLog(`pane=${w.paneId} tap attached (excluded=${w.excluded})`);
  w.untap = pty.tap(w.paneId, (chunk) => {
    try {
      onChunk(w, chunk);
    } catch (err) {
      console.warn("[terminal-agent-notify] chunk handler failed:", err);
    }
  });
  w.offExit = pty.onExit(w.paneId, () => {
    // The pty process itself died. We deliberately do NOT emit a chip state
    // here: the renderer receives its own `pty:exit:${id}` for this pane and
    // routes it through onTerminalPaneExit, which is the authoritative handler
    // for a pty death — it has the EXIT CODE, so it can distinguish a clean
    // teardown (remove the chip) from a crash (keep a red "error" chip). A
    // "done" emit from here would race that handler over a separate IPC message
    // and could tear an "error" chip back down. The chip-relevant exit cases
    // the notifier owns (agent TUI left but pty alive) are handled by the
    // prompt-marker / alt-screen-leave `exited` block in onChunk instead.
    removeWatcher(w.paneId);
  });
  w.attached = true;
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
      // Self-heal: a pane whose pty spawned after the one-shot waitForSpawn
      // window (or whose spawn wait resolved false) re-attaches here instead
      // of waiting for the next renderer layout change. attach() early-returns
      // when already attached or still awaiting spawn, so this is one Map
      // lookup per pane per second.
      if (!w.attached && !w.awaitingSpawn) attach(w);
      if (w.excluded || !w.runtime) continue;
      if (w.state !== "working") continue;
      if (now - w.lastWorkingAt < TURN_QUIET_MS) continue;
      w.state = "idle";
      tanLog(`pane=${w.paneId} turn finished (quiet window elapsed, worked ${w.lastWorkingAt - w.workingSince}ms)`);
      // The turn ended (no working repaints for the quiet window) → chip ready.
      // Emit BEFORE the workedLongEnough/OSC-mute toast gates below: those gate
      // the toast (a boot blip shouldn't ping the user), but the chip should
      // still flip off "working" the instant the stream goes quiet — this is
      // the core fix for the stuck-on-WORKING banner when the pane is hidden.
      emitPaneState(w, "idle");
      if (!workedLongEnough(w)) continue;
      if (now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) continue;
      deliver(w, "done", null);
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
function enterWorking(w: PaneWatcher, now: number): void {
  if (w.state !== "working") {
    w.workingSince = now;
    tanLog(`pane=${w.paneId} state -> working (was ${w.state})`);
    // Real new activity resumed — re-arm the notify policy for this pane so
    // the next done/blocked alert is a fresh event, not the previous turn's
    // tail (Bug 1, Path B).
    rearm(paneSourceKey(w.paneId));
    // Push the working chip state on the transition only (emitPaneState dedups
    // repeats anyway, so the per-chunk lastWorkingAt sustain below is cheap).
    emitPaneState(w, "working");
  }
  w.state = "working";
  w.lastWorkingAt = now;
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
  const carryLen = w.carry.length;
  const text = w.carry + decoded;

  // 1) Explicit notification escapes — honored for ANY foreground program,
  // agent or not, mirroring a real terminal emulator.
  for (const m of newMatches(OSC9_G, text, carryLen)) {
    const message = m[1] ?? "";
    if (message === "4" || message.startsWith("4;")) continue; // ConEmu progress, not a toast
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
  if (!w.runtime) {
    let sniffed: PublicAgentRuntime | null = null;
    for (const m of newMatches(OSC633E_G, text, carryLen)) {
      const fromCmd = runtimeFromCommandLine(unescapeOsc633(m[1] ?? ""));
      if (fromCmd) sniffed = coercePublicRuntime(fromCmd) ?? sniffed;
    }
    if (!sniffed) {
      const banner = sniffRuntime(w.ring);
      if (banner) sniffed = coercePublicRuntime(banner);
    }
    if (sniffed) {
      w.runtime = sniffed;
      w.state = "idle";
      w.workingSince = 0;
      w.lastWorkingAt = 0;
      tanLog(`pane=${w.paneId} runtime sniffed: ${sniffed}`);
      // An agent was just detected but no working/idle pattern has classified
      // yet — show the chip as "starting" until the first real signal. The
      // first enterWorking / blocked / idle below promotes it within a beat.
      emitPaneState(w, "launching");
    }
  }

  if (w.runtime) {
    const now = Date.now();

    // Activity sustain: while a turn is running, ANY pty output counts as
    // "still working". Codex (live-captured v0.138.0) repaints its full
    // footer rarely — between repaints it only shimmers the word "Working",
    // which matches no pattern — so pattern matches alone would go quiet
    // mid-turn and fire a premature "done". Both Claude and Codex TUIs are
    // byte-silent when genuinely idle (verified in all three live captures),
    // so output while working is a safe liveness signal. Entering "working"
    // still requires a real pattern/OSC match.
    if (w.state === "working") w.lastWorkingAt = now;

    // Structured busy/idle signals (both opt-in Claude Code settings; both
    // strictly more reliable than the footer heuristic when present).
    for (const m of newMatches(OSC9_PROGRESS_G, text, carryLen)) {
      const state = m[1] ?? "";
      if (state === "" || state === "0") {
        // Progress cleared — the turn stopped.
        if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
          deliver(w, "done", null);
        }
        if (w.state === "working") w.state = "idle";
        // Turn done = ready for input → chip "idle". Emit regardless of the
        // toast gate; the chip is focus-independent.
        emitPaneState(w, "idle");
      } else {
        enterWorking(w, now);
      }
    }
    for (const m of newMatches(OSC21337_G, text, carryLen)) {
      const status = /(?:^|;)status=([^;]*)/.exec(m[1] ?? "")?.[1] ?? "";
      if (/working/i.test(status)) {
        enterWorking(w, now);
      } else if (/waiting/i.test(status)) {
        if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
          deliver(w, "blocked", null);
        }
        w.state = "blocked";
        emitPaneState(w, "blocked");
      } else if (/idle/i.test(status)) {
        if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
          deliver(w, "done", null);
        }
        w.state = "idle";
        emitPaneState(w, "idle");
      }
    }

    // Only pattern matches that END in the freshly arrived bytes count —
    // the carry exists to bridge phrases split across chunk boundaries, but
    // a footer merely sitting in it (painted seconds ago) must not keep
    // re-asserting "working" off the back of unrelated idle repaints.
    const cls = classifyTail(
      w.runtime,
      text,
      carryLen === 0 ? 0 : stripAnsi(w.carry).length,
    );
    if (cls === "blocked") {
      if (w.state !== "blocked") tanLog(`pane=${w.paneId} state -> blocked (was ${w.state})`);
      // Deliberately NOT gated on workedLongEnough: a permission prompt can
      // appear within the first second of a turn, and missing a real
      // "needs you" is worse than an occasional boot-menu alert (which the
      // suppress-while-watching rule already swallows in the common case).
      if (w.state === "working" && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
        deliver(w, "blocked", null);
      }
      w.state = "blocked";
      emitPaneState(w, "blocked");
    } else if (cls === "working") {
      enterWorking(w, now);
    } else if (cls === "done") {
      // Positive completion line (e.g. "Session ended.") — alert without
      // waiting out the quiet window.
      if (
        w.state === "working" &&
        workedLongEnough(w) &&
        now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
      ) {
        deliver(w, "done", null);
      }
      w.state = "idle";
      // Turn complete (positive done line) → chip ready, not exited. The TUI is
      // still up; the real "done" (TUI gone) is the exited block below.
      emitPaneState(w, "idle");
    }

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
      w.ring = "";
    }
  }

  w.carry = text.slice(-CARRY_MAX);
}

// An explicit OSC 9/777 from the foreground program. Codex's own copy says
// what happened ("Codex: turn completed", "approval requested"), so prefer it
// as the body. Classify needs-you vs done from the message text; default to
// done since turn-complete is the overwhelmingly common emission.
function handleExplicitNotify(w: PaneWatcher, message: string): void {
  const now = Date.now();
  w.lastOscNotifyAt = now;
  // The program announced the stop itself; stand the heuristic down so the
  // quiet-window sweep doesn't re-alert the same turn end.
  if (w.state === "working") w.state = "idle";
  const kind = /approv|permission|review|waiting|needs|input|attention|confirm/i.test(message)
    ? ("blocked" as const)
    : ("done" as const);
  // Chip state mirrors the announced state, focus-independent: an explicit
  // "done" notification means the turn finished and the agent is ready for
  // input → "idle"; an "approval/permission" announcement → "blocked". The TUI
  // is still up (this is not a process exit), so we never emit "done" here.
  emitPaneState(w, kind === "blocked" ? "blocked" : "idle");
  // An explicit OSC notification is the program authoritatively announcing its
  // current state — it is never the previous turn's heuristic footer tail. So
  // stand the policy's completion guard down here; otherwise a real "approval
  // requested" emitted right after a turn-complete (no intervening detected
  // working phase) would be wrongly swallowed by the dedup.
  rearm(paneSourceKey(w.paneId));
  deliver(w, kind, message.length > 0 ? message : null);
}

function runtimeLabel(runtime: PublicAgentRuntime | null): string {
  if (runtime === "claude") return "Claude Code";
  if (runtime === "codex") return "Codex";
  if (runtime === "cursor") return "Cursor";
  return "Terminal";
}

// Push a translated chip RuntimeState to the renderer, focus-independent. This
// is the SEPARATE-from-alert path the chip needs: deliver() (the toast/rail dot)
// is gated by isUserWatchingPane, but the chip must update even while the user
// is looking elsewhere — that hidden case is exactly when the renderer's own
// visible-buffer poller is frozen and the banner gets stuck on "working". We
// dedup on lastEmittedState so a repeated state (e.g. "working" re-asserted by
// every footer repaint) doesn't spam IPC. Excluded panes (Spark workers) carry
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

// Publish a turn-boundary alert into the unified pipeline. Suppression
// (user watching this tab, same-kind re-emits, the terminal-completion
// guard) is the notify policy's job; enterWorking()/handleExplicitNotify()
// rearm the pane's sourceKey where real new activity begins.
function deliver(w: PaneWatcher, kind: "done" | "blocked", body: string | null): void {
  if (w.excluded) return;
  tanLog(`pane=${w.paneId} ALERT kind=${kind} runtime=${w.runtime} ws=${w.workspaceId} tab=${w.tabId}`);
  const label = runtimeLabel(w.runtime);
  const where = w.tabTitle ? `“${w.tabTitle}”` : "a terminal";
  const inWorkspace = w.workspaceName ? ` in workspace “${w.workspaceName}”` : "";
  publish({
    kind: kind === "done" ? "terminal.agent.done" : "terminal.agent.needs-input",
    sourceKey: paneSourceKey(w.paneId),
    // Bug 2 — a blocked terminal agent is asking for input, not failing, so it
    // reads amber (warning); a finished turn reads green (success). The
    // terminal heuristic never produces a genuine "failure", so danger is
    // reserved for orchestration run failures only.
    tone: kind === "done" ? "success" : "warning",
    title: kind === "done" ? `${label} — finished` : `${label} — needs you`,
    body: body
      ? w.workspaceName
        ? `${body} — workspace “${w.workspaceName}”`
        : body
      : kind === "done"
        ? `Finished working in ${where}${inWorkspace}. Click to jump to the terminal.`
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
