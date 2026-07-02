import type { NotifyKind } from "@shared/types";

// Pure notification policy: given an event's kind + sourceKey and the
// caller-computed context (is the user watching the source? is DND on?),
// decide whether to deliver, whether to record to the center, and mutate the
// per-source dedup state. NO Electron imports — this module must stay
// require-able from a plain node test script (scripts/test-notify-policy.cjs).
//
// The three rules it enforces, unified across runs / terminal agents /
// automations:
//   1. "Needs you" (run.blocked) always delivers, even while watching.
//   2. Completions deliver only when the user is not watching the source;
//      suppressed ones are still recorded to the center, pre-read.
//   3. Same kind twice for the same source is a no-op until rearm() —
//      re-emits and settle races never alert twice.
// Plus the terminal-completion guard: once a source alerted a completion
// (complete / failed / done), later needs-input alerts from it are the same
// turn's tail and are swallowed until real new work rearms the source.

// Alerts meaning "the agent stopped and waits on the user".
const NEEDS_INPUT_KINDS: ReadonlySet<NotifyKind> = new Set([
  "run.blocked",
  "terminal.agent.needs-input",
]);

// Alerts meaning "the agent reached a terminal state" — these arm the
// completion guard for their source.
const COMPLETION_KINDS: ReadonlySet<NotifyKind> = new Set([
  "run.complete",
  "run.failed",
  "terminal.agent.done",
]);

export interface PolicyState {
  // Last kind alerted (or watching-suppressed) per sourceKey — drives the
  // no-change rule.
  lastAlertedKind: Map<string, NotifyKind>;
  // Sources whose most recent alert was a completion and that have not been
  // rearmed by new activity since.
  completedSources: Set<string>;
}

export function createPolicyState(): PolicyState {
  return { lastAlertedKind: new Map(), completedSources: new Set() };
}

export interface PolicyContext {
  // The user is focused on the exact surface that raised the event (the
  // run's chat / the pane's tab). Computed by the caller from the attention
  // tracker; always false for automation events.
  watching: boolean;
  // Do Not Disturb preference: mute delivery, still record unread.
  dnd: boolean;
}

export interface PolicyDecision {
  deliver: boolean;
  // False for pure re-emits (duplicate / completion-guard) that would spam
  // the center with identical entries; true otherwise — muted events still
  // land in the history.
  record: boolean;
  // Record as already-read (the user was watching, so it isn't news).
  read: boolean;
  reason: string;
}

export function decide(
  event: { kind: NotifyKind; sourceKey: string },
  ctx: PolicyContext,
  state: PolicyState,
): PolicyDecision {
  const { kind, sourceKey } = event;

  // Completion guard: a needs-input after an alerted completion, with no
  // rearm in between, is the finished turn's tail — not a fresh question.
  if (NEEDS_INPUT_KINDS.has(kind) && state.completedSources.has(sourceKey)) {
    return { deliver: false, record: false, read: false, reason: "completion-guard" };
  }

  // No-change rule: the same kind again for the same source is a re-emit.
  if (state.lastAlertedKind.get(sourceKey) === kind) {
    return { deliver: false, record: false, read: false, reason: "duplicate" };
  }

  state.lastAlertedKind.set(sourceKey, kind);
  if (COMPLETION_KINDS.has(kind)) state.completedSources.add(sourceKey);

  // Watching suppresses everything except a run asking for the user —
  // rule 1 fires even on-screen so a blocked run is never missed.
  if (ctx.watching && kind !== "run.blocked") {
    return { deliver: false, record: true, read: true, reason: "watching" };
  }

  if (ctx.dnd) {
    return { deliver: false, record: true, read: false, reason: "dnd" };
  }

  return { deliver: true, record: true, read: false, reason: "deliver" };
}

// Real new activity began on this source (run re-entered running/planning/
// reviewing, terminal agent entered a working phase, automation started an
// iteration): clear both the no-change memory and the completion guard so
// the next alert of any kind delivers.
export function rearm(state: PolicyState, sourceKey: string): void {
  state.lastAlertedKind.delete(sourceKey);
  state.completedSources.delete(sourceKey);
}

// Weaker rearm for quiescent-but-not-active transitions (run paused/idle):
// a future re-entry into the same status may alert again, but the completion
// guard stays armed — a bare pause is not resumed work.
export function clearLastAlerted(state: PolicyState, sourceKey: string): void {
  state.lastAlertedKind.delete(sourceKey);
}
