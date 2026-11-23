// Agent hibernation: shared policy for stopping finished, untouched agent
// terminals (Claude Code, Codex, Grok, Pi) to give their memory back, and
// resuming them when the user asks for it (the pane's Resume button, Enter in
// the pane, or the Agents view).
//
// Main owns the decision to stop a process (src/main/agent-hibernation.ts);
// the renderer only nominates candidates and paints the sleeping pane. Every
// rule here fails closed: when the evidence is missing or unclear the agent
// stays awake, because a sleeping pane must never cost the user any work.

export type AgentHibernationRuntime = "claude" | "codex" | "grok" | "pi";

// Quick picks shown next to the minutes field in Settings. Any whole number
// of minutes from 0 (off) to AGENT_HIBERNATION_MAX_MINUTES is valid.
export const AGENT_HIBERNATION_PRESETS: ReadonlyArray<{
  value: number;
  label: string;
  hint: string;
}> = [
  { value: 0, label: "Off", hint: "Agents keep running however long they wait." },
  { value: 15, label: "15 min", hint: "Gives memory back soonest." },
  { value: 30, label: "30 min", hint: "Default." },
  { value: 60, label: "1 hour", hint: "For agents you come back to often." },
  { value: 120, label: "2 hours", hint: "Only agents left alone for a long time." },
];
export const AGENT_HIBERNATION_MINUTE_PRESETS: readonly number[] = AGENT_HIBERNATION_PRESETS.map(
  (preset) => preset.value,
);
export const DEFAULT_AGENT_HIBERNATION_MINUTES = 30;
export const AGENT_HIBERNATION_MAX_MINUTES = 720;

function clampMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(AGENT_HIBERNATION_MAX_MINUTES, Math.max(0, Math.round(value)));
}

/** Whole minutes from 0 (off) to the maximum; anything that is not a number is the default. */
export function normalizeAgentHibernationMinutes(value: unknown): number {
  return clampMinutes(value) ?? DEFAULT_AGENT_HIBERNATION_MINUTES;
}

/**
 * Per-workspace exceptions: workspace id to minutes, 0 meaning agents there
 * never sleep. A workspace without an entry follows the global setting.
 * Malformed entries are dropped, never turned into a default.
 */
export function normalizeAgentHibernationWorkspaces(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [workspaceId, minutes] of Object.entries(value as Record<string, unknown>)) {
    if (!workspaceId || workspaceId.length > 256) continue;
    const clamped = clampMinutes(minutes);
    if (clamped !== null) out[workspaceId] = clamped;
  }
  return out;
}

export function isAgentHibernationRuntime(value: unknown): value is AgentHibernationRuntime {
  return value === "claude" || value === "codex" || value === "grok" || value === "pi";
}

// Where the pane was when the renderer asked: for the log only, main judges
// the same way wherever it is. The pane with the keyboard focus is never
// nominated.
export type AgentHibernationPlacement = "visible" | "hidden-tab" | "background-workspace";

/** What the renderer asks main to do for one pane. */
export interface AgentHibernationRequest {
  paneId: string;
  runtime: AgentHibernationRuntime;
  placement: AgentHibernationPlacement;
  // The session's transcript as the resume probe found it: read for the
  // card's line only, and only when the hook trail names none.
  transcriptPath?: string;
  // The pane's session pointer, as the renderer holds it. Main keeps it with
  // the sleeping record and hands it back unread: with session restore off
  // the layout on disk has no pointer, and a reloaded window would otherwise
  // have nothing to resume the agent with.
  session?: AgentSleepingSession;
}

/** A session pointer in the renderer's own shape; main never reads its fields. */
export type AgentSleepingSession = Record<string, unknown>;

export type AgentHibernationRefusal =
  | "off"
  | "exempt"
  | "bad-request"
  | "in-flight"
  | "no-session"
  | "remote"
  | "watched-on-phone"
  | "not-idle-long-enough"
  | "not-watched"
  | "runtime-mismatch"
  | "agent-busy"
  | "waiting-on-user"
  | "unsent-input"
  | "scheduled-work"
  | "unknown-state"
  | "no-agent-process"
  | "other-processes"
  | "process-list-unavailable"
  | "stop-failed";

/**
 * One line about what a sleeping session was doing, for its card. `title` is
 * the session's name or its subject, `detail` the last thing asked of it.
 * Kept in memory and on the pane only: never logged.
 */
export interface AgentSleepSummary {
  title: string;
  detail: string | null;
  source: "custom-title" | "ai-title" | "agent-note" | "prompt" | "first-prompt" | "tab-title";
}

export const AGENT_SLEEP_TITLE_MAX = 120;
export const AGENT_SLEEP_DETAIL_MAX = 180;

const SLEEP_SUMMARY_SOURCES: ReadonlyArray<AgentSleepSummary["source"]> = [
  "custom-title",
  "ai-title",
  "agent-note",
  "prompt",
  "first-prompt",
  "tab-title",
];

/** A summary of exactly the shape main writes, cut to its limits; anything else is null. */
export function validSleepSummary(value: unknown): AgentSleepSummary | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AgentSleepSummary>;
  if (typeof candidate.title !== "string" || !candidate.title.trim()) return null;
  if (!SLEEP_SUMMARY_SOURCES.includes(candidate.source as AgentSleepSummary["source"])) return null;
  const title = oneLine(candidate.title, AGENT_SLEEP_TITLE_MAX);
  if (!title) return null;
  return {
    title,
    detail:
      typeof candidate.detail === "string" && candidate.detail.trim()
        ? oneLine(candidate.detail, AGENT_SLEEP_DETAIL_MAX)
        : null,
    source: candidate.source as AgentSleepSummary["source"],
  };
}

/** Collapse text to one clean line of at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const clean = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…` : clean;
}

export type AgentHibernationResult =
  // freedBytes: the memory the pane's processes held when they were stopped
  // (Windows: working sets; Linux: anonymous and shared proportional set
  // sizes, not the page cache; macOS: RSS);
  // null only when it could not be read for every one of them.
  | { ok: true; sleptAt: number; summary: AgentSleepSummary | null; freedBytes: number | null }
  | { ok: false; reason: AgentHibernationRefusal; detail?: string };

/**
 * A pane whose agent Codara has stopped, as main remembers it: what a pane
 * mounting while asleep (a remount, a reloaded window) needs to show itself
 * asleep. `output` is raw terminal output to write before anything else: the
 * pane's newest output for a fresh (empty) view, or only what a view that
 * kept its own copy never received.
 */
export interface AgentSleepingPane {
  runtime: AgentHibernationRuntime;
  sleptAt: number;
  output: Uint8Array | null;
  summary: AgentSleepSummary | null;
  freedBytes: number | null;
  session: AgentSleepingSession | null;
}

/** A pane that was asleep when Codara quit and comes back asleep (restoreAsleep). */
export interface AgentRestoredAsleepPane {
  paneId: string;
  runtime: AgentHibernationRuntime;
  sleptAt: number;
  summary: AgentSleepSummary | null;
}

// ── Memory pressure ─────────────────────────────────────────────────────────

export type AgentMemoryLevel = "ok" | "low" | "critical";

// Under memory pressure an idle agent sleeps sooner, never later. Each try
// costs a full process listing (a PowerShell CIM query on Windows), so the
// floors stay in minutes: the agent is already idle, a little longer costs
// nothing the machine cannot spare.
export const AGENT_HIBERNATION_PRESSURE_IDLE_MS: Readonly<Record<Exclude<AgentMemoryLevel, "ok">, number>> = {
  low: 10 * 60_000,
  critical: 3 * 60_000,
};

/** The idle time under this memory level: the setting's, or the level's floor when that is sooner. */
export function idleMsUnderPressure(
  idleMs: number,
  memoryLevel: AgentMemoryLevel,
  floors: Readonly<Record<Exclude<AgentMemoryLevel, "ok">, number>> = AGENT_HIBERNATION_PRESSURE_IDLE_MS,
): number {
  if (!(idleMs > 0) || memoryLevel === "ok") return idleMs;
  const floor = floors[memoryLevel];
  return typeof floor === "number" && floor > 0 ? Math.min(idleMs, floor) : idleMs;
}

// Entry and exit thresholds, as shares of physical memory still available.
// The entry points match the title bar's meter (memoryLevelFor); leaving a
// level needs a few points more, so a machine that hovers at the line does
// not flip between idle times on every tick.
const MEMORY_ENTER = { low: 0.12, critical: 0.05 } as const;
const MEMORY_LEAVE = { low: 0.15, critical: 0.07 } as const;

export function nextMemoryLevel(
  previous: AgentMemoryLevel,
  reading: { totalBytes: number; availableBytes: number } | null,
): AgentMemoryLevel {
  if (!reading || !(reading.totalBytes > 0) || !Number.isFinite(reading.availableBytes)) return "ok";
  const share = Math.max(0, reading.availableBytes) / reading.totalBytes;
  if (share < MEMORY_ENTER.critical) return "critical";
  if (previous === "critical" && share < MEMORY_LEAVE.critical) return "critical";
  if (share < MEMORY_ENTER.low) return "low";
  if (previous !== "ok" && share < MEMORY_LEAVE.low) return "low";
  return "ok";
}

/** The policy main answers with, so the renderer can pace its nominations. */
export interface AgentHibernationPolicy {
  // 0 = off. Already the shorter of the setting and the memory level's floor.
  idleMs: number;
  // The same, for each workspace with its own time; 0 = its agents never sleep.
  workspaceIdleMs: Readonly<Record<string, number>>;
  tickMs: number;
  memoryLevel: AgentMemoryLevel;
}

/** The idle time the policy gives one workspace; 0 = its agents never sleep. */
export function policyIdleMs(policy: AgentHibernationPolicy, workspaceId: string | null): number {
  const own = workspaceId ? policy.workspaceIdleMs[workspaceId] : undefined;
  return typeof own === "number" ? own : policy.idleMs;
}

/** True when any workspace can have a sleeping agent at all. */
export function anyAgentHibernation(policy: AgentHibernationPolicy): boolean {
  return policy.idleMs > 0 || Object.values(policy.workspaceIdleMs).some((idleMs) => idleMs > 0);
}

// ── Agent-state evidence (from the terminal agent notifier) ─────────────────

export interface AgentHibernationEvidence {
  excluded: boolean;
  disposing: boolean;
  attached: boolean;
  runtime: AgentHibernationRuntime | null;
  // The notifier's own state machine.
  state: "idle" | "working" | "blocked" | "failed";
  // The last chip state the pane published ("idle", "done", ...).
  chipState: string | null;
  turnActive: boolean;
  pendingDone: boolean;
  pendingToolCalls: number;
  backgroundRunning: number;
  teammatesActive: number;
  codexAwaitingIdle: boolean;
  // Last key the user sent, the last key that could have put text in the
  // agent's input box, and the last time one of those keys was a submit. An
  // edit after the last submit means text may sit unsent in the box. Other
  // features read lastSubmitAt as their draft guard, so it stays raw.
  lastUserInputAt: number;
  lastComposerEditAt: number;
  lastSubmitAt: number;
  // The last Ctrl+C that emptied the box while the agent sat at its prompt:
  // for hibernation's unsent-text rule only. Optional: an older main omits it.
  lastComposerClearAt?: number;
  // What the session scheduled for later (a ScheduleWakeup, cron jobs), in a
  // few words for the log; null or absent when nothing is.
  scheduledWork?: string | null;
  // A dialog on the screen of a hook-owned agent that no hook announced (an
  // MCP server approval, a trust prompt), not answered yet.
  screenDialog?: boolean;
  lastOutputAt: number;
  // The agent reports its state through a structured channel (Claude Code's
  // hooks, or the OSC 7501 program status), not only through what its screen
  // looks like. Optional: an older main omits it, which counts as false.
  structured?: boolean;
  // The last moment anything in the agent's state moved: a chip change, a
  // turn starting or ending, a hook event, background work draining. Output
  // after it with nothing else moving is the TUI repainting (a status line,
  // a clock), not the agent doing anything. 0 when unknown.
  settledAt?: number;
}

/**
 * Null when the notifier's evidence says the agent finished its turn and is
 * not waiting on anything; otherwise the reason to keep it awake.
 */
export function judgeAgentEvidence(
  evidence: AgentHibernationEvidence | null,
  expected: AgentHibernationRuntime,
): AgentHibernationRefusal | null {
  if (!evidence || evidence.excluded || evidence.disposing || !evidence.attached) {
    return "not-watched";
  }
  if (evidence.runtime !== expected) return "runtime-mismatch";
  if (evidence.state === "blocked" || evidence.chipState === "blocked" || evidence.screenDialog === true) {
    return "waiting-on-user";
  }
  if (evidence.state !== "idle") return "agent-busy";
  // Its turn ended but work it started still runs and will wake it; stopping
  // the agent would kill that work.
  if (evidence.chipState === "background" || evidence.backgroundRunning > 0) return "agent-busy";
  // A /loop waiting for its next tick, or a cron job: no process shows it,
  // and stopping the agent would end the loop without a word.
  if (evidence.scheduledWork) return "scheduled-work";
  // "launching" is the chip of an agent that started and never ran a turn
  // since: a resumed session the user has not typed into yet keeps it for
  // good, because only a turn's end moves the chip to idle. With the state
  // idle, no turn open and the idle clock below, that is a quiet agent too.
  if (evidence.chipState !== "idle" && evidence.chipState !== "done" && evidence.chipState !== "launching") {
    return "unknown-state";
  }
  if (
    evidence.turnActive ||
    evidence.pendingDone ||
    evidence.pendingToolCalls > 0 ||
    evidence.backgroundRunning > 0 ||
    evidence.teammatesActive > 0 ||
    evidence.codexAwaitingIdle
  ) {
    return "agent-busy";
  }
  if (evidence.lastComposerEditAt > Math.max(evidence.lastSubmitAt, evidence.lastComposerClearAt ?? 0)) {
    return "unsent-input";
  }
  return null;
}

/**
 * Whether the pane's output may restart the idle clock. An agent whose idle
 * state comes from a structured channel and has not moved since it settled
 * can only be repainting its own screen (Claude Code's status line every
 * `refreshInterval`, a clock, a spinner in the title): that output is left
 * off the clock, and the settle moment counts in its place. Called only once
 * judgeAgentEvidence found nothing busy, so a working, blocked or background
 * agent never gets here. Screen-only evidence keeps every byte on the clock:
 * there a missed working frame would look exactly like a repaint.
 */
export function outputRestartsIdleClock(evidence: AgentHibernationEvidence | null): boolean {
  if (!evidence || evidence.structured !== true) return true;
  return !(typeof evidence.settledAt === "number" && Number.isFinite(evidence.settledAt) && evidence.settledAt > 0);
}

// ── Idle clock ──────────────────────────────────────────────────────────────

export interface AgentHibernationClock {
  now: number;
  idleMs: number;
  // Every moment something happened in or to the pane (output, input, the
  // user showing or touching it). The newest one starts the idle period.
  activityAt: readonly number[];
}

export function judgeIdleClock(clock: AgentHibernationClock): AgentHibernationRefusal | null {
  if (!(clock.idleMs > 0)) return "off";
  let newest = 0;
  for (const at of clock.activityAt) {
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  // A clock that runs backwards (or a stamp from the future) cannot prove
  // anything was quiet.
  if (newest > clock.now) return "not-idle-long-enough";
  return clock.now - newest >= clock.idleMs ? null : "not-idle-long-enough";
}

// ── Waking ──────────────────────────────────────────────────────────────────

/**
 * A key pressed in a sleeping pane that asks for its agent back: Enter or a
 * printable character, without Ctrl, Cmd or Alt (those are app shortcuts).
 * The key itself is swallowed: the agent is not running to read it.
 */
export function isSleepResumeKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === "Enter") return true;
  // One printable character ("a", " ", "é"); named keys ("Shift", "F5",
  // "ArrowUp") are longer than one code point.
  return [...event.key].length === 1 && !/[\u0000-\u001f\u007f]/.test(event.key);
}
