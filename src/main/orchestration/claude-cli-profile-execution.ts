import type {
  ClaudeCliProfileId,
  ClaudeCliResolvedProfile,
} from "./claude-cli-account-profiles";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  ClaudeCliAccountProfileLeasedError,
  ClaudeCliAccountProfileStore,
  normalizeClaudeCliProfileId,
} from "./claude-cli-account-profiles";
import { buildClaudeCliProfileEnvironment } from "./claude-cli-profile-environment";

export interface ClaudeCliExecutionProfile {
  profileId: ClaudeCliProfileId;
  label: string;
  managed: boolean;
  connected: boolean;
  /** Exact child environment. This object never aliases process.env. */
  env: NodeJS.ProcessEnv;
}

export interface ResolveClaudeCliExecutionInput {
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

export async function resolveClaudeCliExecutionProfile(
  store: ClaudeCliAccountProfileStore,
  input: ResolveClaudeCliExecutionInput = {},
): Promise<ClaudeCliExecutionProfile> {
  const resolved: ClaudeCliResolvedProfile = await store.resolveProfile({
    profileId: input.profileId,
    useDefault: input.useDefault,
    requireConnected: input.requireConnected,
  });
  return {
    profileId: resolved.profileId,
    label: resolved.label,
    managed: resolved.managed,
    connected: resolved.connected,
    env: buildClaudeCliProfileEnvironment(
      input.baseEnv ?? process.env,
      resolved.configDirEnv,
    ),
  };
}

/**
 * Persisted pre-feature absence is always the personal config directory, never
 * the mutable configured default. New-session callers must resolve the default
 * explicitly and persist the resulting concrete id before launch.
 */
export function frozenClaudeCliProfileId(
  value: string | null | undefined,
): ClaudeCliProfileId {
  return normalizeClaudeCliProfileId(value);
}

export function preserveFrozenClaudeCliProfileId(
  frozenValue: string | null | undefined,
  resultValue: string | null | undefined,
): ClaudeCliProfileId {
  const frozen = frozenClaudeCliProfileId(frozenValue);
  const result =
    resultValue === undefined || resultValue === null || resultValue === ""
      ? frozen
      : normalizeClaudeCliProfileId(
          resultValue,
          "Resolved native Claude account profile id",
        );
  if (result !== frozen) {
    throw new Error("Native Claude account changed during one frozen execution");
  }
  return frozen;
}

export class ClaudeCliProfileLeaseRegistry {
  private readonly ownerToProfile = new Map<
    string,
    { profileId: ClaudeCliProfileId; count: number }
  >();
  private readonly profileToOwners = new Map<ClaudeCliProfileId, Set<string>>();
  private readonly exclusiveProfiles = new Set<ClaudeCliProfileId>();

  acquire(
    rawProfileId: string | null | undefined,
    ownerId: string,
  ): () => void {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    if (
      typeof ownerId !== "string" ||
      !ownerId.trim() ||
      ownerId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(ownerId)
    ) {
      throw new TypeError(
        "Native Claude profile lease owner must be a bounded label",
      );
    }
    const owner = ownerId.trim();
    const existing = this.ownerToProfile.get(owner);
    if (this.exclusiveProfiles.has(profileId)) {
      throw new Error(
        `Native Claude account profile is being deleted and cannot be acquired: ${profileId}`,
      );
    }
    if (existing && existing.profileId !== profileId) {
      throw new Error(
        `Native Claude lease owner ${owner} is already pinned to another profile`,
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

  isLeased(rawProfileId: ClaudeCliProfileId): boolean {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    return (this.profileToOwners.get(profileId)?.size ?? 0) > 0;
  }

  owners(rawProfileId: ClaudeCliProfileId): string[] {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    return [...(this.profileToOwners.get(profileId) ?? [])].sort();
  }

  profileForOwner(ownerId: string): ClaudeCliProfileId | null {
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
    rawProfileId: ClaudeCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    if (this.exclusiveProfiles.has(profileId) || this.isLeased(profileId)) {
      throw new ClaudeCliAccountProfileLeasedError(profileId);
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

let defaultLeases: ClaudeCliProfileLeaseRegistry | null = null;

export function defaultClaudeCliProfileLeases(): ClaudeCliProfileLeaseRegistry {
  defaultLeases ??= new ClaudeCliProfileLeaseRegistry();
  return defaultLeases;
}

export function isPersonalClaudeCliProfile(
  profileId: ClaudeCliProfileId,
): profileId is typeof CLAUDE_CLI_PERSONAL_PROFILE_ID {
  return profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID;
}
