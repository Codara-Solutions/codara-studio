import { familyForModelId } from "./agent-families";
import type { AgentModelTier, AgentRuntimeKind, AgentRuntimeModel } from "./types";

// Canonical Codex model catalog shared by the main process, Cora's chat
// composer, and the automation editor. Keeping this in @shared prevents the
// three surfaces from drifting back to the old "Codex has one model" world.
//
// OpenAI's current Codex catalog exposes the GPT-5.6 family as:
//   Sol   — flagship quality for complex/open-ended work
//   Terra — balanced everyday implementation work
//   Luna  — fast, efficient, well-scoped work
//
// `gpt-5.6` is an accepted service alias for Sol, but we intentionally show
// the concrete variants in pickers so the user's quality/cost choice is
// explicit and persists predictably.
export type CodexModelId =
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna";

export interface CodexModelCatalogEntry extends AgentRuntimeModel {
  id: CodexModelId;
  description: string;
  shortLabel: "Sol" | "Terra" | "Luna";
}

const GPT_56_EFFORTS: AgentRuntimeModel["effortLevels"] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const CODEX_MODEL_CATALOG: CodexModelCatalogEntry[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    shortLabel: "Sol",
    description: "Flagship quality for complex coding, research, and polished project work.",
    effortLevels: [...GPT_56_EFFORTS],
    isDefault: true,
    tier: "top",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    shortLabel: "Terra",
    description: "Balanced capability and speed for everyday implementation work.",
    effortLevels: [...GPT_56_EFFORTS],
    tier: "mid",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    shortLabel: "Luna",
    description: "Fast, efficient execution for clear and repeatable tasks.",
    effortLevels: [...GPT_56_EFFORTS],
    tier: "cheap",
  },
];

export const DEFAULT_CODEX_CHAT_MODEL: CodexModelId = "gpt-5.6-sol";
export const DEFAULT_CODEX_WORKER_MODEL: CodexModelId = "gpt-5.6-terra";

export const CODEX_MODEL_BY_TIER: Record<AgentModelTier, CodexModelId> = {
  top: "gpt-5.6-sol",
  mid: "gpt-5.6-terra",
  cheap: "gpt-5.6-luna",
};

// Long-lived Cora sessions and persisted looms can retain model ids from the
// prompt/catalog they were created with. Normalize known OpenAI predecessors at
// launch/edit boundaries so an old session cannot keep pinning a deprecated
// model after the app upgrades. Unknown ids pass through for forward
// compatibility; an optional `@effort` suffix is preserved.
export function normalizeCodexModelId(modelId: string): string {
  const at = modelId.indexOf("@");
  const base = (at >= 0 ? modelId.slice(0, at) : modelId).trim().toLowerCase();
  const suffix = at >= 0 ? modelId.slice(at) : "";
  const replacement: CodexModelId | undefined =
    base === "gpt-5.6" || base === "gpt-5.5"
      ? "gpt-5.6-sol"
      : base === "gpt-5.4"
        ? "gpt-5.6-terra"
        : base === "gpt-5.4-mini" || base === "gpt-5.3-codex-spark"
          ? "gpt-5.6-luna"
          : undefined;
  return replacement ? `${replacement}${suffix}` : modelId;
}

// ── Looms on Pi ─────────────────────────────────────────────────────────────
// Automation workers run exclusively on the bundled Pi runtime; the model id
// alone selects the subscription provider, so the old per-worker engine choice
// is gone. These helpers keep the model→provider mapping in one place for the
// scheduler migration, the loop driver, and the automation editor.

/** Default automation worker model when nothing usable was configured. */
export const DEFAULT_LOOM_WORKER_MODEL = "claude-opus-5";
/** Backfill for a legacy codex-engine loom that never pinned a model. */
export const DEFAULT_LOOM_CODEX_WORKER_MODEL: CodexModelId = "gpt-5.6-sol";

/** Which worker runtime family a loom model id belongs to. */
export function loomRuntimeForModel(model: string | undefined): AgentRuntimeKind {
  return familyForModelId(model) ?? "claude";
}
