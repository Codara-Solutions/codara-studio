import {
  AGENT_FAMILIES,
  AGENT_FAMILY_IDS,
  type AgentRuntimeKind,
  type PiSubscriptionProvider,
} from "@shared/agent-families";

/**
 * What differs between the three account providers in the Accounts panel.
 * Every provider reports the same account shape from the main process and
 * offers the same five actions, so only the words and the brand vary; the
 * card component reads them from here and branches on nothing else.
 */
export interface AccountProviderDescriptor {
  provider: PiSubscriptionProvider;
  runtime: AgentRuntimeKind;
  /** Human provider name, e.g. "Anthropic". */
  label: string;
  /** How the terminal half is named in copy; matches the main-process adapter labels. */
  cliLabel: "Claude Code" | "Codex" | "Grok";
  /** The command that signs Account 1 in from a terminal. */
  loginHint: "claude login" | "codex login" | "grok login";
  brand: "claude" | "codex" | "grok";
  /**
   * Codex keeps one sign-in for every terminal, so switching it closes the
   * running Codex sessions; main refuses with their count until the card
   * asks again. Anthropic and Grok switches close nothing.
   */
  switchClosesSessions: boolean;
  /**
   * Every session runs on whichever login is live (Claude Code's one home),
   * so a switch reaches running sessions too and deleting an account never
   * has to close one.
   */
  sessionsFollowLiveLogin: boolean;
  /**
   * The limit windows every account row draws, by the label main gives them.
   * A row with no reading yet draws these as empty meters so every row keeps
   * one shape.
   */
  usageWindows: ReadonlyArray<string>;
  /** False when the provider publishes no client-readable limits at all. */
  reportsUsage: boolean;
}

const CLI_WORDS: Record<
  AgentRuntimeKind,
  Pick<
    AccountProviderDescriptor,
    "cliLabel" | "loginHint" | "switchClosesSessions" | "sessionsFollowLiveLogin"
  >
> = {
  claude: {
    cliLabel: "Claude Code",
    loginHint: "claude login",
    switchClosesSessions: false,
    sessionsFollowLiveLogin: true,
  },
  codex: {
    cliLabel: "Codex",
    loginHint: "codex login",
    switchClosesSessions: true,
    sessionsFollowLiveLogin: false,
  },
  grok: {
    cliLabel: "Grok",
    loginHint: "grok login",
    switchClosesSessions: false,
    sessionsFollowLiveLogin: false,
  },
};

// pi-subscription-usage.ts labels windows by their length. Every row draws
// the same two so the list reads as one table; SuperGrok has no
// client-readable quota, so xAI rows keep them empty and say why.
const USAGE_WINDOWS: ReadonlyArray<string> = ["5-hour", "7-day"];
const REPORTS_USAGE: Record<AgentRuntimeKind, boolean> = {
  claude: true,
  codex: true,
  grok: false,
};

/** One descriptor per family, in the order the Accounts panel lists them. */
export const ACCOUNT_PROVIDER_DESCRIPTORS: ReadonlyArray<AccountProviderDescriptor> =
  AGENT_FAMILY_IDS.map((id) => ({
    provider: AGENT_FAMILIES[id].subscription,
    runtime: id,
    label: AGENT_FAMILIES[id].vendorLabel,
    brand: id,
    usageWindows: USAGE_WINDOWS,
    reportsUsage: REPORTS_USAGE[id],
    ...CLI_WORDS[id],
  }));

/** The one line under the provider name: what a switch moves, and its catch. */
export function accountProviderSummary(descriptor: AccountProviderDescriptor): string {
  if (descriptor.switchClosesSessions) {
    return `Switching moves Cora and ${descriptor.cliLabel} together and closes running ${descriptor.cliLabel} sessions.`;
  }
  if (descriptor.sessionsFollowLiveLogin) {
    return `Switching moves Cora and ${descriptor.cliLabel} together, running sessions included.`;
  }
  return `Switching moves Cora and ${descriptor.cliLabel} together from the next prompt.`;
}

/**
 * The one rule behind a switch that the summary line does not already say,
 * shown under "How switching works".
 */
export function accountProviderDetail(descriptor: AccountProviderDescriptor): string {
  if (descriptor.switchClosesSessions) {
    return `${descriptor.cliLabel} keeps one sign-in for every terminal, which is why a switch has to close its sessions.`;
  }
  if (descriptor.sessionsFollowLiveLogin) {
    return "MCP sign-ins, settings and history stay shared by every account.";
  }
  return `A ${descriptor.cliLabel} session that is already running keeps its account until it exits.`;
}
