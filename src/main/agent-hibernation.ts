// Agent hibernation, main side: stop a finished, untouched agent terminal in
// a background workspace to give its memory back, and let the renderer resume
// it (`--resume`) when the user opens the pane again.
//
// The renderer nominates panes (src/renderer/src/lib/agentHibernation.ts): it
// knows which workspace is on screen, which panes are pinned awake and which
// session each pane can resume. Main decides. It re-checks everything it can
// see itself and stops the pane only when all of these hold:
//   - the setting is on and the pane is a local PTY that still exists;
//   - the terminal agent notifier says the agent's turn ended, nothing is
//     pending, it is not waiting on the user and no typed text is unsent;
//   - nothing happened in the pane (input or output) for the idle period;
//   - the pane's process tree is only the shell, the agent and what the agent
//     started at boot (agent-hibernation-census.ts), so no dev server, watcher
//     or tool command can be caught in the stop.
// Anything unclear refuses. The renderer simply asks again on its next tick.

import { E2E_BACKGROUND } from "./e2e-background";
import type { IpcHandle } from "./ipc";
import * as pty from "./pty-manager";
import { loadPreferences } from "./preferences-store";
import { terminalAgentHibernationEvidence, terminalPanePlacement } from "./terminal-agent-notify";
import {
  classifyPaneProcessTree,
  listCensusProcesses,
  listTerminalPids,
  type CensusProcess,
} from "./agent-hibernation-census";
import {
  isAgentHibernationRuntime,
  judgeAgentEvidence,
  judgeIdleClock,
  normalizeAgentHibernationMinutes,
  type AgentHibernationEvidence,
  type AgentHibernationPolicy,
  type AgentHibernationRequest,
  type AgentHibernationResult,
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

export interface AgentHibernationDeps {
  now: () => number;
  policy: () => Promise<AgentHibernationPolicy>;
  session: (paneId: string) => pty.HibernationSessionInfo | null;
  evidence: (paneId: string) => AgentHibernationEvidence | null;
  listProcesses: () => Promise<CensusProcess[] | null>;
  terminalPids: (ttyPath: string | null) => Promise<number[] | null>;
  stop: (paneId: string, generationId: string) => Promise<boolean>;
  log: (line: string) => void;
}

// e2e only: the suite cannot wait half an hour. Honored only when the app
// was launched by the e2e runner (SPARK_E2E_BACKGROUND=1).
function e2eOverrideMs(name: string): number | null {
  if (!E2E_BACKGROUND) return null;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Read through loadPreferences, never a possibly cold cache: a cold cache
// answers with the default (on) for a user who turned the setting off.
export async function currentHibernationPolicy(): Promise<AgentHibernationPolicy> {
  const prefs = await loadPreferences();
  const minutes = normalizeAgentHibernationMinutes(prefs.agentHibernationMinutes);
  if (minutes === 0) return { idleMs: 0, tickMs: DEFAULT_TICK_MS };
  return {
    idleMs: e2eOverrideMs("CODARA_E2E_HIBERNATION_IDLE_MS") ?? minutes * MINUTE_MS,
    tickMs: e2eOverrideMs("CODARA_E2E_HIBERNATION_TICK_MS") ?? DEFAULT_TICK_MS,
  };
}

const defaultDeps: AgentHibernationDeps = {
  now: () => Date.now(),
  policy: currentHibernationPolicy,
  session: (paneId) => pty.hibernationSessionInfo(paneId),
  evidence: (paneId) => terminalAgentHibernationEvidence(paneId),
  listProcesses: () => listCensusProcesses(),
  terminalPids: (ttyPath) => listTerminalPids(ttyPath),
  stop: (paneId, generationId) => pty.hibernate(paneId, generationId, STOP_GRACE_MS),
  log: (line) => console.log(`[agent-hibernation] ${line}`),
};

const inFlight = new Set<string>();
// Panes this run put to sleep, with the agent each held. A pane that spawned
// again (woke) or was closed drops out lazily in sleepingAgentPanes().
const sleeping = new Map<string, AgentHibernationRequest["runtime"]>();
// Census refusals per pane, reused until `until` while the pane keeps the
// same process generation (see CENSUS_BACKOFF_TICKS).
const censusBackoff = new Map<string, { generationId: string; until: number; result: AgentHibernationResult }>();

/** Tests only: forget every pane's in-memory hibernation state. */
export function resetAgentHibernationForTests(): void {
  inFlight.clear();
  sleeping.clear();
  censusBackoff.clear();
}

/**
 * The panes still asleep, for the quit census (src/main/index.ts): their
 * agent was stopped by Codara, not by the user, so the opt-in relaunch
 * restore must treat them as running sessions.
 */
export function sleepingAgentPanes(): Map<string, AgentHibernationRequest["runtime"]> {
  for (const paneId of [...sleeping.keys()]) {
    if (pty.hasSession(paneId) || !terminalPanePlacement(paneId)) sleeping.delete(paneId);
  }
  return new Map(sleeping);
}

function validRequest(input: unknown): AgentHibernationRequest | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<AgentHibernationRequest>;
  if (typeof value.paneId !== "string" || value.paneId.length === 0 || value.paneId.length > 256) {
    return null;
  }
  if (!isAgentHibernationRuntime(value.runtime)) return null;
  if (typeof value.hiddenForMs !== "number" || !Number.isFinite(value.hiddenForMs) || value.hiddenForMs < 0) {
    return null;
  }
  return { paneId: value.paneId, runtime: value.runtime, hiddenForMs: value.hiddenForMs };
}

type Judged =
  | { ok: true; session: pty.HibernationSessionInfo }
  | { ok: false; result: AgentHibernationResult };

function judgeNow(request: AgentHibernationRequest, deps: AgentHibernationDeps, idleMs: number): Judged {
  const session = deps.session(request.paneId);
  if (!session) return { ok: false, result: { ok: false, reason: "no-session" } };
  if (session.remote || !(session.pid > 0)) return { ok: false, result: { ok: false, reason: "remote" } };
  const evidence = deps.evidence(request.paneId);
  const stateRefusal = judgeAgentEvidence(evidence, request.runtime);
  if (stateRefusal) return { ok: false, result: { ok: false, reason: stateRefusal } };
  const clockRefusal = judgeIdleClock({
    now: deps.now(),
    idleMs,
    hiddenForMs: request.hiddenForMs,
    activityAt: [
      session.createdAt,
      session.lastInputAt,
      session.lastOutputAt,
      evidence?.lastUserInputAt ?? 0,
      evidence?.lastOutputAt ?? 0,
    ],
  });
  if (clockRefusal) return { ok: false, result: { ok: false, reason: clockRefusal } };
  return { ok: true, session };
}

export async function hibernateAgentPane(
  input: unknown,
  deps: AgentHibernationDeps = defaultDeps,
): Promise<AgentHibernationResult> {
  const request = validRequest(input);
  if (!request) return { ok: false, reason: "bad-request" };
  const { idleMs, tickMs } = await deps.policy();
  if (!(idleMs > 0)) return { ok: false, reason: "off" };
  if (inFlight.has(request.paneId)) return { ok: false, reason: "in-flight" };
  inFlight.add(request.paneId);
  try {
    const first = judgeNow(request, deps, idleMs);
    if (!first.ok) return first.result;

    const now = deps.now();
    for (const [paneId, held] of censusBackoff) {
      if (held.until <= now) censusBackoff.delete(paneId);
    }
    const held = censusBackoff.get(request.paneId);
    if (held && held.generationId === first.session.generationId) return held.result;
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
    if (!processes) return holdCensus({ ok: false, reason: "process-list-unavailable" });
    // An unknown terminal on POSIX answers null: without it, a process
    // holding the pane's terminal from outside its tree could not be seen.
    const terminalPids = await deps.terminalPids(first.session.ttyPath);
    if (!terminalPids) return holdCensus({ ok: false, reason: "process-list-unavailable" });
    const census = classifyPaneProcessTree(processes, first.session.pid, request.runtime, {
      terminalPids,
    });
    if (!census.ok) {
      deps.log(`pane=${request.paneId} stays awake: ${census.reason}${census.detail ? ` (${census.detail})` : ""}`);
      return holdCensus({ ok: false, reason: census.reason, ...(census.detail ? { detail: census.detail } : {}) });
    }

    // The listing took time. Judge again from fresh state, and fence the stop
    // on the exact process generation that was judged.
    const second = judgeNow(request, deps, idleMs);
    if (!second.ok) return second.result;
    if (second.session.generationId !== first.session.generationId) {
      return { ok: false, reason: "no-session" };
    }
    // Recorded before the stop: the pty leaves pty-manager's table as the
    // stop begins, so an app quit during the stop's grace period must already
    // find this pane among the sleeping ones, or the relaunch restore would
    // drop its session.
    sleeping.set(request.paneId, request.runtime);
    const stopped = await deps.stop(request.paneId, first.session.generationId);
    if (!stopped) {
      sleeping.delete(request.paneId);
      return { ok: false, reason: "stop-failed" };
    }
    const sleptAt = deps.now();
    deps.log(`pane=${request.paneId} ${request.runtime} is sleeping`);
    return { ok: true, sleptAt };
  } finally {
    inFlight.delete(request.paneId);
  }
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerAgentHibernationIpc(handle: IpcHandle): void {
  handle("agentHibernation:policy", () => currentHibernationPolicy());
  handle("agentHibernation:hibernate", (_event, input: unknown) => hibernateAgentPane(input));
}
