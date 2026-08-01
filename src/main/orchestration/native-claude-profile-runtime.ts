import {
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
 */
export const nativeClaudeProfileLeases = defaultClaudeCliProfileLeases();
export const nativeClaudeProfileStore = new ClaudeCliAccountProfileStore(
  undefined,
  { leases: nativeClaudeProfileLeases },
);

export async function resolveNewNativeClaudeProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  return resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
    useDefault: true,
    baseEnv,
  });
}

export async function resolveFrozenNativeClaudeProfile(
  nativeClaudeProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  return resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
    // Missing persisted values always mean the legacy personal profile.
    profileId: nativeClaudeProfileId,
    baseEnv,
  });
}

export function acquireNativeClaudeProfileLease(
  profileId: ClaudeCliProfileId,
  ownerId: string,
): () => void {
  return nativeClaudeProfileLeases.acquire(profileId, ownerId);
}
