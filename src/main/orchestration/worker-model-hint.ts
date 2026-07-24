// Worker model-hint sanitization.
//
// Split out of run-store.ts so the pure decision logic can be unit-tested
// without dragging in run-store's electron/pty/git dependencies (see
// scripts/test-worker-model-hint.cjs). This module imports ONLY types, so
// esbuild erases every import and the bundle is dependency-free.

import { normalizeCodexModelId } from "@shared/model-catalog";

// The model a Claude worker launches on when its task carries NO modelHint.
// Any explicit hint — including Fable 5 (`claude-fable-5`), Anthropic's top,
// most expensive tier — passes through as given, but an OMITTED hint must
// never delegate the choice to the CLI/subscription default: that default can
// be Fable 5, and a planner that didn't ask for the premium tier shouldn't
// land on it silently. Opus 4.8 is the documented worker fallback.
export const WORKER_DEFAULT_CLAUDE_MODEL = "claude-opus-4-8" as const;

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

export function sanitizeWorkerModelHint(hint: string | undefined): string | undefined {
  if (hint) {
    const at = hint.indexOf("@");
    const base = (at >= 0 ? hint.slice(0, at) : hint).trim();
    if (SUPERSEDED_SONNET_BASE.test(base)) {
      const suffix = at >= 0 ? hint.slice(at) : "";
      return `${SPARK_WORKER_SONNET_CURRENT}${suffix}`;
    }
    const normalizedCodex = normalizeCodexModelId(hint);
    if (normalizedCodex !== hint) {
      return normalizedCodex;
    }
  }
  return hint;
}
