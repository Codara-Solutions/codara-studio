import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  ChatBackendKind,
  ChatMode,
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
    // Fable stays available when the preference is enabled, but it comes last:
    // merely opting into a premium model must never make every fresh chat use
    // it by accident.
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
  fableEnabled = false,
}: {
  diagnostics: AgentRuntimeDiagnostic[];
  openRouterModel: string;
  // Default OFF: Fable 5 is filtered out of the Claude group unless the user
  // opted in via Settings. The static CLAUDE_MODELS list is left intact, so
  // toggling the preference back on re-exposes the row with no reload.
  fableEnabled?: boolean;
}): ChatBackendGroup[] {
  const groups: ChatBackendGroup[] = [];
  // Pi is bundled and version-pinned with Studio. OAuth readiness is checked
  // at launch so the picker can expose the experimental backend without
  // pretending it is one of the native worker CLIs.
  groups.push({
    backend: "pi",
    label: "Cora · Pi",
    models: fableEnabled ? PI_MODELS : PI_MODELS.filter((model) => !/fable/i.test(model.id)),
  });
  if (isAvailable(diagnostics, "claude")) {
    const claudeModels = fableEnabled
      ? CLAUDE_MODELS
      : CLAUDE_MODELS.filter((m) => !/fable/i.test(m.id));
    groups.push({
      backend: "claude",
      label: labelFor(diagnostics, "claude", "Claude Code"),
      models: claudeModels,
    });
  }
  if (isAvailable(diagnostics, "codex")) {
    groups.push({
      backend: "codex",
      label: labelFor(diagnostics, "codex", "Codex"),
      models: CODEX_MODELS,
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

// Authoritative override: hide a runtime when diagnostics report it as
// uninstalled or disabled by settings. If diagnostics are empty (haven't
// loaded yet) or there's no entry for the kind, default to showing — let
// the user pick; a launch failure will surface a clear error if it's
// genuinely missing.
function isAvailable(
  diagnostics: AgentRuntimeDiagnostic[],
  kind: "claude" | "codex",
): boolean {
  if (diagnostics.length === 0) return false;
  const entry = diagnostics.find((d) => d.kind === kind);
  if (!entry) return false;
  return entry.installed === true && entry.disabledBySettings !== true;
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
