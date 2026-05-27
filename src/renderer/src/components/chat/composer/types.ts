import type { AgentEffortLevel, ChatBackendKind, ChatMode } from "@shared/types";

// Per-model option used in the model picker. Extracted from ChatComposer so
// the pill components can import the types without circular imports.
export interface ChatModelOption {
  id: string;
  label: string;
  backend: ChatBackendKind;
  effortLevels?: AgentEffortLevel[];
}

export interface ChatBackendGroup {
  backend: ChatBackendKind;
  label: string;
  models: ChatModelOption[];
}

// Master effort list (used when the model doesn't pin a narrower set).
export const ALL_EFFORTS: AgentEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// All chats start on OpenRouter / Gemini Flash / Execute / medium. The
// composer reads these for the draft (no run yet) state.
export const CHAT_BACKEND_GROUPS: ChatBackendGroup[] = [
  {
    backend: "openrouter",
    label: "OpenRouter",
    models: [
      { id: "google/gemini-flash-latest", label: "Gemini Flash", backend: "openrouter" },
      { id: "openai/gpt-4o", label: "GPT-4o", backend: "openrouter" },
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus", backend: "openrouter" },
    ],
  },
  {
    backend: "claude",
    label: "Claude Code",
    models: [
      {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        backend: "claude",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        backend: "claude",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
  },
  {
    backend: "codex",
    label: "Codex",
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        backend: "codex",
        effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
      },
    ],
  },
];

export const DEFAULT_CHAT_BACKEND: ChatBackendKind = "openrouter";
export const DEFAULT_CHAT_MODEL = "google/gemini-flash-latest";
export const DEFAULT_CHAT_MODE: ChatMode = "execute";
export const DEFAULT_CHAT_EFFORT: AgentEffortLevel = "medium";

export const EFFORT_LABELS: Record<AgentEffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

// Ordinal index of each effort level. Used by `clampEffort` to find the
// nearest allowed level when a model swap drops the current pick.
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

// Cycle to the next allowed level (wraps). Click-to-cycle UX from vienna.
export function nextEffort(
  current: AgentEffortLevel | undefined,
  allowed: AgentEffortLevel[],
): AgentEffortLevel {
  if (allowed.length === 0) return current ?? "medium";
  const idx = current ? allowed.indexOf(current) : -1;
  return allowed[(idx + 1) % allowed.length];
}

// Find the nearest allowed level by ordinal distance from `current`.
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

export function findChatModel(
  backend: ChatBackendKind,
  modelId: string,
): ChatModelOption | null {
  for (const group of CHAT_BACKEND_GROUPS) {
    if (group.backend !== backend) continue;
    const hit = group.models.find((model) => model.id === modelId);
    if (hit) return hit;
  }
  return null;
}

export function fallbackChatModel(backend: ChatBackendKind): ChatModelOption {
  const group = CHAT_BACKEND_GROUPS.find((entry) => entry.backend === backend);
  if (group && group.models.length > 0) return group.models[0];
  return CHAT_BACKEND_GROUPS[0].models[0];
}

export function effortsFor(
  backend: ChatBackendKind,
  model: ChatModelOption,
): AgentEffortLevel[] {
  if (backend === "openrouter") return ALL_EFFORTS;
  if (model.effortLevels && model.effortLevels.length > 0) return model.effortLevels;
  return ALL_EFFORTS;
}
