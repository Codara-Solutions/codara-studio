import {
  GrokCliAccountProfileStore,
  type GrokCliProfileId,
} from "./grok-cli-account-profiles";
import {
  buildGrokCliProfileEnvironment,
  defaultGrokCliProfileLeases,
  type GrokCliExecutionProfile,
} from "./grok-cli-profile-execution";
import {
  activateGrokCliAccount,
  ensureGrokCliAuthVault,
  grokCliPersonalAuthFile,
} from "./grok-cli-auth-selector";
import { codaraGrokCliAccountRootDir } from "./grok-cli-account-profiles";

/**
 * One process-wide store/lease pair for every native Grok launch surface.
 * Keeping this centralized is what makes profile deletion reliably reject
 * while a manager, worker, or manual terminal still owns the selected home.
 */
export const nativeGrokProfileLeases = defaultGrokCliProfileLeases();
export const nativeGrokProfileStore = new GrokCliAccountProfileStore(
  undefined,
  {
    leases: nativeGrokProfileLeases,
    personalAuthFile: grokCliPersonalAuthFile(codaraGrokCliAccountRootDir()),
  },
);

export async function resolveNewNativeGrokProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  const active = await ensureGrokCliAuthVault(nativeGrokProfileStore);
  const { defaultProfileId } = await nativeGrokProfileStore.snapshot();
  if (active !== defaultProfileId) {
    await activateGrokCliAccount(nativeGrokProfileStore, defaultProfileId);
  }
  const selected = await nativeGrokProfileStore.resolveProfile({
    useDefault: true,
  });
  return {
    profileId: selected.profileId,
    label: selected.label,
    managed: selected.managed,
    connected: selected.connected,
    env: buildGrokCliProfileEnvironment(
      baseEnv,
      nativeGrokProfileStore.personalHomeDir,
    ),
  };
}

export async function resolveFrozenNativeGrokProfile(
  nativeGrokProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  // Authentication is global: restored panes follow the account currently
  // selected in Settings instead of reviving a second GROK_HOME.
  void nativeGrokProfileId;
  return resolveNewNativeGrokProfile(baseEnv);
}

export function acquireNativeGrokProfileLease(
  profileId: GrokCliProfileId,
  ownerId: string,
): () => void {
  return nativeGrokProfileLeases.acquire(profileId, ownerId);
}
