import {
  execFile,
  type ExecFileException,
  type ExecFileOptions,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
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
  type ClaudeCliProfileId,
} from "./claude-cli-account-profiles";
import {
  ClaudeCliProfileLeaseRegistry,
  resolveClaudeCliExecutionProfile,
} from "./claude-cli-profile-execution";
import {
  CODEX_CLI_AUTH_FILE,
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
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import {
  CodexCliProfileLeaseRegistry,
  resolveCodexCliExecutionProfile,
} from "./codex-cli-profile-execution";
import {
  readClaudeCliAccountIdentity,
  readCodexCliAccountIdentity,
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

export type NativeCliAccountRuntime = "claude" | "codex";

export type NativeCliAccountConnectionStatus =
  | "connected"
  | "sign_in_required"
  | "unsafe"
  | "unavailable";

/**
 * Renderer-safe projection. It intentionally has no credential, filesystem
 * path, child environment, or raw process output. Provider identity appears as
 * accountFingerprint — a one-way digest, never the id it came from — and as the
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
}

export interface NativeCliAccountsInspection {
  runtimes: NativeCliAccountRuntimeInspection[];
}

export interface NativeCliAccountProfileInput {
  runtime: NativeCliAccountRuntime;
  profileId: string;
}

export interface NativeCliAccountCreateInput {
  runtime: NativeCliAccountRuntime;
  label: string;
}

export interface NativeCliAccountRenameInput
  extends NativeCliAccountProfileInput {
  label: string;
}

export interface NativeCliAccountMutationResult {
  profile: NativeCliAccountProfile;
  inspection: NativeCliAccountRuntimeInspection;
}

export interface NativeCliAccountDeleteResult {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  deleted: boolean;
}

/**
 * The only login preparation value safe to cross IPC. The token is random,
 * one-time, short-lived, and has no executable, arguments, environment, or
 * selected-home path embedded in it.
 */
export interface NativeCliAccountLoginPreparation {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  launchToken: string;
  expiresAt: number;
}

/**
 * Main-process-only launch specification. Future IPC wiring must pass only a
 * NativeCliAccountLoginPreparation to the renderer and consume this object in
 * the main process when creating the Studio terminal.
 */
export interface NativeCliAccountLoginLaunchSpec {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface NativeCliAccountProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnFailed: boolean;
}

export type NativeCliAccountLoginLauncher = (
  spec: Readonly<NativeCliAccountLoginLaunchSpec>,
) =>
  | NativeCliAccountProcessResult
  | Promise<NativeCliAccountProcessResult>;

export interface NativeCliAccountProcessRequest {
  /** Main-process-only. Never expose the selected environment through IPC. */
  runtime: NativeCliAccountRuntime;
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxBufferBytes: number;
}

export type NativeCliAccountProcessRunner = (
  request: Readonly<NativeCliAccountProcessRequest>,
) =>
  | NativeCliAccountProcessResult
  | Promise<NativeCliAccountProcessResult>;

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
  | "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID"
  | "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED"
  | "NATIVE_CLI_ACCOUNT_LOGIN_SPAWN_FAILED"
  | "NATIVE_CLI_ACCOUNT_LOGIN_TIMEOUT"
  | "NATIVE_CLI_ACCOUNT_LOGIN_SIGNAL"
  | "NATIVE_CLI_ACCOUNT_LOGIN_FAILED"
  | "NATIVE_CLI_ACCOUNT_LOGOUT_SPAWN_FAILED"
  | "NATIVE_CLI_ACCOUNT_LOGOUT_TIMEOUT"
  | "NATIVE_CLI_ACCOUNT_LOGOUT_SIGNAL"
  | "NATIVE_CLI_ACCOUNT_LOGOUT_FAILED"
  | "NATIVE_CLI_ACCOUNT_OPERATION_FAILED";

const SAFE_ERROR_MESSAGES: Record<NativeCliAccountErrorCode, string> = {
  NATIVE_CLI_ACCOUNT_INVALID_RUNTIME:
    "Native CLI account runtime must be Claude or Codex",
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
  NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID:
    "Native CLI account login preparation is invalid or already used",
  NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED:
    "Native CLI account login preparation has expired",
  NATIVE_CLI_ACCOUNT_LOGIN_SPAWN_FAILED:
    "Could not start the native CLI account login",
  NATIVE_CLI_ACCOUNT_LOGIN_TIMEOUT: "Native CLI account login timed out",
  NATIVE_CLI_ACCOUNT_LOGIN_SIGNAL:
    "Native CLI account login ended unexpectedly",
  NATIVE_CLI_ACCOUNT_LOGIN_FAILED: "Native CLI account login failed",
  NATIVE_CLI_ACCOUNT_LOGOUT_SPAWN_FAILED:
    "Could not start the native CLI account logout",
  NATIVE_CLI_ACCOUNT_LOGOUT_TIMEOUT: "Native CLI account logout timed out",
  NATIVE_CLI_ACCOUNT_LOGOUT_SIGNAL:
    "Native CLI account logout ended unexpectedly",
  NATIVE_CLI_ACCOUNT_LOGOUT_FAILED: "Native CLI account logout failed",
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

export const NATIVE_CLI_ACCOUNT_PROCESS_TIMEOUT_MS = 10_000;
export const NATIVE_CLI_ACCOUNT_PROCESS_MAX_BUFFER_BYTES = 16 * 1024;
export const NATIVE_CLI_ACCOUNT_LOGIN_PLAN_TTL_MS = 60_000;

interface PendingLoginPlan {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  launchToken: string;
  expiresAt: number;
  state: "prepared" | "launching";
  releaseGuard: () => void;
  guardDone: Promise<void>;
  expiryTimer: NodeJS.Timeout;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function normalizeRuntime(value: unknown): NativeCliAccountRuntime {
  if (value === "claude" || value === "codex") return value;
  throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_INVALID_RUNTIME");
}

function isPersonalProfile(
  runtime: NativeCliAccountRuntime,
  profileId: string,
): boolean {
  return runtime === "claude"
    ? profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID
    : profileId === CODEX_CLI_PERSONAL_PROFILE_ID;
}

function connectionStatus(
  connection: ClaudeCliProfileConnection | CodexCliProfileConnection,
): NativeCliAccountConnectionStatus {
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
  connection: ClaudeCliProfileConnection | CodexCliProfileConnection,
  reservedByLogin: boolean,
  identity: NativeCliAccountIdentity | undefined,
): NativeCliAccountProfile {
  return {
    runtime,
    id: connection.id,
    label: connection.label,
    managed: connection.managed,
    isDefault: connection.isDefault,
    connected: connection.connected,
    inUse: connection.inUse || reservedByLogin,
    status: connectionStatus(connection),
    ...(identity?.fingerprint ? { accountFingerprint: identity.fingerprint } : {}),
    ...(identity?.email ? { email: identity.email } : {}),
  };
}

function processResultFromError(
  error: ExecFileException | null,
): NativeCliAccountProcessResult {
  if (!error) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      spawnFailed: false,
    };
  }
  const signal =
    typeof error.signal === "string"
      ? (error.signal as NodeJS.Signals)
      : null;
  const errorCode = error.code;
  const timedOut = error.killed === true && signal !== null;
  const spawnFailed =
    typeof errorCode === "string" &&
    errorCode !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  return {
    exitCode: typeof errorCode === "number" ? errorCode : null,
    signal,
    timedOut,
    spawnFailed,
  };
}

/**
 * Production runner for non-interactive account commands. `execFile` receives
 * an argument vector directly; shell expansion is explicitly disabled.
 * stdout/stderr are bounded by maxBuffer and deliberately discarded.
 */
export function runNativeCliAccountProcess(
  request: Readonly<NativeCliAccountProcessRequest>,
): Promise<NativeCliAccountProcessResult> {
  return new Promise((resolve) => {
    const options: ExecFileOptions = {
      env: { ...request.env },
      windowsHide: true,
      timeout: request.timeoutMs,
      maxBuffer: request.maxBufferBytes,
      killSignal: "SIGTERM",
      shell: false,
    };
    try {
      execFile(
        request.executable,
        [...request.args],
        options,
        (error, _stdout, _stderr) => {
          resolve(processResultFromError(error));
        },
      );
    } catch {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnFailed: true,
      });
    }
  });
}

export interface NativeCliAccountServiceOptions {
  claudeStore?: ClaudeCliAccountProfileStore;
  codexStore?: CodexCliAccountProfileStore;
  claudeLeases?: ClaudeCliProfileLeaseRegistry;
  codexLeases?: CodexCliProfileLeaseRegistry;
  claudeExecutable?: string;
  codexExecutable?: string;
  baseEnv?: () => NodeJS.ProcessEnv;
  processRunner?: NativeCliAccountProcessRunner;
  /** Test seam. Production reads the Codex credential's account id and email. */
  codexIdentityReader?: NativeCliAccountIdentityReader;
  /** Test seam. Production reads the Claude Code config's account uuid and email. */
  claudeIdentityReader?: ClaudeCliAccountIdentityReader;
  processTimeoutMs?: number;
  processMaxBufferBytes?: number;
  loginPlanTtlMs?: number;
  tokenFactory?: () => string;
  now?: () => number;
}

export class NativeCliAccountService {
  private readonly claudeStore: ClaudeCliAccountProfileStore;
  private readonly codexStore: CodexCliAccountProfileStore;
  private readonly claudeLeases: ClaudeCliProfileLeaseRegistry;
  private readonly codexLeases: CodexCliProfileLeaseRegistry;
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly baseEnv: () => NodeJS.ProcessEnv;
  private readonly processRunner: NativeCliAccountProcessRunner;
  private readonly codexIdentityReader: NativeCliAccountIdentityReader;
  private readonly claudeIdentityReader: ClaudeCliAccountIdentityReader;
  private readonly processTimeoutMs: number;
  private readonly processMaxBufferBytes: number;
  private readonly loginPlanTtlMs: number;
  private readonly tokenFactory: () => string;
  private readonly now: () => number;
  private readonly pendingLoginPlans = new Map<string, PendingLoginPlan>();
  private readonly expiredLoginTokens = new Map<string, number>();
  private readonly mutationTails = new Map<
    NativeCliAccountRuntime,
    Promise<void>
  >();

  constructor(options: NativeCliAccountServiceOptions = {}) {
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
    this.claudeStore = options.claudeStore ?? nativeClaudeProfileStore;
    this.codexStore = options.codexStore ?? nativeCodexProfileStore;
    this.claudeLeases = options.claudeLeases ?? nativeClaudeProfileLeases;
    this.codexLeases = options.codexLeases ?? nativeCodexProfileLeases;
    this.claudeExecutable =
      options.claudeExecutable?.trim() || "claude";
    this.codexExecutable = options.codexExecutable?.trim() || "codex";
    this.baseEnv = options.baseEnv ?? (() => process.env);
    this.processRunner = options.processRunner ?? runNativeCliAccountProcess;
    this.codexIdentityReader =
      options.codexIdentityReader ?? readCodexCliAccountIdentity;
    this.claudeIdentityReader =
      options.claudeIdentityReader ?? readClaudeCliAccountIdentity;
    this.processTimeoutMs =
      options.processTimeoutMs ?? NATIVE_CLI_ACCOUNT_PROCESS_TIMEOUT_MS;
    this.processMaxBufferBytes =
      options.processMaxBufferBytes ??
      NATIVE_CLI_ACCOUNT_PROCESS_MAX_BUFFER_BYTES;
    this.loginPlanTtlMs =
      options.loginPlanTtlMs ?? NATIVE_CLI_ACCOUNT_LOGIN_PLAN_TTL_MS;
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.now = options.now ?? Date.now;

    if (
      !Number.isSafeInteger(this.processTimeoutMs) ||
      this.processTimeoutMs < 1
    ) {
      throw new TypeError("Native CLI process timeout must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.processMaxBufferBytes) ||
      this.processMaxBufferBytes < 1
    ) {
      throw new TypeError(
        "Native CLI process output bound must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(this.loginPlanTtlMs) ||
      this.loginPlanTtlMs < 1
    ) {
      throw new TypeError(
        "Native CLI account login plan TTL must be a positive integer",
      );
    }
  }

  private normalizeProfileId(
    runtime: NativeCliAccountRuntime,
    value: unknown,
  ): string {
    try {
      return runtime === "claude"
        ? normalizeClaudeCliProfileId(value)
        : normalizeCodexCliProfileId(value);
    } catch {
      throw new NativeCliAccountError(
        "NATIVE_CLI_ACCOUNT_NOT_FOUND",
        { runtime },
      );
    }
  }

  private isReservedByLogin(
    runtime: NativeCliAccountRuntime,
    profileId: string,
  ): boolean {
    for (const plan of this.pendingLoginPlans.values()) {
      if (plan.runtime === runtime && plan.profileId === profileId) return true;
    }
    return false;
  }

  /**
   * Account identities for connected Claude Code sign-ins, keyed by profile id.
   * The config path stays inside this method; only the digest and email leave
   * it.
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
   * Account identities for connected Codex sign-ins, keyed by profile id. The
   * credential path stays inside this method; only the digest and email leave
   * it.
   */
  private async codexAccountIdentities(
    profiles: readonly CodexCliProfileConnection[],
  ): Promise<Map<string, NativeCliAccountIdentity>> {
    const identities = new Map<string, NativeCliAccountIdentity>();
    await Promise.all(
      profiles.map(async (profile) => {
        if (!profile.connected) return;
        let authFile: string;
        try {
          authFile = profile.managed
            ? codexCliManagedProfilePaths(this.codexStore.rootDir, profile.id)
                .authFile
            : join(this.codexStore.personalHomeDir, CODEX_CLI_AUTH_FILE);
        } catch {
          return;
        }
        const identity = await this.codexIdentityReader(authFile).catch(
          () => undefined,
        );
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
        const identities = await this.claudeAccountIdentities(
          inspection.profiles,
        );
        return {
          runtime,
          defaultProfileId: inspection.defaultProfileId,
          profiles: inspection.profiles.map((profile) =>
            sanitizeConnection(
              runtime,
              profile,
              this.isReservedByLogin(runtime, profile.id),
              identities.get(profile.id),
            ),
          ),
        };
      }
      const inspection = await this.codexStore.inspect();
      const identities = await this.codexAccountIdentities(
        inspection.profiles,
      );
      return {
        runtime,
        defaultProfileId: inspection.defaultProfileId,
        profiles: inspection.profiles.map((profile) =>
          sanitizeConnection(
            runtime,
            profile,
            this.isReservedByLogin(runtime, profile.id),
            identities.get(profile.id),
          ),
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
    const [claude, codex] = await Promise.all([
      this.inspectRuntime("claude"),
      this.inspectRuntime("codex"),
    ]);
    return { runtimes: [claude, codex] };
  }

  private async requireProfile(
    runtime: NativeCliAccountRuntime,
    profileId: string,
  ): Promise<{
    inspection: NativeCliAccountRuntimeInspection;
    profile: NativeCliAccountProfile;
  }> {
    const inspection = await this.inspectRuntime(runtime);
    const profile = inspection.profiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_NOT_FOUND", {
        runtime,
        profileId,
      });
    }
    return { inspection, profile };
  }

  private async withRuntimeMutation<T>(
    runtime: NativeCliAccountRuntime,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationTails.get(runtime) ?? Promise.resolve();
    const release = deferred<void>();
    const tail = previous.catch(() => undefined).then(() => release.promise);
    this.mutationTails.set(runtime, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release.resolve();
      if (this.mutationTails.get(runtime) === tail) {
        this.mutationTails.delete(runtime);
      }
    }
  }

  private async runWhileUnleased<T>(
    runtime: NativeCliAccountRuntime,
    profileId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      if (runtime === "claude") {
        return await this.claudeLeases.runWhileUnleased(
          profileId as ClaudeCliProfileId,
          operation,
        );
      }
      return await this.codexLeases.runWhileUnleased(
        profileId as CodexCliProfileId,
        operation,
      );
    } catch (error) {
      throw this.sanitizeStoreError(runtime, profileId, error);
    }
  }

  private executableFor(runtime: NativeCliAccountRuntime): string {
    return runtime === "claude"
      ? this.claudeExecutable
      : this.codexExecutable;
  }

  private loginArgs(runtime: NativeCliAccountRuntime): readonly string[] {
    return runtime === "claude" ? ["auth", "login"] : ["login"];
  }

  private logoutArgs(runtime: NativeCliAccountRuntime): readonly string[] {
    return runtime === "claude" ? ["auth", "logout"] : ["logout"];
  }

  private async executionEnvironment(
    runtime: NativeCliAccountRuntime,
    profileId: string,
    requireConnected: boolean,
  ): Promise<NodeJS.ProcessEnv> {
    try {
      const baseEnv = { ...this.baseEnv() };
      if (runtime === "claude") {
        return (
          await resolveClaudeCliExecutionProfile(this.claudeStore, {
            profileId,
            requireConnected,
            baseEnv,
          })
        ).env;
      }
      return (
        await resolveCodexCliExecutionProfile(this.codexStore, {
          profileId,
          requireConnected,
          baseEnv,
        })
      ).env;
    } catch (error) {
      if (/not connected/i.test(error instanceof Error ? error.message : "")) {
        throw new NativeCliAccountError(
          "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
          { runtime, profileId },
        );
      }
      throw this.sanitizeStoreError(runtime, profileId, error);
    }
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

  async create(
    input: NativeCliAccountCreateInput,
  ): Promise<NativeCliAccountMutationResult> {
    const runtime = normalizeRuntime(input.runtime);
    return this.withRuntimeMutation(runtime, async () => {
      try {
        const created =
          runtime === "claude"
            ? await this.claudeStore.createProfile({ label: input.label })
            : await this.codexStore.createProfile({ label: input.label });
        const inspection = await this.inspectRuntime(runtime);
        return {
          profile: this.profileFromInspection(inspection, created.profile.id),
          inspection,
        };
      } catch (error) {
        throw this.sanitizeStoreError(runtime, undefined, error);
      }
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
    return this.withRuntimeMutation(runtime, async () => {
      try {
        if (runtime === "claude") {
          await this.claudeStore.renameProfile(profileId, input.label);
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
    });
  }

  async setDefault(
    input: NativeCliAccountProfileInput,
  ): Promise<NativeCliAccountMutationResult> {
    const runtime = normalizeRuntime(input.runtime);
    const profileId = this.normalizeProfileId(runtime, input.profileId);
    return this.withRuntimeMutation(runtime, async () => {
      const before = await this.requireProfile(runtime, profileId);
      if (before.profile.managed && !before.profile.connected) {
        throw new NativeCliAccountError(
          "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
          { runtime, profileId },
        );
      }
      try {
        if (runtime === "claude") {
          await this.claudeStore.setDefaultProfile(profileId);
        } else {
          await this.codexStore.setDefaultProfile(profileId);
        }
        const inspection = await this.inspectRuntime(runtime);
        return {
          profile: this.profileFromInspection(inspection, profileId),
          inspection,
        };
      } catch (error) {
        throw this.sanitizeStoreError(runtime, profileId, error);
      }
    });
  }

  private allocateLoginToken(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const token = this.tokenFactory();
      if (
        typeof token !== "string" ||
        token.length < 24 ||
        token.length > 256 ||
        /[\u0000-\u0020\u007f]/.test(token)
      ) {
        throw new TypeError(
          "Native CLI account login token must be an opaque bounded value",
        );
      }
      if (
        !this.pendingLoginPlans.has(token) &&
        !this.expiredLoginTokens.has(token)
      ) {
        return token;
      }
    }
    throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_OPERATION_FAILED");
  }

  private rememberExpiredToken(token: string): void {
    this.expiredLoginTokens.set(token, this.now());
    while (this.expiredLoginTokens.size > 128) {
      const oldest = this.expiredLoginTokens.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.expiredLoginTokens.delete(oldest);
    }
  }

  private expireLoginPlan(plan: PendingLoginPlan): void {
    if (this.pendingLoginPlans.get(plan.launchToken) !== plan) return;
    this.pendingLoginPlans.delete(plan.launchToken);
    this.rememberExpiredToken(plan.launchToken);
    clearTimeout(plan.expiryTimer);
    plan.releaseGuard();
    void plan.guardDone.catch(() => undefined);
  }

  async prepareLogin(
    input: NativeCliAccountProfileInput,
  ): Promise<NativeCliAccountLoginPreparation> {
    const runtime = normalizeRuntime(input.runtime);
    const profileId = this.normalizeProfileId(runtime, input.profileId);
    await this.requireProfile(runtime, profileId);
    const launchToken = this.allocateLoginToken();
    const expiresAt = this.now() + this.loginPlanTtlMs;
    const guardEntered = deferred<void>();
    const guardRelease = deferred<void>();
    const guardDone = this.runWhileUnleased(runtime, profileId, async () => {
      try {
        // Resolve again after acquiring exclusivity so a delete between the
        // initial validation and the guard cannot create a stale plan.
        await this.executionEnvironment(runtime, profileId, false);
        guardEntered.resolve();
        await guardRelease.promise;
      } catch (error) {
        guardEntered.reject(error);
        throw error;
      }
    });
    void guardDone.catch((error) => guardEntered.reject(error));
    try {
      await guardEntered.promise;
    } catch (error) {
      await guardDone.catch(() => undefined);
      throw this.sanitizeStoreError(runtime, profileId, error);
    }

    let released = false;
    const releaseGuard = () => {
      if (released) return;
      released = true;
      guardRelease.resolve();
    };
    const plan = {
      runtime,
      profileId,
      launchToken,
      expiresAt,
      state: "prepared" as const,
      releaseGuard,
      guardDone,
      expiryTimer: undefined as unknown as NodeJS.Timeout,
    };
    plan.expiryTimer = setTimeout(
      () => this.expireLoginPlan(plan),
      this.loginPlanTtlMs,
    );
    plan.expiryTimer.unref?.();
    this.pendingLoginPlans.set(launchToken, plan);
    return { runtime, profileId, launchToken, expiresAt };
  }

  async cancelPreparedLogin(launchToken: string): Promise<boolean> {
    const plan = this.pendingLoginPlans.get(launchToken);
    if (!plan || plan.state !== "prepared") return false;
    this.pendingLoginPlans.delete(launchToken);
    clearTimeout(plan.expiryTimer);
    plan.releaseGuard();
    await plan.guardDone.catch(() => undefined);
    return true;
  }

  async launchPreparedLogin(
    launchToken: string,
    launcher: NativeCliAccountLoginLauncher,
  ): Promise<{ runtime: NativeCliAccountRuntime; profileId: string }> {
    const plan = this.pendingLoginPlans.get(launchToken);
    if (!plan) {
      throw new NativeCliAccountError(
        this.expiredLoginTokens.has(launchToken)
          ? "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED"
          : "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID",
      );
    }
    if (plan.expiresAt <= this.now()) {
      this.expireLoginPlan(plan);
      await plan.guardDone.catch(() => undefined);
      throw new NativeCliAccountError(
        "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED",
        { runtime: plan.runtime, profileId: plan.profileId },
      );
    }
    if (plan.state !== "prepared" || typeof launcher !== "function") {
      throw new NativeCliAccountError(
        "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID",
        { runtime: plan.runtime, profileId: plan.profileId },
      );
    }
    plan.state = "launching";
    clearTimeout(plan.expiryTimer);
    try {
      const env = await this.executionEnvironment(
        plan.runtime,
        plan.profileId,
        false,
      );
      let result: NativeCliAccountProcessResult;
      try {
        result = await launcher({
          runtime: plan.runtime,
          profileId: plan.profileId,
          executable: this.executableFor(plan.runtime),
          args: this.loginArgs(plan.runtime),
          env,
          shell: false,
        });
      } catch {
        throw new NativeCliAccountError(
          "NATIVE_CLI_ACCOUNT_LOGIN_SPAWN_FAILED",
          { runtime: plan.runtime, profileId: plan.profileId },
        );
      }
      this.assertProcessSucceeded("login", plan.runtime, plan.profileId, result);
      return { runtime: plan.runtime, profileId: plan.profileId };
    } finally {
      this.pendingLoginPlans.delete(launchToken);
      plan.releaseGuard();
      await plan.guardDone.catch(() => undefined);
    }
  }

  private assertProcessSucceeded(
    operation: "login" | "logout",
    runtime: NativeCliAccountRuntime,
    profileId: string,
    result: NativeCliAccountProcessResult,
  ): void {
    const prefix = operation === "login" ? "LOGIN" : "LOGOUT";
    if (result.timedOut) {
      throw new NativeCliAccountError(
        `NATIVE_CLI_ACCOUNT_${prefix}_TIMEOUT`,
        { runtime, profileId },
      );
    }
    if (result.spawnFailed) {
      throw new NativeCliAccountError(
        `NATIVE_CLI_ACCOUNT_${prefix}_SPAWN_FAILED`,
        { runtime, profileId },
      );
    }
    if (result.signal) {
      throw new NativeCliAccountError(
        `NATIVE_CLI_ACCOUNT_${prefix}_SIGNAL`,
        { runtime, profileId },
      );
    }
    if (result.exitCode !== 0) {
      throw new NativeCliAccountError(
        `NATIVE_CLI_ACCOUNT_${prefix}_FAILED`,
        { runtime, profileId },
      );
    }
  }

  private async logoutInternal(
    runtime: NativeCliAccountRuntime,
    profileId: string,
  ): Promise<void> {
    const { profile } = await this.requireProfile(runtime, profileId);
    if (profile.inUse) {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_ACTIVE", {
        runtime,
        profileId,
      });
    }
    if (!profile.connected) {
      throw new NativeCliAccountError(
        "NATIVE_CLI_ACCOUNT_NOT_CONNECTED",
        { runtime, profileId },
      );
    }
    await this.runWhileUnleased(runtime, profileId, async () => {
      const env = await this.executionEnvironment(runtime, profileId, true);
      let result: NativeCliAccountProcessResult;
      try {
        result = await this.processRunner({
          runtime,
          executable: this.executableFor(runtime),
          args: this.logoutArgs(runtime),
          env,
          shell: false,
          timeoutMs: this.processTimeoutMs,
          maxBufferBytes: this.processMaxBufferBytes,
        });
      } catch {
        throw new NativeCliAccountError(
          "NATIVE_CLI_ACCOUNT_LOGOUT_SPAWN_FAILED",
          { runtime, profileId },
        );
      }
      this.assertProcessSucceeded("logout", runtime, profileId, result);
    });
  }

  async logout(input: NativeCliAccountProfileInput): Promise<{
    runtime: NativeCliAccountRuntime;
    profileId: string;
  }> {
    const runtime = normalizeRuntime(input.runtime);
    const profileId = this.normalizeProfileId(runtime, input.profileId);
    return this.withRuntimeMutation(runtime, async () => {
      await this.logoutInternal(runtime, profileId);
      return { runtime, profileId };
    });
  }

  async delete(
    input: NativeCliAccountProfileInput,
  ): Promise<NativeCliAccountDeleteResult> {
    const runtime = normalizeRuntime(input.runtime);
    const profileId = this.normalizeProfileId(runtime, input.profileId);
    if (isPersonalProfile(runtime, profileId)) {
      throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_PERSONAL", {
        runtime,
        profileId,
      });
    }
    return this.withRuntimeMutation(runtime, async () => {
      const { profile } = await this.requireProfile(runtime, profileId);
      if (profile.isDefault) {
        throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_DEFAULT", {
          runtime,
          profileId,
        });
      }
      if (profile.inUse) {
        throw new NativeCliAccountError("NATIVE_CLI_ACCOUNT_ACTIVE", {
          runtime,
          profileId,
        });
      }

      // Ask the CLI to clear any provider-side/local auth state before its
      // isolated directory is removed. Process failures are deliberately best
      // effort: deletion remains safe and exact because the store performs its
      // own atomic lease/default/symlink checks immediately afterward.
      if (profile.connected) {
        try {
          await this.logoutInternal(runtime, profileId);
        } catch (error) {
          if (
            error instanceof NativeCliAccountError &&
            error.code === "NATIVE_CLI_ACCOUNT_ACTIVE"
          ) {
            throw error;
          }
          if (
            error instanceof NativeCliAccountError &&
            (error.code === "NATIVE_CLI_ACCOUNT_STORE_UNSAFE" ||
              error.code === "NATIVE_CLI_ACCOUNT_STORE_CORRUPT" ||
              error.code === "NATIVE_CLI_ACCOUNT_NOT_FOUND")
          ) {
            throw error;
          }
          // Spawn, timeout, signal, non-zero, and a concurrent sign-out are
          // non-destructive failures. Continue to the store's guarded delete.
        }
      }

      try {
        const result =
          runtime === "claude"
            ? await this.claudeStore.deleteProfile(profileId)
            : await this.codexStore.deleteProfile(profileId);
        return { runtime, profileId, deleted: result.deleted };
      } catch (error) {
        throw this.sanitizeStoreError(runtime, profileId, error);
      }
    });
  }

  private sanitizeStoreError(
    runtime: NativeCliAccountRuntime,
    profileId: string | undefined,
    error: unknown,
  ): NativeCliAccountError {
    if (error instanceof NativeCliAccountError) return error;
    if (
      error instanceof ClaudeCliAccountProfileLeasedError ||
      error instanceof CodexCliAccountProfileLeasedError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_ACTIVE", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliDefaultProfileDeletionError ||
      error instanceof CodexCliDefaultProfileDeletionError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_DEFAULT", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfileNotFoundError ||
      error instanceof CodexCliAccountProfileNotFoundError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_NOT_FOUND", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfileSafetyError ||
      error instanceof CodexCliAccountProfileSafetyError
    ) {
      return new NativeCliAccountError("NATIVE_CLI_ACCOUNT_STORE_UNSAFE", {
        runtime,
        profileId,
      });
    }
    if (
      error instanceof ClaudeCliAccountProfilesCorruptError ||
      error instanceof CodexCliAccountProfilesCorruptError
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
 * Process-wide façade. Constructing it performs no filesystem or child-process
 * work; callers opt into operations explicitly.
 */
export const nativeCliAccounts = new NativeCliAccountService();
