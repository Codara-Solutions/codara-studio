import {
  claudeCredentialAuthChecker,
  ClaudeCliAccountProfileNotFoundError,
  ClaudeCliAccountProfileStore,
  type ClaudeCliProfileId,
} from "./claude-cli-account-profiles";
import {
  defaultClaudeCliProfileLeases,
  resolveClaudeCliExecutionProfile,
  type ClaudeCliExecutionProfile,
} from "./claude-cli-profile-execution";

/**
 * Process-wide native Claude profile store and lease registry. All Claude CLI
 * launch surfaces resolve through this module so legacy-unset and managed
 * CLAUDE_CONFIG_DIR semantics cannot drift between transports.
 *
 * A managed account runs in its own CLAUDE_CONFIG_DIR and the personal
 * account is ~/.claude itself: nothing is swapped into the official slot any
 * more, so resolving a profile never touches another account's credential.
 */
export const nativeClaudeProfileLeases = defaultClaudeCliProfileLeases();
export const nativeClaudeProfileStore = new ClaudeCliAccountProfileStore(
  undefined,
  {
    leases: nativeClaudeProfileLeases,
    authChecker: claudeCredentialAuthChecker,
  },
);

/** The account a brand-new Claude terminal launches with: the stored default. */
export async function resolveNewNativeClaudeProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  return resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
    useDefault: true,
    baseEnv,
  });
}

/**
 * Restored panes keep the account they were started with while it still
 * exists; a profile deleted in the meantime falls back to the default.
 */
export async function resolveFrozenNativeClaudeProfile(
  nativeClaudeProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  try {
    return await resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
      profileId: nativeClaudeProfileId,
      baseEnv,
    });
  } catch (error) {
    if (error instanceof ClaudeCliAccountProfileNotFoundError) {
      return resolveNewNativeClaudeProfile(baseEnv);
    }
    throw error;
  }
}

export function acquireNativeClaudeProfileLease(
  profileId: ClaudeCliProfileId,
  ownerId: string,
): () => void {
  return nativeClaudeProfileLeases.acquire(profileId, ownerId);
}
