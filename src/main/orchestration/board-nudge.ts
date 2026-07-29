// Cora Board nudge — wakes a chat's OWN manager when cards are queued on its
// board. This replaces the retired board-engine (which started a separate run
// per queued card): under the per-chat model nothing is ever launched here;
// the only action is asking run-store to hand the queued cards to the run's
// manager (run-store.nudgeBoardManager injects the synthetic board note and
// schedules a chat decision).
//
// Shape mirrors the retired engine's event plumbing: one subscription to the
// orchestration event bus, a per-run trailing debounce so a burst of queue
// drags collapses into one nudge, and a small in-memory ledger of which card
// ids have already been handed over so an ignored card is not re-nudged every
// time the run settles.
//
// Restart behavior is deliberately quiet: nothing is scanned or nudged at
// boot. Relaunching the app is not consent to start agents (run-store parks
// interrupted runs as paused on the same principle). Instead, the FIRST event
// a run emits in a session (a chat message, a status change, anything) checks
// its board once — so a card still queued from a previous session is handed
// over as soon as the user interacts with that chat, which is the consent
// signal. Accepted consequence: a queued card the manager saw and left queued
// before the restart is offered again in the new session (the in-memory
// ledger does not survive restarts); the user signaled the work matters by
// leaving it in Queued.

import type { RunState } from "@shared/types";
import { subscribeToEvents } from "./event-log";

/** Injectable seam over run-store so the nudge can be driven in a test
 * without standing up the whole orchestration stack. */
export interface BoardNudgeDeps {
  getRun: (runId: string) => Promise<RunState | null>;
  nudge: (runId: string) => Promise<"nudged" | "busy" | "no_queued" | "ineligible">;
  subscribe: (handler: (event: { runId?: string; type: string }) => void) => () => void;
}

async function defaultDeps(): Promise<BoardNudgeDeps> {
  const runStore = await import("./run-store");
  return {
    getRun: runStore.getRun,
    nudge: runStore.nudgeBoardManager,
    subscribe: subscribeToEvents,
  };
}

// A burst of board writes (a drag rewrites every card; queueing three cards is
// three commits) must produce one nudge, so attempts fire on a trailing timer.
const NUDGE_DEBOUNCE_MS = 400;

let deps: BoardNudgeDeps | null = null;
let started = false;
let unsubscribe: (() => void) | null = null;

// Per-run trailing debounce timers.
const timers = new Map<string, NodeJS.Timeout>();

// Runs with queued cards we could not hand over yet (manager busy, run
// paused/blocked). Any later event for such a run schedules a retry; that is
// how "re-nudge on next idle" works without polling.
const pendingRuns = new Set<string>();

// Card ids already handed to the manager, per run. A card is dropped from the
// ledger when it leaves "queued", so re-queueing the same card later nudges
// again, while a card the manager ignores does not re-fire on every settle.
const nudgedCards = new Map<string, Set<string>>();

// Runs whose board we have looked at at least once this session. The first
// event a run emits triggers one board check, which is what picks queued
// cards left over from a previous session back up on user interaction.
const seenRuns = new Set<string>();

function scheduleAttempt(runId: string): void {
  if (!started) return;
  if (timers.has(runId)) return;
  const timer = setTimeout(() => {
    timers.delete(runId);
    void attemptNudge(runId).catch((err: unknown) =>
      console.error(`[board-nudge] nudge attempt for ${runId} failed:`, err),
    );
  }, NUDGE_DEBOUNCE_MS);
  timer.unref?.();
  timers.set(runId, timer);
}

async function attemptNudge(runId: string): Promise<void> {
  const engine = deps;
  if (!engine) return;
  const run = await engine.getRun(runId);
  if (!run || run.automationId || run.executionMode === "direct") {
    pendingRuns.delete(runId);
    nudgedCards.delete(runId);
    return;
  }

  const queuedIds = new Set(
    (run.board?.cards ?? []).filter((card) => card.status === "queued").map((card) => card.id),
  );
  if (queuedIds.size === 0) {
    pendingRuns.delete(runId);
    nudgedCards.delete(runId);
    return;
  }

  // Prune the ledger to cards still queued, then check whether anything NEW
  // is waiting. Without this, every post-turn settle would re-nudge the same
  // cards the manager already saw and chose to leave queued.
  let ledger = nudgedCards.get(runId);
  if (ledger) {
    for (const id of [...ledger]) if (!queuedIds.has(id)) ledger.delete(id);
    if (ledger.size === 0) nudgedCards.delete(runId);
  }
  const hasUnnudged = [...queuedIds].some((id) => !ledger?.has(id));
  if (!hasUnnudged) {
    pendingRuns.delete(runId);
    return;
  }

  const outcome = await engine.nudge(runId);
  if (outcome === "nudged") {
    ledger = nudgedCards.get(runId) ?? new Set<string>();
    for (const id of queuedIds) ledger.add(id);
    nudgedCards.set(runId, ledger);
    pendingRuns.delete(runId);
    return;
  }
  if (outcome === "busy") {
    // Keep it pending: the next event for this run (a status transition when
    // the turn ends, a board change, anything) retries after the debounce.
    pendingRuns.add(runId);
    return;
  }
  // no_queued / ineligible: nothing to do until the board changes again.
  pendingRuns.delete(runId);
  if (outcome === "ineligible") nudgedCards.delete(runId);
}

function onEvent(event: { runId?: string; type: string }): void {
  const runId = event.runId;
  if (!runId) return;
  // A board write may have queued cards; a run's FIRST event this session
  // checks the board once (restart pickup — see the header note); anything
  // else only matters for runs already waiting on a busy manager.
  if (event.type === "run.board_updated") {
    seenRuns.add(runId);
    scheduleAttempt(runId);
    return;
  }
  if (!seenRuns.has(runId)) {
    seenRuns.add(runId);
    scheduleAttempt(runId);
    return;
  }
  if (pendingRuns.has(runId)) scheduleAttempt(runId);
}

/** Wire the nudge to the orchestration event bus. Idempotent. */
export async function startBoardNudge(overrides?: Partial<BoardNudgeDeps>): Promise<void> {
  if (started) return;
  started = true;
  // Fully-injected callers (tests) never load run-store at all.
  deps =
    overrides?.getRun && overrides.nudge && overrides.subscribe
      ? (overrides as BoardNudgeDeps)
      : { ...(await defaultDeps()), ...overrides };
  unsubscribe = deps.subscribe(onEvent);
}

/** Tear down the subscription and timers. Test/shutdown helper. */
export function stopBoardNudge(): void {
  unsubscribe?.();
  unsubscribe = null;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pendingRuns.clear();
  nudgedCards.clear();
  seenRuns.clear();
  deps = null;
  started = false;
}
