// Agent hibernation: shared policy for stopping finished, untouched agent
// terminals (Claude Code, Codex, Grok, Pi) in background workspaces, and
// resuming them when the user opens the pane again.
//
// Main owns the decision to stop a process (src/main/agent-hibernation.ts);
// the renderer only nominates candidates and paints the sleeping pane. Every
// rule here fails closed: when the evidence is missing or unclear the agent
// stays awake, because a sleeping pane must never cost the user any work.

export type AgentHibernationRuntime = "claude" | "codex" | "grok" | "pi";

// Settings choices, in minutes. 0 turns hibernation off.
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

export function normalizeAgentHibernationMinutes(value: unknown): number {
  return typeof value === "number" && AGENT_HIBERNATION_MINUTE_PRESETS.includes(value)
    ? value
    : DEFAULT_AGENT_HIBERNATION_MINUTES;
}

export function isAgentHibernationRuntime(value: unknown): value is AgentHibernationRuntime {
  return value === "claude" || value === "codex" || value === "grok" || value === "pi";
}

/** What the renderer asks main to do for one pane. */
export interface AgentHibernationRequest {
  paneId: string;
  runtime: AgentHibernationRuntime;
  // How long the pane's workspace has been out of view, as the renderer
  // measured it. Main still applies its own idle clock on top.
  hiddenForMs: number;
}

export type AgentHibernationRefusal =
  | "off"
  | "bad-request"
  | "in-flight"
  | "no-session"
  | "remote"
  | "watched-on-phone"
  | "hidden-too-short"
  | "not-idle-long-enough"
  | "not-watched"
  | "runtime-mismatch"
  | "agent-busy"
  | "waiting-on-user"
  | "unsent-input"
  | "unknown-state"
  | "no-agent-process"
  | "other-processes"
  | "process-list-unavailable"
  | "stop-failed";

export type AgentHibernationResult =
  | { ok: true; sleptAt: number }
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
}

/** The policy main answers with, so the renderer can pace its nominations. */
export interface AgentHibernationPolicy {
  idleMs: number; // 0 = off
  tickMs: number;
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
  // Last key the user sent, and the last time one of those keys was a
  // submit. A key after the last submit means text may sit unsent in the
  // agent's input box.
  lastUserInputAt: number;
  lastSubmitAt: number;
  lastOutputAt: number;
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
  if (evidence.state === "blocked" || evidence.chipState === "blocked") return "waiting-on-user";
  if (evidence.state !== "idle") return "agent-busy";
  // Its turn ended but work it started still runs and will wake it; stopping
  // the agent would kill that work.
  if (evidence.chipState === "background" || evidence.backgroundRunning > 0) return "agent-busy";
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
  if (evidence.lastUserInputAt > evidence.lastSubmitAt) return "unsent-input";
  return null;
}

// ── Idle clock ──────────────────────────────────────────────────────────────

export interface AgentHibernationClock {
  now: number;
  idleMs: number;
  hiddenForMs: number;
  // Every moment something happened in or to the pane. The newest one starts
  // the idle period.
  activityAt: readonly number[];
}

export function judgeIdleClock(clock: AgentHibernationClock): AgentHibernationRefusal | null {
  if (!(clock.idleMs > 0)) return "off";
  if (!Number.isFinite(clock.hiddenForMs) || clock.hiddenForMs < clock.idleMs) {
    return "hidden-too-short";
  }
  let newest = 0;
  for (const at of clock.activityAt) {
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  // A clock that runs backwards (or a stamp from the future) cannot prove
  // anything was quiet.
  if (newest > clock.now) return "not-idle-long-enough";
  return clock.now - newest >= clock.idleMs ? null : "not-idle-long-enough";
}
