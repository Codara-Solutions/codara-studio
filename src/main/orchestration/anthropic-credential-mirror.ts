import type { ClaudeLocation } from "./account-adapters/claude-account-adapter";
import type { ClaudeCredentialRecord } from "./claude-cli-credentials";
import {
  CredentialMirror,
  credentialMirror,
  type CanonicalCredential,
  type CredentialPair,
} from "./credential-mirror";

/**
 * The Anthropic names of the provider-generic credential mirror, kept for the
 * callers wired before the mirror served every provider.
 */

export {
  ANTHROPIC_OAUTH_SCOPES,
  canonicalFromClaude,
  canonicalFromPi,
  claudeRecordFromCanonical,
  PI_EXPIRY_PADDING_MS,
  piRecordFromCanonical,
} from "./account-adapters/claude-credential-codec";
export { CLAUDE_CLI_PERSONAL_PROFILE_ID } from "./claude-cli-account-profiles";
export {
  compareCredentials,
  isPersonalPair,
  readPiSide,
  reconcilePair,
  type CredentialComparison,
  type ReconcilePairOptions,
  type ReconcilePairResult,
} from "./credential-mirror";

export type AnthropicCanonicalCredential = CanonicalCredential;
export type AnthropicCredentialPair = CredentialPair<ClaudeLocation, ClaudeCredentialRecord>;
export const AnthropicCredentialMirror = CredentialMirror;
export type AnthropicCredentialMirror = CredentialMirror;
export const anthropicCredentialMirror = credentialMirror;
