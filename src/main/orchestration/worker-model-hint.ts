// Worker model-hint sanitization + the Fable 5 explicit-request gate.
//
// Split out of run-store.ts so the pure decision logic can be unit-tested
// without dragging in run-store's electron/pty/git dependencies (see
// scripts/test-worker-model-hint.cjs). This module imports ONLY types, so
// esbuild erases every import and the bundle is dependency-free.

import type { RunState } from "@shared/types";

// Fable 5 (`claude-fable-5`) is Anthropic's top, most expensive tier. Cora-
// spawned workers (execute-mode codara_spawn_workers, plan-council judges,
// autopilot worker tasks) default to Opus 4.8 for a fable hint; they may only
// run fable when the user explicitly opted in AND asked for it (see
// runUserRequestedFable / workerFableAllowed in run-store.ts, and the
// `allowFable` option below). A manager LLM may nonetheless emit a fable
// modelHint; this helper downgrades any such hint to Opus 4.8 unless the caller
// has cleared the gate. Case-insensitive substring match on "fable" so
// suffixed/aliased variants (e.g. "claude-fable-5@high", "Claude-Fable-5") are
// caught too. The model id itself (`claude-fable-5`) is the canonical string
// used everywhere else.
export const SPARK_WORKER_FABLE_FALLBACK = "claude-opus-4-8" as const;

// Manager sessions keep the system prompt they were born with for the whole
// run, so a run started before a model-roster update keeps emitting the old
// mid-tier id (observed: run-mr7vuzog kept requesting claude-sonnet-4-6 after
// the prompts moved to claude-sonnet-5). Remap superseded Sonnet ids here at
// the spawn chokepoint — same capability tier, same price, strictly better
// model — preserving any "@effort" suffix. Bare aliases are covered too:
// managers have shipped raw variants like "sonnet-4-6" across runs. "-legacy"/
// other suffixed ids stay untouched (the anchor requires the id to END at the
// version digits).
const SUPERSEDED_SONNET_BASE = /^(claude-)?sonnet-4(-\d+)?$/i;
const SPARK_WORKER_SONNET_CURRENT = "claude-sonnet-5" as const;

export function sanitizeWorkerModelHint(
  hint: string | undefined,
  opts?: { allowFable?: boolean },
): { hint: string | undefined; downgraded: boolean } {
  if (hint && /fable/i.test(hint)) {
    // Pass a fable hint through UNCHANGED only when the caller has cleared the
    // explicit-request gate (workerFableAllowed): the Fable setting is on AND
    // the user named Fable in their own message this run. Otherwise downgrade
    // to Opus 4.8 and report it so the swap isn't silent.
    if (opts?.allowFable) return { hint, downgraded: false };
    return { hint: SPARK_WORKER_FABLE_FALLBACK, downgraded: true };
  }
  if (hint) {
    const at = hint.indexOf("@");
    const base = (at >= 0 ? hint.slice(0, at) : hint).trim();
    if (SUPERSEDED_SONNET_BASE.test(base)) {
      const suffix = at >= 0 ? hint.slice(at) : "";
      return { hint: `${SPARK_WORKER_SONNET_CURRENT}${suffix}`, downgraded: false };
    }
  }
  return { hint, downgraded: false };
}

// Did the user explicitly ask for Fable 5 in their OWN message this run? We scan
// only user-authored chat text — author "user" and the note/answer kinds a human
// types — never manager or worker output, so a worker echoing "fable" in its
// report cannot self-authorize the most expensive tier. Any user message that
// mentions fable latches the allowance on for the rest of the run (matching
// "use it only if I explicitly tell it"). Callers combine this with the
// "fableEnabled" preference (see workerFableAllowed in run-store.ts).
export function runUserRequestedFable(run: RunState): boolean {
  return run.humanMessages.some(
    (m) =>
      m.author === "user" &&
      (m.kind === "note" || m.kind === "answer") &&
      /fable/i.test(m.message),
  );
}
