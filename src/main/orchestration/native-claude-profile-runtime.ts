import {
  ClaudeCliAccountProfileStore,
  codaraClaudeCliAccountRootDir,
  type ClaudeCliProfileId,
} from "./claude-cli-account-profiles";
import {
  defaultClaudeCliProfileLeases,
  type ClaudeCliExecutionProfile,
} from "./claude-cli-profile-execution";
import { buildClaudeCliProfileEnvironment } from "./claude-cli-profile-environment";
import {
  activateClaudeCliAccount,
  claudeCliPersonalConfigDir,
  ensureClaudeCliAuthVault,
} from "./claude-cli-auth-selector";

/**
 * Process-wide native Claude profile store and lease registry. All Claude CLI
 * launch surfaces resolve through this module so legacy-unset and managed
 * CLAUDE_CONFIG_DIR semantics cannot drift between transports.
 */
export const nativeClaudeProfileLeases = defaultClaudeCliProfileLeases();
export const nativeClaudeProfileStore = new ClaudeCliAccountProfileStore(
  undefined,
  {
    leases: nativeClaudeProfileLeases,
    personalProfileConfigDir: claudeCliPersonalConfigDir(
      codaraClaudeCliAccountRootDir(),
    ),
    personalProfileConfigDirEnv: claudeCliPersonalConfigDir(
      codaraClaudeCliAccountRootDir(),
    ),
  },
);

export async function resolveNewNativeClaudeProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  const active = await ensureClaudeCliAuthVault(nativeClaudeProfileStore);
  const { defaultProfileId } = await nativeClaudeProfileStore.snapshot();
  if (active !== defaultProfileId) {
    await activateClaudeCliAccount(nativeClaudeProfileStore, defaultProfileId);
  }
  const selected = await nativeClaudeProfileStore.resolveProfile({
    useDefault: true,
  });
  return {
    profileId: selected.profileId,
    label: selected.label,
    managed: selected.managed,
    connected: selected.connected,
    env: buildClaudeCliProfileEnvironment(
      baseEnv,
      nativeClaudeProfileStore.personalConfigDirEnv,
    ),
  };
}

export async function resolveFrozenNativeClaudeProfile(
  nativeClaudeProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  // Authentication is global: restored panes follow the account currently
  // selected in Settings instead of reviving a second CLAUDE_CONFIG_DIR.
  void nativeClaudeProfileId;
  return resolveNewNativeClaudeProfile(baseEnv);
}

export function acquireNativeClaudeProfileLease(
  profileId: ClaudeCliProfileId,
  ownerId: string,
): () => void {
  return nativeClaudeProfileLeases.acquire(profileId, ownerId);
}
