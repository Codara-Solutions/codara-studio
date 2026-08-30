import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import {
  readAnthropicAccountProfile,
  type AnthropicAccountProfile,
} from "./anthropic-account-identity";
import {
  anthropicCredentialMirror,
  canonicalFromClaude,
  claudeRecordFromCanonical,
  piRecordFromCanonical,
  readPiSide,
  reconcilePair,
  type AnthropicCanonicalCredential,
  type AnthropicCredentialMirror,
  type AnthropicCredentialPair,
  type ReconcilePairResult,
} from "./anthropic-credential-mirror";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  claudeCliManagedProfileConfigDir,
  isClaudeCliManagedProfileId,
  writeManagedClaudeIdentity,
  type ClaudeCliAccountProfileStore,
  type ClaudeCliProfileConnection,
} from "./claude-cli-account-profiles";
import {
  clearClaudeCredentialRecord,
  readClaudeCredentialRecord,
  writeClaudeCredentialRecord,
  type ClaudeCliCredentialBackend,
  type ClaudeCredentialRecord,
} from "./claude-cli-credentials";
import type { ClaudeCliProfileLeaseRegistry } from "./claude-cli-profile-execution";
import {
  readClaudeCliAccountIdentity,
  type NativeCliAccountIdentity,
} from "./native-cli-account-identity";
import {
  defaultPiAccountAuthStore,
  piAccountProfilePaths,
  type PiAccountAuthStore,
  type PiAccountProfileAuthStatus,
  type PiAccountProfileOwnershipGuard,
} from "./pi-account-auth-store";
import {
  PiAccountProfileProtectedError,
  type PiAccountProfile,
} from "./pi-account-profiles";
import { loadPiAuthStorage, type PiAuthStorageLoader } from "./pi-auth-storage";
import {
  nativeClaudeProfileLeases,
  nativeClaudeProfileStore,
} from "./native-claude-profile-runtime";

/**
 * One Anthropic account, two halves. The Pi registry row is the account; its
 * cliProfileId names the Claude Code half ("personal" for the user's own
 * ~/.claude, a managed CLAUDE_CONFIG_DIR otherwise). Everything that touches
 * both halves at once lives here, behind one in-process mutation tail so a
 * switch, a share and a delete can never interleave:
 *
 *  - useAnthropicAccount writes the Pi default and the Claude default in one
 *    step with rollback, and kills nothing: managed terminals run in their
 *    own directory and Account 1 is ~/.claude itself.
 *  - deleteAnthropicAccount hands both sides to Account 1 first, closes only
 *    that account's terminals (after confirmation), then removes the Claude
 *    half (staged rename plus the hashed Keychain item) and the Pi half.
 *  - shareLogin turns a half into a whole in either direction.
 *  - ensureAccountOne creates or pairs the row for ~/.claude.
 *
 * No path, token or environment leaves this module through IPC; callers get
 * ids and booleans.
 */

const PROVIDER: PiSubscriptionProvider = "anthropic";
const ACCOUNT_ONE_LABEL = "Account 1";
const PERSONAL_PROBE_INTERVAL_MS = 60_000;

export interface AnthropicTerminalStatus {
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
}

export interface AnthropicAccountView {
  coraProfileId: string;
  cliProfileId: string | null;
  label: string;
  isAccount1: boolean;
  isDefault: boolean;
  cora: PiAccountProfileAuthStatus;
  terminal: AnthropicTerminalStatus | null;
}

/** A managed Claude Code profile no row links: the card offers Share. */
export interface AnthropicTerminalOnlyView {
  coraProfileId: null;
  cliProfileId: string;
  label: string;
  isCliDefault: boolean;
  terminal: AnthropicTerminalStatus;
}

export type PiSubscriptionShareLoginInput =
  | { coraProfileId: string }
  | { cliProfileId: string };

export interface DeleteAnthropicAccountOptions {
  closeSessions?: boolean;
  ownershipGuard?: PiAccountProfileOwnershipGuard;
}

export interface DeleteAnthropicAccountResult {
  deleted: boolean;
  closedSessionCount: number;
}

export interface AnthropicTerminalSessions {
  liveOwnerIds(): ReadonlySet<string>;
  disposeProfileSessions(cliProfileId: string): Promise<{ closedSessionCount: number }>;
}

export class AnthropicAccountSessionsError extends Error {
  readonly sessionCount: number;

  constructor(sessionCount: number) {
    super(
      `${sessionCount} terminal ${sessionCount === 1 ? "session is" : "sessions are"} using this account. Close ${sessionCount === 1 ? "it" : "them"} to delete the account.`,
    );
    this.name = "AnthropicAccountSessionsError";
    this.sessionCount = sessionCount;
  }
}

export class AnthropicAccountNotConnectedError extends Error {
  constructor(profileId: string) {
    super(`Neither Cora nor Claude Code is signed in to account ${profileId}`);
    this.name = "AnthropicAccountNotConnectedError";
  }
}

export interface AnthropicAccountServiceOptions {
  piStore?: PiAccountAuthStore;
  claudeStore?: ClaudeCliAccountProfileStore;
  leases?: ClaudeCliProfileLeaseRegistry;
  mirror?: AnthropicCredentialMirror;
  backend?: ClaudeCliCredentialBackend;
  loadAuthStorage?: PiAuthStorageLoader;
  /** Test seam. Production asks Anthropic's OAuth profile endpoint. */
  readIdentity?: (accessToken: string) => Promise<AnthropicAccountProfile>;
  /** Test seam. Production reads the config's oauthAccount block. */
  readCliIdentity?: (
    configDir: string,
    configDirEnv: string | null,
    homeDir: string,
  ) => Promise<NativeCliAccountIdentity>;
  homeDir?: string;
  invalidateCaches?: () => Promise<void>;
  /** Wired by the IPC layer; the service itself never imports Electron. */
  broadcast?: () => void;
  sessions?: AnthropicTerminalSessions;
  /** Test seam. Production checks process.platform for the Keychain probe. */
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email ? email : undefined;
}

function terminalStatusFrom(connection: ClaudeCliProfileConnection): AnthropicTerminalStatus {
  return {
    connected: connection.connected,
    expired: connection.expired,
    canRefresh: connection.canRefresh,
  };
}

async function defaultInvalidateCaches(): Promise<void> {
  const [{ invalidatePiSubscriptionUsageCache }, { invalidatePiModelCatalogCache }] =
    await Promise.all([import("./pi-subscription-usage"), import("./pi-model-catalog")]);
  invalidatePiSubscriptionUsageCache();
  invalidatePiModelCatalogCache();
}

export class AnthropicAccountService {
  private readonly options: AnthropicAccountServiceOptions;
  private resolvedPiStore: PiAccountAuthStore | null = null;
  private resolvedClaudeStore: ClaudeCliAccountProfileStore | null = null;
  private resolvedLeases: ClaudeCliProfileLeaseRegistry | null = null;
  private resolvedMirror: AnthropicCredentialMirror | null = null;
  private mirrorSubscribed = false;
  private tail: Promise<void> = Promise.resolve();
  private personalWatcher: FSWatcher | null = null;
  private personalProbe: NodeJS.Timeout | null = null;
  private broadcastHook: (() => void) | null;
  private sessionsHook: AnthropicTerminalSessions | null;

  constructor(options: AnthropicAccountServiceOptions = {}) {
    this.options = options;
    this.broadcastHook = options.broadcast ?? null;
    this.sessionsHook = options.sessions ?? null;
  }

  private get piStore(): PiAccountAuthStore {
    this.resolvedPiStore ??= this.options.piStore ?? defaultPiAccountAuthStore();
    return this.resolvedPiStore;
  }

  private get claudeStore(): ClaudeCliAccountProfileStore {
    this.resolvedClaudeStore ??= this.options.claudeStore ?? nativeClaudeProfileStore;
    return this.resolvedClaudeStore;
  }

  private get leases(): ClaudeCliProfileLeaseRegistry {
    this.resolvedLeases ??= this.options.leases ?? nativeClaudeProfileLeases;
    return this.resolvedLeases;
  }

  private get mirror(): AnthropicCredentialMirror {
    this.resolvedMirror ??= this.options.mirror ?? anthropicCredentialMirror;
    if (!this.mirrorSubscribed) {
      this.mirrorSubscribed = true;
      this.resolvedMirror.onChanged(() => {
        void this.invalidateCaches().catch(() => undefined);
        this.broadcast();
      });
    }
    return this.resolvedMirror;
  }

  private get homeDir(): string {
    return this.options.homeDir ?? dirname(this.claudeStore.personalConfigDir);
  }

  private get credentialOptions(): { backend?: ClaudeCliCredentialBackend } {
    return this.options.backend ? { backend: this.options.backend } : {};
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private broadcast(): void {
    try {
      this.broadcastHook?.();
    } catch {
      // A renderer that is gone must not fail an account mutation.
    }
  }

  private invalidateCaches(): Promise<void> {
    return (this.options.invalidateCaches ?? defaultInvalidateCaches)();
  }

  setBroadcast(hook: (() => void) | null): void {
    this.broadcastHook = hook;
  }

  setTerminalSessions(sessions: AnthropicTerminalSessions | null): void {
    this.sessionsHook = sessions;
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private personalLocation(): { configDir: string; configDirEnv: string | null } {
    return {
      configDir: this.claudeStore.personalConfigDir,
      configDirEnv: this.claudeStore.personalConfigDirEnv,
    };
  }

  private cliLocation(cliProfileId: string): { configDir: string; configDirEnv: string | null } {
    if (cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) return this.personalLocation();
    const configDir = claudeCliManagedProfileConfigDir(this.claudeStore.rootDir, cliProfileId);
    return { configDir, configDirEnv: configDir };
  }

  /** The mirror pair for a linked row; null for an unlinked one. */
  pairFromProfile(profile: PiAccountProfile): AnthropicCredentialPair | null {
    if (profile.provider !== PROVIDER || !profile.cliProfileId) return null;
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, profile.id);
    return {
      coraProfileId: profile.id,
      cliProfileId: profile.cliProfileId,
      authFile,
      ...this.cliLocation(profile.cliProfileId),
    };
  }

  async pairFor(coraProfileId: string): Promise<AnthropicCredentialPair | null> {
    const profile = await this.piStore.registry.getProfile(coraProfileId);
    return profile ? this.pairFromProfile(profile) : null;
  }

  private async requireProfile(coraProfileId: string): Promise<PiAccountProfile> {
    const profile = await this.piStore.registry.getProfile(coraProfileId);
    if (!profile) throw new Error(`Pi account profile not found: ${coraProfileId}`);
    if (profile.provider !== PROVIDER) {
      throw new Error(`Pi account profile ${coraProfileId} is not an Anthropic account`);
    }
    return profile;
  }

  private async readPiCanonical(coraProfileId: string): Promise<AnthropicCanonicalCredential | null> {
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    const side = await readPiSide(authFile);
    return side.kind === "credential" ? side.canonical : null;
  }

  private async readCliRecord(cliProfileId: string): Promise<ClaudeCredentialRecord | null> {
    const location = this.cliLocation(cliProfileId);
    return readClaudeCredentialRecord(
      location.configDir,
      location.configDirEnv,
      this.credentialOptions,
    ).catch(() => null);
  }

  private async writePiCredential(
    coraProfileId: string,
    canonical: AnthropicCanonicalCredential,
  ): Promise<void> {
    const { configDir, authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(configDir, 0o700);
    const AuthStorage = await (this.options.loadAuthStorage ?? loadPiAuthStorage)();
    await AuthStorage.create(authFile).modify(PROVIDER, async () => piRecordFromCanonical(canonical));
    if (process.platform !== "win32") await fs.chmod(authFile, 0o600).catch(() => undefined);
  }

  private reconcileOptions() {
    return {
      ...this.credentialOptions,
      ...(this.options.loadAuthStorage ? { loadAuthStorage: this.options.loadAuthStorage } : {}),
      log: (message: string) => this.log(message),
    };
  }

  /** Reconcile a row's pair whether or not the mirror is watching it yet. */
  async reconcileProfile(coraProfileId: string): Promise<ReconcilePairResult | null> {
    const watched = await this.mirror.reconcileNow(coraProfileId);
    if (watched) return watched;
    const pair = await this.pairFor(coraProfileId).catch(() => null);
    if (!pair) return null;
    return reconcilePair(pair, this.reconcileOptions()).catch(() => null);
  }

  async reconcileCliProfile(cliProfileId: string): Promise<ReconcilePairResult | null> {
    const watched = await this.mirror.reconcileCliProfile(cliProfileId);
    if (watched) return watched;
    const profile = await this.piStore.registry
      .profileForCliProfileId(cliProfileId)
      .catch(() => undefined);
    return profile ? this.reconcileProfile(profile.id) : null;
  }

  async reconcileDefault(): Promise<ReconcilePairResult | null> {
    const snapshot = await this.piStore.registry.snapshot();
    const defaultId = snapshot.defaults[PROVIDER];
    return defaultId ? this.reconcileProfile(defaultId) : null;
  }

  /** Terminal status per Claude Code profile id, from one credential read each. */
  async terminalStatuses(): Promise<Map<string, AnthropicTerminalStatus>> {
    const statuses = new Map<string, AnthropicTerminalStatus>();
    try {
      const inspection = await this.claudeStore.inspect();
      for (const connection of inspection.profiles) {
        statuses.set(connection.id, terminalStatusFrom(connection));
      }
    } catch (error) {
      this.log(
        `[accounts] Claude Code profile inspection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return statuses;
  }

  async listAnthropicAccounts(): Promise<{
    accounts: AnthropicAccountView[];
    terminalOnly: AnthropicTerminalOnlyView[];
  }> {
    const [inspection, claude] = await Promise.all([
      this.piStore.inspect(),
      this.claudeStore.inspect().catch(() => null),
    ]);
    const statuses = new Map(inspection.statuses.map((status) => [status.profileId, status]));
    const connections = new Map(
      (claude?.profiles ?? []).map((connection) => [connection.id, connection]),
    );
    const linked = new Set<string>();
    const accounts: AnthropicAccountView[] = [];
    for (const profile of inspection.snapshot.profiles) {
      if (profile.provider !== PROVIDER) continue;
      const cliProfileId = profile.cliProfileId ?? null;
      const connection = cliProfileId ? connections.get(cliProfileId) : undefined;
      if (cliProfileId) linked.add(cliProfileId);
      const cora = statuses.get(profile.id) ?? {
        profileId: profile.id,
        provider: PROVIDER,
        connected: false,
        expired: false,
        canRefresh: false,
        expiresAt: null,
      };
      accounts.push({
        coraProfileId: profile.id,
        cliProfileId,
        label: profile.label,
        isAccount1: cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID,
        isDefault: inspection.snapshot.defaults[PROVIDER] === profile.id,
        cora,
        terminal: connection ? terminalStatusFrom(connection) : null,
      });
    }
    const terminalOnly: AnthropicTerminalOnlyView[] = [];
    for (const connection of claude?.profiles ?? []) {
      if (!connection.managed || linked.has(connection.id)) continue;
      terminalOnly.push({
        coraProfileId: null,
        cliProfileId: connection.id,
        label: connection.label,
        isCliDefault: connection.isDefault,
        terminal: terminalStatusFrom(connection),
      });
    }
    return { accounts, terminalOnly };
  }

  private async watchProfile(profile: PiAccountProfile): Promise<void> {
    const pair = this.pairFromProfile(profile);
    if (pair) this.mirror.watch(pair);
  }

  /**
   * The row for the user's own ~/.claude login. Created (or paired with an
   * existing unlinked row of the same account) the first time ~/.claude holds
   * a credential; nothing happens while it holds none.
   */
  async ensureAccountOne(): Promise<PiAccountProfile | null> {
    return this.withMutation(() => this.ensureAccountOneLocked());
  }

  private async ensureAccountOneLocked(): Promise<PiAccountProfile | null> {
    const existing = await this.piStore.registry.accountOneProfile();
    if (existing) {
      await this.watchProfile(existing);
      this.stopPersonalProbe();
      return existing;
    }
    const personal = this.personalLocation();
    const record = await readClaudeCredentialRecord(
      personal.configDir,
      personal.configDirEnv,
      this.credentialOptions,
    ).catch(() => null);
    const canonical = canonicalFromClaude(record);
    if (!canonical) {
      this.startPersonalProbe();
      return null;
    }
    const cliIdentity = await (this.options.readCliIdentity ?? readClaudeCliAccountIdentity)(
      personal.configDir,
      personal.configDirEnv,
      this.homeDir,
    ).catch((): NativeCliAccountIdentity => ({}));
    let identity: AnthropicAccountProfile = cliIdentity;
    if (!identity.fingerprint) {
      identity = await (this.options.readIdentity ?? readAnthropicAccountProfile)(
        canonical.access,
      ).catch((): AnthropicAccountProfile => ({}));
      identity = { ...identity, email: identity.email ?? cliIdentity.email };
    }
    const snapshot = await this.piStore.registry.snapshot();
    const unlinked = snapshot.profiles.filter(
      (profile) => profile.provider === PROVIDER && !profile.cliProfileId,
    );
    const match = findMatchingRow(unlinked, identity);
    let profile: PiAccountProfile;
    if (match) {
      profile = await this.piStore.registry.recordCliProfileId(
        match.id,
        CLAUDE_CLI_PERSONAL_PROFILE_ID,
      );
      if (!match.identityFingerprint && identity.fingerprint) {
        await this.piStore.registry
          .recordIdentityFingerprint(match.id, identity.fingerprint)
          .catch(() => undefined);
      }
      this.log(
        `[accounts] paired ${match.id} with the personal Claude login by ${
          match.identityFingerprint && identity.fingerprint ? "fingerprint" : "email"
        }`,
      );
    } else {
      const registered = await this.piStore.registry.registerProfile({
        provider: PROVIDER,
        label: ACCOUNT_ONE_LABEL,
        cliProfileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
        ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
        ...(identity.email ? { accountEmail: identity.email } : {}),
      });
      profile = registered.profile;
      if (profile.cliProfileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        // The same Anthropic account is already a managed profile's row; the
        // personal login stays a plain terminal login rather than a second row.
        this.log(
          `[accounts] the personal Claude login belongs to ${profile.id}, which is already paired with a managed profile`,
        );
        return null;
      }
      if (registered.created) {
        await this.writePiCredential(profile.id, canonical);
      }
    }
    await this.watchProfile(profile);
    await this.mirror.reconcileNow(profile.id).catch(() => null);
    this.stopPersonalProbe();
    await this.invalidateCaches().catch(() => undefined);
    this.broadcast();
    return profile;
  }

  /**
   * While no Account 1 row exists, watch ~/.claude for a login to appear. A
   * Keychain-only login leaves no file event, so macOS also probes slowly.
   */
  private startPersonalProbe(): void {
    if (this.personalWatcher || this.personalProbe) return;
    const personal = this.personalLocation();
    try {
      const watcher = watch(personal.configDir, { persistent: false });
      watcher.on("change", (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString();
        if (name !== undefined && name !== ".credentials.json") return;
        void this.ensureAccountOne().catch(() => null);
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.personalWatcher === watcher) this.personalWatcher = null;
      });
      this.personalWatcher = watcher;
    } catch {
      // No ~/.claude yet; the probe below covers its creation.
    }
    const platform = this.options.platform ?? process.platform;
    if (platform === "darwin" || !this.personalWatcher) {
      this.personalProbe = setInterval(() => {
        void this.ensureAccountOne().catch(() => null);
      }, PERSONAL_PROBE_INTERVAL_MS);
      this.personalProbe.unref?.();
    }
  }

  private stopPersonalProbe(): void {
    this.personalWatcher?.close();
    this.personalWatcher = null;
    if (this.personalProbe) clearInterval(this.personalProbe);
    this.personalProbe = null;
  }

  /**
   * Give a row its Claude Code half from the credential it already holds.
   * Failure leaves the row unlinked (the card offers Share) and never leaves
   * a half-built managed directory behind.
   */
  async ensureCliHalf(
    coraProfileId: string,
    canonical: AnthropicCanonicalCredential,
    identity?: AnthropicAccountProfile,
  ): Promise<string> {
    return this.withMutation(() => this.ensureCliHalfLocked(coraProfileId, canonical, identity));
  }

  private async ensureCliHalfLocked(
    coraProfileId: string,
    canonical: AnthropicCanonicalCredential,
    identity?: AnthropicAccountProfile,
  ): Promise<string> {
    const profile = await this.requireProfile(coraProfileId);
    if (profile.cliProfileId) {
      await this.watchProfile(profile);
      await this.mirror.reconcileNow(profile.id).catch(() => null);
      if (identity?.accountUuid && profile.cliProfileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        await writeManagedClaudeIdentity(this.cliLocation(profile.cliProfileId).configDir, {
          accountUuid: identity.accountUuid,
          ...(identity.email ? { emailAddress: identity.email } : {}),
          ...(identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {}),
        }).catch(() => undefined);
      }
      return profile.cliProfileId;
    }
    const created = await this.claudeStore.createProfile({ label: profile.label });
    const cliProfileId = created.profile.id;
    const location = this.cliLocation(cliProfileId);
    try {
      await writeClaudeCredentialRecord(
        location.configDir,
        location.configDirEnv,
        claudeRecordFromCanonical(canonical, null),
        this.credentialOptions,
      );
      if (identity?.accountUuid) {
        await writeManagedClaudeIdentity(location.configDir, {
          accountUuid: identity.accountUuid,
          ...(identity.email ? { emailAddress: identity.email } : {}),
          ...(identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {}),
        });
      }
      await this.piStore.registry.recordCliProfileId(profile.id, cliProfileId);
    } catch (error) {
      await clearClaudeCredentialRecord(
        location.configDir,
        location.configDirEnv,
        this.credentialOptions,
      ).catch(() => undefined);
      await this.claudeStore.deleteProfile(cliProfileId).catch(() => undefined);
      throw error;
    }
    const linked = await this.requireProfile(coraProfileId);
    await this.watchProfile(linked);
    return cliProfileId;
  }

  /** Switch Cora and Claude Code to one account together. Nothing is killed. */
  async useAnthropicAccount(coraProfileId: string): Promise<void> {
    return this.withMutation(() => this.useAnthropicAccountLocked(coraProfileId));
  }

  private async useAnthropicAccountLocked(coraProfileId: string): Promise<void> {
    const profile = await this.requireProfile(coraProfileId);
    await this.reconcileProfile(profile.id);
    const [pi, cli] = await Promise.all([
      this.readPiCanonical(profile.id),
      profile.cliProfileId ? this.readCliRecord(profile.cliProfileId) : Promise.resolve(null),
    ]);
    if (!pi && !canonicalFromClaude(cli)) {
      throw new AnthropicAccountNotConnectedError(profile.id);
    }
    const before = await this.piStore.registry.snapshot();
    const previousDefault = before.defaults[PROVIDER] ?? null;
    await this.piStore.registry.setDefaultProfile(PROVIDER, profile.id);
    try {
      await this.claudeStore.setDefaultProfile(
        profile.cliProfileId ?? CLAUDE_CLI_PERSONAL_PROFILE_ID,
      );
    } catch (error) {
      await this.piStore.registry
        .setDefaultProfile(PROVIDER, previousDefault)
        .catch(() => undefined);
      throw error;
    }
    await this.invalidateCaches().catch(() => undefined);
    this.broadcast();
  }

  /**
   * The Cora row a Claude Code profile id stands for, for callers that still
   * speak in terminal ids: the linked row, or Account 1 for "personal".
   */
  async coraProfileForCli(cliProfileId: string): Promise<PiAccountProfile | undefined> {
    return this.piStore.registry.profileForCliProfileId(cliProfileId);
  }

  async shareLogin(
    input: PiSubscriptionShareLoginInput,
  ): Promise<{ coraProfileId: string; cliProfileId: string }> {
    return this.withMutation(async () => {
      if ("coraProfileId" in input) return this.shareCoraLoginLocked(input.coraProfileId);
      return this.shareCliLoginLocked(input.cliProfileId);
    });
  }

  private async shareCoraLoginLocked(
    coraProfileId: string,
  ): Promise<{ coraProfileId: string; cliProfileId: string }> {
    const profile = await this.requireProfile(coraProfileId);
    const canonical = await this.readPiCanonical(profile.id);
    if (!canonical) throw new AnthropicAccountNotConnectedError(profile.id);
    const identity = await (this.options.readIdentity ?? readAnthropicAccountProfile)(
      canonical.access,
    ).catch((): AnthropicAccountProfile => ({}));
    const cliProfileId = await this.ensureCliHalfLocked(profile.id, canonical, identity);
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[PROVIDER] === profile.id) {
      await this.useAnthropicAccountLocked(profile.id);
    } else {
      this.broadcast();
    }
    return { coraProfileId: profile.id, cliProfileId };
  }

  private async shareCliLoginLocked(
    cliProfileId: string,
  ): Promise<{ coraProfileId: string; cliProfileId: string }> {
    if (!isClaudeCliManagedProfileId(cliProfileId)) {
      throw new TypeError("Only a managed Claude Code profile can be shared with Cora");
    }
    const already = await this.piStore.registry.profileForCliProfileId(cliProfileId);
    if (already) return { coraProfileId: already.id, cliProfileId };
    const claudeSnapshot = await this.claudeStore.snapshot();
    const managed = claudeSnapshot.profiles.find((entry) => entry.id === cliProfileId);
    if (!managed) throw new Error(`Native Claude account profile not found: ${cliProfileId}`);
    const record = await this.readCliRecord(cliProfileId);
    const canonical = canonicalFromClaude(record);
    if (!canonical) throw new Error("This Claude Code profile is not signed in");
    const location = this.cliLocation(cliProfileId);
    const identity = await (this.options.readCliIdentity ?? readClaudeCliAccountIdentity)(
      location.configDir,
      location.configDirEnv,
      this.homeDir,
    ).catch((): NativeCliAccountIdentity => ({}));
    const snapshot = await this.piStore.registry.snapshot();
    const sameAccount = identity.fingerprint
      ? snapshot.profiles.find(
          (entry) =>
            entry.provider === PROVIDER && entry.identityFingerprint === identity.fingerprint,
        )
      : undefined;
    if (sameAccount?.cliProfileId) {
      throw new Error(
        `This sign-in belongs to ${sameAccount.label}, which already has a Claude Code profile.`,
      );
    }
    let profile: PiAccountProfile;
    if (sameAccount) {
      profile = await this.piStore.registry.recordCliProfileId(sameAccount.id, cliProfileId);
      if (!(await this.readPiCanonical(profile.id))) {
        await this.writePiCredential(profile.id, canonical);
      }
    } else {
      const registered = await this.piStore.registry.registerProfile({
        provider: PROVIDER,
        label: managed.label,
        cliProfileId,
        ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
        ...(identity.email ? { accountEmail: identity.email } : {}),
      });
      profile = registered.profile;
      await this.writePiCredential(profile.id, canonical);
    }
    await this.watchProfile(profile);
    await this.mirror.reconcileNow(profile.id).catch(() => null);
    if (claudeSnapshot.defaultProfileId === cliProfileId) {
      await this.useAnthropicAccountLocked(profile.id);
    } else {
      await this.invalidateCaches().catch(() => undefined);
      this.broadcast();
    }
    return { coraProfileId: profile.id, cliProfileId };
  }

  private sweepLeases(): void {
    if (!this.sessionsHook) return;
    this.leases.sweep(this.sessionsHook.liveOwnerIds());
  }

  private async removeCliHalf(cliProfileId: string): Promise<void> {
    const location = this.cliLocation(cliProfileId);
    await this.claudeStore.deleteProfile(cliProfileId);
    // The directory is gone; this removes the hashed Keychain item.
    await clearClaudeCredentialRecord(
      location.configDir,
      location.configDirEnv,
      this.credentialOptions,
    ).catch(() => undefined);
  }

  /** Hand the defaults to Account 1 (or to nothing) before a row disappears. */
  private async handOffDefault(coraProfileId: string): Promise<void> {
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[PROVIDER] !== coraProfileId) return;
    const accountOne = await this.piStore.registry.accountOneProfile();
    if (accountOne) {
      await this.useAnthropicAccountLocked(accountOne.id);
      return;
    }
    await this.claudeStore.setDefaultProfile(CLAUDE_CLI_PERSONAL_PROFILE_ID);
    await this.piStore.registry.setDefaultProfile(PROVIDER, null);
  }

  async deleteAnthropicAccount(
    coraProfileId: string,
    options: DeleteAnthropicAccountOptions = {},
  ): Promise<DeleteAnthropicAccountResult> {
    return this.withMutation(async () => {
      const profile = await this.requireProfile(coraProfileId);
      if (profile.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        throw new PiAccountProfileProtectedError(profile.id);
      }
      if (await options.ownershipGuard?.(profile)) {
        throw new PiAccountProfileProtectedError(profile.id);
      }
      await this.handOffDefault(profile.id);
      let closedSessionCount = 0;
      const cliProfileId = profile.cliProfileId;
      if (cliProfileId) {
        this.sweepLeases();
        if (this.leases.isLeased(cliProfileId)) {
          const count = this.leases.owners(cliProfileId).length;
          if (!options.closeSessions || !this.sessionsHook) {
            throw new AnthropicAccountSessionsError(count);
          }
          closedSessionCount = (await this.sessionsHook.disposeProfileSessions(cliProfileId))
            .closedSessionCount;
          this.sweepLeases();
        }
        this.mirror.unwatch(profile.id);
        await this.removeCliHalf(cliProfileId);
      }
      await this.piStore.deleteProfile(profile.id, {
        ...(options.ownershipGuard ? { ownershipGuard: options.ownershipGuard } : {}),
      });
      await this.invalidateCaches().catch(() => undefined);
      this.broadcast();
      return { deleted: true, closedSessionCount };
    });
  }

  /** Delete a managed Claude Code profile no row links (a terminal-only half). */
  async deleteTerminalOnlyProfile(cliProfileId: string): Promise<{ deleted: boolean }> {
    return this.withMutation(async () => {
      if (!isClaudeCliManagedProfileId(cliProfileId)) {
        throw new TypeError("Only a managed Claude Code profile can be deleted here");
      }
      const linked = await this.piStore.registry.profileForCliProfileId(cliProfileId);
      if (linked) {
        throw new Error("This Claude Code profile belongs to an account; delete the account instead");
      }
      const snapshot = await this.claudeStore.snapshot();
      if (!snapshot.profiles.some((entry) => entry.id === cliProfileId)) {
        return { deleted: false };
      }
      if (snapshot.defaultProfileId === cliProfileId) {
        await this.claudeStore.setDefaultProfile(CLAUDE_CLI_PERSONAL_PROFILE_ID);
      }
      this.sweepLeases();
      await this.removeCliHalf(cliProfileId);
      this.broadcast();
      return { deleted: true };
    });
  }

  // Startup pass pieces. Each re-derives its state from disk and is safe to
  // repeat; the migration module orders them.

  async clearDanglingLinks(): Promise<string[]> {
    return this.withMutation(async () => {
      const [snapshot, claude] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.claudeStore.inspect(),
      ]);
      const managed = new Set(
        claude.profiles.filter((entry) => entry.managed).map((entry) => entry.id),
      );
      const cleared: string[] = [];
      for (const profile of snapshot.profiles) {
        if (
          profile.provider !== PROVIDER ||
          !profile.cliProfileId ||
          profile.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID ||
          managed.has(profile.cliProfileId)
        ) {
          continue;
        }
        await this.piStore.registry.recordCliProfileId(profile.id, null);
        this.mirror.unwatch(profile.id);
        cleared.push(profile.id);
      }
      return cleared;
    });
  }

  /**
   * Pair unlinked rows with managed profiles no row links: equal fingerprints
   * pair, equal emails pair only when a fingerprint verdict is impossible,
   * differing fingerprints never pair, first match claims.
   */
  async pairHalves(): Promise<Array<{ coraProfileId: string; cliProfileId: string; by: "fingerprint" | "email" }>> {
    return this.withMutation(async () => {
      const [snapshot, claude] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.claudeStore.snapshot(),
      ]);
      const linked = new Set(
        snapshot.profiles.map((profile) => profile.cliProfileId).filter(Boolean),
      );
      const candidates = snapshot.profiles.filter(
        (profile) => profile.provider === PROVIDER && !profile.cliProfileId,
      );
      const paired: Array<{ coraProfileId: string; cliProfileId: string; by: "fingerprint" | "email" }> = [];
      if (candidates.length === 0) return paired;
      for (const managed of claude.profiles) {
        if (linked.has(managed.id)) continue;
        const location = this.cliLocation(managed.id);
        const identity = await (this.options.readCliIdentity ?? readClaudeCliAccountIdentity)(
          location.configDir,
          location.configDirEnv,
          this.homeDir,
        ).catch((): NativeCliAccountIdentity => ({}));
        const match = findMatchingRow(candidates, identity);
        if (!match) continue;
        const by = match.identityFingerprint && identity.fingerprint ? "fingerprint" : "email";
        const profile = await this.piStore.registry.recordCliProfileId(match.id, managed.id);
        if (!match.identityFingerprint && identity.fingerprint) {
          await this.piStore.registry
            .recordIdentityFingerprint(match.id, identity.fingerprint)
            .catch(() => undefined);
        }
        candidates.splice(candidates.indexOf(match), 1);
        linked.add(managed.id);
        this.log(`[accounts] paired ${match.id} with Claude Code profile ${managed.id} by ${by}`);
        const pair = this.pairFromProfile(profile);
        if (pair) await reconcilePair(pair, this.reconcileOptions()).catch(() => null);
        paired.push({ coraProfileId: match.id, cliProfileId: managed.id, by });
      }
      return paired;
    });
  }

  /** Make the Claude default follow the Cora default, or derive one from the other. */
  async repairDefaults(): Promise<void> {
    return this.withMutation(async () => {
      const [snapshot, claude] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.claudeStore.snapshot(),
      ]);
      const defaultId = snapshot.defaults[PROVIDER];
      const row = defaultId
        ? snapshot.profiles.find((profile) => profile.id === defaultId)
        : undefined;
      if (row) {
        const link = row.cliProfileId ?? CLAUDE_CLI_PERSONAL_PROFILE_ID;
        if (claude.defaultProfileId !== link) {
          await this.claudeStore.setDefaultProfile(link).catch((error) => {
            this.log(
              `[accounts] could not point Claude Code at the active account: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
        return;
      }
      const accountOne = snapshot.profiles.find(
        (profile) => profile.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID,
      );
      if (claude.defaultProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        if (accountOne) await this.piStore.registry.setDefaultProfile(PROVIDER, accountOne.id);
        return;
      }
      const linkedRow = snapshot.profiles.find(
        (profile) => profile.cliProfileId === claude.defaultProfileId,
      );
      if (linkedRow) {
        await this.piStore.registry.setDefaultProfile(PROVIDER, linkedRow.id);
        return;
      }
      // An unlinked managed default stays where it is; its card offers Share.
    });
  }

  /** Arm the mirror over every linked pair and reconcile each once. */
  async startMirror(): Promise<AnthropicCredentialPair[]> {
    const snapshot = await this.piStore.registry.snapshot();
    const pairs: AnthropicCredentialPair[] = [];
    for (const profile of snapshot.profiles) {
      const pair = this.pairFromProfile(profile);
      if (pair) pairs.push(pair);
    }
    const watched = new Set(pairs.map((pair) => pair.coraProfileId));
    for (const pair of this.mirror.watchedPairs()) {
      if (!watched.has(pair.coraProfileId)) this.mirror.unwatch(pair.coraProfileId);
    }
    for (const pair of pairs) this.mirror.watch(pair);
    await this.mirror.reconcileAll();
    if (!snapshot.profiles.some((profile) => profile.cliProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID)) {
      this.startPersonalProbe();
    }
    return pairs;
  }

  rearmMirror(): void {
    this.mirror.rearm();
  }

  stop(): void {
    this.stopPersonalProbe();
    this.mirror.stop();
  }
}

/**
 * Equal fingerprints pair; equal emails pair only when a fingerprint is
 * missing on at least one side; differing fingerprints never pair.
 */
export function findMatchingRow(
  rows: readonly PiAccountProfile[],
  identity: NativeCliAccountIdentity,
): PiAccountProfile | undefined {
  const email = normalizeEmail(identity.email);
  for (const row of rows) {
    if (row.identityFingerprint && identity.fingerprint) {
      if (row.identityFingerprint === identity.fingerprint) return row;
      continue;
    }
    if (email && normalizeEmail(row.accountEmail) === email) return row;
  }
  return undefined;
}

export const anthropicAccounts = new AnthropicAccountService({
  log: (message) => console.warn(message),
});
