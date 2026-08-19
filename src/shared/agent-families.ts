// The three first-party agent families Codara knows about.
//
// One row is the only place a new family is listed. Types below are derived
// from the table so a fourth family is a new entry here, not a new branch in
// forty files. Implementations stay concrete — this is not a plugin loader.

export const AGENT_FAMILIES = {
  claude: {
    runtime: "claude",
    subscription: "anthropic",
    cliLabel: "Claude Code",
    vendorLabel: "Anthropic",
    planLabel: "Claude Pro / Max",
    binary: "claude",
    displayName: "Claude",
  },
  codex: {
    runtime: "codex",
    subscription: "openai-codex",
    cliLabel: "Codex CLI",
    vendorLabel: "OpenAI",
    planLabel: "ChatGPT Plus / Pro",
    binary: "codex",
    displayName: "Codex",
  },
  grok: {
    runtime: "grok",
    subscription: "xai",
    cliLabel: "Grok Build",
    vendorLabel: "xAI",
    planLabel: "SuperGrok / X Premium",
    binary: "grok",
    displayName: "Grok",
  },
} as const;

export type AgentFamilyId = keyof typeof AGENT_FAMILIES;
export type AgentRuntimeKind = AgentFamilyId;
export type NativeCliAccountRuntime = AgentFamilyId;
export type WorkerSessionRuntime = AgentFamilyId;
export type PublicAgentRuntime = AgentFamilyId;
export type SparkBuiltinRuntime = AgentFamilyId;
export type PiSubscriptionProvider =
  (typeof AGENT_FAMILIES)[AgentFamilyId]["subscription"];

export const AGENT_FAMILY_IDS = Object.keys(AGENT_FAMILIES) as AgentFamilyId[];

export const PI_SUBSCRIPTION_PROVIDERS = AGENT_FAMILY_IDS.map(
  (id) => AGENT_FAMILIES[id].subscription,
) as PiSubscriptionProvider[];

const RUNTIME_SET = new Set<string>(AGENT_FAMILY_IDS);
const SUBSCRIPTION_SET = new Set<string>(PI_SUBSCRIPTION_PROVIDERS);

const FAMILY_BY_SUBSCRIPTION = Object.fromEntries(
  AGENT_FAMILY_IDS.map((id) => [AGENT_FAMILIES[id].subscription, AGENT_FAMILIES[id]]),
) as Record<PiSubscriptionProvider, (typeof AGENT_FAMILIES)[AgentFamilyId]>;

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return typeof value === "string" && RUNTIME_SET.has(value);
}

export function isPiSubscriptionProvider(value: unknown): value is PiSubscriptionProvider {
  return typeof value === "string" && SUBSCRIPTION_SET.has(value);
}

export function familyForRuntime(
  runtime: AgentRuntimeKind,
): (typeof AGENT_FAMILIES)[AgentFamilyId] {
  return AGENT_FAMILIES[runtime];
}

export function familyForSubscription(
  provider: PiSubscriptionProvider,
): (typeof AGENT_FAMILIES)[AgentFamilyId] {
  return FAMILY_BY_SUBSCRIPTION[provider];
}

export function subscriptionForRuntime(runtime: AgentRuntimeKind): PiSubscriptionProvider {
  return AGENT_FAMILIES[runtime].subscription;
}

export function runtimeForSubscription(provider: PiSubscriptionProvider): AgentRuntimeKind {
  return FAMILY_BY_SUBSCRIPTION[provider].runtime;
}

/** Which family a model id belongs to. Used by Cora routing and the picker. */
export function familyForModelId(model: string | undefined): AgentFamilyId | null {
  const id = model?.trim().toLowerCase() ?? "";
  if (!id) return null;
  if (id.startsWith("gpt-")) return "codex";
  if (id.startsWith("claude-") || id.startsWith("sonnet-") || id.startsWith("opus-") || id.startsWith("haiku-") || id.startsWith("fable-")) {
    return "claude";
  }
  if (id.startsWith("grok-")) return "grok";
  return null;
}

export function subscriptionForModelId(model: string): PiSubscriptionProvider | null {
  const family = familyForModelId(model);
  return family ? AGENT_FAMILIES[family].subscription : null;
}

export function runtimeForModelId(model: string | undefined): AgentRuntimeKind | null {
  return familyForModelId(model);
}
