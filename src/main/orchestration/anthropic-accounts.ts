import type { AnthropicAccountProfile } from "./anthropic-account-identity";
import {
  createClaudeAccountAdapter,
  type ClaudeLocation,
} from "./account-adapters/claude-account-adapter";
import type { ClaudeCliAccountProfileStore } from "./claude-cli-account-profiles";
import type {
  ClaudeCliCredentialBackend,
  ClaudeCredentialRecord,
} from "./claude-cli-credentials";
import type { ClaudeCliProfileLeaseRegistry } from "./claude-cli-profile-execution";
import {
  UnifiedAccountNotConnectedError,
  UnifiedAccountSessionsError,
  UnifiedAccountService,
  type DeleteAccountOptions,
  type DeleteAccountResult,
  type UnifiedAccountServiceOptions,
} from "./unified-accounts";

/**
 * The Anthropic names of the unified account service, kept for the suites
 * that build the service from the Claude seams directly. The production
 * instance lives in the registry with its two siblings.
 */

export type {
  UnifiedAccountView as AnthropicAccountView,
  UnifiedTerminalOnlyView as AnthropicTerminalOnlyView,
  UnifiedTerminalStatus as AnthropicTerminalStatus,
  UnifiedTerminalSessions as AnthropicTerminalSessions,
  PiSubscriptionShareLoginInput,
} from "./unified-accounts";
export type DeleteAnthropicAccountOptions = DeleteAccountOptions;
export type DeleteAnthropicAccountResult = DeleteAccountResult;
export { findMatchingRow } from "./unified-accounts";
export const AnthropicAccountSessionsError = UnifiedAccountSessionsError;
export type AnthropicAccountSessionsError = UnifiedAccountSessionsError;
export const AnthropicAccountNotConnectedError = UnifiedAccountNotConnectedError;
export type AnthropicAccountNotConnectedError = UnifiedAccountNotConnectedError;

export interface AnthropicAccountServiceOptions extends UnifiedAccountServiceOptions {
  claudeStore?: ClaudeCliAccountProfileStore;
  leases?: ClaudeCliProfileLeaseRegistry;
  backend?: ClaudeCliCredentialBackend;
  /** Test seam: keep the live Claude slot away from the Keychain. */
  fileOnly?: boolean;
  /** Test seam. Production asks Anthropic's OAuth profile endpoint. */
  readIdentity?: (accessToken: string) => Promise<AnthropicAccountProfile>;
  /** Test seam. Production checks process.platform for the Keychain probe. */
  platform?: NodeJS.Platform;
}

export class AnthropicAccountService extends UnifiedAccountService<
  ClaudeLocation,
  ClaudeCredentialRecord
> {
  constructor(options: AnthropicAccountServiceOptions = {}) {
    const { claudeStore, leases, backend, fileOnly, readIdentity, platform, ...rest } = options;
    super(
      createClaudeAccountAdapter({
        ...(claudeStore ? { store: claudeStore } : {}),
        ...(leases ? { leases } : {}),
        ...(backend ? { backend } : {}),
        ...(fileOnly ? { fileOnly } : {}),
        ...(readIdentity ? { readIdentity } : {}),
        ...(platform ? { platform } : {}),
        ...(rest.log ? { log: rest.log } : {}),
      }),
      rest,
    );
  }

  useAnthropicAccount(coraProfileId: string): Promise<void> {
    return this.useAccount(coraProfileId).then(() => undefined);
  }

  deleteAnthropicAccount(
    coraProfileId: string,
    options: DeleteAccountOptions = {},
  ): Promise<DeleteAccountResult> {
    return this.deleteAccount(coraProfileId, options);
  }

  listAnthropicAccounts() {
    return this.listAccounts();
  }
}

export { anthropicAccounts } from "./unified-account-registry";
