import {
  CodexCliAccountProfileStore,
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import {
  defaultCodexCliProfileLeases,
  resolveCodexCliExecutionProfile,
  type CodexCliExecutionProfile,
} from "./codex-cli-profile-execution";

/**
 * One process-wide store/lease pair for every native Codex launch surface.
 * Keeping this centralized is what makes profile deletion reliably reject
 * while a manager, worker, or manual terminal still owns the selected home.
 */
export const nativeCodexProfileLeases = defaultCodexCliProfileLeases();
export const nativeCodexProfileStore = new CodexCliAccountProfileStore(
  undefined,
  { leases: nativeCodexProfileLeases },
);

export async function resolveNewNativeCodexProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  return resolveCodexCliExecutionProfile(nativeCodexProfileStore, {
    useDefault: true,
    baseEnv,
  });
}

export async function resolveFrozenNativeCodexProfile(
  nativeCodexProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliExecutionProfile> {
  return resolveCodexCliExecutionProfile(nativeCodexProfileStore, {
    // An absent persisted value is intentionally personal for legacy records.
    profileId: nativeCodexProfileId,
    baseEnv,
  });
}

export function acquireNativeCodexProfileLease(
  profileId: CodexCliProfileId,
  ownerId: string,
): () => void {
  return nativeCodexProfileLeases.acquire(profileId, ownerId);
}
