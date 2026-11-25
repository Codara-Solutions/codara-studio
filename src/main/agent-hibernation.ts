// Agent hibernation, main side: stop a finished, untouched agent terminal to
// give its memory back, and let the renderer resume it (`--resume`) when the
// user asks for it (the pane's Resume button, Enter in the pane).
//
// The renderer nominates panes (src/renderer/src/lib/agentHibernation.ts): it
// knows which pane has the keyboard focus (never nominated), which panes are
// pinned awake and which session each pane can resume. Main decides. It
// re-checks everything it can see itself and stops the pane only when all of
// these hold:
//   - the setting is on for the pane's workspace (its own time, or the
//     global one) and the pane is a local PTY that still exists, and no
//     paired phone has it open (Remote Access);
//   - the terminal agent notifier says the agent's turn ended, nothing is
//     pending, it is not waiting on the user and no typed text is unsent;
//   - nothing happened in the pane for the idle time (the setting's, or a
//     shorter one while the computer is low on memory): no input, no output,
//     and the user did not show or touch it (noteAgentPanesTouched). When
//     the agent reports its state through hooks or program status and that
//     state has not moved since it settled, its output is the TUI repainting
//     (Claude Code's status line) and does not count; the settle does;
//   - the pane's process tree is only the shell, the agent and what the agent
//     started at boot (agent-hibernation-census.ts), so no dev server, watcher
//     or tool command can be caught in the stop;
//   - Antigravity only: the agy process holds exactly the conversation the
//     pane will reopen, and agy marks neither it nor a subagent under it as
//     working (antigravity-presence.ts). agy's screen alone proves too little.
// Anything unclear refuses. The renderer simply asks again on its next tick.
// Every verdict lands in <codaraHome>/logs/main.log once per change.

import { latestSessionStart } from "./agent-session-registry";
import {
  antigravityActivityVerdict,
  antigravitySleepVerdict,
  isAntigravityConversationId,
  type AntigravitySleepVerdict,
} from "./antigravity-presence";
import { currentAntigravityConversations } from "./session-search/antigravity-summaries";
import { describeSleepingAgent } from "./agent-sleep-summary";
import { E2E_BACKGROUND } from "./e2e-background";
import { logMain } from "./file-log";
import type { IpcHandle } from "./ipc";
import * as pty from "./pty-manager";
import { loadPreferences } from "./preferences-store";
import { readAvailableMemory } from "./system-metrics";
import {
  terminalAgentActivitySnapshot,
  terminalAgentHibernationEvidence,
  terminalPanePlacement,
} from "./terminal-agent-notify";
import { studioPaneWatchedFromPhone } from "./remote-access/studio-terminal-share";
import {
  classifyPaneProcessTree,
  listCensusProcesses,
  listPaneTerminalPids,
  readTreeMemoryBytes,
  type CensusProcess,
} from "./agent-hibernation-census";
import {
  idleMsUnderPressure,
  isAgentHibernationRuntime,
  judgeAgentEvidence,
  judgeIdleClock,
  nextMemoryLevel,
  normalizeAgentHibernationMinutes,
  normalizeAgentHibernationWorkspaces,
  outputRestartsIdleClock,
  policyIdleMs,
  validSleepSummary,
  type AgentMemoryLevel,
  type AgentHibernationEvidence,
  type AgentHibernationPolicy,
  type AgentHibernationPlacement,
  type AgentHibernationRequest,
  type AgentHibernationResult,
  type AgentRestoredAsleepPane,
  type AgentSleepingPane,
  type AgentSleepingSession,
  type AgentSleepSummary,
} from "@shared/agent-hibernation";

const MINUTE_MS = 60_000;
// How often the renderer looks for candidates. Hibernation is measured in
// tens of minutes, so a minute of lag costs nothing.
const DEFAULT_TICK_MS = 60_000;
// The CLI gets this long after SIGHUP to write its transcript before the
// tree is force-killed, the same grace an account switch gives.
const STOP_GRACE_MS = 3_000;
// A pane the census kept awake (a dev server, a late child, a listing that
// could not be read) usually stays that way for a while. Listing every
// process on the machine again on each tick costs a `ps` per such pane per
// minute, and on Windows a PowerShell CIM query, so the census verdict is
// reused for this many ticks, for the same process generation only.
const CENSUS_BACKOFF_TICKS = 5;
// What the pane printed is kept for the sleeping pane to show when its view
// mounts again with an empty xterm (the stop drops pty-manager's tail and
// backlog). Bounded per pane; the newest output wins.
const MAX_SLEEPING_OUTPUT_BYTES = 2 * 1024 * 1024;
// A pane restored asleep at launch is known to main before the renderer has
// placed it (terminalPanePlacement); it is not dropped for that meanwhile.
const RESTORED_PLACEMENT_GRACE_MS = 120_000;
// The card's line is read from the transcript after the stop; the stop never
// waits on it longer than this.
const SUMMARY_TIMEOUT_MS = 1_500;
// Memory is read at most this often; the level keeps between reads.
const MEMORY_READ_MS = 15_000;
// Reading what the pane's processes hold (agent-hibernation-census.ts) is a
// few /proc reads; the sleep never waits on it longer than this.
const TREE_MEMORY_TIMEOUT_MS = 2_000;
// Sleep now on an agent known only from its screen: this long without output.
const MANUAL_QUIET_MS = 5_000;

export interface AgentHibernationDeps {
  now: () => number;
  policy: () => Promise<AgentHibernationPolicy>;
  session: (paneId: string) => pty.HibernationSessionInfo | null;
  evidence: (paneId: string) => AgentHibernationEvidence | null;
  // Which workspace the pane is in, as the renderer last reported it.
  placement?: (paneId: string) => { workspaceId: string } | null;
  listProcesses: () => Promise<CensusProcess[] | null>;
  // Every process holding the pane's terminal (POSIX tty, Windows console).
  terminalPids: (pane: { pid: number; ttyPath: string | null }) => Promise<number[] | null>;
  // What these processes hold in memory, for a listing without a memory
  // column (POSIX); null when it cannot be read for all of them.
  treeMemory?: (pids: readonly number[]) => Promise<number | null>;
  stop: (paneId: string, generationId: string) => Promise<boolean>;
  log: (line: string) => void;
  // A paired phone has the pane open (Remote Access): it is on a screen.
  watchedOnPhone?: (paneId: string) => boolean;
  // What the pane printed, kept for its sleeping view (see pty.sleepOutput).
  sleepOutput?: (paneId: string) => { tail: Buffer | null; unsent: Buffer | null } | null;
  // The card's line. Called before the stop, while the notifier still holds
  // the session's last prompt; awaited after it.
  describe?: (
    paneId: string,
    runtime: AgentHibernationRequest["runtime"],
    probedTranscriptPath: string | null,
    conversationId?: string | null,
  ) => Promise<AgentSleepSummary | null>;
  // Antigravity: may the agy process the census found be stopped for the
  // pane to reopen `conversationId`? (antigravity-presence.ts)
  // otherPids: every other process the stop would end, none of which may
  // hold an agy conversation.
  antigravity?: (
    agentPid: number,
    agentCommand: string,
    conversationId: string | undefined,
    otherPids: readonly number[],
  ) => Promise<AntigravitySleepVerdict>;
  // Antigravity: agy's busy flags for the conversation, read synchronously
  // as the last thing before the stop.
  antigravityActivity?: (conversationId: string) => AntigravitySleepVerdict;
}

// e2e only: the suite cannot wait half an hour. Honored only when the app
// was launched by the e2e runner (SPARK_E2E_BACKGROUND=1).
function e2eOverrideMs(name: string): number | null {
  if (!E2E_BACKGROUND) return null;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function e2eMemoryLevel(): AgentMemoryLevel | null {
  if (!E2E_BACKGROUND) return null;
  const value = process.env.CODARA_E2E_MEMORY_LEVEL;
  return value === "ok" || value === "low" || value === "critical" ? value : null;
}

let memoryLevel: AgentMemoryLevel = "ok";
let memoryReadAt = 0;
let memoryRead: Promise<AgentMemoryLevel> | null = null;

async function currentMemoryLevel(now: number): Promise<AgentMemoryLevel> {
  const forced = e2eMemoryLevel();
  if (forced) return forced;
  if (now - memoryReadAt < MEMORY_READ_MS) return memoryLevel;
  memoryRead ??= readAvailableMemory()
    .catch(() => null)
    .then((reading) => {
      const next = nextMemoryLevel(memoryLevel, reading);
      if (next !== memoryLevel) {
        const share = reading ? Math.round((reading.availableBytes / reading.totalBytes) * 100) : null;
        logMain("agent-hibernation", `memory ${memoryLevel} -> ${next}${share === null ? "" : ` (${share}% available)`}`);
      }
      memoryLevel = next;
      memoryReadAt = Date.now();
      return next;
    })
    .finally(() => {
      memoryRead = null;
    });
  return memoryRead;
}

// Read through loadPreferences, never a possibly cold cache: a cold cache
// answers with the default (on) for a user who turned the setting off.
export async function currentHibernationPolicy(): Promise<AgentHibernationPolicy> {
  const prefs = await loadPreferences();
  const minutes = normalizeAgentHibernationMinutes(prefs.agentHibernationMinutes);
  const exceptions = Object.entries(normalizeAgentHibernationWorkspaces(prefs.agentHibernationWorkspaces));
  if (minutes === 0 && !exceptions.some(([, own]) => own > 0)) {
    const workspaceIdleMs = Object.fromEntries(exceptions.map(([workspaceId]) => [workspaceId, 0]));
    return { idleMs: 0, workspaceIdleMs, tickMs: DEFAULT_TICK_MS, memoryLevel: "ok" };
  }
  const tickMs = e2eOverrideMs("CODARA_E2E_HIBERNATION_TICK_MS") ?? DEFAULT_TICK_MS;
  // The memory is not read at all with the preference off.
  const level = prefs.agentHibernationSoonerWhenLow === false ? "ok" : await currentMemoryLevel(Date.now());
  const override = e2eOverrideMs("CODARA_E2E_HIBERNATION_IDLE_MS");
  const pressure = e2eOverrideMs("CODARA_E2E_HIBERNATION_PRESSURE_IDLE_MS");
  const idleFor = (own: number): number =>
    own > 0
      ? idleMsUnderPressure(override ?? own * MINUTE_MS, level, pressure ? { low: pressure, critical: pressure } : undefined)
      : 0;
  return {
    idleMs: idleFor(minutes),
    workspaceIdleMs: Object.fromEntries(exceptions.map(([workspaceId, own]) => [workspaceId, idleFor(own)])),
    tickMs,
    memoryLevel: level,
  };
}

/** Tests only: forget the memory level read so far. */
export function resetMemoryLevelForTests(level: AgentMemoryLevel = "ok"): void {
  memoryLevel = level;
  memoryReadAt = 0;
  memoryRead = null;
}

// The rail note module pulls in the workspace status store; it is loaded only
// when a pane actually goes to sleep.
async function paneAgentNote(paneId: string): Promise<string | null> {
  try {
    const { paneAgentNote: read } = await import("./workspace-status");
    return read(paneId);
  } catch {
    return null;
  }
}

function antigravityConversationTitle(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return currentAntigravityConversations()?.find((item) => item.id === conversationId)?.title || null;
}

function describePane(
  paneId: string,
  runtime: AgentHibernationRequest["runtime"],
  probedTranscriptPath: string | null,
  conversationId?: string | null,
): Promise<AgentSleepSummary | null> {
  // Read now, before the stop: the notifier forgets the session's last prompt
  // once the agent is gone.
  const activity = terminalAgentActivitySnapshot().find((entry) => entry.paneId === paneId) ?? null;
  const start = latestSessionStart(paneId);
  // A session resumed without a SessionStart on record (hooks off, an older
  // CLI) still has the transcript the renderer's resume probe found.
  const transcriptPath = (start && start.runtime === runtime ? start.transcriptPath : null) ?? probedTranscriptPath;
  return paneAgentNote(paneId).then((agentNote) =>
    describeSleepingAgent({
      runtime,
      transcriptPath,
      notifierPrompt: activity?.prompt ?? null,
      agentNote,
      tabTitle: activity?.tabTitle ?? null,
      conversationTitle: runtime === "antigravity" ? antigravityConversationTitle(conversationId) : null,
    }),
  );
}

// Agrees with the card, which shows no figure unless some memory was freed.
function formatMb(bytes: number | null): string {
  return typeof bytes === "number" && bytes > 0 ? `${Math.round(bytes / (1024 * 1024))} MB` : "unknown";
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const defaultDeps: AgentHibernationDeps = {
  now: () => Date.now(),
  policy: currentHibernationPolicy,
  session: (paneId) => pty.hibernationSessionInfo(paneId),
  evidence: (paneId) => terminalAgentHibernationEvidence(paneId),
  placement: (paneId) => terminalPanePlacement(paneId),
  listProcesses: () => listCensusProcesses(),
  terminalPids: (pane) => listPaneTerminalPids(pane),
  treeMemory: (pids) => readTreeMemoryBytes(pids),
  stop: (paneId, generationId) => pty.hibernate(paneId, generationId, STOP_GRACE_MS),
  log: (line) => logMain("agent-hibernation", line),
  watchedOnPhone: (paneId) => studioPaneWatchedFromPhone(paneId),
  sleepOutput: (paneId) => pty.sleepOutput(paneId, MAX_SLEEPING_OUTPUT_BYTES),
  describe: describePane,
  antigravity: (agentPid, agentCommand, conversationId, otherPids) =>
    antigravitySleepVerdict(agentPid, agentCommand, conversationId, undefined, otherPids),
  antigravityActivity: (conversationId) => antigravityActivityVerdict(conversationId),
};

// The decision running for each pane. A timer's request that finds one is
// refused (it asks again next tick); Sleep now waits for it instead.
const inFlight = new Map<string, Promise<AgentHibernationResult>>();
// Panes this run put to sleep: the agent each held, when, and what the pane
// printed (its newest raw output, and what a paused view never received). A
// pane leaves the list when it is seen running again or closed
// (sleepingEntry), and at the first exit after it woke (forgetAtNextExit),
// so a woken pane whose shell later ends is never taken for a sleeping one.
interface SleepingEntry {
  runtime: AgentHibernationRequest["runtime"];
  sleptAt: number;
  tail: Buffer | null;
  unsent: Buffer | null;
  summary: AgentSleepSummary | null;
  freedBytes: number | null;
  session: AgentSleepingSession | null;
  // Restored asleep at launch: kept without a placement until this time.
  placementGraceUntil: number;
  offExit: (() => void) | null;
}
const sleeping = new Map<string, SleepingEntry>();

function forget(paneId: string, entry: SleepingEntry): void {
  if (sleeping.get(paneId) === entry) sleeping.delete(paneId);
  try {
    entry.offExit?.();
  } catch {
    /* already gone */
  }
  entry.offExit = null;
}

// pty-manager's exit listeners are one-shot per exit. The stop's own exit
// (hibernated) re-arms for the next one, which can only be the end of the
// session that woke the pane.
function forgetAtNextExit(paneId: string, entry: SleepingEntry): void {
  entry.offExit = pty.onExit(paneId, (info) => {
    entry.offExit = null;
    if (sleeping.get(paneId) !== entry) return;
    if (info.hibernated === true) {
      forgetAtNextExit(paneId, entry);
      return;
    }
    forget(paneId, entry);
  });
}
// Census refusals per pane, reused until `until` while the pane keeps the
// same process generation (see CENSUS_BACKOFF_TICKS).
const censusBackoff = new Map<string, { generationId: string; until: number; result: AgentHibernationResult }>();
// The last verdict logged per pane, so a refusal repeated every tick is
// logged once (and again each VERDICT_RELOG_MS): when it was logged last, and
// since when the pane has been kept awake for that reason.
const lastLogged = new Map<string, { key: string; at: number; since: number }>();
const VERDICT_RELOG_MS = 60 * MINUTE_MS;
// When the user last showed or touched each pane (noteAgentPanesTouched).
const touchedAt = new Map<string, number>();

/** Tests only: forget every pane's in-memory hibernation state. */
export function resetAgentHibernationForTests(): void {
  inFlight.clear();
  for (const [paneId, entry] of [...sleeping]) forget(paneId, entry);
  censusBackoff.clear();
  lastLogged.clear();
  touchedAt.clear();
}

/**
 * The user showed or touched these panes (focus, a click, a scroll, a tab or
 * workspace switch onto them). Each counts as activity on the idle clock, so
 * a pane the user just reached is not stopped by a decision already running.
 */
export function noteAgentPanesTouched(paneIds: readonly string[], now = Date.now()): void {
  for (const paneId of paneIds) {
    if (typeof paneId === "string" && paneId.length > 0 && paneId.length <= 256) touchedAt.set(paneId, now);
  }
  if (touchedAt.size > 2_000) {
    // Panes come and go; keep the newest stamps only.
    const newest = [...touchedAt].sort((a, b) => b[1] - a[1]).slice(0, 1_000);
    touchedAt.clear();
    for (const [paneId, at] of newest) touchedAt.set(paneId, at);
  }
}

/**
 * The panes still asleep, for the quit census (src/main/index.ts): their
 * agent was stopped by Codara, not by the user, so the session must not be
 * dropped at the relaunch.
 */
export function sleepingAgentPanes(): Map<string, AgentHibernationRequest["runtime"]> {
  const out = new Map<string, AgentHibernationRequest["runtime"]>();
  for (const paneId of [...sleeping.keys()]) {
    const entry = sleepingEntry(paneId);
    if (entry) out.set(paneId, entry.runtime);
  }
  return out;
}

function sleepingEntry(paneId: string): SleepingEntry | null {
  const entry = sleeping.get(paneId);
  if (!entry) return null;
  const unplaced = !terminalPanePlacement(paneId) && Date.now() >= entry.placementGraceUntil;
  if (pty.hasSession(paneId) || unplaced) {
    forget(paneId, entry);
    return null;
  }
  return entry;
}

/**
 * True while Codara has this pane's agent stopped and nothing runs in the
 * pane. Text sent to it now would reach no process (agent delivery refuses
 * it instead of reporting it pasted).
 */
export function agentPaneAsleep(paneId: string): boolean {
  return sleepingEntry(paneId) !== null;
}

/**
 * How long a pane has had no input or output, in ms; null when it is not a
 * live or sleeping pane. A sleeping one counts from when it fell asleep,
 * the least it can have been quiet.
 */
export function paneIdleMs(paneId: string, now = Date.now()): number | null {
  const entry = sleepingEntry(paneId);
  if (entry) return Math.max(0, now - entry.sleptAt);
  const info = pty.hibernationSessionInfo(paneId);
  return info ? Math.max(0, now - Math.max(info.lastInputAt, info.lastOutputAt)) : null;
}

/**
 * For a pane that mounts while its agent sleeps: whether it does, since
 * when, and what to show. A view that kept its own copy of the output gets
 * only what it never received (once); a fresh view, an empty xterm after a
 * window reload, gets the pane's newest raw output, as a live pane's
 * reattach does. The leaf's own sleeping mark is runtime-only, so after a
 * reload this is the only record of it.
 */
export function takeSleepingPane(paneId: string, freshView = false): AgentSleepingPane | null {
  const entry = sleepingEntry(paneId);
  if (!entry) return null;
  const output = freshView ? entry.tail : entry.unsent;
  entry.unsent = null;
  // The size only: the output itself is the user's terminal content.
  logMain("agent-hibernation", `pane=${paneId} mounts asleep (${output?.byteLength ?? 0} bytes of output kept)`);
  return {
    runtime: entry.runtime,
    sleptAt: entry.sleptAt,
    // A copy with its own exact-size buffer: a view could carry the rest of
    // a pooled ArrayBuffer across IPC.
    output: output ? new Uint8Array(output) : null,
    summary: entry.summary,
    freedBytes: entry.freedBytes,
    session: entry.session,
  };
}

/**
 * A pane that was asleep when Codara quit comes back asleep: the renderer
 * mounts it with its card and no process, and tells main, so delivery, the
 * quit census and a window reload treat it as the sleeping pane it is.
 */
export function registerRestoredAsleep(input: unknown, now = Date.now()): boolean {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<AgentRestoredAsleepPane>;
  if (typeof value.paneId !== "string" || !value.paneId || value.paneId.length > 256) return false;
  if (!isAgentHibernationRuntime(value.runtime)) return false;
  if (pty.hasSession(value.paneId)) return false;
  const sleptAt = typeof value.sleptAt === "number" && Number.isFinite(value.sleptAt) ? value.sleptAt : now;
  const previous = sleeping.get(value.paneId);
  if (previous) forget(value.paneId, previous);
  const entry: SleepingEntry = {
    runtime: value.runtime,
    sleptAt,
    tail: null,
    unsent: null,
    summary: validSleepSummary(value.summary),
    freedBytes: null,
    // Restored from the layout, which has its pointer.
    session: null,
    placementGraceUntil: now + RESTORED_PLACEMENT_GRACE_MS,
    offExit: null,
  };
  sleeping.set(value.paneId, entry);
  forgetAtNextExit(value.paneId, entry);
  logMain("agent-hibernation", `pane=${value.paneId} ${value.runtime} restored asleep`);
  return true;
}

const PLACEMENTS: ReadonlySet<AgentHibernationPlacement> = new Set(["visible", "hidden-tab", "background-workspace"]);

// A plain, small JSON object: kept and handed back, never interpreted here.
const MAX_SLEEPING_SESSION_CHARS = 32 * 1024;

function validSleepingSession(value: unknown): AgentSleepingSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text.length > MAX_SLEEPING_SESSION_CHARS) return null;
    return JSON.parse(text) as AgentSleepingSession;
  } catch {
    return null;
  }
}

function validRequest(input: unknown): AgentHibernationRequest | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<AgentHibernationRequest>;
  if (typeof value.paneId !== "string" || value.paneId.length === 0 || value.paneId.length > 256) {
    return null;
  }
  if (!isAgentHibernationRuntime(value.runtime)) return null;
  if (!PLACEMENTS.has(value.placement as AgentHibernationPlacement)) return null;
  const transcriptPath =
    typeof value.transcriptPath === "string" && value.transcriptPath.length > 0 && value.transcriptPath.length <= 4096
      ? value.transcriptPath
      : undefined;
  const session = validSleepingSession(value.session);
  const conversationId = isAntigravityConversationId(value.conversationId) ? value.conversationId : undefined;
  return {
    paneId: value.paneId,
    runtime: value.runtime,
    placement: value.placement as AgentHibernationPlacement,
    ...(value.manual === true ? { manual: true } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(session ? { session } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

type Judged =
  | { ok: true; session: pty.HibernationSessionInfo }
  | { ok: false; result: AgentHibernationResult };

function judgeNow(request: AgentHibernationRequest, deps: AgentHibernationDeps, idleMs: number): Judged {
  const session = deps.session(request.paneId);
  if (!session) return { ok: false, result: { ok: false, reason: "no-session" } };
  if (session.remote || !(session.pid > 0)) return { ok: false, result: { ok: false, reason: "remote" } };
  if (deps.watchedOnPhone?.(request.paneId)) {
    return { ok: false, result: { ok: false, reason: "watched-on-phone" } };
  }
  // Without the id, waking would run `agy --continue`, which reopens agy's
  // latest conversation, not necessarily this pane's.
  if (request.runtime === "antigravity" && !request.conversationId) {
    return { ok: false, result: { ok: false, reason: "conversation-unknown", detail: "no conversation id" } };
  }
  const evidence = deps.evidence(request.paneId);
  const stateRefusal = judgeAgentEvidence(evidence, request.runtime);
  if (stateRefusal) {
    const detail = stateRefusal === "scheduled-work" ? evidence?.scheduledWork : null;
    return { ok: false, result: { ok: false, reason: stateRefusal, ...(detail ? { detail } : {}) } };
  }
  const now = deps.now();
  // Sleep now: the user asked for it, so how long the pane was quiet does
  // not matter; everything above and the census still do. An agent read
  // from its screen alone may have painted a working frame the patterns
  // missed: output in the last few seconds keeps it running.
  if (request.manual) {
    if (outputRestartsIdleClock(evidence)) {
      const lastOutput = Math.max(session.lastOutputAt, evidence?.lastOutputAt ?? 0);
      if (now - lastOutput < MANUAL_QUIET_MS) {
        const detail = `output ${Math.max(0, Math.round((now - lastOutput) / 1000))}s ago`;
        return { ok: false, result: { ok: false, reason: "recent-output", detail } };
      }
    }
    return { ok: true, session };
  }
  // The idle clock: the newest of these starts the idle period. With
  // structured evidence of a settled agent (outputRestartsIdleClock), the
  // pane's output is its TUI repainting and stays off the clock, and so does
  // the pty's raw input stamp, which also counts the terminal's own replies
  // to queries in that output; the notifier's input stamp counts only the
  // user's keys and Codara's sends.
  const withOutput = outputRestartsIdleClock(evidence);
  const stamps: Array<[string, number]> = [
    ["started", session.createdAt],
    ["agent input", evidence?.lastUserInputAt ?? 0],
    ["shown or touched", touchedAt.get(request.paneId) ?? 0],
    ...(withOutput
      ? ([
          ["pty input", session.lastInputAt],
          ["pty output", session.lastOutputAt],
          ["agent output", evidence?.lastOutputAt ?? 0],
        ] as Array<[string, number]>)
      : ([["agent state", evidence?.settledAt ?? 0]] as Array<[string, number]>)),
  ];
  const activityAt = stamps.map(([, at]) => at);
  const clockRefusal = judgeIdleClock({ now, idleMs, activityAt });
  if (clockRefusal === "not-idle-long-enough") {
    let newest = 0;
    for (let index = 1; index < activityAt.length; index += 1) {
      if (activityAt[index] > activityAt[newest]) newest = index;
    }
    const ago = Math.max(0, Math.round((now - activityAt[newest]) / 1000));
    const detail = `${stamps[newest][0]} ${ago}s ago, needs ${Math.round(idleMs / 1000)}s`;
    return { ok: false, result: { ok: false, reason: clockRefusal, detail } };
  }
  if (clockRefusal) return { ok: false, result: { ok: false, reason: clockRefusal } };
  return { ok: true, session };
}

// One line per change of verdict; a sleep or a failed stop always logs. The
// not-idle detail carries ages that change every tick, so only the reason
// counts as a change there. A pane kept awake for the same reason is logged
// again once an hour with the detail of the moment, so a pane that never
// sleeps says why in the log of any day, not only on the line that started it.
function noteVerdict(paneId: string, result: AgentHibernationResult, deps: AgentHibernationDeps, context: string): void {
  if (result.ok) {
    lastLogged.delete(paneId);
    deps.log(`pane=${paneId} ${context}`);
    return;
  }
  if (result.reason === "in-flight") return;
  const key = result.reason === "not-idle-long-enough" ? result.reason : `${result.reason}|${result.detail ?? ""}`;
  const now = deps.now();
  const previous = lastLogged.get(paneId);
  const same = previous?.key === key;
  if (result.reason !== "stop-failed" && same && now - previous.at < VERDICT_RELOG_MS) return;
  const since = same ? previous.since : now;
  lastLogged.set(paneId, { key, at: now, since });
  if (lastLogged.size > 2_000) lastLogged.clear();
  const parts = [
    result.detail,
    same && result.reason !== "stop-failed" ? `still, for ${Math.round((now - since) / MINUTE_MS)} min` : null,
  ].filter(Boolean);
  deps.log(`pane=${paneId} stays awake: ${result.reason}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`);
}

export async function hibernateAgentPane(
  input: unknown,
  deps: AgentHibernationDeps = defaultDeps,
): Promise<AgentHibernationResult> {
  const request = validRequest(input);
  if (!request) return { ok: false, reason: "bad-request" };
  if (request.manual) return sleepNow(request, deps);
  const policy = await deps.policy();
  const workspaceId = deps.placement?.(request.paneId)?.workspaceId ?? null;
  const idleMs = policyIdleMs(policy, workspaceId);
  if (!(idleMs > 0)) {
    // Off everywhere says nothing; a workspace set to Never while others
    // sleep is worth one line.
    if (!(policy.idleMs > 0)) return { ok: false, reason: "off" };
    const exempt: AgentHibernationResult = { ok: false, reason: "exempt", detail: `workspace ${workspaceId} never sleeps` };
    noteVerdict(request.paneId, exempt, deps, "");
    return exempt;
  }
  if (inFlight.has(request.paneId)) return { ok: false, reason: "in-flight" };
  return runDecision(request.paneId, async () => {
    const decided = await decide(request, deps, { ...policy, idleMs });
    const result = "result" in decided ? decided.result : decided;
    noteVerdict(request.paneId, result, deps, "context" in decided ? decided.context : "");
    return result;
  });
}

function runDecision(paneId: string, run: () => Promise<AgentHibernationResult>): Promise<AgentHibernationResult> {
  const running = run().finally(() => {
    if (inFlight.get(paneId) === running) inFlight.delete(paneId);
  });
  inFlight.set(paneId, running);
  return running;
}

/**
 * The pane toolbar's Sleep now: stop this pane's agent at once. No idle
 * clock, no idle-time setting and no rule about the pane being on screen,
 * but every refusal about the agent and the pane's processes stands, the
 * census is taken fresh, and each refusal is logged and handed back for the
 * pane to say in words.
 */
async function sleepNow(request: AgentHibernationRequest, deps: AgentHibernationDeps): Promise<AgentHibernationResult> {
  // Read before the in-flight check: nothing is awaited between that check
  // and registering this decision, so a timer request cannot slip in.
  const policy = await deps.policy();
  // A decision already running for the pane (the timer's) settles first; if
  // it put the pane to sleep, that is the answer.
  const running = inFlight.get(request.paneId);
  if (running) {
    const earlier = await running.catch(() => null);
    if (earlier?.ok) return earlier;
    if (inFlight.has(request.paneId)) return { ok: false, reason: "in-flight" };
  }
  return runDecision(request.paneId, async () => {
    const decided = await decide(request, deps, policy);
    const result = "result" in decided ? decided.result : decided;
    if (result.ok) {
      lastLogged.delete(request.paneId);
      deps.log(`pane=${request.paneId} ${"context" in decided ? decided.context : ""}`);
    } else {
      deps.log(`pane=${request.paneId} Sleep now refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    }
    return result;
  });
}

// A sleep comes back with the line its log entry describes it by.
async function decide(
  request: AgentHibernationRequest,
  deps: AgentHibernationDeps,
  { idleMs, tickMs, memoryLevel: level }: AgentHibernationPolicy,
): Promise<AgentHibernationResult | { result: AgentHibernationResult; context: string }> {
  const first = judgeNow(request, deps, idleMs);
  if (!first.ok) return first.result;

  const now = deps.now();
  for (const [paneId, held] of censusBackoff) {
    if (held.until <= now) censusBackoff.delete(paneId);
  }
  const held = censusBackoff.get(request.paneId);
  // Sleep now takes a fresh census: the program that kept the pane awake a
  // few ticks ago may have ended since.
  if (held && held.generationId === first.session.generationId && !request.manual) return held.result;
  censusBackoff.delete(request.paneId);
  const holdCensus = (result: AgentHibernationResult): AgentHibernationResult => {
    censusBackoff.set(request.paneId, {
      generationId: first.session.generationId,
      until: now + Math.max(1_000, tickMs) * CENSUS_BACKOFF_TICKS,
      result,
    });
    return result;
  };

  const processes = await deps.listProcesses();
  if (!processes) return holdCensus({ ok: false, reason: "process-list-unavailable", detail: "process listing failed" });
  // An unknown terminal answers null: without it, a process holding the
  // pane's terminal from outside its tree could not be seen.
  const terminalPids = await deps.terminalPids({ pid: first.session.pid, ttyPath: first.session.ttyPath });
  if (!terminalPids) {
    return holdCensus({ ok: false, reason: "process-list-unavailable", detail: "terminal holders unreadable" });
  }
  const census = classifyPaneProcessTree(processes, first.session.pid, request.runtime, {
    terminalPids,
  });
  if (!census.ok) {
    return holdCensus({ ok: false, reason: census.reason, ...(census.detail ? { detail: census.detail } : {}) });
  }

  // The POSIX listing carries no memory: read it for the processes the stop
  // would end, while they still hold it. Before the re-check below, never
  // after it: nothing may be awaited between that re-check and the stop.
  const freedBytes =
    census.memoryBytes ??
    (deps.treeMemory ? await withTimeout(deps.treeMemory(census.pids).catch(() => null), TREE_MEMORY_TIMEOUT_MS, null) : null);

  // agy's own word that nothing runs in the conversation, read last before
  // the re-check: its subagents live inside the agy process, where the
  // census cannot see them. Never held like a census refusal: the flag
  // changes as soon as the work ends.
  if (request.runtime === "antigravity") {
    const agentCommand = processes.find((entry) => entry.pid === census.agentPid)?.command ?? "";
    const verdict = deps.antigravity
      ? await deps.antigravity(census.agentPid, agentCommand, request.conversationId, census.pids).catch(() => null)
      : null;
    if (!verdict) return { ok: false, reason: "conversation-unknown", detail: "agy could not be checked" };
    if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };
    // The proof took time: the processes the stop will end must still be
    // the ones the census passed, with the agy it read, and no other agy.
    const again = await deps.listProcesses();
    const recount = again ? classifyPaneProcessTree(again, first.session.pid, request.runtime, { terminalPids }) : null;
    // Same processes: pid, start and command, so a pid reused by another
    // program does not pass.
    const identity = (list: readonly CensusProcess[], pids: readonly number[]) => {
      const byPid = new Map(list.map((entry) => [entry.pid, entry]));
      return pids
        .map((pid) => `${pid}|${byPid.get(pid)?.startMs ?? "?"}|${byPid.get(pid)?.command ?? "?"}`)
        .sort()
        .join("\n");
    };
    if (
      !again ||
      !recount?.ok ||
      recount.agentPid !== census.agentPid ||
      identity(again, recount.pids) !== identity(processes, census.pids)
    ) {
      return { ok: false, reason: "other-processes", detail: "the pane's processes changed while agy was checked" };
    }
    // agy may have moved to another conversation during the re-census: the
    // open conversation and flags again, for the same process.
    const recheck = deps.antigravity
      ? await deps.antigravity(census.agentPid, agentCommand, request.conversationId, census.pids).catch(() => null)
      : null;
    if (!recheck) return { ok: false, reason: "conversation-unknown", detail: "agy could not be checked" };
    if (!recheck.ok) return { ok: false, reason: recheck.reason, detail: recheck.detail };
    // agy's flags again, after the last await: a turn or a subagent that
    // started during the re-check is seen here or after the stop.
    const still = deps.antigravityActivity?.(request.conversationId ?? "") ?? null;
    if (!still) return { ok: false, reason: "conversation-unknown", detail: "agy could not be checked" };
    if (!still.ok) return { ok: false, reason: still.reason, detail: still.detail };
  }

  // The listing took time. Judge again from fresh state, and fence the stop
  // on the exact process generation that was judged. From here to the stop
  // runs in one tick: a prompt sent meanwhile (a session message, Cora, the
  // phone) is either seen here or arrives after the pane is marked asleep.
  const second = judgeNow(request, deps, idleMs);
  if (!second.ok) return second.result;
  if (second.session.generationId !== first.session.generationId) {
    return { ok: false, reason: "respawned", detail: "respawned while judged" };
  }
  const why = request.manual
    ? "Sleep now"
    : `idle ${Math.round(idleMs / 1000)}s${level === "ok" ? "" : `, memory ${level}`}`;
  const context = `${request.runtime} is sleeping (${request.placement}, ${why}, census ${processes.length} processes in ${deps.now() - now}ms)`;
  // Recorded before the stop: the pty leaves pty-manager's table as the
  // stop begins, so an app quit during the stop's grace period must already
  // find this pane among the sleeping ones, or the relaunch restore would
  // drop its session.
  const sleptAt = deps.now();
  const previous = sleeping.get(request.paneId);
  if (previous) forget(request.paneId, previous);
  const kept = deps.sleepOutput?.(request.paneId) ?? null;
  const entry: SleepingEntry = {
    runtime: request.runtime,
    sleptAt,
    tail: kept?.tail ?? null,
    unsent: kept?.unsent ?? null,
    summary: null,
    freedBytes,
    // Antigravity wakes the conversation proved held above, whatever the
    // renderer's pointer said (useTerminalSession reads it back on wake).
    session:
      request.runtime === "antigravity" && request.conversationId
        ? { ...(request.session ?? {}), runtime: "antigravity", sessionId: request.conversationId }
        : (request.session ?? null),
    placementGraceUntil: 0,
    offExit: null,
  };
  sleeping.set(request.paneId, entry);
  forgetAtNextExit(request.paneId, entry);
  const described = deps.describe
    ? deps.describe(request.paneId, request.runtime, request.transcriptPath ?? null, request.conversationId ?? null).catch(() => null)
    : Promise.resolve(null);
  const stopped = await deps.stop(request.paneId, first.session.generationId);
  if (!stopped) {
    forget(request.paneId, entry);
    return { ok: false, reason: "stop-failed" };
  }
  entry.summary = await withTimeout(described, SUMMARY_TIMEOUT_MS, null);
  // Where the line came from, never the line: it is the user's content.
  return {
    result: {
      ok: true,
      sleptAt,
      summary: entry.summary,
      freedBytes: entry.freedBytes,
      ...(request.runtime === "antigravity" && request.conversationId ? { conversationId: request.conversationId } : {}),
    },
    context: `${context.replace(/\)$/, "")}, freed ${formatMb(entry.freedBytes)}, card ${entry.summary?.source ?? "none"})`,
  };
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerAgentHibernationIpc(handle: IpcHandle): void {
  handle("agentHibernation:policy", () => currentHibernationPolicy());
  handle("agentHibernation:hibernate", (_event, input: unknown) => hibernateAgentPane(input));
  handle("agentHibernation:sleepingPane", (_event, paneId: unknown, options: unknown) =>
    typeof paneId === "string" && paneId.length > 0 && paneId.length <= 256
      ? takeSleepingPane(paneId, (options as { freshView?: unknown } | null)?.freshView === true)
      : null,
  );
  handle("agentHibernation:restoredAsleep", (_event, input: unknown) => registerRestoredAsleep(input));
  handle("agentHibernation:sleepingSession", (_event, paneId: unknown) =>
    typeof paneId === "string" && paneId.length > 0 && paneId.length <= 256 ? (sleepingEntry(paneId)?.session ?? null) : null,
  );
}

/** The renderer's fire-and-forget channels (touches and its own skips). */
export function onAgentHibernationMessage(channel: "touched" | "log", payload: unknown): void {
  if (channel === "touched") {
    if (Array.isArray(payload) && payload.length <= 64) noteAgentPanesTouched(payload.filter((id) => typeof id === "string"));
    return;
  }
  if (typeof payload === "string" && payload.length > 0 && payload.length < 512) {
    logMain("agent-hibernation", `renderer: ${payload}`);
  }
}
