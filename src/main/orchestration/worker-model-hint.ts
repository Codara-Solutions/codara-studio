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
export const WORKER_DEFAULT_CLAUDE_MODEL = "claude-opus-5" as const;

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

// ── The worker model roster ─────────────────────────────────────────────────
//
// Cora may route a worker to exactly three models:
//
//   claude-opus-5   standard   Anthropic's workhorse
//   gpt-5.6-sol       standard   OpenAI's frontier
//   claude-fable-5    premium    strongest, materially more expensive
//
// Excluded on purpose, and coerced away below rather than merely discouraged
// in a prompt:
//   gpt-5.6-terra, gpt-5.6-luna   below the bar for autonomous worker runs
//   claude-sonnet-*               too token-hungry for what it returns
//
// TIERS ARE THE CONTRACT; IDS ARE A DETAIL. Nothing downstream should ever
// hardcode "sol" or "opus", when a provider ships its next frontier model,
// change the id in this one table and every prompt, tool schema, spawn path,
// and fallback follows. That is the whole reason this indirection exists.
export type WorkerModelTier = "standard" | "premium";

export type RosterRuntime = "claude" | "codex";

export const WORKER_MODEL_ROSTER: Record<RosterRuntime, Record<WorkerModelTier, string>> = {
  claude: { standard: WORKER_DEFAULT_CLAUDE_MODEL, premium: "claude-fable-5" },
  // OpenAI contributes a single allowed model, so both tiers resolve to it.
  // Stated plainly rather than hidden: asking for the premium tier on the
  // codex runtime gets the frontier model, not a more expensive one.
  codex: { standard: "gpt-5.6-sol", premium: "gpt-5.6-sol" },
};

/** Every model id a worker is allowed to launch on, deduped. */
export const ALLOWED_WORKER_MODELS: readonly string[] = [
  ...new Set(
    Object.values(WORKER_MODEL_ROSTER).flatMap((tiers) => Object.values(tiers)),
  ),
];

export function rosterModelFor(runtime: RosterRuntime, tier: WorkerModelTier): string {
  return WORKER_MODEL_ROSTER[runtime][tier];
}

/**
 * Force a model hint onto the roster for its runtime.
 *
 * A planner can emit anything, a stale id from a long-lived session, a model
 * the user disallowed, a typo, a bare alias. This is the chokepoint that makes
 * the roster real: it never rejects, it always lands on the nearest allowed
 * model, so a bad hint degrades to a good default instead of failing a spawn.
 * An `@effort` suffix is preserved.
 */
export function coerceWorkerModelToRoster(
  runtime: string,
  hint: string | undefined,
): string | undefined {
  if (runtime !== "claude" && runtime !== "codex") return hint;
  const tiers = WORKER_MODEL_ROSTER[runtime];

  const raw = sanitizeWorkerModelHint(hint?.trim() || undefined);
  if (!raw) return tiers.standard;
  const at = raw.indexOf("@");
  const base = (at >= 0 ? raw.slice(0, at) : raw).trim().toLowerCase();
  const suffix = at >= 0 ? raw.slice(at) : "";

  if (base === tiers.standard || base === tiers.premium) return `${base}${suffix}`;
  // Fable is the only premium tier, and it is Anthropic-only. Honour an
  // explicit ask for it on the claude runtime; on codex there is nothing to
  // honour it with, so the frontier model stands in.
  if (runtime === "claude" && /fable/.test(base)) return `${tiers.premium}${suffix}`;
  return `${tiers.standard}${suffix}`;
}
