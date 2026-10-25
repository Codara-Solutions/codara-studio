import {
  claudeCredentialAuthChecker,
  ClaudeCliAccountProfileStore,
  type ClaudeCliProfileId,
} from "./claude-cli-account-profiles";
import { ensureClaudeManagedHome } from "./cli-account-homes";
import {
  defaultClaudeCliProfileLeases,
  resolveClaudeCliExecutionProfile,
  type ClaudeCliExecutionProfile,
} from "./claude-cli-profile-execution";

/**
 * Process-wide native Claude profile store and lease registry. All Claude CLI
 * launch surfaces resolve through this module so CLAUDE_CONFIG_DIR semantics
 * cannot drift between transports.
 *
 * A launch on a managed account runs in Codara's live slot, whose login the
 * Active account holds (claude-cli-live-login.ts); a launch on the System
 * login runs with the inherited environment, exactly as `claude` does in any
 * other terminal app. A profile id only records which account a session
 * started on.
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
  /** A Claude terminal exited; the moment the live login most likely rotated. */
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
 * Create or refresh the live slot's links into the System Claude home and
 * its own `.claude.json`. Failures are logged: a launch never fails because
 * a shared link could not be made.
 */
export async function ensureClaudeLiveHome(
  store: ClaudeCliAccountProfileStore = nativeClaudeProfileStore,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  await ensureClaudeManagedHome({
    home: store.liveConfigDir,
    root: store.rootDir,
    systemHome: store.personalConfigDir,
    systemConfigDirEnv: store.personalConfigDirEnv,
    log,
  }).catch((error: unknown) => {
    log(
      `[accounts] the Claude live slot could not be prepared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

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
  const profile = await resolveClaudeCliExecutionProfile(nativeClaudeProfileStore, {
    useDefault: true,
    baseEnv,
  });
  if (profile.managed) await ensureClaudeLiveHome();
  return profile;
}

/**
 * A restored pane or a transcript lookup for an earlier session. Its
 * account is history: managed sessions all run in the one live slot, so it
 * resolves like a new launch and continues on the Active account, the same
 * as a `claude --resume` in any other terminal after a `/login`.
 */
export async function resolveFrozenNativeClaudeProfile(
  _nativeClaudeProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCliExecutionProfile> {
  return resolveNewNativeClaudeProfile(baseEnv);
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
