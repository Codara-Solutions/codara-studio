import type { AgentEffortLevel } from "@shared/types";
import { CODEX_MODEL_CATALOG, DEFAULT_LOOM_WORKER_MODEL } from "@shared/model-catalog";
import { ALL_EFFORTS, EFFORT_LABELS } from "../chat/composer/types";

// Single source of truth for the automation worker model roster. Workers run
// on the bundled Pi runtime, so the knobs are MODEL and EFFORT only — there is
// no engine choice and no install/auth gating to render. The effort ladder and
// its labels are shared with the chat composer so the same word means the same
// thing on both surfaces.
//
// This roster is deliberately WIDER than the one Cora uses for the workers it
// spawns mid-chat (see worker-model-hint.ts, where anything off-roster is
// coerced). An automation is configured once, by hand, for a job whose shape
// the user already knows, so the cheaper Codex tiers are a real choice here:
// a nightly file-shuffle does not need the frontier model. Nothing downstream
// filters these, the automation path passes a pinned model through verbatim
// (run-store's piModelForWorker) and validation is a shape check, not an
// allowlist (agent-socket's validateConcreteWorker).

export interface WorkerModelOption {
  id: string;
  label: string;
  /** One-word positioning shown beside the label in pickers. */
  note: string;
  /** Effort levels this model accepts. */
  effortLevels: AgentEffortLevel[];
}

// The GPT entries are derived from the shared Codex catalog rather than
// restated, so a catalog change (a new variant, a changed effort ladder)
// reaches this picker without a second edit. None of the GPT-5.6 models take
// "minimal"; claude-* models take the full six-level ladder.
const CODEX_NOTES: Record<string, string> = {
  "gpt-5.6-sol": "frontier",
  "gpt-5.6-terra": "balanced",
  "gpt-5.6-luna": "fast",
};

const CODEX_WORKER_MODELS: WorkerModelOption[] = CODEX_MODEL_CATALOG.map((entry) => ({
  id: entry.id,
  label: entry.label,
  note: CODEX_NOTES[entry.id] ?? entry.tier,
  effortLevels: [...entry.effortLevels],
}));

export const WORKER_MODELS: WorkerModelOption[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "standard", effortLevels: ALL_EFFORTS },
  { id: "claude-fable-5", label: "Fable 5", note: "premium", effortLevels: ALL_EFFORTS },
  ...CODEX_WORKER_MODELS,
];

export const DEFAULT_WORKER_MODEL = DEFAULT_LOOM_WORKER_MODEL;
export const DEFAULT_WORKER_EFFORT: AgentEffortLevel = "medium";

export { EFFORT_LABELS };

/** Friendly label for a stored model id; falls back to the raw id so a model
 *  outside the curated roster still names itself. */
export function workerModelLabel(id: string | undefined): string {
  if (!id) return "Worker";
  return WORKER_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** The effort ladder for a model: its roster entry's list, or the full ladder
 *  for an unrecognized id (Pi passes unmapped levels through to the provider,
 *  so over-offering is harmless; silently narrowing would escalate a pick). */
export function workerEffortsFor(modelId: string | undefined): AgentEffortLevel[] {
  if (!modelId) return ALL_EFFORTS;
  return WORKER_MODELS.find((m) => m.id === modelId)?.effortLevels ?? ALL_EFFORTS;
}
