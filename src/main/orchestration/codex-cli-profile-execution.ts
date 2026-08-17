import type {
  CodexCliProfileId,
  CodexCliResolvedProfile,
} from "./codex-cli-account-profiles";
import { isAbsolute, resolve } from "node:path";
import {
  CODEX_CLI_PERSONAL_PROFILE_ID,
  CodexCliAccountProfileLeasedError,
  CodexCliAccountProfileStore,
  normalizeCodexCliProfileId,
} from "./codex-cli-account-profiles";

/**
 * Environment credentials that can bypass the selected ChatGPT subscription
 * or route native Codex through a metered/third-party API. Comparisons are
 * case-insensitive so Windows cannot retain a differently-cased duplicate.
 */
export const CODEX_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_AD_TOKEN",
  "OPENROUTER_API_KEY",
]);

export interface CodexCliExecutionProfile {
  profileId: CodexCliProfileId;
  label: string;
  managed: boolean;
  connected: boolean;
  /** Exact child environment. This object never aliases process.env. */
  env: NodeJS.ProcessEnv;
}

export interface ResolveCodexCliExecutionInput {
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildCodexCliProfileEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  if (
    typeof codexHome !== "string" ||
    !codexHome.trim() ||
    !isAbsolute(codexHome) ||
    resolve(codexHome) !== codexHome
  ) {
    throw new TypeError(
      "Native Codex home must be a non-empty canonical absolute path",
    );
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (
      upper === "CODEX_HOME" ||
      CODEX_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES.has(upper)
    ) {
      continue;
    }
    env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  return env;
}

export async function resolveCodexCliExecutionProfile(
  store: CodexCliAccountProfileStore,
  input: ResolveCodexCliExecutionInput = {},
): Promise<CodexCliExecutionProfile> {
  const resolved: CodexCliResolvedProfile = await store.resolveProfile({
    profileId: input.profileId,
    useDefault: input.useDefault,
    requireConnected: input.requireConnected,
  });
  return {
    profileId: resolved.profileId,
    label: resolved.label,
    managed: resolved.managed,
    connected: resolved.connected,
    env: buildCodexCliProfileEnvironment(
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
export function frozenCodexCliProfileId(
  value: string | null | undefined,
): CodexCliProfileId {
  return normalizeCodexCliProfileId(value);
}

export function preserveFrozenCodexCliProfileId(
  frozenValue: string | null | undefined,
  resultValue: string | null | undefined,
): CodexCliProfileId {
  const frozen = frozenCodexCliProfileId(frozenValue);
  const result =
    resultValue === undefined || resultValue === null || resultValue === ""
      ? frozen
      : normalizeCodexCliProfileId(
          resultValue,
          "Resolved native Codex account profile id",
        );
  if (result !== frozen) {
    throw new Error("Native Codex account changed during one frozen execution");
  }
  return frozen;
}

export class CodexCliProfileLeaseRegistry {
  private readonly ownerToProfile = new Map<
    string,
    { profileId: CodexCliProfileId; count: number }
  >();
  private readonly profileToOwners = new Map<CodexCliProfileId, Set<string>>();
  private readonly exclusiveProfiles = new Set<CodexCliProfileId>();

  acquire(
    rawProfileId: string | null | undefined,
    ownerId: string,
  ): () => void {
    const profileId = normalizeCodexCliProfileId(rawProfileId);
    if (
      typeof ownerId !== "string" ||
      !ownerId.trim() ||
      ownerId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(ownerId)
    ) {
      throw new TypeError(
        "Native Codex profile lease owner must be a bounded label",
      );
    }
    const owner = ownerId.trim();
    const existing = this.ownerToProfile.get(owner);
    if (this.exclusiveProfiles.has(profileId)) {
      throw new Error(
        `Native Codex account profile is being deleted and cannot be acquired: ${profileId}`,
      );
    }
    if (existing && existing.profileId !== profileId) {
      throw new Error(
        `Native Codex lease owner ${owner} is already pinned to another profile`,
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

  isLeased(rawProfileId: CodexCliProfileId): boolean {
    const profileId = normalizeCodexCliProfileId(rawProfileId);
    return (this.profileToOwners.get(profileId)?.size ?? 0) > 0;
  }

  owners(rawProfileId: CodexCliProfileId): string[] {
    const profileId = normalizeCodexCliProfileId(rawProfileId);
    return [...(this.profileToOwners.get(profileId) ?? [])].sort();
  }

  profileForOwner(ownerId: string): CodexCliProfileId | null {
    return this.ownerToProfile.get(ownerId)?.profileId ?? null;
  }

  async runWhileUnleased<T>(
    rawProfileId: CodexCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const profileId = normalizeCodexCliProfileId(rawProfileId);
    if (this.exclusiveProfiles.has(profileId) || this.isLeased(profileId)) {
      throw new CodexCliAccountProfileLeasedError(profileId);
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

let defaultLeases: CodexCliProfileLeaseRegistry | null = null;

export function defaultCodexCliProfileLeases(): CodexCliProfileLeaseRegistry {
  defaultLeases ??= new CodexCliProfileLeaseRegistry();
  return defaultLeases;
}
