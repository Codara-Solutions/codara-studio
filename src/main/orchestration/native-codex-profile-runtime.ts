import { ensureCodexManagedHome } from "./cli-account-homes";
import {
  CodexCliAccountProfileNotFoundError,
  CodexCliAccountProfileStore,
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codexCliManagedProfilePaths,
  isCodexCliManagedProfileId,
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import {
  buildCodexCliSharedEnvironment,
  defaultCodexCliProfileLeases,
  resolveCodexCliExecutionProfile,
  type CodexCliExecutionProfile,
} from "./codex-cli-profile-execution";

/**
 * One process-wide store/lease pair for every native Codex launch surface.
 * Keeping this centralized is what makes profile deletion reliably wait
 * while a manager, worker, or manual terminal still owns the selected home.
 *
 * A managed account runs with CODEX_HOME at its own home under Codara's
 * (codex-cli/accounts/<id>/home); the System login runs with the inherited
 * CODEX_HOME, or none for the default ~/.codex. Codex loads its login once
 * per process, so a running session keeps the account it started on and
 * only new sessions follow the Active account.
 */
export const nativeCodexProfileLeases = defaultCodexCliProfileLeases();

/**
 * Installed by the unified account service once it is loaded: every launch
 * waits for the startup migration and reconciles the active account's
 * credential first. Injected rather than imported so this launch-path module
 * never pulls the account service, the registry and the Pi runtime into
 * every surface that resolves a profile.
 */
export interface NativeCodexProfileResolutionHooks {
  ready(): Promise<void>;
  beforeNewProfile(): Promise<void>;
  /** A terminal on this profile exited; the moment its token most likely rotated. */
  afterLeaseReleased(profileId: CodexCliProfileId): Promise<void>;
}

let resolutionHooks: NativeCodexProfileResolutionHooks | null = null;

export function setNativeCodexProfileResolutionHooks(
  hooks: NativeCodexProfileResolutionHooks | null,
): void {
  resolutionHooks = hooks;
}

export const nativeCodexProfileStore = new CodexCliAccountProfileStore(undefined, {
  leases: nativeCodexProfileLeases,
});

/**
 * Create or refresh a managed home's links into the System Codex home.
 * Failures are logged: a launch never fails because a link could not be made.
 */
export async function ensureCodexAccountHome(
  profileId: string,
  store: CodexCliAccountProfileStore = nativeCodexProfileStore,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  if (!isCodexCliManagedProfileId(profileId)) return;
  await ensureCodexManagedHome({
    home: codexCliManagedProfilePaths(store.rootDir, profileId).homeDir,
    root: store.rootDir,
    systemHome: store.personalHomeDir,
    log,
  }).catch((error: unknown) => {
    log(
      `[accounts] the Codex home of ${profileId} could not be prepared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

async function resolveCodexProfile(
  profileId: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<CodexCliExecutionProfile> {
  if (profileId === CODEX_CLI_PERSONAL_PROFILE_ID) {
    const selected = await nativeCodexProfileStore.resolveProfile({
      profileId: CODEX_CLI_PERSONAL_PROFILE_ID,
    });
    return {
      ...selected,
      stateHome: selected.homeDir,
      env: buildCodexCliSharedEnvironment(baseEnv, selected.homeDir),
    };
  }
  // Provisioning links the whole System home into the account directory, so
  // an id the store no longer lists (a deleted account a restored pane still
  // names) must fail before it, or the purged directory comes back for good.
  const { profiles } = await nativeCodexProfileStore.snapshot();
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new CodexCliAccountProfileNotFoundError(profileId);
  }
  await ensureCodexAccountHome(profileId);
  return resolveCodexCliExecutionProfile(nativeCodexProfileStore, { profileId, baseEnv });
}

export async function resolveNewNativeCodexProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  const hooks = resolutionHooks;
  await hooks?.ready();
  await hooks?.beforeNewProfile().catch(() => undefined);
  const { defaultProfileId } = await nativeCodexProfileStore.snapshot();
  return resolveCodexProfile(defaultProfileId, baseEnv);
}

/**
 * Restored panes keep the account they were started with while it still
 * exists; a profile deleted in the meantime falls back to the default.
 */
export async function resolveFrozenNativeCodexProfile(
  nativeCodexProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  if (!isCodexCliManagedProfileId(nativeCodexProfileId)) {
    return resolveNewNativeCodexProfile(baseEnv);
  }
  await resolutionHooks?.ready();
  try {
    return await resolveCodexProfile(nativeCodexProfileId, baseEnv);
  } catch (error) {
    if (error instanceof CodexCliAccountProfileNotFoundError) {
      return resolveNewNativeCodexProfile(baseEnv);
    }
    throw error;
  }
}

/** Called by the pty layer when a Codex terminal's lease is released. */
export function notifyNativeCodexProfileLeaseReleased(profileId: CodexCliProfileId): void {
  void resolutionHooks?.afterLeaseReleased(profileId).catch(() => undefined);
}

export function acquireNativeCodexProfileLease(
  profileId: CodexCliProfileId,
  ownerId: string,
): () => void {
  return nativeCodexProfileLeases.acquire(profileId, ownerId);
}
