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
  brand: "claude" | "codex" | "grok";
  /** The CLI's own folder, named where copy promises Codara leaves it alone. */
  systemHome: "~/.claude" | "~/.codex" | "~/.grok";
  /**
   * Claude Code re-reads the credential in its live slot on every request,
   * so a switch reaches running sessions. Codex loads its login once per
   * process, and Grok is not known to re-read it, so only new sessions move.
   */
  runningSessionsSwitch: boolean;
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
  Pick<AccountProviderDescriptor, "cliLabel" | "systemHome" | "runningSessionsSwitch">
> = {
  claude: { cliLabel: "Claude Code", systemHome: "~/.claude", runningSessionsSwitch: true },
  codex: { cliLabel: "Codex", systemHome: "~/.codex", runningSessionsSwitch: false },
  grok: { cliLabel: "Grok", systemHome: "~/.grok", runningSessionsSwitch: false },
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

/** What a switch reaches for this provider, said under its name. */
export function accountProviderSummary(descriptor: AccountProviderDescriptor): string {
  const running = descriptor.runningSessionsSwitch
    ? `Running ${descriptor.cliLabel} sessions switch on their next request.`
    : `Running ${descriptor.cliLabel} sessions keep their account.`;
  return `The Active account is used by new Codara terminals and new Cora chats. ${running}`;
}

/**
 * The rule the summary leaves out, shown under "How switching works": the
 * System login is never written to, so it cannot be swapped into a running
 * session.
 */
export function accountProviderDetail(descriptor: AccountProviderDescriptor): string {
  const { cliLabel } = descriptor;
  const running = descriptor.runningSessionsSwitch
    ? `Running ${cliLabel} sessions switch on their next request.`
    : `New ${cliLabel} sessions use the new account. Running ones keep theirs.`;
  return `${running} Switching to or from your own ${cliLabel} login applies to new sessions.`;
}

/** The badge on the row for the CLI's own login on this computer. */
export function systemLoginBadge(descriptor: AccountProviderDescriptor): string {
  return `Your ${descriptor.cliLabel} login`;
}
