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

/**
 * Installed by the unified account service once it is loaded: every launch
 * waits for the startup migration and reconciles the launching account's
 * credential pair first. Injected rather than imported so this launch-path
 * module never pulls the account service, the registry and the Pi runtime
 * into every surface that resolves a profile.
 */
export interface NativeClaudeProfileResolutionHooks {
  ready(): Promise<void>;
  beforeNewProfile(): Promise<void>;
  beforeFrozenProfile(profileId: ClaudeCliProfileId): Promise<void>;
  /** A terminal on this profile exited; the moment its token most likely rotated. */
  afterLeaseReleased(profileId: ClaudeCliProfileId): Promise<void>;
}

let resolutionHooks: NativeClaudeProfileResolutionHooks | null = null;

export function setNativeClaudeProfileResolutionHooks(
  hooks: NativeClaudeProfileResolutionHooks | null,
): void {
  resolutionHooks = hooks;
}
export const nativeClaudeProfileStore = new ClaudeCliAccountProfileStore(
  undefined,
  {
    leases: nativeClaudeProfileLeases,
    authChecker: claudeCredentialAuthChecker,
  },
);

/**
 * The account a brand-new Claude terminal launches with: the unified default,
 * after the account migration has settled and the default's credential pair
 * has been reconciled so the terminal starts on the freshest token.
 */
export async function resolveNewNativeClaudeProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  const hooks = resolutionHooks;
  await hooks?.ready();
  await hooks?.beforeNewProfile().catch(() => undefined);
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
  const hooks = resolutionHooks;
  await hooks?.ready();
  try {
    const frozen = await resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
      profileId: nativeClaudeProfileId,
      baseEnv,
    });
    await hooks?.beforeFrozenProfile(frozen.profileId).catch(() => undefined);
    return frozen;
  } catch (error) {
    if (error instanceof ClaudeCliAccountProfileNotFoundError) {
      return resolveNewNativeClaudeProfile(baseEnv);
    }
    throw error;
  }
}

/** Called by the pty layer when a Claude terminal's lease is released. */
export function notifyNativeClaudeProfileLeaseReleased(profileId: ClaudeCliProfileId): void {
  void resolutionHooks?.afterLeaseReleased(profileId).catch(() => undefined);
}

export function acquireNativeClaudeProfileLease(
  profileId: ClaudeCliProfileId,
  ownerId: string,
): () => void {
  return nativeClaudeProfileLeases.acquire(profileId, ownerId);
}
