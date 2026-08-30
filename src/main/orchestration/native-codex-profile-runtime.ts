import {
  CodexCliAccountProfileStore,
  codaraCodexCliAccountRootDir,
  defaultPersonalCodexHomeDir,
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import { codexCliPersonalAuthFile } from "./codex-cli-auth-selector";
import {
  buildCodexCliSharedEnvironment,
  defaultCodexCliProfileLeases,
  type CodexCliExecutionProfile,
} from "./codex-cli-profile-execution";

/**
 * One process-wide store/lease pair for every native Codex launch surface.
 * Keeping this centralized is what makes profile deletion reliably reject
 * while a manager, worker, or manual terminal still owns the selected home.
 *
 * Codex authentication is global: every process reads the one live
 * ~/.codex/auth.json, which the unified account service keeps aligned with
 * the store default. Launching never moves the live file itself.
 */
export const nativeCodexProfileLeases = defaultCodexCliProfileLeases();

/**
 * Installed by the unified account service once it is loaded: every launch
 * waits for the startup migration and reconciles the active account's
 * credential (and re-activates a lagging marker) first. Injected rather than
 * imported so this launch-path module never pulls the account service, the
 * registry and the Pi runtime into every surface that resolves a profile.
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
  const hooks = resolutionHooks;
  await hooks?.ready();
  await hooks?.beforeNewProfile().catch(() => undefined);
  // Resolve account metadata directly. The more general execution-profile
  // helper builds an isolated CODEX_HOME; normal terminals must never even
  // construct that env.
  const selected = await nativeCodexProfileStore.resolveProfile({
    useDefault: true,
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
