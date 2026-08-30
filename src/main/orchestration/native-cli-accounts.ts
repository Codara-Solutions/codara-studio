import { dirname } from "node:path";
import {
  claudeCliManagedProfileConfigDir,
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  ClaudeCliAccountProfileLeasedError,
  ClaudeCliAccountProfileNotFoundError,
  ClaudeCliAccountProfileSafetyError,
  ClaudeCliAccountProfilesCorruptError,
  ClaudeCliAccountProfileStore,
  ClaudeCliDefaultProfileDeletionError,
  normalizeClaudeCliProfileId,
  type ClaudeCliProfileConnection,
} from "./claude-cli-account-profiles";
import { ClaudeCliProfileLeaseRegistry } from "./claude-cli-profile-execution";
import {
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codexCliManagedProfilePaths,
  CodexCliAccountProfileLeasedError,
  CodexCliAccountProfileNotFoundError,
  CodexCliAccountProfileSafetyError,
  CodexCliAccountProfilesCorruptError,
  CodexCliAccountProfileStore,
  CodexCliDefaultProfileDeletionError,
  normalizeCodexCliProfileId,
  type CodexCliProfileConnection,
} from "./codex-cli-account-profiles";
import { codexCliPersonalAuthFile, readCodexCliSelection } from "./codex-cli-auth-selector";
import { CodexCliProfileLeaseRegistry } from "./codex-cli-profile-execution";
import {
  GROK_CLI_PERSONAL_PROFILE_ID,
  grokCliManagedProfilePaths,
  GrokCliAccountProfileLeasedError,
  GrokCliAccountProfileNotFoundError,
  GrokCliAccountProfileSafetyError,
  GrokCliAccountProfilesCorruptError,
  GrokCliAccountProfileStore,
  GrokCliDefaultProfileDeletionError,
  normalizeGrokCliProfileId,
  type GrokCliProfileConnection,
} from "./grok-cli-account-profiles";
import { GrokCliProfileLeaseRegistry } from "./grok-cli-profile-execution";
import {
  readClaudeCliAccountIdentity,
  readCodexCliAccountIdentity,
  readGrokCliAccountIdentity,
  type NativeCliAccountIdentity,
} from "./native-cli-account-identity";
import {
  nativeClaudeProfileLeases,
  nativeClaudeProfileStore,
} from "./native-claude-profile-runtime";
import {
  nativeCodexProfileLeases,
  nativeCodexProfileStore,
} from "./native-codex-profile-runtime";
import {
  nativeGrokProfileLeases,
  nativeGrokProfileStore,
} from "./native-grok-profile-runtime";
import { isAgentRuntimeKind } from "../../shared/agent-families";

/**
 * The token-blind view of the three native CLI profile stores, plus rename.
 * Every other mutation of a CLI profile (create, sign in, switch, sign out,
 * delete) belongs to the unified account service of its provider: one
 * sign-in serves Cora and the CLI together, and this facade refuses them
 * with one typed code so a caller learns where to go.
 */

export type NativeCliAccountRuntime = "claude" | "codex" | "grok";

export type NativeCliAccountConnectionStatus =
  | "connected"
  | "sign_in_required"
  | "unsafe"
  | "unavailable";

/**
 * Renderer-safe projection. It intentionally has no credential, filesystem
 * path, child environment, or raw process output. Provider identity appears as
 * accountFingerprint (a one-way digest, never the id it came from) and as the
 * account's email, which the Settings card shows so one login is tellable from
 * another. The email is for this machine's own window only: the remote
 * projection in remote-access/native-cli-account-projection.ts drops it, so it
 * never reaches a paired phone.
 */
export interface NativeCliAccountProfile {
  runtime: NativeCliAccountRuntime;
  id: string;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  inUse: boolean;
  status: NativeCliAccountConnectionStatus;
  /**
   * sha256 of the vendor account id this sign-in belongs to, matching the
   * digest Pi's account store records, so Settings can render one card for a
   * Cora connection and a CLI sign-in that share an account. Absent when the
   * sign-in is signed out or its account cannot be read; see
   * native-cli-account-identity.ts.
   */
  accountFingerprint?: string;
  /**
   * The email address this sign-in belongs to, as the provider itself reports
   * it. Absent when the sign-in is signed out or its account cannot be read.
   */
  email?: string;
}

export interface NativeCliAccountRuntimeInspection {
  runtime: NativeCliAccountRuntime;
  defaultProfileId: string;
  profiles: NativeCliAccountProfile[];
  /** This provider failed independently; sibling providers remain usable. */
  unavailable?: boolean;
}

export interface NativeCliAccountsInspection {
  runtimes: NativeCliAccountRuntimeInspection[];
}

export interface NativeCliAccountProfileInput {
  runtime: NativeCliAccountRuntime;
  profileId: string;
}

export interface NativeCliAccountRenameInput
  extends NativeCliAccountProfileInput {
  label: string;
}

export interface NativeCliAccountMutationResult {
  profile: NativeCliAccountProfile;
  inspection: NativeCliAccountRuntimeInspection;
  /** Sessions closed before an account activation; absent for other mutations. */
  closedSessionCount?: number;
}

export interface NativeCliAccountDeleteResult {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  deleted: boolean;
}

/**
 * Read-only account-identity probe. It receives a main-process-only credential
 * path and returns a digest and email or nothing; it must never write, refresh,
 * or copy the credential, and must never throw.
 */
export type NativeCliAccountIdentityReader = (
  authFile: string,
) => Promise<NativeCliAccountIdentity>;

/**
 * Read-only account-identity probe for Claude Code, which records its account
 * in a config file rather than a credential file. It receives the profile's
 * config directory and the CLAUDE_CONFIG_DIR value that profile runs with, and
 * is bound by the same rules as the reader above.
 */
export type ClaudeCliAccountIdentityReader = (
  configDir: string,
  configDirEnv: string | null,
  homeDir: string,
) => Promise<NativeCliAccountIdentity>;

export type NativeCliAccountErrorCode =
  | "NATIVE_CLI_ACCOUNT_INVALID_RUNTIME"
  | "NATIVE_CLI_ACCOUNT_NOT_FOUND"
  | "NATIVE_CLI_ACCOUNT_NOT_CONNECTED"
  | "NATIVE_CLI_ACCOUNT_ACTIVE"
  | "NATIVE_CLI_ACCOUNT_DEFAULT"
  | "NATIVE_CLI_ACCOUNT_PERSONAL"
  | "NATIVE_CLI_ACCOUNT_STORE_UNSAFE"
  | "NATIVE_CLI_ACCOUNT_STORE_CORRUPT"
  | "NATIVE_CLI_ACCOUNT_UNIFIED"
  | "NATIVE_CLI_ACCOUNT_OPERATION_FAILED";

const SAFE_ERROR_MESSAGES: Record<NativeCliAccountErrorCode, string> = {
  NATIVE_CLI_ACCOUNT_INVALID_RUNTIME:
    "Native CLI account runtime must be Claude, Codex, or Grok",
  NATIVE_CLI_ACCOUNT_NOT_FOUND: "Native CLI account was not found",
  NATIVE_CLI_ACCOUNT_NOT_CONNECTED: "Native CLI account is not connected",
  NATIVE_CLI_ACCOUNT_ACTIVE:
    "Native CLI account is active and cannot be changed",
  NATIVE_CLI_ACCOUNT_DEFAULT:
    "Choose another default before deleting this native CLI account",
  NATIVE_CLI_ACCOUNT_PERSONAL:
    "The personal native CLI account cannot be removed or renamed",
  NATIVE_CLI_ACCOUNT_STORE_UNSAFE: "Native CLI account store is unsafe",
  NATIVE_CLI_ACCOUNT_STORE_CORRUPT: "Native CLI account store is corrupt",
  NATIVE_CLI_ACCOUNT_UNIFIED:
    "CLI accounts are managed from their account card: one sign-in serves Cora and the CLI together",
  NATIVE_CLI_ACCOUNT_OPERATION_FAILED: "Native CLI account operation failed",
};

export class NativeCliAccountError extends Error {
  readonly code: NativeCliAccountErrorCode;
  readonly runtime?: NativeCliAccountRuntime;
  readonly profileId?: string;

  constructor(
    code: NativeCliAccountErrorCode,
    details: {
      runtime?: NativeCliAccountRuntime;
      profileId?: string;
    } = {},
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "NativeCliAccountError";
    this.code = code;
    this.runtime = details.runtime;
    this.profileId = details.profileId;
  }
}

function normalizeRuntime(value: unknown): NativeCliAccountRuntime {
  if (isAgentRuntimeKind(value)) return value;
  throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_INVALID_RUNTIME");
}

function isPersonalProfile(
  runtime: NativeCliAccountRuntime,
  profileId: string,
): boolean {
  if (runtime === "claude") return profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID;
  if (runtime === "grok") return profileId === GROK_CLI_PERSONAL_PROFILE_ID;
  return profileId === CODEX_CLI_PERSONAL_PROFILE_ID;
}

type AnyConnection =
  | ClaudeCliProfileConnection
  | CodexCliProfileConnection
  | GrokCliProfileConnection;

function connectionStatus(connection: AnyConnection): NativeCliAccountConnectionStatus {
  if (connection.connected) return "connected";
  if (connection.error === "Sign in required") return "sign_in_required";
  if (
    connection.error === "Config directory is unsafe" ||
    connection.error === "Credential file is unsafe"
  ) {
    return "unsafe";
  }
  return "unavailable";
}

function sanitizeConnection(
  runtime: NativeCliAccountRuntime,
  connection: AnyConnection,
  identity: NativeCliAccountIdentity | undefined,
): NativeCliAccountProfile {
  return {
    runtime,
    id: connection.id,
    label: connection.label,
    managed: connection.managed,
    isDefault: connection.isDefault,
    connected: connection.connected,
    inUse: connection.inUse,
    status: connectionStatus(connection),
    ...(identity?.fingerprint ? { accountFingerprint: identity.fingerprint } : {}),
    ...(identity?.email ? { email: identity.email } : {}),
  };
}

export interface NativeCliAccountServiceOptions {
  claudeStore?: ClaudeCliAccountProfileStore;
  codexStore?: CodexCliAccountProfileStore;
  grokStore?: GrokCliAccountProfileStore;
  claudeLeases?: ClaudeCliProfileLeaseRegistry;
  codexLeases?: CodexCliProfileLeaseRegistry;
  grokLeases?: GrokCliProfileLeaseRegistry;
  /** Test seam. Production reads the Codex credential's account id and email. */
  codexIdentityReader?: NativeCliAccountIdentityReader;
  /** Test seam. Production reads the Grok Build credential's account id and email. */
  grokIdentityReader?: NativeCliAccountIdentityReader;
  /** Test seam. Production reads the Claude Code config's account uuid and email. */
  claudeIdentityReader?: ClaudeCliAccountIdentityReader;
}

export class NativeCliAccountService {
  private readonly claudeStore: ClaudeCliAccountProfileStore;
  private readonly codexStore: CodexCliAccountProfileStore;
  private readonly grokStore: GrokCliAccountProfileStore;
  private readonly codexIdentityReader: NativeCliAccountIdentityReader;
  private readonly grokIdentityReader: NativeCliAccountIdentityReader;
  private readonly claudeIdentityReader: ClaudeCliAccountIdentityReader;

  constructor(options: NativeCliAccountServiceOptions = {}) {
    // A custom store carries its own lease registry (the store consults it
    // for inUse); the pair must be supplied together so they cannot drift.
    if (
      (options.claudeStore && !options.claudeLeases) ||
      (!options.claudeStore && options.claudeLeases)
    ) {
      throw new TypeError(
        "Custom native Claude store and lease registry must be supplied together",
      );
    }
    if (
      (options.codexStore && !options.codexLeases) ||
      (!options.codexStore && options.codexLeases)
    ) {
      throw new TypeError(
        "Custom native Codex store and lease registry must be supplied together",
      );
    }
    if (
      (options.grokStore && !options.grokLeases) ||
      (!options.grokStore && options.grokLeases)
    ) {
      throw new TypeError(
        "Custom native Grok store and lease registry must be supplied together",
      );
    }
    void nativeClaudeProfileLeases;
    void nativeCodexProfileLeases;
    void nativeGrokProfileLeases;
    this.claudeStore = options.claudeStore ?? nativeClaudeProfileStore;
    this.codexStore = options.codexStore ?? nativeCodexProfileStore;
    this.grokStore = options.grokStore ?? nativeGrokProfileStore;
    this.codexIdentityReader = options.codexIdentityReader ?? readCodexCliAccountIdentity;
    this.grokIdentityReader = options.grokIdentityReader ?? readGrokCliAccountIdentity;
    this.claudeIdentityReader = options.claudeIdentityReader ?? readClaudeCliAccountIdentity;
  }

  private normalizeProfileId(
    runtime: NativeCliAccountRuntime,
    value: unknown,
  ): string {
    try {
      if (runtime === "claude") return normalizeClaudeCliProfileId(value);
      if (runtime === "grok") return normalizeGrokCliProfileId(value);
      return normalizeCodexCliProfileId(value);
    } catch {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_NOT_FOUND", { runtime });
    }
  }

  /**
   * Account identities for connected Claude sign-ins, keyed by profile id.
   * The config path stays inside this method; only the digest and email
   * leave it.
   */
  private async claudeAccountIdentities(
    profiles: readonly ClaudeCliProfileConnection[],
  ): Promise<Map<string, NativeCliAccountIdentity>> {
    const identities = new Map<string, NativeCliAccountIdentity>();
    await Promise.all(
      profiles.map(async (profile) => {
        if (!profile.connected) return;
        let configDir: string;
        let configDirEnv: string | null;
        try {
          configDir = profile.managed
            ? claudeCliManagedProfileConfigDir(this.claudeStore.rootDir, profile.id)
            : this.claudeStore.personalConfigDir;
          configDirEnv = profile.managed
            ? configDir
            : this.claudeStore.personalConfigDirEnv;
        } catch {
          return;
        }
        // The personal profile runs with no CLAUDE_CONFIG_DIR, so Claude Code
        // keeps its config beside that directory rather than inside it. Taking
        // the home directory from the store keeps a store pointed at a sandbox
        // from reaching the real one.
        const homeDir = dirname(this.claudeStore.personalConfigDir);
        const identity = await this.claudeIdentityReader(
          configDir,
          configDirEnv,
          homeDir,
        ).catch(() => undefined);
        if (identity?.fingerprint || identity?.email) {
          identities.set(profile.id, identity);
        }
      }),
    );
    return identities;
  }

  /**
   * Account identities for connected Codex sign-ins, keyed by profile id.
   * The slot that answers for a profile depends on the marker: the live
   * ~/.codex/auth.json while the profile is active, its vault slot otherwise.
   */
  private async codexAccountIdentities(
    profiles: readonly CodexCliProfileConnection[],
  ): Promise<Map<string, NativeCliAccountIdentity>> {
    const identities = new Map<string, NativeCliAccountIdentity>();
    const active =
      (await readCodexCliSelection(this.codexStore.rootDir).catch(() => null)) ??
      CODEX_CLI_PERSONAL_PROFILE_ID;
    await Promise.all(
      profiles.map(async (profile) => {
        if (!profile.connected) return;
        let authFile: string;
        try {
          authFile =
            profile.id === active
              ? this.codexStore.personalAuthFile
              : profile.managed
                ? codexCliManagedProfilePaths(this.codexStore.rootDir, profile.id).authFile
                : codexCliPersonalAuthFile(this.codexStore.rootDir);
        } catch {
          return;
        }
        const identity = await this.codexIdentityReader(authFile).catch(() => undefined);
        if (identity?.fingerprint || identity?.email) {
          identities.set(profile.id, identity);
        }
      }),
    );
    return identities;
  }

  private async grokAccountIdentities(
    profiles: readonly GrokCliProfileConnection[],
  ): Promise<Map<string, NativeCliAccountIdentity>> {
    const identities = new Map<string, NativeCliAccountIdentity>();
    await Promise.all(
      profiles.map(async (profile) => {
        if (!profile.connected) return;
        let authFile: string;
        try {
          authFile = profile.managed
            ? grokCliManagedProfilePaths(this.grokStore.rootDir, profile.id).authFile
            : this.grokStore.personalAuthFile;
        } catch {
          return;
        }
        const identity = await this.grokIdentityReader(authFile).catch(() => undefined);
        if (identity?.fingerprint || identity?.email) {
          identities.set(profile.id, identity);
        }
      }),
    );
    return identities;
  }

  private async inspectRuntime(
    runtime: NativeCliAccountRuntime,
  ): Promise<NativeCliAccountRuntimeInspection> {
    try {
      if (runtime === "claude") {
        const inspection = await this.claudeStore.inspect();
        const identities = await this.claudeAccountIdentities(inspection.profiles);
        return {
          runtime,
          defaultProfileId: inspection.defaultProfileId,
          profiles: inspection.profiles.map((profile) =>
            sanitizeConnection(runtime, profile, identities.get(profile.id)),
          ),
        };
      }
      const store = runtime === "grok" ? this.grokStore : this.codexStore;
      const inspection = await store.inspect();
      const identities =
        runtime === "grok"
          ? await this.grokAccountIdentities(inspection.profiles)
          : await this.codexAccountIdentities(inspection.profiles);
      return {
        runtime,
        defaultProfileId: inspection.defaultProfileId,
        profiles: inspection.profiles.map((profile) =>
          sanitizeConnection(runtime, profile, identities.get(profile.id)),
        ),
      };
    } catch (error) {
      throw this.sanitizeStoreError(runtime, undefined, error);
    }
  }

  async inspect(
    rawRuntime?: NativeCliAccountRuntime,
  ): Promise<NativeCliAccountsInspection> {
    if (rawRuntime !== undefined) {
      const runtime = normalizeRuntime(rawRuntime);
      return { runtimes: [await this.inspectRuntime(runtime)] };
    }
    const inspectIndependently = async (
      runtime: NativeCliAccountRuntime,
    ): Promise<NativeCliAccountRuntimeInspection> => {
      try {
        return await this.inspectRuntime(runtime);
      } catch {
        return {
          runtime,
          defaultProfileId: "personal",
          profiles: [],
          unavailable: true,
        };
      }
    };
    const [claude, codex, grok] = await Promise.all([
      inspectIndependently("claude"),
      inspectIndependently("codex"),
      inspectIndependently("grok"),
    ]);
    return { runtimes: [claude, codex, grok] };
  }

  private profileFromInspection(
    inspection: NativeCliAccountRuntimeInspection,
    profileId: string,
  ): NativeCliAccountProfile {
    const profile = inspection.profiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_NOT_FOUND", {
        runtime: inspection.runtime,
        profileId,
      });
    }
    return profile;
  }

  /**
   * Every mutation but rename belongs to the unified account service of the
   * CLI's provider: one sign-in through the account card writes both halves,
   * and the service owns switching, sharing and deletion.
   */
  assertNotUnified(runtime: NativeCliAccountRuntime, profileId?: string): never {
    throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_UNIFIED", {
      runtime,
      ...(profileId ? { profileId } : {}),
    });
  }

  async rename(
    input: NativeCliAccountRenameInput,
  ): Promise<NativeCliAccountMutationResult> {
    const runtime = normalizeRuntime(input.runtime);
    const profileId = this.normalizeProfileId(runtime, input.profileId);
    if (isPersonalProfile(runtime, profileId)) {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_PERSONAL", {
        runtime,
        profileId,
      });
    }
    try {
      if (runtime === "claude") {
        await this.claudeStore.renameProfile(profileId, input.label);
      } else if (runtime === "grok") {
        await this.grokStore.renameProfile(profileId, input.label);
      } else {
        await this.codexStore.renameProfile(profileId, input.label);
      }
      const inspection = await this.inspectRuntime(runtime);
      return {
        profile: this.profileFromInspection(inspection, profileId),
        inspection,
      };
    } catch (error) {
      throw this.sanitizeStoreError(runtime, profileId, error);
    }
  }

  private sanitizeStoreError(
    runtime: NativeCliAccountRuntime,
    profileId: string | undefined,
    error: unknown,
  ): NativeCliAccountError {
    if (error instanceof NativeCliAccountError) return error;
    if (
      error instanceof ClaudeCliAccountProfileLeasedError ||
      error instanceof CodexCliAccountProfileLeasedError ||
      error instanceof GrokCliAccountProfileLeasedError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_ACTIVE", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliDefaultProfileDeletionError ||
      error instanceof CodexCliDefaultProfileDeletionError ||
      error instanceof GrokCliDefaultProfileDeletionError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_DEFAULT", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfileNotFoundError ||
      error instanceof CodexCliAccountProfileNotFoundError ||
      error instanceof GrokCliAccountProfileNotFoundError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_NOT_FOUND", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfileSafetyError ||
      error instanceof CodexCliAccountProfileSafetyError ||
      error instanceof GrokCliAccountProfileSafetyError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_STORE_UNSAFE", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfilesCorruptError ||
      error instanceof CodexCliAccountProfilesCorruptError ||
      error instanceof GrokCliAccountProfilesCorruptError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_STORE_CORRUPT", {
        runtime,
        profileId,
      });
    }
    const message = error instanceof Error ? error.message : "";
    if (/must be connected|not connected/i.test(message)) {
      return new NativeCliAccountError(
        "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
        { runtime, profileId },
      );
    }
    return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_OPERATION_FAILED", {
      runtime,
      profileId,
    });
  }
}

/**
 * Process-wide facade. Constructing it performs no filesystem or child-process
 * work; callers opt into operations explicitly.
 */
export const nativeCliAccounts = new NativeCliAccountService();
