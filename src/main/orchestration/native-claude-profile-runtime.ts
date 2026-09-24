import {
  claudeCredentialAuthChecker,
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
 * launch surfaces resolve through this module so CLAUDE_CONFIG_DIR semantics
 * cannot drift between transports.
 *
 * Every account runs in the user's own Claude home, exactly as `claude` does
 * in any other terminal app; an account switch moves the login inside that
 * home (claude-cli-live-login.ts). A profile id only records which account a
 * session started on.
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
 * A restored pane or a transcript lookup for an earlier session. Its
 * account is history: every Claude session runs on the live login in the
 * one home, so it resolves like a new launch. A pane that started on another
 * account continues on the active one, the same as a `claude --resume` in
 * any other terminal after a `/login`.
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
