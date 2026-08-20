import {
  CodexCliAccountProfileStore,
  codaraCodexCliAccountRootDir,
  defaultPersonalCodexHomeDir,
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import {
  buildCodexCliSharedEnvironment,
  defaultCodexCliProfileLeases,
  resolveCodexCliExecutionProfile,
  type CodexCliExecutionProfile,
} from "./codex-cli-profile-execution";
import {
  activateCodexCliAccount,
  codexCliPersonalAuthFile,
  ensureCodexCliAuthVault,
} from "./codex-cli-auth-selector";

/**
 * One process-wide store/lease pair for every native Codex launch surface.
 * Keeping this centralized is what makes profile deletion reliably reject
 * while a manager, worker, or manual terminal still owns the selected home.
 */
export const nativeCodexProfileLeases = defaultCodexCliProfileLeases();
export const nativeCodexProfileStore = new CodexCliAccountProfileStore(
  undefined,
  {
    leases: nativeCodexProfileLeases,
    personalAuthFile: codexCliPersonalAuthFile(
      codaraCodexCliAccountRootDir(),
    ),
  },
);

export async function resolveNewNativeCodexProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  const active = await ensureCodexCliAuthVault(nativeCodexProfileStore);
  const { defaultProfileId } = await nativeCodexProfileStore.snapshot();
  if (active !== defaultProfileId) {
    await activateCodexCliAccount(nativeCodexProfileStore, defaultProfileId);
  }
  const selected = await resolveCodexCliExecutionProfile(nativeCodexProfileStore, {
    useDefault: true,
    baseEnv,
  });
  return {
    ...selected,
    stateHome: defaultPersonalCodexHomeDir(),
    env: buildCodexCliSharedEnvironment(baseEnv),
  };
}

export async function resolveFrozenNativeCodexProfile(
  nativeCodexProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  // Codex authentication is intentionally global: every process reads the one
  // active ~/.codex/auth.json, so a restored pane follows the account Settings
  // currently marks Active instead of reviving a second CODEX_HOME.
  void nativeCodexProfileId;
  return resolveNewNativeCodexProfile(baseEnv);
}

export function acquireNativeCodexProfileLease(
  profileId: CodexCliProfileId,
  ownerId: string,
): () => void {
  return nativeCodexProfileLeases.acquire(profileId, ownerId);
}
