// Agent hibernation, main side: stop a finished, untouched agent terminal in
// a background workspace to give its memory back, and let the renderer resume
// it (`--resume`) when the user opens the pane again.
//
// The renderer nominates panes (src/renderer/src/lib/agentHibernation.ts): it
// knows which workspace is on screen, which panes are pinned awake and which
// session each pane can resume. Main decides. It re-checks everything it can
// see itself and stops the pane only when all of these hold:
//   - the setting is on and the pane is a local PTY that still exists, and
//     no paired phone has it open (Remote Access);
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
import { studioPaneWatchedFromPhone } from "./remote-access/studio-terminal-share";
import {
  classifyPaneProcessTree,
  listCensusProcesses,
  listPaneTerminalPids,
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
  type AgentSleepingPane,
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

export interface AgentHibernationDeps {
  now: () => number;
  policy: () => Promise<AgentHibernationPolicy>;
  session: (paneId: string) => pty.HibernationSessionInfo | null;
  evidence: (paneId: string) => AgentHibernationEvidence | null;
  listProcesses: () => Promise<CensusProcess[] | null>;
  // Every process holding the pane's terminal (POSIX tty, Windows console).
  terminalPids: (pane: { pid: number; ttyPath: string | null }) => Promise<number[] | null>;
  stop: (paneId: string, generationId: string) => Promise<boolean>;
  log: (line: string) => void;
  // A paired phone has the pane open (Remote Access): it is on a screen.
  watchedOnPhone?: (paneId: string) => boolean;
  // What the pane printed, kept for its sleeping view (see pty.sleepOutput).
  sleepOutput?: (paneId: string) => { tail: Buffer | null; unsent: Buffer | null } | null;
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
  terminalPids: (pane) => listPaneTerminalPids(pane),
  stop: (paneId, generationId) => pty.hibernate(paneId, generationId, STOP_GRACE_MS),
  log: (line) => console.log(`[agent-hibernation] ${line}`),
  watchedOnPhone: (paneId) => studioPaneWatchedFromPhone(paneId),
  sleepOutput: (paneId) => pty.sleepOutput(paneId, MAX_SLEEPING_OUTPUT_BYTES),
};

const inFlight = new Set<string>();
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

/** Tests only: forget every pane's in-memory hibernation state. */
export function resetAgentHibernationForTests(): void {
  inFlight.clear();
  for (const [paneId, entry] of [...sleeping]) forget(paneId, entry);
  censusBackoff.clear();
}

/**
 * The panes still asleep, for the quit census (src/main/index.ts): their
 * agent was stopped by Codara, not by the user, so the opt-in relaunch
 * restore must treat them as running sessions.
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
  if (pty.hasSession(paneId) || !terminalPanePlacement(paneId)) {
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
  console.log(`[agent-hibernation] pane=${paneId} mounts asleep (${output?.byteLength ?? 0} bytes of output kept)`);
  return {
    runtime: entry.runtime,
    sleptAt: entry.sleptAt,
    // A copy with its own exact-size buffer: a view could carry the rest of
    // a pooled ArrayBuffer across IPC.
    output: output ? new Uint8Array(output) : null,
  };
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
  if (deps.watchedOnPhone?.(request.paneId)) {
    return { ok: false, result: { ok: false, reason: "watched-on-phone" } };
  }
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
    // An unknown terminal answers null: without it, a process holding the
    // pane's terminal from outside its tree could not be seen.
    const terminalPids = await deps.terminalPids({ pid: first.session.pid, ttyPath: first.session.ttyPath });
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
    const sleptAt = deps.now();
    const previous = sleeping.get(request.paneId);
    if (previous) forget(request.paneId, previous);
    const kept = deps.sleepOutput?.(request.paneId) ?? null;
    const entry: SleepingEntry = {
      runtime: request.runtime,
      sleptAt,
      tail: kept?.tail ?? null,
      unsent: kept?.unsent ?? null,
      offExit: null,
    };
    sleeping.set(request.paneId, entry);
    forgetAtNextExit(request.paneId, entry);
    const stopped = await deps.stop(request.paneId, first.session.generationId);
    if (!stopped) {
      forget(request.paneId, entry);
      return { ok: false, reason: "stop-failed" };
    }
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
  handle("agentHibernation:sleepingPane", (_event, paneId: unknown, options: unknown) =>
    typeof paneId === "string" && paneId.length > 0 && paneId.length <= 256
      ? takeSleepingPane(paneId, (options as { freshView?: unknown } | null)?.freshView === true)
      : null,
  );
}
