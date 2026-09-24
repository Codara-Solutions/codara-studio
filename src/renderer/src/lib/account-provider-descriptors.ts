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

/** One descriptor per family, in the order the Accounts panel lists them. */
export const ACCOUNT_PROVIDER_DESCRIPTORS: ReadonlyArray<AccountProviderDescriptor> =
  AGENT_FAMILY_IDS.map((id) => ({
    provider: AGENT_FAMILIES[id].subscription,
    runtime: id,
    label: AGENT_FAMILIES[id].vendorLabel,
    brand: id,
    ...CLI_WORDS[id],
  }));

/** The line under the provider name: what one account is and what a switch does. */
export function accountProviderDetail(descriptor: AccountProviderDescriptor): string {
  if (descriptor.switchClosesSessions) {
    return `One sign-in per account. Switching an account moves Cora and ${descriptor.cliLabel} together and closes running ${descriptor.cliLabel} sessions, because ${descriptor.cliLabel} keeps one sign-in for every terminal. Account 1 is your own ${descriptor.loginHint}.`;
  }
  if (descriptor.sessionsFollowLiveLogin) {
    return `One sign-in per account. Switching an account moves Cora and ${descriptor.cliLabel} together, in every terminal app, the way ${descriptor.loginHint} does; running sessions pick it up on their next request. MCP sign-ins, settings and history are shared by every account. Account 1 is your own ${descriptor.loginHint}.`;
  }
  return `One sign-in per account. Switching an account moves Cora and ${descriptor.cliLabel} together. Open terminals follow at their next prompt; a ${descriptor.cliLabel} session that is already running keeps its account until it exits. Account 1 is your own ${descriptor.loginHint}.`;
}
