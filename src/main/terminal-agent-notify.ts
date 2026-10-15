import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyTail,
  coercePublicRuntime,
  countTeammateEvents,
  PI_EXIT_LINE_RE,
  runtimeFromCommandLine,
  runtimeFromProcessCommand,
  sniffLiveRuntime,
  sniffRuntime,
  stripAnsi,
  unescapeOsc633,
  type PublicAgentRuntime,
} from "@shared/agent-patterns";
import * as pty from "./pty-manager";
import { CodexTerminalScreen } from "./codex-terminal-screen";
import { CodexRolloutTail, type CodexRolloutEvent } from "./codex-rollout-tail";
import { latestSessionStart } from "./agent-session-registry";
import { descendantProcessesWithCommands } from "./owned-process-tree";
import { emitTerminalAgentState, paneSourceKey, publish, rearm } from "./notify";
import { nudgeUsageRefresh } from "./orchestration/usage-activity-refresh";
import { signalAgentBoardChanged } from "./agent-board-signal";
import type { TerminalAgentActivity } from "@shared/agent-board";
import type { RuntimeState, TerminalAgentStatePayload } from "@shared/types";

// Terminal-agent notifier: tells the user when a Claude Code, Codex, Grok
// or Pi CLI they ran in a NORMAL terminal pane finished a turn, or stopped to
// ask them something, while they are looking elsewhere. Orchestration runs
// alert through run-store events; this module covers the "I typed `claude`
// in a shell" workflow.
//
// Why main-process: the renderer's visible-buffer poller freezes when a pane
// is hidden and gets no bytes at all while its workspace is switched away.
// The cases where a notification is useful are exactly those, so detection
// lives on pty-manager's tap() fan-out, which sees every chunk.
//
// A notification is about a TURN: the user submitted something, the agent
// worked, and the agent stopped. A turn starts on a submit (Enter in the pane,
// or Claude's UserPromptSubmit hook) and is announced at most once. Startup
// screens, background follow-ups and repaints never start one.
//
// Signals, most trusted first. A pane that has produced a trusted signal for
// its current agent session never announces "finished" from screen output:
//   1. OSC 7501 program status. The pane answers the support query, and
//      Claude Code (2.1.295+) then reports working / blocked (with a kind) /
//      done / idle (the user stopped the turn) / error itself. Codex 0.163+
//      reports working / blocked / idle unasked.
//   2. Agent hooks. Claude's Stop ends the lead turn (carrying its last
//      message and the background tasks still running), UserPromptSubmit
//      starts one, PreToolUse for AskUserQuestion / ExitPlanMode and the
//      Notification hook's permission types mean "needs you". Subagent
//      events never end a turn. For Codex, the notify program (passed to each
//      launch by agent-launch-integration.ts) reports agent-turn-complete
//      with the last agent message, and the session file
//      (codex-rollout-tail.ts) records task_complete / turn_aborted.
//   3. Screen and stream heuristics (src/shared/agent-patterns.ts): the
//      working footer repainting, an idle frame, a permission dialog. Used
//      for Grok and Pi, and for Claude or Codex when nothing above exists. An
//      idle frame must hold before it counts, and silence after a working
//      footer is a stall, not a finish.
//
// Who is watching is the notify policy's call (src/main/notify): a finished
// turn in a pane on screen is not announced; a prompt is announced unless its
// pane is the selected one.

const RING_MAX = 8_192;
// Banner-sniff window: while a pane has no detected runtime (every plain
// shell, forever), each chunk is sniffed as fresh-decoded-text + this much
// prior ring, not the whole 8 KB ring. attach() replays history through
// onChunk chunk by chunk, so pre-attach banners are covered too; the overlap
// only bridges a banner split across a chunk boundary (Ink can spend ~5 raw
// bytes per visible character on cursor moves).
const SNIFF_OVERLAP = 512;
// Raw-text carry bridging escape sequences / footer phrases split across
// chunk boundaries.
const CARRY_MAX = 1_024;
// Heuristic turn end: how long the working-pattern repaints must stay silent.
// Claude/Codex repaint their status footer at least once per second while a
// turn runs.
const TURN_QUIET_MS = 3_000;
// Silence that began with the working footer still painted is a mid-turn
// stall (hidden thinking, a silent tool, API backoff; ConPTY goes fully quiet
// then) until it lasts this long.
const TURN_QUIET_STALL_MS = 15_000;
// Heuristic idle frames must hold this long with no working frame before the
// turn counts as finished. Claude repaints an older turn's "done" footer
// while it redraws after a tool result, a moment before the spinner returns
// (audit 2026-10-11: 51 of 68 false "finished" alerts came from that frame,
// each followed by a working frame 1 to 3 ms later).
const HEURISTIC_IDLE_CONFIRM_MS = 1_500;
// Claude's structured busy signals (the ConEmu progress bar, the tab status)
// also drop to idle between two tool calls of one turn and come back within
// moments; an idle report is announced only once it has held this long.
const STRUCTURED_IDLE_SETTLE_MS = 1_000;
// A Stop hook is followed by nothing when the turn is really over. A Stop
// hook that blocks makes Claude continue, which shows up as a new tool call
// or prompt within this window and cancels the pending announcement.
const HOOK_DONE_CONFIRM_MS = 800;
const PROGRAM_DONE_CONFIRM_MS = 600;
// When Codex has a structured completion source (the notify program or a
// tracked session file), an idle screen waits this long for it so the alert
// carries Codex's own message and an interrupted turn stays silent.
const CODEX_STRUCTURED_GRACE_MS = 3_000;
// Esc / Ctrl+C followed by an idle screen within this window is the user
// stopping the turn. Claude sends no hook for it.
const INTERRUPT_WINDOW_MS = 10_000;
// With hooks, a turn whose screen has shown only idle frames and whose hooks
// have been silent this long ended without a Stop (a denied permission). The
// chip goes idle; a late Stop still announces.
const HOOK_IDLE_SETTLE_MS = 20_000;
const SWEEP_MS = 1_000;
// Minimum working-phase duration before heuristic alerts fire. Codex paints
// its working footer for ~half a second while booting; a real turn clears it.
const MIN_WORK_MS = 1_500;
// After an explicit OSC 9/777 notification, mute the stream heuristic so the
// same turn end can't alert twice.
const OSC_NOTIFY_MUTE_MS = 10_000;
// Self-heal window for the stream-counted teammate counter (heuristic panes).
const TEAMMATE_SILENCE_MS = 15_000;
const AGENT_PROC_RECHECK_MS = 2_000;
const PROCESS_LIST_MAX_AGE_MS = 900;
// Late registration is most visible during cold restore. Replaying a bounded
// recent tail closes that gap without scanning the full 4 MB PTY history.
const BOOTSTRAP_TAIL_BYTES = 256 * 1024;
const SUMMARY_MAX_CHARS = 180;
const DETAIL_MAX_CHARS = 120;

interface AgentTurn {
  startedAt: number;
  // "prompt": Claude's UserPromptSubmit or a Codex completion that names the
  // user's input. "input": an Enter keypress in the pane.
  source: "prompt" | "input";
  sessionId: string | null;
  announced: boolean;
  announcedAt: number;
}

type DoneOrigin = "heuristic" | "explicit" | "program" | "hook" | "codex";

const DONE_RANK: Record<DoneOrigin, number> = {
  heuristic: 0,
  explicit: 1,
  program: 2,
  hook: 3,
  codex: 3,
};

interface PendingDone {
  timer: NodeJS.Timeout | null;
  origin: DoneOrigin;
  body: string | null;
  bodyRank: number;
  backgroundRunning: number;
  // Claude's background work drained after the turn was already announced.
  followUp: boolean;
}

interface PaneSignals {
  hooks: boolean;
  programStatus: boolean;
  codexNotify: boolean;
  codexRollout: boolean;
}

interface PaneWatcher {
  paneId: string;
  workspaceId: string;
  // Display name of the owning workspace. Shipped by the renderer with each
  // registry sync; may be empty.
  workspaceName: string;
  tabId: string;
  tabTitle: string;
  // Cora-orchestrated worker panes register excluded: their lifecycle alerts
  // through run-store status events.
  excluded: boolean;
  attached: boolean;
  // True only while rebuilding state from output that predates this watcher.
  // Historic bytes may contain old completion/permission frames; they rebuild
  // the chip but must never create toasts or answer queries.
  replayingTail: boolean;
  untap: (() => void) | null;
  offExit: (() => void) | null;
  decoder: TextDecoder;
  ring: string;
  carry: string;
  runtime: PublicAgentRuntime | null;
  runtimeHint: PublicAgentRuntime | null;
  state: "idle" | "working" | "blocked" | "failed";
  turn: AgentTurn | null;
  pendingDone: PendingDone | null;
  signals: PaneSignals;
  // Renderer-owned close/dispose in progress. A killed PTY can report a
  // non-zero exit even though the user intentionally closed the pane.
  disposing: boolean;
  // Heuristic working phase (screen evidence), distinct from the turn.
  workingSince: number;
  lastWorkingAt: number;
  lastOscNotifyAt: number;
  // Whether the most recent chunk positively asserted "working". Silence
  // that began with the working footer painted is a stall (see
  // TURN_QUIET_STALL_MS).
  lastChunkAssertedWorking: boolean;
  completedTurnPending: boolean;
  // When the screen last started showing an idle frame with no working frame
  // since; null otherwise.
  screenIdleSince: number | null;
  lastUserInputAt: number;
  lastInterruptKeyAt: number;
  lastHookEventAt: number;
  // Claude tool calls announced by PreToolUse and not yet answered by
  // PostToolUse. A permission dialog can only be on screen while one is
  // pending, which is what filters screen text that merely looks like one.
  pendingToolCalls: number;
  lastToolDetail: string | null;
  // What the rail's Agents view shows for this pane.
  activity: PaneActivity;
  // The UserPromptSubmit that started the current Claude activity was a
  // background task reporting back, not the user.
  hookFollowUp: boolean;
  backgroundRunningAtLastStop: number;
  lastProgramState: string | null;
  codexScreen: CodexTerminalScreen | null;
  codexIdleSince: number | null;
  // Explicit outcomes outrank an old busy frame until Codex paints its composer idle.
  codexAwaitingIdle: boolean;
  codexTitleBlocked: boolean;
  codexAnnouncedTurnIds: string[];
  codexRollout: CodexRolloutTail | null;
  codexRolloutSince: number;
  // Net count of live background teammates counted from the transcript
  // stream. Heuristic panes only: with hooks the Stop payload is exact.
  teammatesActive: number;
  agentProcSeen: boolean;
  lastAgentProcCheckAt: number;
  agentProcGone: boolean;
  agentProcCheckInflight: boolean;
  lastOutputAt: number;
  // Last RuntimeState pushed to the renderer chip; dedups the chip channel.
  lastEmittedState: RuntimeState | null;
}

const watchers = new Map<string, PaneWatcher>();
let sweepTimer: NodeJS.Timeout | null = null;
let codexNotifyInstalled = false;

// Diagnostic trail (state transitions only, never raw bytes). The notifier
// works while nobody is looking at the pane, so this file is the flight
// recorder. Best-effort: truncated when oversized, errors swallowed.
const LOG_PATH = path.join(os.tmpdir(), "spark-terminal-notify.log");
let logChecked = false;
function tanLog(msg: string): void {
  // SPARK_TERMINAL_NOTIFY_LOG=0 switches it off.
  if (process.env.SPARK_TERMINAL_NOTIFY_LOG === "0") return;
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
  // pointer, which avoids depending on a banner printed before attach.
  runtimeHint?: PublicAgentRuntime | null;
}

function knownRuntimeHint(value: unknown): PublicAgentRuntime | null {
  return value === "claude" || value === "codex" || value === "grok" || value === "pi"
    ? value
    : null;
}

function emptySignals(): PaneSignals {
  return { hooks: false, programStatus: false, codexNotify: false, codexRollout: false };
}

// Called once boot knows whether Codex launches carry the notify program. A
// pane may still run a Codex started before this boot, or one launched
// around the pane's `codex` function; the grace window below only delays the
// heuristic, it never suppresses it, and only applies to panes whose launch
// can carry the program.
export function noteCodexNotifyInstalled(installed: boolean): void {
  codexNotifyInstalled = installed;
}

// Renderer-driven registry sync, one call per workspace layout change. The
// renderer is the only side that knows which pty sessions are user-facing
// terminal panes and which tab each lives in, so it ships the full desired set
// for the workspace and we reconcile.
export function syncTerminalNotifyPanes(input: {
  workspaceId: string;
  workspaceName?: string;
  panes: TerminalNotifyPaneEntry[];
}): TerminalAgentStatePayload[] {
  if (!input || typeof input.workspaceId !== "string" || !Array.isArray(input.panes)) return [];
  const workspaceName = typeof input.workspaceName === "string" ? input.workspaceName : "";
  const seen = new Set<string>();
  let added = 0;
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
      existing.runtimeHint = knownRuntimeHint(entry.runtimeHint);
      if (!existing.runtime && existing.runtimeHint) existing.runtime = existing.runtimeHint;
      if (!existing.attached) attach(existing);
      continue;
    }
    added += 1;
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
      runtime: knownRuntimeHint(entry.runtimeHint),
      runtimeHint: knownRuntimeHint(entry.runtimeHint),
      state: "idle",
      turn: null,
      pendingDone: null,
      signals: emptySignals(),
      disposing: false,
      workingSince: 0,
      lastWorkingAt: 0,
      lastOscNotifyAt: 0,
      lastChunkAssertedWorking: false,
      completedTurnPending: false,
      screenIdleSince: null,
      lastUserInputAt: 0,
      lastInterruptKeyAt: 0,
      lastHookEventAt: 0,
      pendingToolCalls: 0,
      lastToolDetail: null,
      activity: emptyActivity(),
      hookFollowUp: false,
      backgroundRunningAtLastStop: 0,
      lastProgramState: null,
      codexScreen: null,
      codexIdleSince: null,
      codexAwaitingIdle: false,
      codexTitleBlocked: false,
      codexAnnouncedTurnIds: [],
      codexRollout: null,
      codexRolloutSince: 0,
      teammatesActive: 0,
      agentProcSeen: false,
      lastAgentProcCheckAt: 0,
      agentProcGone: false,
      agentProcCheckInflight: false,
      lastOutputAt: 0,
      lastEmittedState: null,
    };
    watchers.set(entry.paneId, watcher);
    attach(watcher);
  }
  // Panes that disappeared from this workspace's layout were closed (a pane
  // that merely moved tabs is still in the list with its new tabId).
  let removed = 0;
  for (const [paneId, watcher] of watchers) {
    if (watcher.workspaceId === input.workspaceId && !seen.has(paneId)) {
      removeWatcher(paneId);
      removed += 1;
    }
  }
  // The renderer re-syncs on every layout change; only membership changes
  // are worth a log line.
  if (added > 0 || removed > 0) {
    tanLog(
      `sync ws=${input.workspaceId} panes=${input.panes
        .map((p) => `${p?.paneId}(tab=${p?.tabId}${p?.excluded ? ",excluded" : ""})`)
        .join(" ")} watchers=${watchers.size}`,
    );
  }
  ensureSweep();
  return terminalAgentStateSnapshot(input.workspaceId);
}

function attach(w: PaneWatcher): void {
  if (w.attached) return;
  // pty.tap/onExit accept ids before the underlying session exists. Register
  // immediately so a cold-restored agent cannot print its one-shot banner
  // between pty:spawn and a waitForSpawn continuation.
  tanLog(`pane=${w.paneId} tap attached (excluded=${w.excluded})`);
  w.untap = pty.tap(w.paneId, (chunk) => {
    try {
      onChunk(w, chunk);
    } catch (err) {
      console.warn("[terminal-agent-notify] chunk handler failed:", err);
    }
  });
  w.offExit = pty.onExit(w.paneId, (info) => {
    // Only a real non-zero exit STATUS is a crash worth alerting on. A missing
    // code (pty killed on teardown, host suspend, signal death) tells the user
    // nothing; the renderer's own pty:exit handler paints the red chip.
    const exitCode = typeof info.exitCode === "number" ? info.exitCode : null;
    if (!w.excluded && !w.disposing && w.runtime && exitCode !== null && exitCode !== 0) {
      deliver(w, "failed", { body: `The terminal exited with code ${exitCode}.` });
    }
    if (w.disposing) {
      removeWatcher(w.paneId);
      return;
    }
    emitPaneState(w, info.exitCode === 0 ? "done" : "error");

    // Keep the watcher registration alive across a same-id respawn
    // (useTerminalSession can auto-resume a live agent after a PTY death).
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
    resetAgentSession(w);
    w.lastOutputAt = 0;
    w.lastEmittedState = null;
    attach(w);
  });
  w.attached = true;

  // The tap is installed first. Node cannot interleave another pty onData
  // callback while the synchronous snapshot below is replayed, so bytes are
  // observed exactly once with no read/subscribe race.
  const recent = pty.readTailChunks(w.paneId, BOOTSTRAP_TAIL_BYTES) ?? [];
  if (recent.length > 0) {
    w.replayingTail = true;
    try {
      for (const chunk of recent) onChunk(w, chunk);
    } catch (err) {
      console.warn("[terminal-agent-notify] tail replay failed:", err);
    } finally {
      w.replayingTail = false;
      // Replayed submits and command markers belong to history.
      w.turn = null;
      cancelPendingDone(w, "tail replay");
      w.lastOscNotifyAt = 0;
    }
  }
}

function removeWatcher(paneId: string): void {
  const w = watchers.get(paneId);
  if (!w) return;
  tanLog(`pane=${paneId} watcher removed`);
  watchers.delete(paneId);
  clearCodexScreen(w);
  cancelPendingDone(w, "watcher removed");
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

// Everything that belongs to one agent session in the pane. A new agent
// (or the same CLI relaunched) starts with no turn and no trusted signals.
function resetAgentSession(w: PaneWatcher): void {
  cancelPendingDone(w, "agent session reset");
  clearCodexScreen(w);
  w.state = "idle";
  w.turn = null;
  w.signals = emptySignals();
  w.workingSince = 0;
  w.lastWorkingAt = 0;
  w.lastOscNotifyAt = 0;
  w.lastChunkAssertedWorking = false;
  w.completedTurnPending = false;
  w.screenIdleSince = null;
  w.pendingToolCalls = 0;
  w.lastToolDetail = null;
  noteActivity(w, emptyActivity());
  w.hookFollowUp = false;
  w.backgroundRunningAtLastStop = 0;
  w.lastProgramState = null;
  w.codexAnnouncedTurnIds = [];
  w.codexRollout = null;
  w.codexRolloutSince = 0;
  w.teammatesActive = 0;
}

function ensureSweep(): void {
  if (sweepTimer || watchers.size === 0) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const w of watchers.values()) {
      // Self-heal a watcher whose transport was reset by an unexpected PTY
      // exit or a transient attach failure.
      if (!w.attached) attach(w);
      if (w.excluded || w.disposing) continue;
      if (checkAgentProcess(w, now)) {
        markAgentExited(w, now, "process tree");
        continue;
      }
      if (!w.runtime) continue;
      if (w.runtime === "codex") pollCodexRollout(w);
      if (w.runtime === "codex" && w.codexScreen) {
        sweepCodexScreen(w, now);
        continue;
      }
      // A screenless Codex with a structured source still needs the quiet
      // window to settle its chip; codexTurnEndedOnScreen sends no done there.
      if (w.signals.programStatus || (w.signals.hooks && w.runtime !== "codex")) {
        if (w.runtime === "claude") sweepTrustedClaude(w, now);
        continue;
      }
      if (w.teammatesActive > 0) {
        if (now - w.lastOutputAt >= TEAMMATE_SILENCE_MS) {
          // A running teammate repaints its strip row at least once a second;
          // byte silence this long means the counter is stale.
          tanLog(`pane=${w.paneId} teammate counter stale (silence), cleared`);
          w.teammatesActive = 0;
        } else {
          continue;
        }
      }
      if (w.state !== "working") continue;
      const quietMs = w.completedTurnPending ? 0 : w.lastChunkAssertedWorking ? TURN_QUIET_STALL_MS : TURN_QUIET_MS;
      if (now - w.lastWorkingAt < quietMs) continue;
      w.state = "idle";
      tanLog(
        `pane=${w.paneId} turn quiet (${quietMs}ms, stall-like=${w.lastChunkAssertedWorking}, worked ${w.lastWorkingAt - w.workingSince}ms)`,
      );
      // The chip flips off "working" even when the toast gates below say no.
      emitPaneState(w, "idle");
      if (w.runtime === "codex") {
        codexTurnEndedOnScreen(w, now);
        continue;
      }
      if (!workedLongEnough(w) || now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) continue;
      // The quiet window already waited; no further confirmation needed.
      requestDone(w, { origin: "heuristic", delayMs: 0 });
    }
  }, SWEEP_MS);
  sweepTimer.unref();
}

function sweepTrustedClaude(w: PaneWatcher, now: number): void {
  // Program status owns the chip outright.
  if (w.signals.programStatus) return;
  if (
    w.state === "working" &&
    turnActive(w) &&
    w.screenIdleSince !== null &&
    now - w.screenIdleSince >= HOOK_IDLE_SETTLE_MS &&
    now - w.lastHookEventAt >= HOOK_IDLE_SETTLE_MS
  ) {
    tanLog(`pane=${w.paneId} hook turn idle on screen without a Stop; chip -> idle`);
    w.state = "idle";
    emitPaneState(w, "idle");
  }
}

function sweepCodexScreen(w: PaneWatcher, now: number): void {
  if (!w.codexScreen || w.signals.programStatus || w.codexTitleBlocked) return;
  const dimensions = pty.sessionDimensions(w.paneId);
  if (dimensions) w.codexScreen.resize(dimensions.cols, dimensions.rows);
  const state = w.codexScreen.state();
  if (state === "working") {
    w.codexIdleSince = null;
    if (w.codexAwaitingIdle && w.codexScreen.hasProgressSinceCompletion()) {
      w.codexAwaitingIdle = false;
    }
    if (!w.codexAwaitingIdle) enterWorking(w, now);
  } else if (state === "idle") {
    w.codexAwaitingIdle = false;
    if (w.state === "failed") return;
    w.codexIdleSince ??= now;
    if (now - w.codexIdleSince >= 1_200) {
      const finished = w.state === "working";
      w.state = "idle";
      emitPaneState(w, "idle");
      if (finished) codexTurnEndedOnScreen(w, now);
    }
  } else {
    w.codexIdleSince = null;
  }
  // Silence and incomplete repaints cannot end a turn while the rendered
  // busy footer is still present. Only an idle frame or explicit event can.
}

// The Codex composer came back. With a structured source this is chip-only;
// otherwise it is the turn end, delayed while a structured source may still
// report it with Codex's own words.
function codexTurnEndedOnScreen(w: PaneWatcher, now: number): void {
  if (codexHasStructuredDone(w)) return;
  if (interruptedThisTurn(w, now)) {
    closeTurnSilently(w, now, "interrupted by the user");
    return;
  }
  if (!workedLongEnough(w) || now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) return;
  requestDone(w, {
    origin: "heuristic",
    delayMs: codexStructuredExpected(w) ? CODEX_STRUCTURED_GRACE_MS : 0,
  });
}

function codexHasStructuredDone(w: PaneWatcher): boolean {
  return w.signals.codexNotify || w.signals.codexRollout;
}

function codexStructuredExpected(w: PaneWatcher): boolean {
  // The notify program rides on the launch, so a pane whose shell does not
  // wrap `codex` (fish, cmd, a remote host) never hears from it.
  if (codexNotifyInstalled && pty.sessionAgentFlagsReachCli(w.paneId)) return true;
  const record = latestSessionStart(w.paneId);
  return record?.runtime === "codex" && record.active === true && !!record.transcriptPath;
}

function hasTrustedSignals(w: PaneWatcher): boolean {
  if (w.signals.programStatus || w.signals.hooks) return true;
  return w.runtime === "codex" && codexHasStructuredDone(w);
}

// ── Turns ─────────────────────────────────────────────────────────────────

function turnActive(w: PaneWatcher): boolean {
  return w.turn !== null && !w.turn.announced;
}

function startTurn(w: PaneWatcher, now: number, source: AgentTurn["source"], sessionId: string | null): void {
  if (w.replayingTail) return;
  cancelPendingDone(w, "new turn");
  if (w.state !== "working") {
    w.workingSince = 0;
    w.lastWorkingAt = 0;
  }
  w.turn = { startedAt: now, source, sessionId, announced: false, announcedAt: 0 };
  w.screenIdleSince = null;
  w.lastOscNotifyAt = 0;
  tanLog(`pane=${w.paneId} turn start (${source}${sessionId ? ` session=${sessionId.slice(0, 8)}` : ""})`);
  // A new turn is real new activity: the next alert of any kind may deliver.
  rearm(paneSourceKey(w.paneId));
}

// Esc or Ctrl+C reached the pane during the current turn, recently enough
// that an idle screen now is the user stopping it. A key from before this
// turn's submit stopped an earlier one.
function interruptedThisTurn(w: PaneWatcher, now: number): boolean {
  return (
    w.turn !== null &&
    w.lastInterruptKeyAt >= w.turn.startedAt &&
    now - w.lastInterruptKeyAt < INTERRUPT_WINDOW_MS
  );
}

// The turn is over without anything worth announcing (the user stopped it).
function closeTurnSilently(w: PaneWatcher, now: number, reason: string): void {
  cancelPendingDone(w, reason);
  if (!w.turn || w.turn.announced) return;
  w.turn.announced = true;
  w.turn.announcedAt = now;
  tanLog(`pane=${w.paneId} turn closed without an alert (${reason})`);
}

function requestDone(
  w: PaneWatcher,
  req: {
    origin: DoneOrigin;
    delayMs: number;
    body?: string | null;
    backgroundRunning?: number;
    followUp?: boolean;
  },
): void {
  if (w.replayingTail || w.excluded) return;
  if (req.body && req.body.trim()) noteActivity(w, { message: req.body.slice(0, ACTIVITY_TEXT_MAX) });
  if (!req.followUp && !turnActive(w)) {
    tanLog(`pane=${w.paneId} done (${req.origin}) ignored: no unannounced turn`);
    return;
  }
  const existing = w.pendingDone;
  // A heuristic never shortens or overrides a structured pending announcement.
  if (existing && DONE_RANK[req.origin] < DONE_RANK[existing.origin]) return;
  if (existing?.timer) clearTimeout(existing.timer);
  const rank = DONE_RANK[req.origin];
  const newBody = req.body && req.body.trim() ? req.body : null;
  const keepOld = existing?.body && (!newBody || existing.bodyRank > rank);
  const pending: PendingDone = {
    timer: null,
    origin: req.origin,
    body: keepOld ? existing.body : newBody,
    bodyRank: keepOld ? existing.bodyRank : newBody ? rank : -1,
    backgroundRunning: req.backgroundRunning ?? existing?.backgroundRunning ?? 0,
    followUp: req.followUp === true || existing?.followUp === true,
  };
  w.pendingDone = pending;
  tanLog(`pane=${w.paneId} done pending (${req.origin}, ${req.delayMs}ms)`);
  if (req.delayMs <= 0) {
    fireDone(w, pending);
    return;
  }
  pending.timer = setTimeout(() => fireDone(w, pending), req.delayMs);
  pending.timer.unref?.();
}

function fireDone(w: PaneWatcher, pending: PendingDone): void {
  if (w.pendingDone !== pending || watchers.get(w.paneId) !== w) return;
  w.pendingDone = null;
  if (pending.timer) clearTimeout(pending.timer);
  if (!pending.followUp && !turnActive(w)) return;
  const now = Date.now();
  const startedAt = w.turn && !w.turn.announced ? w.turn.startedAt : null;
  if (w.turn) {
    w.turn.announced = true;
    w.turn.announcedAt = now;
  }
  // The earlier turn alert for this source already went out; the drained
  // background work is new information.
  if (pending.followUp) rearm(paneSourceKey(w.paneId));
  deliver(w, "done", {
    body: pending.body,
    durationMs: startedAt !== null ? now - startedAt : null,
    backgroundRunning: pending.backgroundRunning,
    followUp: pending.followUp,
  });
}

function cancelPendingDone(w: PaneWatcher, reason: string, onlyBelow?: DoneOrigin): void {
  const pending = w.pendingDone;
  if (!pending) return;
  if (onlyBelow && DONE_RANK[pending.origin] >= DONE_RANK[onlyBelow]) return;
  if (pending.timer) clearTimeout(pending.timer);
  w.pendingDone = null;
  tanLog(`pane=${w.paneId} pending done (${pending.origin}) cancelled: ${reason}`);
}

// The agent stopped for the user. Only inside a turn: launch-time trust and
// login screens are answered by someone who is looking at the pane.
function needsYou(w: PaneWatcher, now: number, body: string | null, why: string): void {
  noteActivity(w, { question: body });
  if (!turnActive(w) && w.state !== "working") {
    if (w.state !== "blocked") tanLog(`pane=${w.paneId} prompt outside a turn (${why}), no alert`);
    w.state = "blocked";
    emitPaneState(w, "blocked");
    return;
  }
  const wasBlocked = w.state === "blocked";
  w.state = "blocked";
  w.screenIdleSince = null;
  emitPaneState(w, "blocked");
  cancelPendingDone(w, "agent is waiting for an answer");
  if (wasBlocked) return;
  if (now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) return;
  tanLog(`pane=${w.paneId} needs you (${why})`);
  // Working again after an announced turn (a background follow-up) is new
  // activity; the finished alert must not swallow this prompt.
  if (!turnActive(w)) rearm(paneSourceKey(w.paneId));
  deliver(w, "blocked", { body });
}

// A prompt the agent was waiting on got its answer. A later prompt in the
// same turn is new and must be allowed to alert.
function promptResolved(w: PaneWatcher, now: number): void {
  if (w.state !== "blocked") return;
  rearm(paneSourceKey(w.paneId));
  enterWorking(w, now);
}

// Enter (or stay in) the heuristic working state.
//
// Deliberately does NOT start a turn or rearm the policy: a stream re-match of
// the working footer is not proof of a NEW turn (a mid-turn stall resumes
// through here too). Turns start on a submit.
function enterWorking(w: PaneWatcher, now: number): void {
  w.completedTurnPending = false;
  w.screenIdleSince = null;
  cancelPendingDone(w, "working again", "program");
  if (w.state !== "working") {
    w.workingSince = now;
    tanLog(`pane=${w.paneId} state -> working (was ${w.state})`);
    emitPaneState(w, "working");
  }
  w.state = "working";
  w.lastWorkingAt = now;
}

// Bracketed pastes can contain newlines without submitting anything, and
// Alt+Enter / Shift+Enter insert a newline in agent composers.
const PASTE_RE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g;
const TERMINAL_REPLY_RE =
  /^(?:\x1b\[[?>=]?[\d;:]*(?:[cnRt]|\$y)|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[<[\d;]*[mM])+$/;

function isSubmit(data: string): boolean {
  return /\r/.test(data.replace(PASTE_RE, "").replace(/\x1b\r/g, ""));
}

// User keystrokes / injected input reached this pane's pty. A submit starts a
// turn; other keys only matter as answers to a prompt or as an interrupt.
// `data` undefined means an injected prompt that was submitted.
export function noteTerminalUserInput(paneId: string, data?: string): void {
  // xterm's onData also carries device replies, focus reports and mouse
  // reports. None of them is the user acting on the agent.
  if (data !== undefined && TERMINAL_REPLY_RE.test(data)) return;
  const w = watchers.get(paneId);
  if (!w || w.excluded) return;
  const now = Date.now();
  w.lastUserInputAt = now;
  if (data !== undefined && (data === "\x1b" || data.includes("\x03"))) {
    w.lastInterruptKeyAt = now;
  }
  // Any key while a prompt is up is the user answering it.
  if (w.state === "blocked") rearm(paneSourceKey(paneId));
  if (data !== undefined && !isSubmit(data)) return;
  // Enter while a turn runs queues a message or answers a dialog; the turn
  // already exists. A submit that started no work (an empty prompt, a local
  // slash command, a turn the user stopped) leaves an idle turn behind, and
  // the turn being timed is the one this submit starts.
  if (turnActive(w) && (w.state !== "idle" || w.pendingDone !== null)) return;
  startTurn(w, now, "input", null);
}

// The host slept: the wall-clock gap is not byte silence. Restart the quiet
// window so the first sweep after wake doesn't read the gap as a finish.
export function noteHostResume(): void {
  const now = Date.now();
  for (const w of watchers.values()) {
    if (w.state !== "working") continue;
    w.lastWorkingAt = now;
    w.lastOutputAt = now;
    if (w.screenIdleSince !== null) w.screenIdleSince = now;
    tanLog(`pane=${w.paneId} host resume, quiet window restarted`);
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hookToolName(payload: Record<string, unknown> | null): string {
  const value = payload?.tool_name ?? payload?.toolName ?? payload?.tool;
  return typeof value === "string" ? value : "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// A short, plain-text line from an agent's final message: markdown markers
// dropped, code blocks skipped, cut at a sentence boundary when one is near.
export function summarizeAgentMessage(text: unknown, max = SUMMARY_MAX_CHARS): string | null {
  if (typeof text !== "string") return null;
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  if (plain.length <= max) return plain;
  const window = plain.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= max * 0.5) return window.slice(0, sentenceEnd + 1);
  return `${window.slice(0, max - 1).trimEnd()}…`;
}

// What a pending tool call wants to do, in words a permission alert can show.
export function describeToolCall(toolName: string, input: unknown): string | null {
  if (!toolName) return null;
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = (key: string): string | null => (typeof args[key] === "string" && args[key] ? (args[key] as string) : null);
  const file = text("file_path") ?? text("notebook_path") ?? text("path");
  let detail: string | null = null;
  if (toolName === "Bash") detail = text("command");
  else if (file) detail = path.basename(file);
  else detail = text("url") ?? text("pattern") ?? text("description") ?? text("query");
  const name = toolName.startsWith("mcp__") ? toolName.split("__").slice(2).join("__") || toolName : toolName;
  return oneLine(detail ? `${name}: ${detail}` : name, DETAIL_MAX_CHARS);
}

function questionText(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as { questions?: unknown }).questions;
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      const question = entry && typeof entry === "object" ? (entry as { question?: unknown }).question : null;
      if (typeof question === "string" && question.trim()) return oneLine(question, SUMMARY_MAX_CHARS);
    }
  }
  const question = (input as { question?: unknown }).question;
  return typeof question === "string" && question.trim() ? oneLine(question, SUMMARY_MAX_CHARS) : null;
}

function runningBackgroundTasks(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let running = 0;
  for (const task of value) {
    if (!task || typeof task !== "object") continue;
    const status = (task as { status?: unknown }).status;
    if (typeof status !== "string" || /^(?:running|pending|in_progress|active)$/i.test(status)) running += 1;
  }
  return running;
}

// Claude Code hook events (and the Codex notify program's events) for a pane
// the user opened themselves, routed here by hook-watcher.ts.
export function noteTerminalHookEvent(
  paneId: string,
  hookName: string,
  payload: Record<string, unknown> | null = null,
): void {
  const w = watchers.get(paneId);
  if (!w || w.excluded) return;
  const now = Date.now();
  if (hookName === "CodexNotify") {
    handleCodexNotify(w, now, payload);
    return;
  }
  // Claude hooks only. A pane running another agent can still host a nested
  // `claude -p` (a tool call, a script); its hooks say nothing about that agent.
  if (w.runtime !== null && w.runtime !== "claude") return;
  w.lastHookEventAt = now;
  if (!w.signals.hooks) {
    w.signals.hooks = true;
    tanLog(`pane=${w.paneId} Claude hooks active`);
  }
  const agentId = stringField(payload, "agent_id");
  const sessionId = stringField(payload, "session_id");
  // A one-shot `claude -p` run inside the pane fires hooks with the same pane
  // id. While the user's turn is open, only its own session counts.
  const nested = sessionId !== null && turnActive(w) && w.turn?.sessionId != null && sessionId !== w.turn.sessionId;
  if (nested) return;
  switch (hookName) {
    case "UserPromptSubmit": {
      if (agentId) return;
      const prompt = stringField(payload, "prompt") ?? "";
      w.pendingToolCalls = 0;
      if (/^\s*<task-notification>/.test(prompt)) {
        // A background task reporting back. Claude works on it, but nobody
        // submitted anything.
        w.hookFollowUp = true;
        if (!w.signals.programStatus) enterWorking(w, now);
        return;
      }
      w.hookFollowUp = false;
      noteActivity(w, { prompt: oneLine(prompt, SUMMARY_MAX_CHARS) || null, question: null, tool: null });
      if (turnActive(w) && w.turn?.source === "input" && now - w.turn.startedAt < 10_000) {
        w.turn.source = "prompt";
        w.turn.sessionId = sessionId;
      } else {
        startTurn(w, now, "prompt", sessionId);
      }
      if (!w.signals.programStatus) enterWorking(w, now);
      return;
    }
    case "PreToolUse": {
      const tool = hookToolName(payload);
      const input = payload?.tool_input ?? payload?.toolInput;
      w.pendingToolCalls += 1;
      w.lastToolDetail = describeToolCall(tool, input);
      noteActivity(w, { tool: w.lastToolDetail });
      if (!agentId) cancelPendingDone(w, `lead tool call ${tool}`);
      if (tool === "AskUserQuestion") {
        if (!w.signals.programStatus) needsYou(w, now, questionText(input) ?? "Has a question for you.", "AskUserQuestion");
        return;
      }
      if (tool === "ExitPlanMode") {
        if (!w.signals.programStatus) needsYou(w, now, "A plan is ready for your review.", "ExitPlanMode");
        return;
      }
      if (w.signals.programStatus) return;
      if (w.state === "blocked") promptResolved(w, now);
      else if (turnActive(w) || w.hookFollowUp) enterWorking(w, now);
      return;
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      w.pendingToolCalls = Math.max(0, w.pendingToolCalls - 1);
      if (w.signals.programStatus) return;
      if (w.state === "blocked") promptResolved(w, now);
      return;
    case "Notification": {
      const type = stringField(payload, "notification_type") ?? "";
      // idle_prompt repeats a finished turn a minute later; agent_completed
      // is a background agent, not the lead turn.
      if (!/^(?:permission_prompt|elicitation_dialog|agent_needs_input)$/.test(type)) return;
      if (w.signals.programStatus) return;
      const message = stringField(payload, "message");
      const body =
        type === "permission_prompt" && w.lastToolDetail
          ? `Permission for ${w.lastToolDetail}`
          : message
            ? oneLine(message, SUMMARY_MAX_CHARS)
            : null;
      needsYou(w, now, body, `Notification ${type}`);
      return;
    }
    case "Stop":
    case "StopFailure":
      if (agentId) return;
      handleClaudeStop(w, now, hookName, payload);
      return;
    case "SessionStart": {
      const source = stringField(payload, "source") ?? "";
      // compact fires inside a turn.
      if (source === "compact") return;
      closeTurnSilently(w, now, `session ${source || "start"}`);
      w.turn = null;
      w.pendingToolCalls = 0;
      w.backgroundRunningAtLastStop = 0;
      w.hookFollowUp = false;
      return;
    }
    case "SessionEnd":
      closeTurnSilently(w, now, "session end");
      w.pendingToolCalls = 0;
      return;
    default:
      // SubagentStart / SubagentStop / PreCompact: never a lead-turn boundary.
      return;
  }
}

function handleClaudeStop(
  w: PaneWatcher,
  now: number,
  hookName: string,
  payload: Record<string, unknown> | null,
): void {
  const running = runningBackgroundTasks(payload?.background_tasks);
  const message = summarizeAgentMessage(payload?.last_assistant_message);
  const followUp = w.hookFollowUp;
  w.hookFollowUp = false;
  w.pendingToolCalls = 0;
  w.screenIdleSince = null;
  if (!w.signals.programStatus) {
    w.state = "idle";
    emitPaneState(w, "idle");
  }
  const drained = w.backgroundRunningAtLastStop > 0 && running === 0;
  w.backgroundRunningAtLastStop = running;
  tanLog(`pane=${w.paneId} hook ${hookName} (background running=${running}, follow-up=${followUp})`);
  if (hookName === "StopFailure") {
    if (!turnActive(w)) return;
    const error = stringField(payload, "error") ?? stringField(payload, "error_type");
    closeTurnSilently(w, now, "stop failure");
    deliver(w, "failed", { body: error ? `The turn ended with an error: ${oneLine(error, 100)}` : "The turn ended with an API error." });
    return;
  }
  if (turnActive(w) && !followUp) {
    requestDone(w, {
      origin: "hook",
      body: message,
      backgroundRunning: running,
      delayMs: HOOK_DONE_CONFIRM_MS,
    });
    return;
  }
  if (drained) {
    requestDone(w, { origin: "hook", body: message, followUp: true, delayMs: HOOK_DONE_CONFIRM_MS });
  }
}

// ── Codex structured completion ───────────────────────────────────────────

function rememberCodexTurn(w: PaneWatcher, turnId: string | null): boolean {
  if (!turnId) return true;
  if (w.codexAnnouncedTurnIds.includes(turnId)) return false;
  w.codexAnnouncedTurnIds.push(turnId);
  if (w.codexAnnouncedTurnIds.length > 16) w.codexAnnouncedTurnIds.shift();
  return true;
}

function codexCompleted(
  w: PaneWatcher,
  now: number,
  turnId: string | null,
  message: unknown,
  userInput: boolean | null,
  why: string,
): void {
  if (!rememberCodexTurn(w, turnId)) return;
  w.state = "idle";
  w.codexIdleSince = null;
  w.codexAwaitingIdle = true;
  w.codexScreen?.markCompleted();
  if (!w.signals.programStatus) emitPaneState(w, "idle");
  if (userInput === false) {
    tanLog(`pane=${w.paneId} Codex turn without user input (${why}), no alert`);
    closeTurnSilently(w, now, "turn without user input");
    return;
  }
  if (!turnActive(w)) {
    // A just-announced turn is the same completion reported by the other source.
    if (w.turn?.announced && now - w.turn.announcedAt < 5_000) return;
    if (userInput !== true) return;
    startTurn(w, now, "prompt", null);
  }
  requestDone(w, { origin: "codex", body: summarizeAgentMessage(message), delayMs: 0 });
}

function handleCodexNotify(w: PaneWatcher, now: number, payload: Record<string, unknown> | null): void {
  if (w.runtime !== null && w.runtime !== "codex") return;
  if (!payload || payload.type !== "agent-turn-complete") return;
  // Subagents and a nested `codex exec` inherit the pane's environment, so
  // their turns run the notify program too. Only the thread the pane's Codex
  // holds open is the user's.
  const threadId = stringField(payload, "thread-id");
  const record = latestSessionStart(w.paneId);
  if (
    threadId &&
    record?.runtime === "codex" &&
    record.active === true &&
    record.sessionId &&
    record.sessionId.toLowerCase() !== threadId.toLowerCase()
  ) {
    tanLog(`pane=${w.paneId} Codex notify for another thread (${threadId.slice(0, 8)}), ignored`);
    return;
  }
  if (!w.signals.codexNotify) {
    w.signals.codexNotify = true;
    tanLog(`pane=${w.paneId} Codex notify active`);
  }
  const inputs = payload["input-messages"];
  const userInput = Array.isArray(inputs) ? inputs.some((m) => typeof m === "string" && m.trim().length > 0) : null;
  codexCompleted(w, now, stringField(payload, "turn-id"), payload["last-assistant-message"], userInput, "notify");
}

function pollCodexRollout(w: PaneWatcher): void {
  const record = latestSessionStart(w.paneId);
  if (record?.runtime !== "codex" || record.active !== true || !record.transcriptPath) return;
  if (w.codexRollout?.path !== record.transcriptPath) {
    w.codexRollout = new CodexRolloutTail(record.transcriptPath);
    w.codexRolloutSince = Date.now();
  }
  const tail = w.codexRollout;
  void tail.poll().then((events) => {
    if (watchers.get(w.paneId) !== w || w.codexRollout !== tail) return;
    for (const event of events) handleCodexRolloutEvent(w, event);
  });
}

function handleCodexRolloutEvent(w: PaneWatcher, event: CodexRolloutEvent): void {
  if (w.runtime !== "codex") return;
  // The first read looks back a little; only events from this pane's watch
  // (or from the turn the user just started) are news.
  const cutoff = Math.min(w.codexRolloutSince, w.turn?.startedAt ?? Infinity) - 2_000;
  if (event.at < cutoff) return;
  const now = Date.now();
  if (!w.signals.codexRollout) {
    w.signals.codexRollout = true;
    tanLog(`pane=${w.paneId} Codex session file active`);
  }
  if (event.type === "task_started") {
    w.codexAwaitingIdle = false;
    if (!w.signals.programStatus && !w.codexTitleBlocked) enterWorking(w, now);
    return;
  }
  if (event.type === "turn_aborted") {
    closeTurnSilently(w, now, "Codex turn interrupted");
    w.state = "idle";
    if (!w.signals.programStatus) emitPaneState(w, "idle");
    return;
  }
  codexCompleted(w, now, event.turnId, event.lastAgentMessage, null, "session file");
}

export function noteTerminalWillDispose(paneId: string): void {
  const w = watchers.get(paneId);
  if (w) w.disposing = true;
}

// Snapshot foreground agent panes before app-level PTY teardown begins.
export function activeTerminalAgentPaneIds(): string[] {
  const active: string[] = [];
  for (const watcher of watchers.values()) {
    if (!watcher.disposing && watcher.runtime && pty.hasSession(watcher.paneId)) {
      active.push(watcher.paneId);
    }
  }
  return active;
}

// The agent in this pane already tells the notifier when its turns end and
// when it waits on the user (hooks, status reports, Codex notify or its
// session file). An agent-sent alert on top of that would arrive mid-turn,
// before the real end, and the policy would then swallow the exact one.
export function terminalAgentTurnsSignaled(paneId: string): boolean {
  const w = watchers.get(paneId);
  if (!w || w.excluded || !w.runtime) return false;
  const s = w.signals;
  return s.hooks || s.programStatus || s.codexNotify || s.codexRollout;
}

// True when the current/just-ended working phase ran long enough to be a
// real turn rather than a boot blip or pattern flap (see MIN_WORK_MS).
function workedLongEnough(w: PaneWatcher): boolean {
  return w.lastWorkingAt - w.workingSince >= MIN_WORK_MS;
}

// ── Per-chunk stream scanning ────────────────────────────────────────────

// Explicit desktop-notification escapes, exactly the set WezTerm renders:
//   OSC 9:   `ESC ] 9 ; message BEL`   (iTerm2/growl style)
//   OSC 777: `ESC ] 777 ; notify ; title ; body BEL` (rxvt extension)
// `ESC ] 9 ; 4 ; …` is the ConEmu progress protocol, filtered below.
const OSC9_G = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC777_G = /\x1b\]777;notify;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC633E_G = /\x1b\]633;E;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// ConEmu/Windows-Terminal progress protocol (Claude Code with
// `terminalProgressBarEnabled`): state 0 = clear, otherwise busy.
const OSC9_PROGRESS_G = /\x1b\]9;4(?:;(\d*))?(?:;\d*)?(?:\x07|\x1b\\)/g;
// iTerm2 tab-status extension (Claude Code with `showStatusInTerminalTab`).
const OSC21337_G = /\x1b\]21337;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 7501 program status. `?` alone is the support query; anything else is a
// report of `key=value` fields separated by `:`.
const OSC7501_G = /\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const PROGRAM_STATUS_REPLY =
  "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";
// Window title (OSC 0 / 2). Codex titles the window "[ ! ] Action Required"
// while an approval waits.
const OSC_TITLE_G = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const CODEX_ACTION_REQUIRED_RE = /Action Required/i;
// Prompt-back markers (OSC 633 A/B/D/P + OSC 133;A / 133;D). Kept in sync
// with the shared PROMPT_MARKER_RE.
const PROMPT_MARKER_G = /\x1b\]633;[ABDP](?:;|\x07|\x1b\\)|\x1b\]133;[AD](?:\x07|\x1b\\)/g;
// Pi paints BEL-terminated OSC 133 zones around every chat message; in a Pi
// pane only the shell's ST-terminated 133 (and any 633) marker means the
// prompt is back. Kept in sync with the shared PI_PROMPT_MARKER_RE.
const PI_PROMPT_MARKER_G = /\x1b\]633;[ABDP](?:;|\x07|\x1b\\)|\x1b\]133;[AD]\x1b\\/g;
const PI_EXIT_LINE_G = new RegExp(PI_EXIT_LINE_RE.source, "g");
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

// High-confidence terminal problems. A banner OWNS its line: each candidate
// line is normalized (TUI glyphs and box drawing stripped), rejected if it
// carries code punctuation, and matched anchored at the start. Substring scans
// used to alert on the agent's own code about authentication (2026-08-29: 45
// of 195 delivered alerts in 32h).
const CREDENTIAL_LINE_RE =
  /^(?:not\s+(?:logged|signed)\s+in|authentication\s+(?:is\s+)?(?:required|failed)|oauth\s+token\s+(?:expired|invalid)|unauthorized\s+(?:request|account)|invalid\s+api\s+key)\b/i;
const HARD_FAILURE_LINE_RE =
  /^(?:you(?:'|’)ve\s+hit\s+your\s+(?:usage|rate)\s+limit|(?:usage|rate)\s+limit\s+(?:reached|exceeded|exhausted)|credit\s+balance\s+(?:is\s+)?too\s+low|(?:credit|quota)\s+(?:balance\s+)?(?:is\s+)?(?:exhausted|exceeded)|(?:request|connection)\s+failed\s+after\s+\d+\s+retr(?:y|ies))\b/i;

const LINE_DECORATION_RE = /^[\s>│┃|*•●○◆◇⏺⎿└├─┌┐┘╭╮╰╯═║✗✘×✖!⚠]+/u;
// Punctuation that effectively never appears in a CLI status banner but is
// everywhere in source code, diffs and log lines. The apostrophe is
// deliberately absent ("You've hit your usage limit").
const CODE_PUNCTUATION_RE = /[{}();=<>[\]"`\\]|\/\/|\/\*|::|=>/;
const MAX_BANNER_LINE_LENGTH = 160;

function bannerLine(rawLine: string): string | null {
  const line = rawLine.replace(LINE_DECORATION_RE, "").trim();
  if (!line || line.length > MAX_BANNER_LINE_LENGTH) return null;
  if (CODE_PUNCTUATION_RE.test(line)) return null;
  return line;
}

// One stream line → the problem it announces, if any. Exported so the false-
// alarm corpus in scripts/test-terminal-agent-notify.cjs tests the SHIPPING
// patterns rather than a copy of them.
export function classifyBannerLine(rawLine: string): "blocked" | "failed" | null {
  const line = bannerLine(rawLine);
  if (!line) return null;
  if (CREDENTIAL_LINE_RE.test(line)) return "blocked";
  if (HARD_FAILURE_LINE_RE.test(line)) return "failed";
  return null;
}

// `plain` is the already-stripped carry+chunk text; `freshFrom` is an offset
// into it. Segments break on CR as well as LF (TUIs rewrite a row with \r).
function detectTerminalProblem(
  plain: string,
  freshFrom: number,
): { kind: "blocked" | "failed"; body: string } | null {
  let segmentStart = 0;
  for (let i = 0; i <= plain.length; i++) {
    const ch = i < plain.length ? plain[i] : "\n";
    if (ch !== "\n" && ch !== "\r") continue;
    if (i > freshFrom) {
      const kind = classifyBannerLine(plain.slice(segmentStart, i));
      if (kind) return { kind, body: bannerLine(plain.slice(segmentStart, i)) as string };
    }
    segmentStart = i + 1;
  }
  return null;
}

// Collect regex matches that END inside the newly arrived text (index >=
// minEnd). Matches fully contained in the carry were processed already.
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

export interface ProgramStatusReport {
  state: string;
  app: string | null;
  id: string | null;
  kind: string | null;
  msg: string | null;
}

function decodeStatusText(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    // The protocol rejects decoded text with control characters.
    if (!text || /[\x00-\x1f\x7f]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

// Parse the body of one OSC 7501 report; null for the query and for bodies
// without a state.
export function parseProgramStatus(body: string): ProgramStatusReport | null {
  if (body.trim().startsWith("?")) return null;
  const fields = new Map<string, string>();
  for (const part of body.split(":")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const state = fields.get("state");
  if (!state) return null;
  return {
    state,
    app: fields.get("app") ?? null,
    id: fields.get("id") ?? null,
    kind: fields.get("kind") ?? null,
    msg: decodeStatusText(fields.get("msg")),
  };
}

function blockedBody(kind: string | null, msg: string | null): string {
  if (msg) return oneLine(msg, SUMMARY_MAX_CHARS);
  if (kind === "permission") return "Wants your permission to continue.";
  if (kind === "question") return "Has a question for you.";
  if (kind === "auth") return "Needs you to sign in.";
  return "Waiting for your answer.";
}

function handleProgramStatus(w: PaneWatcher, report: ProgramStatusReport, now: number): void {
  // Child records describe background tasks. The parent's own state decides
  // whether the turn is done.
  if (report.id) return;
  const app = report.app ?? "";
  const reported: PublicAgentRuntime | null = app === "codex" ? "codex" : app.startsWith("claude") ? "claude" : null;
  if (!w.runtime && reported) identifyRuntime(w, reported, "program status");
  if (reported && w.runtime && reported !== w.runtime) return;
  if (!w.signals.programStatus) {
    w.signals.programStatus = true;
    tanLog(`pane=${w.paneId} program status active (${app || "unknown app"})`);
  }
  const previous = w.lastProgramState;
  w.lastProgramState = report.state;
  switch (report.state) {
    case "working":
      if (w.state === "blocked") promptResolved(w, now);
      // Only a transition into working is new activity (a queued message
      // started); repeated working reports carry progress.
      else if (previous !== "working") {
        cancelPendingDone(w, "program working again");
        enterWorking(w, now);
      } else {
        w.lastWorkingAt = now;
      }
      return;
    case "blocked":
      needsYou(w, now, blockedBody(report.kind, report.msg), `program status blocked${report.kind ? ` ${report.kind}` : ""}`);
      return;
    case "done":
      w.state = "idle";
      emitPaneState(w, "idle");
      if (w.runtime === "codex") return;
      requestDone(w, { origin: "program", body: report.msg, delayMs: PROGRAM_DONE_CONFIRM_MS });
      return;
    case "idle": {
      const wasActive = previous === "working" || previous === "blocked";
      w.state = "idle";
      emitPaneState(w, "idle");
      if (!wasActive) return;
      if (w.runtime === "codex") {
        // Codex has no `done`: idle after working is the turn end, and an
        // interrupt looks the same, so a structured source is preferred.
        w.codexAwaitingIdle = true;
        w.codexScreen?.markCompleted();
        codexTurnEndedOnScreen(w, now);
        return;
      }
      // Claude reports a turn the user stopped as idle.
      closeTurnSilently(w, now, "program status idle (stopped)");
      return;
    }
    case "error":
      w.state = "failed";
      if (report.msg) noteActivity(w, { message: report.msg.slice(0, ACTIVITY_TEXT_MAX) });
      emitPaneState(w, "error");
      if (!turnActive(w)) return;
      closeTurnSilently(w, now, "program status error");
      deliver(w, "failed", { body: report.msg ? oneLine(report.msg, SUMMARY_MAX_CHARS) : "The turn ended with an error." });
      return;
    default:
      return;
  }
}

function identifyRuntime(w: PaneWatcher, runtime: PublicAgentRuntime, why: string): void {
  // A banner repainted by the same agent (or a restored runtime hint) keeps
  // the session's trusted signals; a launched command is a new session.
  const sameSession = w.runtime === runtime && why !== "command marker";
  w.runtime = runtime;
  w.agentProcSeen = false;
  w.agentProcGone = false;
  w.lastAgentProcCheckAt = 0;
  if (!sameSession) resetAgentSession(w);
  // Launching an agent is not a turn. The Enter that started the CLI must not
  // arm a "finished" for whatever the CLI does at startup (Codex can run a
  // startup task with no user message).
  cancelPendingDone(w, "agent identified");
  w.turn = null;
  tanLog(`pane=${w.paneId} runtime identified: ${runtime} (${why})`);
  // Show "starting" until the first real signal classifies the state.
  emitPaneState(w, "launching");
}

function onChunk(w: PaneWatcher, chunk: Buffer): void {
  if (w.excluded) return;
  const decoded = w.decoder.decode(chunk, { stream: true });
  if (decoded.length === 0) return;
  w.lastOutputAt = Date.now();
  const carryLen = w.carry.length;
  const text = w.carry + decoded;

  // 0) OSC 7501. The query is answered here rather than in the renderer: this
  // tap sees the stream when the pane's workspace is hidden, and the reply
  // must reach the program before its end-of-query marker is answered.
  if (text.includes("\x1b]7501;")) {
    for (const m of newMatches(OSC7501_G, text, carryLen)) {
      const body = m[1] ?? "";
      if (body.trim() === "?") {
        if (!w.replayingTail) {
          tanLog(`pane=${w.paneId} answered OSC 7501 query`);
          pty.write(w.paneId, PROGRAM_STATUS_REPLY);
        }
        continue;
      }
      const report = parseProgramStatus(body);
      if (report) handleProgramStatus(w, report, Date.now());
    }
  }

  // 1) Explicit notification escapes, honored for ANY foreground program.
  for (const m of newMatches(OSC9_G, text, carryLen)) {
    const message = m[1] ?? "";
    // ConEmu overloaded OSC 9 with numeric subcommands (`9;4` progress,
    // `9;9;<cwd>`); none of them are toasts.
    if (/^\d{1,2}(?:;|$)/.test(message)) continue;
    handleExplicitNotify(w, message.trim());
  }
  for (const m of newMatches(OSC777_G, text, carryLen)) {
    const parts = (m[1] ?? "").split(";");
    const message = parts.filter((p) => p.trim().length > 0).join(": ");
    handleExplicitNotify(w, message.trim());
  }

  // 2) Agent lifecycle. Runtime identification first (shell-integration
  // command marker beats banner sniffing), then live-state classification.
  w.ring = (w.ring + decoded).slice(-RING_MAX);
  let launchedRuntime: PublicAgentRuntime | null = null;
  for (const m of newMatches(OSC633E_G, text, carryLen)) {
    const fromCmd = runtimeFromCommandLine(unescapeOsc633(m[1] ?? ""));
    const publicRuntime = fromCmd ? coercePublicRuntime(fromCmd) : null;
    if (publicRuntime) launchedRuntime = publicRuntime;
  }
  if (launchedRuntime) {
    // A shell command marker means the user launched an agent. Launching a
    // TUI is not an agent turn.
    identifyRuntime(w, launchedRuntime, "command marker");
    rearm(paneSourceKey(w.paneId));
  } else if (!w.runtime || w.lastEmittedState === null) {
    const window = w.ring.slice(-(decoded.length + SNIFF_OVERLAP));
    const banner = sniffRuntime(window);
    let sniffed = banner ? coercePublicRuntime(banner) : null;
    if (!sniffed) sniffed = sniffLiveRuntime(w.ring.slice(-2048));
    if (sniffed) identifyRuntime(w, sniffed, "banner");
  }

  if (w.runtime) {
    const now = Date.now();
    if (w.runtime === "codex" && !w.excluded) {
      const dimensions = pty.sessionDimensions(w.paneId);
      if (dimensions) {
        if (!w.codexScreen) {
          w.codexScreen = new CodexTerminalScreen(dimensions.cols, dimensions.rows, () => {
            w.codexAwaitingIdle = false;
          });
          w.codexScreen.write(w.ring);
        } else {
          w.codexScreen.resize(dimensions.cols, dimensions.rows);
          w.codexScreen.write(chunk);
        }
      }
      if (text.includes("\x1b]")) scanCodexTitle(w, text, carryLen, now);
    }
    let chunkAssertedWorking = false;
    // Offset into the STRIPPED text where the fresh bytes begin.
    const fresh = carryLen === 0 ? 0 : stripAnsi(w.carry).length;
    const plain = stripAnsi(text);
    const programOwned = w.signals.programStatus;
    const hookOwned = !programOwned && w.signals.hooks && w.runtime === "claude";

    // Codex shimmers "Working" between full footer repaints. Sustain an
    // existing turn on those frames, but not on arbitrary output (editing the
    // composer also emits bytes).
    if (
      w.state === "working" &&
      (w.runtime !== "codex" || /^(?:\s*[•●]?\s*Working\s*)+$/i.test(stripAnsi(decoded)))
    ) {
      w.lastWorkingAt = now;
    }

    // Teammate lifecycle bookkeeping (heuristic Claude panes). Must run
    // BEFORE the turn-stopped handlers: a "1 teammate started" line and the
    // main turn's progress-clear can land in the same chunk. The 16-char
    // slack biases boundary errors toward double counting (a delayed alert)
    // instead of a lost "started" (a false finish).
    if (w.runtime === "claude" && !programOwned && !hookOwned) {
      const tm = countTeammateEvents(plain, Math.max(0, fresh - 16), { preStripped: true });
      if (tm.started || tm.finished) {
        w.teammatesActive = Math.max(0, w.teammatesActive + tm.started - tm.finished);
        tanLog(`pane=${w.paneId} teammates ${tm.started}+/${tm.finished}- -> ${w.teammatesActive}`);
      }
    }

    if (!programOwned) {
      // Structured busy/idle signals (opt-in Claude Code settings).
      for (const m of newMatches(OSC9_PROGRESS_G, text, carryLen)) {
        const state = m[1] ?? "";
        if (state === "" || state === "0") {
          heuristicIdle(w, now, "progress cleared", 0, STRUCTURED_IDLE_SETTLE_MS);
        } else {
          w.codexAwaitingIdle = false;
          enterWorking(w, now);
          chunkAssertedWorking = true;
        }
      }
      for (const m of newMatches(OSC21337_G, text, carryLen)) {
        const status = /(?:^|;)status=([^;]*)/.exec(m[1] ?? "")?.[1] ?? "";
        if (/working/i.test(status)) {
          w.codexAwaitingIdle = false;
          enterWorking(w, now);
          chunkAssertedWorking = true;
        } else if (/waiting/i.test(status) && w.runtime === "claude") {
          if (!hookOwned || w.pendingToolCalls > 0) needsYou(w, now, w.lastToolDetail ? `Permission for ${w.lastToolDetail}` : null, "tab status waiting");
        } else if (/idle/i.test(status)) {
          heuristicIdle(w, now, "tab status idle", 0, STRUCTURED_IDLE_SETTLE_MS);
        }
      }
    }

    const problem = detectTerminalProblem(plain, fresh);
    const applyProblem =
      problem !== null && !(problem.kind === "blocked" && w.runtime !== "claude");
    if (applyProblem && problem) {
      const priorState = w.state;
      const shouldAlert = priorState !== problem.kind && (priorState === "working" || turnActive(w));
      if (w.runtime === "codex") {
        w.codexAwaitingIdle = true;
        w.codexScreen?.markCompleted();
      }
      w.state = problem.kind;
      emitPaneState(w, problem.kind === "failed" ? "error" : "blocked");
      if (shouldAlert && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS && !w.replayingTail) {
        // A positive new outcome, not the tail of a prior completion.
        rearm(paneSourceKey(w.paneId));
        if (problem.kind === "failed") closeTurnSilently(w, now, "hard failure banner");
        else cancelPendingDone(w, "credential banner");
        deliver(w, problem.kind, { body: problem.body });
      }
    }

    // Only pattern matches that END in the freshly arrived bytes count.
    const cls =
      applyProblem || w.codexScreen || programOwned
        ? null
        : classifyTail(w.runtime, plain, fresh, { preStripped: true });
    if (cls === "blocked" && (w.runtime === "claude" || w.runtime === "pi")) {
      // With hooks, a permission dialog exists only while a tool call waits;
      // anything else that matches is transcript text that looks like one.
      if (!hookOwned || w.pendingToolCalls > 0) {
        if (w.state !== "blocked") tanLog(`pane=${w.paneId} screen shows a prompt (was ${w.state})`);
        needsYou(w, now, hookOwned && w.lastToolDetail ? `Permission for ${w.lastToolDetail}` : null, "screen prompt");
      }
    } else if (cls === "working") {
      enterWorking(w, now);
      chunkAssertedWorking = true;
    } else if (cls === "idle") {
      if (hookOwned) {
        hookScreenIdle(w, now);
      } else {
        w.completedTurnPending = true;
        heuristicIdle(w, now, "idle frame", HEURISTIC_IDLE_CONFIRM_MS);
      }
    } else if (cls === "done") {
      // Positive session end line ("Session ended."). Any teammate
      // bookkeeping dies with the session.
      w.teammatesActive = 0;
      const wasWorking = w.state === "working";
      w.state = "idle";
      emitPaneState(w, "idle");
      if (wasWorking && !hasTrustedSignals(w) && workedLongEnough(w) && now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS) {
        requestDone(w, { origin: "heuristic", delayMs: 0 });
      }
    }

    w.lastChunkAssertedWorking = chunkAssertedWorking;

    // Agent exit: the shell prompt is back, the TUI left the alt screen, or
    // Pi printed the resume line it writes on an interactive quit.
    const promptReturned =
      newMatches(w.runtime === "pi" ? PI_PROMPT_MARKER_G : PROMPT_MARKER_G, text, carryLen).length > 0;
    const leftAltScreen = text.indexOf(ALT_SCREEN_LEAVE, Math.max(0, carryLen - ALT_SCREEN_LEAVE.length + 1)) !== -1;
    const piQuit = w.runtime === "pi" && newMatches(PI_EXIT_LINE_G, plain, fresh).length > 0;
    if (promptReturned || (leftAltScreen && !w.codexScreen) || piQuit) {
      markAgentExited(w, now, piQuit ? "pi exit line" : "prompt marker / alt-screen leave");
    }
    // Codex also leaves the alternate screen when closing transcript views;
    // its process exit or a shell prompt marker confirms when the agent left.
  }

  w.carry = text.slice(-CARRY_MAX);
}

function scanCodexTitle(w: PaneWatcher, text: string, carryLen: number, now: number): void {
  for (const m of newMatches(OSC_TITLE_G, text, carryLen)) {
    const blocked = CODEX_ACTION_REQUIRED_RE.test(m[1] ?? "");
    if (blocked === w.codexTitleBlocked) continue;
    w.codexTitleBlocked = blocked;
    if (blocked) {
      if (!w.signals.programStatus) needsYou(w, now, "Wants your approval to continue.", "title Action Required");
    } else if (!w.signals.programStatus) {
      promptResolved(w, now);
    }
  }
}

// An idle frame in a pane whose turns come from hooks. The chip follows only
// when the user just interrupted; otherwise the Stop hook decides, and the
// sweep settles a turn that ended without one. The turn itself is left to the
// Stop hook even after an interrupt key: Claude sends no Stop for a turn the
// user stopped, and an Esc that only closed a menu is followed by a real Stop
// that may land after this frame.
function hookScreenIdle(w: PaneWatcher, now: number): void {
  if (!turnActive(w) && !w.hookFollowUp) {
    if (w.state === "working" || w.state === "blocked") {
      w.state = "idle";
      emitPaneState(w, "idle");
    }
    return;
  }
  if (interruptedThisTurn(w, now) && w.pendingDone === null) {
    if (w.state !== "idle") tanLog(`pane=${w.paneId} idle after an interrupt key; the Stop hook decides the turn`);
    w.hookFollowUp = false;
    w.state = "idle";
    emitPaneState(w, "idle");
    return;
  }
  w.screenIdleSince ??= now;
}

// A screen or stream signal that the turn is over, in a pane with no trusted
// source. The idle state must hold for `confirmMs` without a working frame.
// `confirmMs` both delays the announcement and requires a real working phase
// first; `settleMs` only delays it, and resumed work cancels it meanwhile.
function heuristicIdle(w: PaneWatcher, now: number, why: string, confirmMs: number, settleMs = 0): void {
  if (w.teammatesActive > 0) {
    tanLog(`pane=${w.paneId} ${why} held: ${w.teammatesActive} teammate(s) running`);
    // A blocked chip stays blocked; a pending prompt is the actionable cue.
    if (w.state !== "blocked") emitPaneState(w, "working");
    return;
  }
  const finished = w.state === "working";
  if (w.state !== "failed") w.state = "idle";
  if (w.runtime === "codex") {
    w.codexAwaitingIdle = true;
    w.codexScreen?.markCompleted();
  }
  emitPaneState(w, "idle");
  if (!finished || hasTrustedSignals(w)) return;
  if (now - w.lastOscNotifyAt < OSC_NOTIFY_MUTE_MS) return;
  if (confirmMs > 0 && !workedLongEnough(w)) return;
  if (interruptedThisTurn(w, now)) {
    closeTurnSilently(w, now, "interrupted by the user");
    return;
  }
  requestDone(w, { origin: "heuristic", delayMs: Math.max(confirmMs, settleMs) });
}

// The foreground agent handed control back to the shell, seen either in the
// stream (prompt marker, alt-screen leave) or in the process tree.
function markAgentExited(w: PaneWatcher, now: number, reason: string): void {
  tanLog(`pane=${w.paneId} agent exited (${reason}); state was ${w.state}`);
  // A turn that was still mid-work when the TUI vanished ended somehow;
  // surface it. The user quitting the agent themselves is watching the pane.
  if (
    w.state === "working" &&
    turnActive(w) &&
    workedLongEnough(w) &&
    now - w.lastOscNotifyAt >= OSC_NOTIFY_MUTE_MS
  ) {
    requestDone(w, { origin: "explicit", body: "The agent exited.", delayMs: 0 });
  }
  // Emit while w.runtime is still set so the payload names the agent, then
  // reset lastEmittedState so a relaunch re-emits "launching".
  emitPaneState(w, "done");
  w.lastEmittedState = null;
  w.runtime = null;
  resetAgentSession(w);
  w.agentProcSeen = false;
  w.agentProcGone = false;
  w.lastAgentProcCheckAt = 0;
  w.ring = "";
}

function clearCodexScreen(w: PaneWatcher): void {
  w.codexScreen?.dispose();
  w.codexScreen = null;
  w.codexIdleSince = null;
  w.codexAwaitingIdle = false;
  w.codexTitleBlocked = false;
}

// Recover missed launches even when an idle agent emits no more output, and
// return true once a previously seen agent is gone. A process proves
// presence, never busy state.
function checkAgentProcess(w: PaneWatcher, now: number): boolean {
  if (w.agentProcGone) {
    w.agentProcGone = false;
    return true;
  }
  if (w.agentProcCheckInflight) return false;
  if (now - w.lastAgentProcCheckAt < AGENT_PROC_RECHECK_MS) return false;
  w.lastAgentProcCheckAt = now;
  const rootPid = pty.sessionPid(w.paneId);
  if (rootPid === null) return false;
  const runtime = w.runtime;
  w.agentProcCheckInflight = true;
  void descendantProcessesWithCommands(rootPid, PROCESS_LIST_MAX_AGE_MS)
    .then((below) => {
      if (
        below === null ||
        watchers.get(w.paneId) !== w ||
        w.disposing ||
        pty.sessionPid(w.paneId) !== rootPid ||
        w.runtime !== runtime
      ) return;
      if (!runtime) {
        // Prefer the outer agent over a different CLI it launched as a worker.
        for (const proc of [...below].sort((a, b) => a.depth - b.depth)) {
          const detected = runtimeFromProcessCommand(proc.command);
          if (!detected) continue;
          identifyRuntime(w, detected, "process tree");
          w.agentProcSeen = true;
          emitPaneState(w, "idle");
          if (detected === "codex") {
            const dimensions = pty.sessionDimensions(w.paneId);
            const recent = pty.readTailChunks(w.paneId, BOOTSTRAP_TAIL_BYTES) ?? [];
            if (dimensions && recent.length > 0) {
              w.codexScreen = new CodexTerminalScreen(dimensions.cols, dimensions.rows, () => {
                w.codexAwaitingIdle = false;
              });
              for (const chunk of recent) w.codexScreen.write(chunk);
            }
          }
          return;
        }
        return;
      }
      const present = below.some((proc) => runtimeFromProcessCommand(proc.command) === runtime);
      if (present) {
        if (!w.agentProcSeen) tanLog(`pane=${w.paneId} ${runtime} process seen under pid ${rootPid}`);
        w.agentProcSeen = true;
        // A restored runtime hint can bypass banner discovery entirely.
        if (w.lastEmittedState === null) {
          emitPaneState(w, w.state === "failed" ? "error" : w.state);
        }
      } else if (w.agentProcSeen) {
        w.agentProcGone = true;
      }
    })
    .catch(() => undefined)
    .finally(() => {
      w.agentProcCheckInflight = false;
    });
  return false;
}

// Codex's desktop notifications for an approval, a plan or a question
// (tui.notifications). Everything else it sends is a finished turn.
const CODEX_PROMPT_NOTIFY_RE = /^(?:approval requested\b|codex wants to\b|plan mode prompt\b|question:)/i;

// An explicit OSC 9/777 from the foreground program. In an agent pane with a
// trusted source the structured signal already covers the same moment.
// "Claude is waiting for your input" is Claude Code's idle reminder, sent a
// minute after the turn ended, not a permission prompt.
function handleExplicitNotify(w: PaneWatcher, message: string): void {
  const now = Date.now();
  const kind = /waiting\s*for\s*your\s*input/i.test(message)
    ? ("done" as const)
    : (w.runtime === "claude" &&
          /approv|permission|review|needs|attention|confirm|waiting|input/i.test(message)) ||
        (w.runtime === "codex" && CODEX_PROMPT_NOTIFY_RE.test(message))
      ? ("blocked" as const)
      : ("done" as const);
  if (w.runtime !== null && hasTrustedSignals(w)) {
    tanLog(`pane=${w.paneId} explicit notification left to the structured source`);
    return;
  }
  if (kind === "done" && w.teammatesActive > 0) {
    tanLog(`pane=${w.paneId} explicit done held: ${w.teammatesActive} teammate(s) running`);
    if (w.state !== "blocked") emitPaneState(w, "working");
    return;
  }
  if (kind === "blocked") {
    w.state = "blocked";
  } else {
    w.state = "idle";
    if (w.runtime === "codex") {
      w.codexAwaitingIdle = true;
      w.codexScreen?.markCompleted();
    }
    w.teammatesActive = 0;
  }
  emitPaneState(w, kind === "blocked" ? "blocked" : "idle");
  if (w.replayingTail) return;
  if (w.runtime === null && !/\b(?:claude|codex|grok)\b/i.test(message)) {
    // A plain program's notification is shown the way a terminal would.
    w.lastOscNotifyAt = now;
    rearm(paneSourceKey(w.paneId));
    deliver(w, kind === "blocked" ? "blocked" : "done", { body: message || null, plain: true });
    return;
  }
  // Agent CLIs can emit a ready/waiting notification while their opening
  // screen paints. Without a submitted turn there is nothing to announce.
  if (!turnActive(w)) {
    tanLog(`pane=${w.paneId} explicit notification outside a turn, no alert`);
    return;
  }
  const isAgentIdleEcho = kind === "done" && /waiting\s*for\s*your\s*input/i.test(message);
  if (isAgentIdleEcho && !workedLongEnough(w)) {
    tanLog(`pane=${w.paneId} idle echo without a turn since last input, no alert`);
    return;
  }
  w.lastOscNotifyAt = now;
  if (kind === "blocked") {
    deliver(w, "blocked", { body: message || null });
    return;
  }
  requestDone(w, { origin: "explicit", body: isAgentIdleEcho ? null : message, delayMs: 0 });
}

function runtimeLabel(runtime: PublicAgentRuntime | null): string {
  if (runtime === "claude") return "Claude Code";
  if (runtime === "codex") return "Codex";
  if (runtime === "grok") return "Grok";
  if (runtime === "pi") return "Pi";
  return "Terminal";
}

// Push a translated chip RuntimeState to the renderer, focus-independent. The
// chip must update even while the user is looking elsewhere (the case where
// the renderer's own poller is frozen). Dedup on lastEmittedState.
function emitPaneState(w: PaneWatcher, chipState: RuntimeState): void {
  if (w.excluded) return;
  if (w.lastEmittedState === chipState) return;
  w.lastEmittedState = chipState;
  noteActivity(w, { stateSince: Date.now() });
  tanLog(`pane=${w.paneId} chip-state -> ${chipState} (runtime=${w.runtime})`);
  emitTerminalAgentState({
    workspaceId: w.workspaceId,
    tabId: w.tabId,
    paneId: w.paneId,
    runtime: w.runtime,
    state: chipState,
  });
}

// Where the renderer last placed a user pane, whether or not an agent in it
// ever reported a state. Survives a window reload, after which the renderer no
// longer holds the layouts of workspaces it has not reopened. Cora worker
// panes stay unplaced: their run decides where their calls go.
export function terminalPanePlacement(paneId: string): { workspaceId: string; tabId: string } | null {
  const watcher = watchers.get(paneId);
  if (!watcher || watcher.disposing || watcher.excluded) return null;
  return { workspaceId: watcher.workspaceId, tabId: watcher.tabId };
}

// Level-triggered companion to the live terminal-agent:state event, for
// renderer reloads and cold hydration.
export function manualTerminalPaneIds(): Set<string> {
  return new Set([...watchers.values()].filter((w) => !w.excluded && !w.disposing).map((w) => w.paneId));
}

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

function compactDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 10_000) return null;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Publish a turn-boundary alert into the unified pipeline. Suppression (the
// user looking at the pane, same-kind repeats) is the notify policy's job.
function deliver(
  w: PaneWatcher,
  kind: "done" | "blocked" | "failed",
  detail: {
    body?: string | null;
    durationMs?: number | null;
    backgroundRunning?: number;
    followUp?: boolean;
    plain?: boolean;
  } = {},
): void {
  if (w.excluded) return;
  if (w.replayingTail) {
    tanLog(`pane=${w.paneId} replay suppressed alert kind=${kind}`);
    return;
  }
  tanLog(`pane=${w.paneId} ALERT kind=${kind} runtime=${w.runtime} ws=${w.workspaceId} tab=${w.tabId}`);
  const label = detail.plain ? "Terminal" : runtimeLabel(w.runtime);
  const where = w.tabTitle ? ` · ${w.tabTitle}` : "";
  const status =
    kind === "done"
      ? detail.followUp
        ? "finished background work"
        : "finished"
      : kind === "failed"
        ? "stopped"
        : "needs you";
  const parts: string[] = [];
  if (detail.body) parts.push(detail.body);
  else if (kind === "done") parts.push(detail.followUp ? "Its background tasks are done." : "Finished its turn.");
  else if (kind === "blocked") parts.push("Waiting for your answer.");
  else parts.push("Stopped unexpectedly.");
  if (kind === "done") {
    const duration = compactDuration(detail.durationMs);
    if (duration) parts.push(`took ${duration}`);
    const running = detail.backgroundRunning ?? 0;
    if (running > 0) parts.push(`${running} background task${running === 1 ? "" : "s"} still running`);
  }
  publish({
    kind:
      kind === "done"
        ? "terminal.agent.done"
        : kind === "failed"
          ? "terminal.agent.failed"
          : "terminal.agent.needs-input",
    sourceKey: paneSourceKey(w.paneId),
    // A prompt reads amber, a finished turn green, an explicit failure red.
    tone: kind === "done" ? "success" : kind === "failed" ? "danger" : "warning",
    title: `${label} ${status}${where}`,
    ...(w.workspaceName ? { workspaceName: w.workspaceName } : {}),
    body: parts.join(" · "),
    soundKind: kind === "done" ? "done" : "needs-you",
    target: { type: "terminal", workspaceId: w.workspaceId, tabId: w.tabId, paneId: w.paneId },
  });
  // A finished turn is when the subscription quota actually moved.
  nudgeUsageRefresh();
}

// What a pane keeps of an agent message for the board; it shows one line.
const ACTIVITY_TEXT_MAX = 4_000;

interface PaneActivity {
  stateSince: number;
  sessionSince: number;
  prompt: string | null;
  message: string | null;
  question: string | null;
  tool: string | null;
}

function emptyActivity(): PaneActivity {
  const now = Date.now();
  return { stateSince: now, sessionSince: now, prompt: null, message: null, question: null, tool: null };
}

function noteActivity(w: PaneWatcher, patch: Partial<PaneActivity>): void {
  w.activity = { ...w.activity, ...patch };
  if (!w.excluded) signalAgentBoardChanged();
}

// Every user pane hosting an agent, for the rail's Agents view. Cora worker
// panes are left out: their runs stand for them. Accounts are filled in by
// agent-board.ts, which owns the pty lookups.
export function terminalAgentActivitySnapshot(): TerminalAgentActivity[] {
  const out: TerminalAgentActivity[] = [];
  for (const w of watchers.values()) {
    if (w.excluded || w.disposing || !w.runtime) continue;
    const state = w.lastEmittedState ?? "launching";
    const active = state === "working" || state === "blocked" || state === "stalled";
    out.push({
      paneId: w.paneId,
      workspaceId: w.workspaceId,
      tabId: w.tabId,
      tabTitle: w.tabTitle,
      runtime: w.runtime,
      state,
      stateSince: w.activity.stateSince,
      sessionSince: w.activity.sessionSince,
      turnStartedAt: w.turn && !w.turn.announced ? w.turn.startedAt : null,
      tool: active ? w.activity.tool : null,
      prompt: w.activity.prompt,
      message: summarizeAgentMessage(w.activity.message),
      question: state === "blocked" ? w.activity.question : null,
      accountProfileId: null,
    });
  }
  return out;
}

// Test/maintenance escape hatch: drop every watcher. Safe to call repeatedly.
export function disposeAllTerminalAgentWatchers(): void {
  for (const paneId of [...watchers.keys()]) removeWatcher(paneId);
}
