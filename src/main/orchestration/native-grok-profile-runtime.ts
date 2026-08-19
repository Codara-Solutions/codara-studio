import {
  GrokCliAccountProfileStore,
  type GrokCliProfileId,
} from "./grok-cli-account-profiles";
import {
  defaultGrokCliProfileLeases,
  resolveGrokCliExecutionProfile,
  type GrokCliExecutionProfile,
} from "./grok-cli-profile-execution";

/**
 * One process-wide store/lease pair for every native Grok launch surface.
 * Keeping this centralized is what makes profile deletion reliably reject
 * while a manager, worker, or manual terminal still owns the selected home.
 */
export const nativeGrokProfileLeases = defaultGrokCliProfileLeases();
export const nativeGrokProfileStore = new GrokCliAccountProfileStore(
  undefined,
  { leases: nativeGrokProfileLeases },
);

export async function resolveNewNativeGrokProfile(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  return resolveGrokCliExecutionProfile(nativeGrokProfileStore, {
    useDefault: true,
    baseEnv,
  });
}

export async function resolveFrozenNativeGrokProfile(
  nativeGrokProfileId: string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokCliExecutionProfile> {
  return resolveGrokCliExecutionProfile(nativeGrokProfileStore, {
    // An absent persisted value is intentionally personal for legacy records.
    profileId: nativeGrokProfileId,
    baseEnv,
  });
}

export function acquireNativeGrokProfileLease(
  profileId: GrokCliProfileId,
  ownerId: string,
): () => void {
  return nativeGrokProfileLeases.acquire(profileId, ownerId);
}
