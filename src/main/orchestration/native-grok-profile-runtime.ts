import {
  GrokCliAccountProfileNotFoundError,
  GrokCliAccountProfileStore,
  type GrokCliProfileId,
} from "./grok-cli-account-profiles";
import {
  defaultGrokCliProfileLeases,
  resolveGrokCliExecutionProfile,
  type GrokCliExecutionProfile,
} from "./grok-cli-profile-execution";

/**
 * Process-wide native Grok profile store and lease registry. All Grok CLI
 * launch surfaces resolve through this module so personal and managed
 * GROK_HOME semantics cannot drift between transports.
 *
 * A managed account runs in its own GROK_HOME and the personal account is
 * ~/.grok itself: nothing is swapped into the official home any more, so
 * resolving a profile never touches another account's credential.
 */
export const nativeGrokProfileLeases = defaultGrokCliProfileLeases();

/**
 * Installed by the unified account service once it is loaded: every launch
 * waits for the startup migration and reconciles the launching account's
 * credential pair first. Injected rather than imported so this launch-path
 * module never pulls the account service, the registry and the Pi runtime
 * into every surface that resolves a profile.
 */
export interface NativeGrokProfileResolutionHooks {
  ready(): Promise<void>;
  beforeNewProfile(): Promise<void>;
  beforeFrozenProfile(profileId: GrokCliProfileId): Promise<void>;
  /** A terminal on this profile exited; the moment its token most likely rotated. */
  afterLeaseReleased(profileId: GrokCliProfileId): Promise<void>;
}

let resolutionHooks: NativeGrokProfileResolutionHooks | null = null;

export function setNativeGrokProfileResolutionHooks(
  hooks: NativeGrokProfileResolutionHooks | null,
): void {
  resolutionHooks = hooks;
}

export const nativeGrokProfileStore = new GrokCliAccountProfileStore(undefined, {
  leases: nativeGrokProfileLeases,
});

/**
 * The account a brand-new Grok terminal launches with: the unified default,
 * after the account migration has settled and the default's credential pair
 * has been reconciled so the terminal starts on the freshest token.
 */
export async function resolveNewNativeGrokProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  const hooks = resolutionHooks;
  await hooks?.ready();
  await hooks?.beforeNewProfile().catch(() => undefined);
  return resolveGrokCliExecutionProfile(nativeGrokProfileStore, {
    useDefault: true,
    baseEnv,
  });
}

/**
 * Restored panes keep the account they were started with while it still
 * exists; a profile deleted in the meantime falls back to the default.
 */
export async function resolveFrozenNativeGrokProfile(
  nativeGrokProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  const hooks = resolutionHooks;
  await hooks?.ready();
  try {
    const frozen = await resolveGrokCliExecutionProfile(nativeGrokProfileStore, {
      profileId: nativeGrokProfileId,
      baseEnv,
    });
    await hooks?.beforeFrozenProfile(frozen.profileId).catch(() => undefined);
    return frozen;
  } catch (error) {
    if (error instanceof GrokCliAccountProfileNotFoundError) {
      return resolveNewNativeGrokProfile(baseEnv);
    }
    throw error;
  }
}

/** Called by the pty layer when a Grok terminal's lease is released. */
export function notifyNativeGrokProfileLeaseReleased(profileId: GrokCliProfileId): void {
  void resolutionHooks?.afterLeaseReleased(profileId).catch(() => undefined);
}

export function acquireNativeGrokProfileLease(
  profileId: GrokCliProfileId,
  ownerId: string,
): () => void {
  return nativeGrokProfileLeases.acquire(profileId, ownerId);
}
