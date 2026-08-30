import type {
  GrokCliProfileId,
  GrokCliResolvedProfile,
} from "./grok-cli-account-profiles";
import { isAbsolute, resolve } from "node:path";
import {
  GrokCliAccountProfileLeasedError,
  GrokCliAccountProfileStore,
  normalizeGrokCliProfileId,
} from "./grok-cli-account-profiles";

/**
 * Environment credentials that can bypass the selected SuperGrok subscription
 * or route native Grok through a metered/third-party API. Comparisons are
 * case-insensitive so Windows cannot retain a differently-cased duplicate.
 */
export const GROK_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES = new Set([
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GROK_ACCESS_TOKEN",
]);

export interface GrokCliExecutionProfile {
  profileId: GrokCliProfileId;
  label: string;
  managed: boolean;
  connected: boolean;
  /** Exact child environment. This object never aliases process.env. */
  env: NodeJS.ProcessEnv;
}

export interface ResolveGrokCliExecutionInput {
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildGrokCliProfileEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  grokHome: string,
): NodeJS.ProcessEnv {
  if (
    typeof grokHome !== "string" ||
    !grokHome.trim() ||
    !isAbsolute(grokHome) ||
    resolve(grokHome) !== grokHome
  ) {
    throw new TypeError(
      "Native Grok home must be a non-empty canonical absolute path",
    );
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (
      upper === "GROK_HOME" ||
      GROK_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES.has(upper)
    ) {
      continue;
    }
    env[key] = value;
  }
  env.GROK_HOME = grokHome;
  return env;
}

export async function resolveGrokCliExecutionProfile(
  store: GrokCliAccountProfileStore,
  input: ResolveGrokCliExecutionInput = {},
): Promise<GrokCliExecutionProfile> {
  const resolved: GrokCliResolvedProfile = await store.resolveProfile({
    profileId: input.profileId,
    useDefault: input.useDefault,
    requireConnected: input.requireConnected,
  });
  return {
    profileId: resolved.profileId,
    label: resolved.label,
    managed: resolved.managed,
    connected: resolved.connected,
    env: buildGrokCliProfileEnvironment(
      input.baseEnv ?? process.env,
      resolved.homeDir,
    ),
  };
}

/**
 * Persisted pre-feature absence is always the personal home, never the mutable
 * configured default. New-session callers resolve the default explicitly and
 * persist the resulting concrete id before launch.
 */
export function frozenGrokCliProfileId(
  value: string | null | undefined,
): GrokCliProfileId {
  return normalizeGrokCliProfileId(value);
}

export function preserveFrozenGrokCliProfileId(
  frozenValue: string | null | undefined,
  resultValue: string | null | undefined,
): GrokCliProfileId {
  const frozen = frozenGrokCliProfileId(frozenValue);
  const result =
    resultValue === undefined || resultValue === null || resultValue === ""
      ? frozen
      : normalizeGrokCliProfileId(
          resultValue,
          "Resolved native Grok account profile id",
        );
  if (result !== frozen) {
    throw new Error("Native Grok account changed during one frozen execution");
  }
  return frozen;
}

export class GrokCliProfileLeaseRegistry {
  private readonly ownerToProfile = new Map<
    string,
    { profileId: GrokCliProfileId; count: number }
  >();
  private readonly profileToOwners = new Map<GrokCliProfileId, Set<string>>();
  private readonly exclusiveProfiles = new Set<GrokCliProfileId>();

  acquire(
    rawProfileId: string | null | undefined,
    ownerId: string,
  ): () => void {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    if (
      typeof ownerId !== "string" ||
      !ownerId.trim() ||
      ownerId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(ownerId)
    ) {
      throw new TypeError(
        "Native Grok profile lease owner must be a bounded label",
      );
    }
    const owner = ownerId.trim();
    const existing = this.ownerToProfile.get(owner);
    if (this.exclusiveProfiles.has(profileId)) {
      throw new Error(
        `Native Grok account profile is being deleted and cannot be acquired: ${profileId}`,
      );
    }
    if (existing && existing.profileId !== profileId) {
      throw new Error(
        `Native Grok lease owner ${owner} is already pinned to another profile`,
      );
    }
    if (!existing) {
      this.ownerToProfile.set(owner, { profileId, count: 1 });
      const owners = this.profileToOwners.get(profileId) ?? new Set<string>();
      owners.add(owner);
      this.profileToOwners.set(profileId, owners);
    } else {
      existing.count += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const lease = this.ownerToProfile.get(owner);
      if (!lease || lease.profileId !== profileId) return;
      lease.count -= 1;
      if (lease.count > 0) return;
      this.ownerToProfile.delete(owner);
      const owners = this.profileToOwners.get(profileId);
      owners?.delete(owner);
      if (owners?.size === 0) this.profileToOwners.delete(profileId);
    };
  }

  isLeased(rawProfileId: GrokCliProfileId): boolean {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    return (this.profileToOwners.get(profileId)?.size ?? 0) > 0;
  }

  owners(rawProfileId: GrokCliProfileId): string[] {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    return [...(this.profileToOwners.get(profileId) ?? [])].sort();
  }

  profileForOwner(ownerId: string): GrokCliProfileId | null {
    return this.ownerToProfile.get(ownerId)?.profileId ?? null;
  }

  /**
   * Release every lease whose owner carries `ownerPrefix` but is not in the
   * live set. A terminal that died without reaching its exit handler would
   * otherwise pin its account forever; owners outside the prefix (Cora runs)
   * are never touched because their liveness is tracked elsewhere.
   */
  sweep(liveOwnerIds: ReadonlySet<string>, ownerPrefix = "terminal:"): string[] {
    const released: string[] = [];
    for (const [owner, lease] of [...this.ownerToProfile.entries()]) {
      if (!owner.startsWith(ownerPrefix) || liveOwnerIds.has(owner)) continue;
      this.ownerToProfile.delete(owner);
      const owners = this.profileToOwners.get(lease.profileId);
      owners?.delete(owner);
      if (owners?.size === 0) this.profileToOwners.delete(lease.profileId);
      released.push(owner);
    }
    return released.sort();
  }

  async runWhileUnleased<T>(
    rawProfileId: GrokCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    if (this.exclusiveProfiles.has(profileId) || this.isLeased(profileId)) {
      throw new GrokCliAccountProfileLeasedError(profileId);
    }
    this.exclusiveProfiles.add(profileId);
    try {
      return await operation();
    } finally {
      this.exclusiveProfiles.delete(profileId);
    }
  }

  clear(): void {
    this.ownerToProfile.clear();
    this.profileToOwners.clear();
    this.exclusiveProfiles.clear();
  }
}

let defaultLeases: GrokCliProfileLeaseRegistry | null = null;

export function defaultGrokCliProfileLeases(): GrokCliProfileLeaseRegistry {
  defaultLeases ??= new GrokCliProfileLeaseRegistry();
  return defaultLeases;
}
