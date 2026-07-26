import type {
  AgentEffortLevel,
  ChatBackendKind,
  ChatMode,
  PiCatalogModel,
} from "@shared/types";
import { CODEX_MODEL_CATALOG } from "@shared/model-catalog";

// Per-model option used in the model picker. Each row is either a "real" id
// the backend understands directly (e.g. "claude-opus-5", "gpt-5.6-sol") or a
// virtual id with the `:1m` suffix that the composer decomposes into the
// base model id plus chat1mContext=true on pick. The backend never sees a
// `:1m` id.
export interface ChatModelOption {
  id: string;
  label: string;
  backend: ChatBackendKind;
  effortLevels?: AgentEffortLevel[];
  isOneMillion?: boolean;
  /** Deliberate sort position within a group; see MODEL_RANK / TIER_RANK. */
  rank?: number;
}

export interface ChatBackendGroup {
  /**
   * Unique per rendered group. Distinct from `backend` because Cora now runs
   * only on Pi, and that single backend is split into two groups by vendor, so
   * `backend` is no longer unique across the list.
   */
  key: string;
  backend: ChatBackendKind;
  /**
   * The harness heading, rendered ONCE above every consecutive group that
   * shares it. All rows run on Pi, so this reads "Cora · Pi" for the whole
   * menu and `label` below only says which vendor the model comes from.
   * Without this split the vendor names looked like separate backends.
   */
  section: string;
  /** The vendor the models come from, e.g. "OpenAI" or "Anthropic". */
  label: string;
  models: ChatModelOption[];
}

const ONEM_SUFFIX = ":1m" as const;

/** Every row runs on Pi, so the whole menu sits under one harness heading. */
const PI_SECTION = "Cora · Pi";

// Master effort list, the fallback for any model that doesn't pin a
// narrower set of its own.
export const ALL_EFFORTS: AgentEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Curated rows. PI_MODELS seeds the picker and is merged with whatever the live
// catalog reports. CLAUDE_MODELS / CODEX_MODELS are no longer rendered as
// groups (Cora is Pi-only) but are still read by findOptionInCatalog, so a run
// persisted on a CLI backend keeps a friendly label instead of a raw id.
const CLAUDE_MODELS: ChatModelOption[] = [
  {
    // Kept in step with WORKER_DEFAULT_CLAUDE_MODEL. When this row named an
    // older Opus than the one the live catalog serves, keepCurrentGeneration
    // replaced it a moment after the menu opened, so the row visibly changed
    // from "Opus 4.8 1M" to "Opus 5" under the cursor.
    id: "claude-opus-5:1m",
    label: "Opus 5 1M",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isOneMillion: true,
  },
  {
    id: "claude-sonnet-5:1m",
    label: "Sonnet 5 1M",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    isOneMillion: true,
  },
  {
    // Fable is always available, but it comes last: a fresh chat must default
    // to Opus (the first row), never drift onto the premium tier by accident.
    id: "claude-fable-5",
    label: "Fable 5",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

const CODEX_MODELS: ChatModelOption[] = CODEX_MODEL_CATALOG.map((model) => ({
  id: model.id,
  label: model.label,
  backend: "codex",
  effortLevels: [...model.effortLevels],
}));

const PI_MODELS: ChatModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

// ── Ordering ────────────────────────────────────────────────────────────────
//
// Rows render as a bare name: no blurb, no tier card. Order is the only signal
// the list gives, which makes it the thing worth getting right, so it is a
// deliberate rank rather than whatever sequence Pi's API happened to emit.
// Ranking on this table (not on arrival order) is also what keeps the list
// stable between catalog refreshes.
//
// Models discovered from the live catalog have no curated row at all, so the
// match is on the BASE id (version digits and any `:1m` suffix already
// stripped) and anything unrecognized sorts last, a model that shipped after
// this build is still selectable, just not promoted above the known lineup.

// Premium sits at the TOP of its vendor group: Fable is the strongest Claude
// model, so it leads the Anthropic list.
//
// This ordering used to double as the safeguard that a fresh chat never opens
// on the premium tier, by ranking premium dead last. That was always a fragile
// way to express it, because the ordering also has to serve presentation. The
// guarantee now lives in defaultChatModel() as an explicit rule, which is both
// stronger (it holds no matter how these ranks are tuned, and no matter which
// group ends up first) and honest about being a spend guard rather than taste.
const TIER_RANK = {
  recommended: 0,
  premium: 1,
  flagship: 2,
  balanced: 3,
  fast: 4,
  unknown: 5,
} as const;

const MODEL_RANK: Array<{ match: RegExp; rank: number }> = [
  { match: /^gpt-5\.6-sol$/i, rank: TIER_RANK.recommended },
  { match: /fable/i, rank: TIER_RANK.premium },
  { match: /opus/i, rank: TIER_RANK.flagship },
  { match: /^gpt-5\.6-terra$/i, rank: TIER_RANK.balanced },
  { match: /sonnet/i, rank: TIER_RANK.balanced },
  { match: /^gpt-5\.6-luna$/i, rank: TIER_RANK.fast },
  { match: /haiku/i, rank: TIER_RANK.fast },
];

function modelRankFor(id: string): number {
  const base = decomposeModelId(id).baseId;
  return MODEL_RANK.find(({ match }) => match.test(base))?.rank ?? TIER_RANK.unknown;
}

/** Give a row its sort position if it does not already pin one. */
function withModelRank(option: ChatModelOption): ChatModelOption {
  return { ...option, rank: option.rank ?? modelRankFor(option.id) };
}

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

// Build the visible groups for the model dropdown. Cora runs on Pi only, so
// every row is a Pi model; the list is split into two groups by model family.
export function buildVisibleGroups({
  piCatalog = [],
}: {
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
  const codexModels = keepCurrentGeneration(piMerged.filter(isCodexModel), "openai");
  const claudeModels = keepCurrentGeneration(
    piMerged.filter((model) => !isCodexModel(model)),
    "anthropic",
  );
  // Split by model family rather than listed flat. The two families were
  // interleaved by rank, which read as one arbitrary list once the rows lost
  // their tier badges.
  //
  // Codex leads because the default chat model is the first row of the first
  // group (several call sites read groups[0].models[0]) and Sol is rank 0.
  // Sorting within each family keeps the premium tier last inside its own
  // group, so Fable still cannot become the default.
  groups.push({
    key: "pi-openai",
    backend: "pi",
    section: PI_SECTION,
    label: "OpenAI",
    models: sortByRank(codexModels),
  });
  groups.push({
    key: "pi-anthropic",
    backend: "pi",
    section: PI_SECTION,
    label: "Anthropic",
    models: sortByRank(claudeModels),
  });
  // No Claude Code / Codex CLI groups: those ran CORA ITSELF on a local CLI
  // instead of Pi, which is a manager-harness choice, not a model choice, and
  // it confused the menu into looking like three ways to pick the same models.
  // Cora is Pi-only now. This does not touch WORKER runtimes: Cora still spawns
  // Claude Code and Codex CLI workers, chosen per task via runtimePreference.
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
 * claude-opus-5, whose thinking map only lists xhigh/max).
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
    // A discovered model arrives with only these three fields, so it has no
    // sort position of its own; withModelRank gives it a deterministic one.
    extras.push(withModelRank({ id: model.id, label: model.label, backend }));
  }
  return extras.length > 0 ? [...curated, ...extras] : curated;
}

/**
 * Order a group deliberately instead of inheriting whatever order the vendor
 * catalog happened to emit. Rank comes from MODEL_RANK, so the recommended
 * default leads, premium follows, and the rest descend by capability; ties
 * break on label so the list can never reshuffle between refreshes.
 *
 * Sort is STABLE with respect to rank, and the recommended row is rank 0 , 
 * both matter, because several call sites take `groups[0].models[0]` as the
 * default chat model for a new session.
 */
function sortByRank(models: ChatModelOption[]): ChatModelOption[] {
  return [...models].sort((a, b) => {
    const rankA = a.rank ?? modelRankFor(a.id);
    const rankB = b.rank ?? modelRankFor(b.id);
    if (rankA !== rankB) return rankA - rankB;
    return a.label.localeCompare(b.label);
  });
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

// isAvailable / labelFor lived here to gate and name the Claude Code and Codex
// CLI groups from runtime diagnostics. Cora runs only on Pi now, so there is no
// runtime to gate: the groups are model families, not harnesses.

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
// triple. Returns null when no row matches (e.g. an older run pinned a model
// the provider has since retired out of the live catalog).
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

/** Rows the picker must never auto-select on the user's behalf. */
function isPremiumTier(option: ChatModelOption): boolean {
  return modelRankFor(option.id) === TIER_RANK.premium;
}

/**
 * The model a brand-new chat opens on.
 *
 * The rule this enforces: never the premium tier. Premium is materially more
 * expensive, so it is something the user opts into, never something a fresh
 * chat lands on because it happened to sort first or because it was the only
 * row in the leading group. Previously this was implied by ranking premium
 * last, which broke the moment the ordering was tuned for presentation.
 *
 * Scans groups in order and takes the first non-premium row. Falls back to the
 * very first row only when EVERY available model is premium, since offering
 * nothing would be worse than offering the one model that exists.
 */
export function defaultChatModel(groups: ChatBackendGroup[]): ChatModelOption | null {
  for (const group of groups) {
    const affordable = group.models.find((model) => !isPremiumTier(model));
    if (affordable) return affordable;
  }
  return groups.find((group) => group.models.length > 0)?.models[0] ?? null;
}

// The effort cycle for a model: its pinned list when it has one, otherwise
// the full ladder (curated rows pin; models discovered from the live catalog
// don't, and Pi passes an unmapped level straight through to the provider).
export function effortsFor(option: ChatModelOption | null): AgentEffortLevel[] {
  if (!option) return ALL_EFFORTS;
  if (option.effortLevels && option.effortLevels.length > 0) return option.effortLevels;
  return ALL_EFFORTS;
}

// Find a model in the STATIC catalog (Claude/Codex/Pi), ignoring availability.
// Used by the composer to derive effort levels for the current selection
// without needing the diagnostics IPC — effort lists never depend on whether
// the runtime is installed. A model discovered from the live catalog has no
// curated row, so this returns null for it; the caller should treat that as
// "use ALL_EFFORTS".
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
