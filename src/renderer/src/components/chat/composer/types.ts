import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  ChatBackendKind,
  ChatMode,
  PiCatalogModel,
} from "@shared/types";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";

// Per-model option used in the model picker. Each row is either a "real" id
// the backend understands directly (e.g. "claude-opus-4-8", "gpt-5.6-sol") or a
// virtual id with the `:1m` suffix that the composer decomposes into the
// base model id plus chat1mContext=true on pick. The backend never sees a
// `:1m` id.
export interface ChatModelOption {
  id: string;
  label: string;
  backend: ChatBackendKind;
  effortLevels?: AgentEffortLevel[];
  isOneMillion?: boolean;
  description?: string;
  badge?: string;
}

export interface ChatBackendGroup {
  backend: ChatBackendKind;
  label: string;
  models: ChatModelOption[];
}

const ONEM_SUFFIX = ":1m" as const;

// Master effort list (used for OpenRouter and as the fallback when a CLI
// model doesn't pin a narrower set).
export const ALL_EFFORTS: AgentEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Catalogs. Claude and Codex are fixed; the OpenRouter "API" group is built
// dynamically from settings.openRouterModel at render time (one row, the
// configured model). Claude Code is always shown as 1M-context rows only,
// so selecting Opus/Sonnet always sets chat1mContext=true.
const CLAUDE_MODELS: ChatModelOption[] = [
  {
    id: "claude-opus-4-8:1m",
    label: "Opus 4.8 1M",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isOneMillion: true,
    description: "Highest-quality Claude model for complex project work.",
    badge: "Flagship",
  },
  {
    id: "claude-sonnet-5:1m",
    label: "Sonnet 5 1M",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isOneMillion: true,
    description: "Fast, capable everyday model with a one-million-token context.",
    badge: "Balanced",
  },
  {
    // Fable is always available, but it comes last: a fresh chat must default
    // to Opus (the first row), never drift onto the premium tier by accident.
    id: "claude-fable-5",
    label: "Fable 5",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    description: "Premium Claude tier; use intentionally for the hardest work.",
    badge: "Premium",
  },
];

const CODEX_MODELS: ChatModelOption[] = CODEX_MODEL_CATALOG.map((model) => ({
  id: model.id,
  label: model.label,
  backend: "codex",
  effortLevels: [...model.effortLevels],
  description: model.description,
  badge:
    model.tier === "top"
      ? "Flagship"
      : model.tier === "mid"
        ? "Balanced"
        : "Fast",
}));

const PI_MODELS: ChatModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    description: "Cora's pinned Pi runtime using the Codex subscription. The default route for serious project work.",
    badge: "Recommended",
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    description: "Cora's pinned Pi runtime using the Claude subscription for the hardest work.",
    badge: "Premium",
  },
];

export const DEFAULT_CHAT_BACKEND: ChatBackendKind = "pi";
export const DEFAULT_CHAT_MODEL = "gpt-5.6-sol";
export const DEFAULT_CHAT_MODE: ChatMode = "auto";
export const DEFAULT_CHAT_EFFORT: AgentEffortLevel = "high";

export const EFFORT_LABELS: Record<AgentEffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

const EFFORT_ORDER: AgentEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_BARS: Record<AgentEffortLevel, number> = {
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export const THINKING_BAR_COUNT = 5;

export function barsForEffort(effort: AgentEffortLevel | undefined): number {
  if (!effort) return 0;
  return EFFORT_BARS[effort] ?? 0;
}

export function nextEffort(
  current: AgentEffortLevel | undefined,
  allowed: AgentEffortLevel[],
): AgentEffortLevel {
  if (allowed.length === 0) return current ?? "medium";
  const idx = current ? allowed.indexOf(current) : -1;
  return allowed[(idx + 1) % allowed.length];
}

export function clampEffort(
  current: AgentEffortLevel | undefined,
  allowed: AgentEffortLevel[],
): AgentEffortLevel | undefined {
  if (allowed.length === 0) return undefined;
  if (current && allowed.includes(current)) return current;
  const target = current ? EFFORT_ORDER.indexOf(current) : EFFORT_ORDER.indexOf("medium");
  let best = allowed[0];
  let bestDist = Infinity;
  for (const lvl of allowed) {
    const d = Math.abs(EFFORT_ORDER.indexOf(lvl) - target);
    if (d < bestDist) {
      bestDist = d;
      best = lvl;
    }
  }
  return best;
}

// Build the visible groups for the model dropdown. Filters by availability:
//   * Claude/Codex groups appear only when the runtime is installed and not
//     disabled in settings (per agents.runtimes() diagnostics).
//   * API group appears only when settings.openRouterModel is non-empty, and
//     contains exactly that one row (matching vienna).
// Returns an empty array before diagnostics load (rendered as a friendly
// empty-state in the menu).
export function buildVisibleGroups({
  diagnostics,
  openRouterModel,
  piCatalog = [],
}: {
  diagnostics: AgentRuntimeDiagnostic[];
  openRouterModel: string;
  /** Models Pi reports as usable by the connected subscriptions right now.
   * Merged under the curated rows so a model released after this build is
   * selectable without a code change. */
  piCatalog?: PiCatalogModel[];
}): ChatBackendGroup[] {
  const groups: ChatBackendGroup[] = [];
  // Pi is bundled and version-pinned with Studio. OAuth readiness is checked
  // at launch so the picker can expose the experimental backend without
  // pretending it is one of the native worker CLIs.
  // Pi spans both providers, so each side is trimmed against its own rule and
  // the survivors are then re-read in the ORIGINAL row order. Concatenating the
  // two filtered lists instead would reorder the group, and the first row of
  // this group is the default chat model — that alone would silently move the
  // default off Sol.
  const piMerged = mergePiModels(PI_MODELS, piCatalog);
  const isCodexModel = (model: ChatModelOption): boolean =>
    /^gpt-/i.test(decomposeModelId(model.id).baseId);
  const piKept = new Set([
    ...keepCurrentGeneration(piMerged.filter((m) => !isCodexModel(m)), "anthropic").map((m) => m.id),
    ...keepCurrentGeneration(piMerged.filter(isCodexModel), "openai").map((m) => m.id),
  ]);
  groups.push({
    backend: "pi",
    label: "Cora · Pi",
    models: piMerged.filter((model) => piKept.has(model.id)),
  });
  // The CLI groups get the same live catalog, scoped to the provider each one
  // actually talks to. Claude Code runs Anthropic models and Codex runs OpenAI
  // models, so a newly released model belongs in these lists too — merging only
  // into the Pi group above was why a just-shipped Opus did not appear here.
  if (isAvailable(diagnostics, "claude")) {
    groups.push({
      backend: "claude",
      label: labelFor(diagnostics, "claude", "Claude Code"),
      models: keepCurrentGeneration(
        mergeCatalogModels(CLAUDE_MODELS, piCatalog, "anthropic", "claude"),
        "anthropic",
      ),
    });
  }
  if (isAvailable(diagnostics, "codex")) {
    groups.push({
      backend: "codex",
      label: labelFor(diagnostics, "codex", "Codex"),
      models: keepCurrentGeneration(
        mergeCatalogModels(CODEX_MODELS, piCatalog, "openai-codex", "codex"),
        "openai",
      ),
    });
  }
  const apiModel = openRouterModel.trim();
  if (apiModel) {
    groups.push({
      backend: "openrouter",
      label: "API",
      models: [{ id: apiModel, label: apiModel, backend: "openrouter" }],
    });
  }
  return groups;
}

/**
 * Union Pi's live catalog under the curated Pi rows.
 *
 * Curated rows win on presentation and ordering — they carry the labels,
 * badges, descriptions and hand-tuned effort ladders — so they stay exactly
 * where they are. Anything Pi reports that isn't already covered is appended
 * as a plain row using the vendor's own name. That is the whole point: the day
 * a new model ships, it is selectable, and a nicer curated entry can follow
 * later without blocking the user in the meantime.
 *
 * Dynamic rows deliberately do NOT pin effortLevels: they fall through to
 * effortsFor()'s ALL_EFFORTS, matching findOptionInCatalog (which only knows
 * the static rows and so also yields ALL_EFFORTS for a selected dynamic model).
 * Pi passes an unmapped level through to the provider rather than rejecting
 * it, so over-offering a level is harmless — whereas deriving a narrowed
 * ladder here silently escalated a picked effort (e.g. "high" → "xhigh" on
 * claude-opus-4-8, whose thinking map only lists xhigh/max).
 */
function mergeCatalogModels(
  curated: ChatModelOption[],
  catalog: PiCatalogModel[],
  provider: PiCatalogModel["provider"] | null,
  backend: ChatBackendKind,
): ChatModelOption[] {
  const scoped = provider === null ? catalog : catalog.filter((m) => m.provider === provider);
  if (scoped.length === 0) return curated;
  // Compare on the base id so a curated `:1m` row still suppresses the plain
  // dynamic row for the same underlying model.
  const covered = new Set(curated.map((option) => decomposeModelId(option.id).baseId));
  const extras: ChatModelOption[] = [];
  for (const model of scoped) {
    if (covered.has(model.id)) continue;
    covered.add(model.id);
    extras.push({ id: model.id, label: model.label, backend });
  }
  return extras.length > 0 ? [...curated, ...extras] : curated;
}

/** The Pi group spans both providers, so it takes the catalog unscoped. */
function mergePiModels(
  curated: ChatModelOption[],
  catalog: PiCatalogModel[],
): ChatModelOption[] {
  return mergeCatalogModels(curated, catalog, null, "pi");
}

// ---------------------------------------------------------------------------
// Current-generation filter
//
// The live catalog carries every model a provider still serves, including long
// superseded ones (gpt-5.3-codex-spark, claude-opus-4-1). The picker should
// offer the current lineup only. This is expressed as a RULE rather than a list
// of ids, so the day Opus 6 or GPT-5.7 ships it takes over automatically —
// which is the entire reason the catalog is dynamic in the first place.
//
// The two providers need different rules because they version differently:
//   * OpenAI ships a generation at a time (5.6 sol/terra/luna), so keep every
//     model at the highest generation and drop earlier ones wholesale.
//   * Anthropic ships tiers on independent cadences (Sonnet 5 alongside Opus
//     4.8), so keep the newest release of each tier instead. Anchoring to a
//     single highest version would delete a whole tier the moment one tier
//     moved ahead — including offline, where the curated rows are all we have.
// ---------------------------------------------------------------------------

/** Small/cheap tiers Cora does not offer as a chat model. */
const MINOR_TIER_PATTERN = /haiku|mini|spark/i;

/** Numeric version embedded in a model id, most significant first. */
function versionOf(id: string): number[] {
  const numbers = id.match(/\d+/g);
  return numbers ? numbers.map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Anthropic tier: the word between "claude-" and the version ("opus", "sonnet"). */
function claudeTier(baseId: string): string | null {
  const match = /^claude-([a-z]+)/i.exec(baseId);
  return match ? match[1].toLowerCase() : null;
}

/** OpenAI generation: the leading major.minor ("gpt-5.6-sol" -> [5, 6]). */
function codexGeneration(baseId: string): number[] | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(baseId);
  if (!match) return null;
  return match[2] === undefined ? [Number(match[1])] : [Number(match[1]), Number(match[2])];
}

/**
 * Reduce a group to the current lineup. Anything whose id does not parse is
 * KEPT — an unrecognized id is far more likely to be a brand-new naming scheme
 * than something stale, and silently hiding a just-released model is exactly
 * the failure this whole mechanism exists to prevent.
 */
function keepCurrentGeneration(
  models: ChatModelOption[],
  provider: "anthropic" | "openai",
): ChatModelOption[] {
  if (models.length === 0) return models;

  if (provider === "openai") {
    let newest: number[] | null = null;
    for (const model of models) {
      const generation = codexGeneration(decomposeModelId(model.id).baseId);
      if (generation && (newest === null || compareVersions(generation, newest) > 0)) {
        newest = generation;
      }
    }
    if (newest === null) return models;
    return models.filter((model) => {
      const baseId = decomposeModelId(model.id).baseId;
      if (MINOR_TIER_PATTERN.test(baseId)) return false;
      const generation = codexGeneration(baseId);
      return generation === null || compareVersions(generation, newest) === 0;
    });
  }

  // Anthropic: newest release per tier.
  const newestByTier = new Map<string, number[]>();
  for (const model of models) {
    const baseId = decomposeModelId(model.id).baseId;
    const tier = claudeTier(baseId);
    if (!tier || MINOR_TIER_PATTERN.test(baseId)) continue;
    const version = versionOf(baseId);
    const best = newestByTier.get(tier);
    if (!best || compareVersions(version, best) > 0) newestByTier.set(tier, version);
  }
  const survives = (model: ChatModelOption): boolean => {
    const baseId = decomposeModelId(model.id).baseId;
    if (MINOR_TIER_PATTERN.test(baseId)) return false;
    const tier = claudeTier(baseId);
    if (!tier) return true;
    const best = newestByTier.get(tier);
    return !best || compareVersions(versionOf(baseId), best) === 0;
  };

  // Order matters beyond tidiness: the first row of the Claude group is the
  // default chat model. A superseded row is therefore REPLACED IN PLACE by its
  // successor rather than dropped — otherwise retiring Opus 4.8 would silently
  // promote whatever sat below it (Sonnet) to the default, and strand the new
  // Opus at the bottom of the list.
  const ordered: ChatModelOption[] = [];
  const placed = new Set<string>();
  for (const model of models) {
    if (survives(model)) {
      if (!placed.has(model.id)) {
        placed.add(model.id);
        ordered.push(model);
      }
      continue;
    }
    const tier = claudeTier(decomposeModelId(model.id).baseId);
    if (!tier) continue;
    const successor = models.find(
      (candidate) =>
        !placed.has(candidate.id) &&
        survives(candidate) &&
        claudeTier(decomposeModelId(candidate.id).baseId) === tier,
    );
    if (successor) {
      placed.add(successor.id);
      ordered.push(successor);
    }
  }
  return ordered;
}

// Authoritative override: hide a runtime when diagnostics report it as
// uninstalled. If diagnostics are empty (haven't loaded yet) or there's no
// entry for the kind, default to showing — let the user pick; a launch
// failure will surface a clear error if it's genuinely missing.
function isAvailable(
  diagnostics: AgentRuntimeDiagnostic[],
  kind: "claude" | "codex",
): boolean {
  if (diagnostics.length === 0) return false;
  const entry = diagnostics.find((d) => d.kind === kind);
  if (!entry) return false;
  return entry.installed === true;
}

function labelFor(
  diagnostics: AgentRuntimeDiagnostic[],
  kind: "claude" | "codex",
  fallback: string,
): string {
  return diagnostics.find((d) => d.kind === kind)?.label ?? fallback;
}

// Decompose a virtual model id into the real backend id + the chat1mContext
// flag. The composer calls this when the picker fires onPick so the existing
// backend payload (chatModel, chat1mContext) is preserved unchanged.
export function decomposeModelId(id: string): {
  baseId: string;
  oneMillion: boolean;
} {
  if (id.endsWith(ONEM_SUFFIX)) {
    return { baseId: id.slice(0, -ONEM_SUFFIX.length), oneMillion: true };
  }
  return { baseId: id, oneMillion: false };
}

// Inverse of decompose. Used to figure out which dropdown row to highlight
// given the run's current (chatModel, chat1mContext) state.
export function composeModelId(baseId: string, oneMillion: boolean): string {
  return oneMillion ? `${baseId}${ONEM_SUFFIX}` : baseId;
}

// Find the dropdown option that matches the current (backend, model, 1M)
// triple. Returns null when no row matches (e.g. an older run was using an
// OpenRouter model the user has since changed in settings).
export function findChatModel(
  backend: ChatBackendKind,
  modelId: string,
  oneMillion: boolean,
  groups: ChatBackendGroup[],
): ChatModelOption | null {
  const compoundId = composeModelId(modelId, oneMillion);
  for (const group of groups) {
    if (group.backend !== backend) continue;
    const hit = group.models.find((m) => m.id === compoundId);
    if (hit) return hit;
  }
  return null;
}

// Pick a sensible fallback option when the current selection isn't in the
// visible groups (e.g. the user disabled the runtime in settings). Prefers
// the same backend; falls back to the first group's first model.
export function fallbackChatModel(
  backend: ChatBackendKind,
  groups: ChatBackendGroup[],
): ChatModelOption | null {
  const same = groups.find((g) => g.backend === backend);
  if (same && same.models.length > 0) return same.models[0];
  if (groups.length > 0 && groups[0].models.length > 0) return groups[0].models[0];
  return null;
}

// The effort cycle for a model. OpenRouter has the full effort list; CLI
// models use their pinned list. Empty (CLI without pin) falls back to ALL.
export function effortsFor(option: ChatModelOption | null): AgentEffortLevel[] {
  if (!option) return ALL_EFFORTS;
  if (option.backend === "openrouter") return ALL_EFFORTS;
  if (option.effortLevels && option.effortLevels.length > 0) return option.effortLevels;
  return ALL_EFFORTS;
}

// Find a model in the STATIC catalog (Claude/Codex), ignoring availability.
// Used by the composer to derive effort levels for the current selection
// without needing the diagnostics IPC — effort lists never depend on whether
// the runtime is installed. OpenRouter rows aren't in the catalog (the
// configured model is dynamic) so this returns null for that backend; the
// caller should treat that as "use ALL_EFFORTS".
export function findOptionInCatalog(
  backend: ChatBackendKind,
  modelId: string,
  oneMillion: boolean,
): ChatModelOption | null {
  const compoundId = composeModelId(modelId, oneMillion);
  if (backend === "claude") {
    return CLAUDE_MODELS.find((m) => m.id === compoundId) ?? null;
  }
  if (backend === "codex") {
    return CODEX_MODELS.find((m) => m.id === compoundId) ?? null;
  }
  if (backend === "pi") {
    return PI_MODELS.find((m) => m.id === compoundId) ?? null;
  }
  return null;
}
