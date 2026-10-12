import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import type {
  AccountIdentity,
  AccountProviderAdapter,
  CliProfileStatus,
} from "./account-adapters/account-adapter";
import { isPathInside } from "../outside-write-guard";
import { purgeManagedPath } from "./cli-account-homes";
import {
  credentialMirror,
  readPiSide,
  reconcilePair,
  type CanonicalCredential,
  type CredentialMirror,
  type CredentialPair,
  type ReconcilePairResult,
} from "./credential-mirror";
import type { NativeCliAccountIdentity } from "./native-cli-account-identity";
import {
  defaultPiAccountAuthStore,
  piAccountProfilePaths,
  type PiAccountAuthStore,
  type PiAccountProfileAuthStatus,
  type PiAccountProfileOwnershipGuard,
} from "./pi-account-auth-store";
import {
  PiAccountProfileProtectedError,
  SYSTEM_CLI_PROFILE_ID,
  type PiAccountCoraHalf,
  type PiAccountPendingPurge,
  type PiAccountProfile,
} from "./pi-account-profiles";
import { loadPiAuthStorage, type PiAuthStorageLoader } from "./pi-auth-storage";
import { readSystemLogin, type SystemLogin } from "./system-cli-login";
import {
  UnifiedAccountNotConnectedError,
  UnifiedAccountSessionsError,
} from "./unified-account-errors";

export { UnifiedAccountNotConnectedError, UnifiedAccountSessionsError };

/**
 * One account, up to two halves, for any provider. The Pi registry row is
 * the account: its `cli` names where terminals get their login (a managed
 * profile in Codara's home, the System login, or none) and its `cora` what
 * Cora holds. Which CLI, where its managed home is and what activating an
 * account means is the adapter's business; everything that touches both
 * halves at once lives here, behind one in-process mutation tail so a
 * switch, a share and a delete can never interleave.
 *
 * The list changes only through an explicit add, Use in Codara on the
 * System login, a delete, or the migration. Nothing here watches the
 * System login, adopts a login it finds, or writes anything of the user's
 * own: the System login is used by not setting the CLI's home variable.
 *
 *  - useAccount sets the Active row and projects it onto the CLI store's
 *    default; for Claude it also puts the account's login into the live
 *    slot, which running Claude sessions pick up on their next request.
 *  - deleteAccount tombstones and removes the row in one write, drops the
 *    Active pointer (the System login takes over, no hand-off), removes
 *    Cora's grant and purges the managed home, or queues the purge while a
 *    terminal still runs in it.
 *  - shareLogin turns a half into a whole in either direction.
 *
 * No path, token or environment leaves this module through IPC; callers get
 * ids and booleans.
 */

const GROW_TIMEOUT_MS = 20_000;

export interface UnifiedTerminalStatus {
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
  /** Studio terminals holding a lease on the half right now. */
  liveSessions: number;
}

export interface UnifiedAccountView {
  coraProfileId: string;
  cliProfileId: string | null;
  label: string;
  /** The row uses the CLI's own login on this computer. */
  isSystem: boolean;
  isDefault: boolean;
  coraHalf: PiAccountCoraHalf;
  cora: PiAccountProfileAuthStatus;
  terminal: UnifiedTerminalStatus | null;
}

/** A managed CLI profile no row links: the card offers Share. */
export interface UnifiedTerminalOnlyView {
  coraProfileId: null;
  cliProfileId: string;
  label: string;
  isCliDefault: boolean;
  terminal: UnifiedTerminalStatus;
}

/** The one-line offer for a System login no row uses. No secret, no fingerprint. */
export interface UnifiedSystemOffer {
  email?: string;
  apiKey?: boolean;
}

export type PiSubscriptionShareLoginInput =
  | { coraProfileId: string }
  | { cliProfileId: string };

export interface DeleteAccountOptions {
  ownershipGuard?: PiAccountProfileOwnershipGuard;
}

export interface DeleteAccountResult {
  deleted: boolean;
  /** The managed home waits for the terminals still running in it. */
  purgePending: boolean;
}

export interface UnifiedTerminalSessions {
  liveOwnerIds(): ReadonlySet<string>;
}

export interface UnifiedAccountServiceOptions {
  piStore?: PiAccountAuthStore;
  mirror?: CredentialMirror;
  loadAuthStorage?: PiAuthStorageLoader;
  invalidateCaches?: () => Promise<void>;
  /** Wired by the IPC layer; the service itself never imports Electron. */
  broadcast?: () => void;
  sessions?: UnifiedTerminalSessions;
  /** Test seam: what the System login is signed in as. */
  readSystemLogin?: (provider: PiSubscriptionProvider) => Promise<SystemLogin>;
  /** Runs after the Active account moved: the shell pointer is rewritten from it. */
  defaultsChanged?: () => void | Promise<void>;
  log?: (message: string) => void;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email ? email : undefined;
}

function terminalStatusFrom(
  connection: CliProfileStatus,
  liveSessions: number,
): UnifiedTerminalStatus {
  return {
    connected: connection.connected,
    expired: connection.expired,
    canRefresh: connection.canRefresh,
    liveSessions,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultInvalidateCaches(): Promise<void> {
  const [{ invalidatePiSubscriptionUsageCache }, { invalidatePiModelCatalogCache }] =
    await Promise.all([import("./pi-subscription-usage"), import("./pi-model-catalog")]);
  invalidatePiSubscriptionUsageCache();
  invalidatePiModelCatalogCache();
}

export class UnifiedAccountService<Loc = unknown, Raw = unknown> {
  readonly adapter: AccountProviderAdapter<Loc, Raw>;
  readonly provider: PiSubscriptionProvider;
  private readonly options: UnifiedAccountServiceOptions;
  private resolvedPiStore: PiAccountAuthStore | null = null;
  private resolvedMirror: CredentialMirror | null = null;
  private mirrorSubscribed = false;
  private tail: Promise<void> = Promise.resolve();
  /** Rows mid-delete: every reconcile entry point answers null for them. */
  private readonly deleting = new Set<string>();
  private broadcastHook: (() => void) | null;
  private sessionsHook: UnifiedTerminalSessions | null;
  private readonly defaultsChangedHook: (() => void | Promise<void>) | null;

  constructor(adapter: AccountProviderAdapter<Loc, Raw>, options: UnifiedAccountServiceOptions = {}) {
    this.adapter = adapter;
    this.provider = adapter.provider;
    this.options = options;
    this.broadcastHook = options.broadcast ?? null;
    this.sessionsHook = options.sessions ?? null;
    this.defaultsChangedHook = options.defaultsChanged ?? null;
  }

  get codec() {
    return this.adapter.codec;
  }

  private get piStore(): PiAccountAuthStore {
    this.resolvedPiStore ??= this.options.piStore ?? defaultPiAccountAuthStore();
    return this.resolvedPiStore;
  }

  private get store() {
    return this.adapter.store;
  }

  private get leases() {
    return this.adapter.leases;
  }

  private get systemId(): string {
    return this.adapter.systemProfileId;
  }

  private get mirror(): CredentialMirror {
    this.resolvedMirror ??= this.options.mirror ?? credentialMirror;
    if (!this.mirrorSubscribed) {
      this.mirrorSubscribed = true;
      this.resolvedMirror.onChanged((change) => {
        if (change.provider !== this.provider) return;
        void this.invalidateCaches().catch(() => undefined);
        this.broadcast();
      });
      // The busy signals behind the poll cadence: the active account and
      // any half a terminal is running on poll faster.
      this.resolvedMirror.setActivity(this.provider, {
        isActive: async (coraProfileId) =>
          (await this.piStore.registry.snapshot()).defaults[this.provider] === coraProfileId,
        isLeased: (cliProfileId) => this.leases.isLeased(cliProfileId),
      });
    }
    return this.resolvedMirror;
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

  setTerminalSessions(sessions: UnifiedTerminalSessions | null): void {
    this.sessionsHook = sessions;
  }

  /** Best effort and off the mutation path: a pointer write never fails an account mutation. */
  private defaultsChanged(): void {
    try {
      void Promise.resolve(this.defaultsChangedHook?.()).catch((error: unknown) => {
        this.log(`[accounts] the active-account pointer was not written: ${errorText(error)}`);
      });
    } catch {
      // Same rule for a hook that throws synchronously.
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private readSystem(): Promise<SystemLogin> {
    return (this.options.readSystemLogin ?? readSystemLogin)(this.provider);
  }

  /**
   * The mirror pair for a row whose Cora half shares one grant with a
   * managed CLI half; null for every other row.
   */
  pairFromProfile(profile: PiAccountProfile): CredentialPair<Loc, Raw> | null {
    if (profile.provider !== this.provider) return null;
    if (profile.cli.kind !== "managed" || profile.cora !== "linked") return null;
    const cliProfileId = profile.cli.profileId;
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, profile.id);
    return {
      provider: this.provider,
      coraProfileId: profile.id,
      cliProfileId,
      authFile,
      location: this.adapter.locate(cliProfileId),
      adapter: this.adapter,
      ...(profile.identityFingerprint ? { identityFingerprint: profile.identityFingerprint } : {}),
    };
  }

  async pairFor(coraProfileId: string): Promise<CredentialPair<Loc, Raw> | null> {
    const profile = await this.piStore.registry.getProfile(coraProfileId);
    return profile ? this.pairFromProfile(profile) : null;
  }

  private async requireProfile(coraProfileId: string): Promise<PiAccountProfile> {
    const profile = await this.piStore.registry.getProfile(coraProfileId);
    if (!profile) throw new Error(`Pi account profile not found: ${coraProfileId}`);
    if (profile.provider !== this.provider) {
      throw new Error(`Pi account profile ${coraProfileId} is not a ${this.provider} account`);
    }
    return profile;
  }

  private async readPiCanonical(coraProfileId: string): Promise<CanonicalCredential | null> {
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    const side = await readPiSide(authFile, this.codec);
    return side.kind === "credential" ? side.canonical : null;
  }

  private async readCliCanonical(cliProfileId: string): Promise<CanonicalCredential | null> {
    if (!this.adapter.isManagedProfileId(cliProfileId)) return null;
    const side = await this.adapter.readCli(this.adapter.locate(cliProfileId));
    return side.kind === "credential" ? this.codec.canonicalFromCli(side.raw) : null;
  }

  private async writePiCredential(
    coraProfileId: string,
    canonical: CanonicalCredential,
  ): Promise<void> {
    const { configDir, authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(configDir, 0o700);
    const AuthStorage = await (this.options.loadAuthStorage ?? loadPiAuthStorage)();
    await AuthStorage.create(authFile).modify(this.provider, async (current) =>
      this.codec.piRecordFromCanonical(canonical, current),
    );
    if (process.platform !== "win32") await fs.chmod(authFile, 0o600).catch(() => undefined);
  }

  private reconcileOptions() {
    return {
      ...(this.options.loadAuthStorage ? { loadAuthStorage: this.options.loadAuthStorage } : {}),
      log: (message: string) => this.log(message),
    };
  }

  /** Reconcile a row's pair whether or not the mirror is watching it yet. */
  async reconcileProfile(coraProfileId: string): Promise<ReconcilePairResult | null> {
    if (this.deleting.has(coraProfileId)) return null;
    const watched = await this.mirror.reconcileNow(coraProfileId);
    if (watched) return watched;
    const pair = await this.pairFor(coraProfileId).catch(() => null);
    if (!pair) return null;
    return reconcilePair(pair, this.reconcileOptions()).catch(() => null);
  }

  async reconcileCliProfile(cliProfileId: string): Promise<ReconcilePairResult | null> {
    if (!this.adapter.isManagedProfileId(cliProfileId)) return null;
    const watched = await this.mirror.reconcileCliProfile(this.provider, cliProfileId);
    if (watched) return watched;
    const profile = await this.piStore.registry
      .profileForCliProfileId(this.provider, cliProfileId)
      .catch(() => undefined);
    return profile ? this.reconcileProfile(profile.id) : null;
  }

  async reconcileDefault(): Promise<ReconcilePairResult | null> {
    const snapshot = await this.piStore.registry.snapshot();
    const defaultId = snapshot.defaults[this.provider];
    return defaultId ? this.reconcileProfile(defaultId) : null;
  }

  /** Studio terminals holding a lease on a half, with dead owners swept first. */
  private liveSessionCount(cliProfileId: string): number {
    return this.leases.owners(cliProfileId).filter((owner) => owner.startsWith("terminal:"))
      .length;
  }

  /**
   * Terminals per CLI profile. Where every managed session runs in the
   * live slot, all managed terminals count for the live profile whichever
   * account they started on, and none for any other managed profile.
   */
  private async sessionCounter(
    profileIds: readonly string[],
  ): Promise<(cliProfileId: string) => number> {
    if (!this.adapter.sessionsFollowLiveLogin) {
      return (cliProfileId) => this.liveSessionCount(cliProfileId);
    }
    const live = await this.adapter.activeCliProfileId?.().catch(() => undefined);
    const owners = new Set<string>();
    for (const id of profileIds) {
      if (!this.adapter.isManagedProfileId(id)) continue;
      for (const owner of this.leases.owners(id)) {
        if (owner.startsWith("terminal:")) owners.add(owner);
      }
    }
    return (cliProfileId) =>
      cliProfileId === this.systemId
        ? this.liveSessionCount(cliProfileId)
        : cliProfileId === live
          ? owners.size
          : 0;
  }

  /** Terminal status per CLI profile id, from one credential read each. */
  async terminalStatuses(): Promise<Map<string, UnifiedTerminalStatus>> {
    const statuses = new Map<string, UnifiedTerminalStatus>();
    try {
      const connections = await this.adapter.inspectCli();
      this.sweepLeases();
      const sessions = await this.sessionCounter(connections.map((connection) => connection.id));
      for (const connection of connections) {
        statuses.set(connection.id, terminalStatusFrom(connection, sessions(connection.id)));
      }
    } catch (error) {
      this.log(
        `[accounts] ${this.adapter.labels.cliLabel} profile inspection failed: ${errorText(error)}`,
      );
    }
    return statuses;
  }

  async listAccounts(): Promise<{
    accounts: UnifiedAccountView[];
    terminalOnly: UnifiedTerminalOnlyView[];
  }> {
    const [inspection, cli] = await Promise.all([
      this.piStore.inspect(),
      this.adapter.inspectCli().catch(() => null),
    ]);
    const statuses = new Map(inspection.statuses.map((status) => [status.profileId, status]));
    const connections = new Map((cli ?? []).map((connection) => [connection.id, connection]));
    const linked = new Set<string>();
    const accounts: UnifiedAccountView[] = [];
    this.sweepLeases();
    const sessions = await this.sessionCounter((cli ?? []).map((connection) => connection.id));
    for (const profile of inspection.snapshot.profiles) {
      if (profile.provider !== this.provider) continue;
      const cliProfileId = profile.cliProfileId ?? null;
      const connection = cliProfileId ? connections.get(cliProfileId) : undefined;
      if (cliProfileId) linked.add(cliProfileId);
      const cora = statuses.get(profile.id) ?? {
        profileId: profile.id,
        provider: this.provider,
        connected: false,
        expired: false,
        canRefresh: false,
        expiresAt: null,
      };
      accounts.push({
        coraProfileId: profile.id,
        cliProfileId,
        label: profile.label,
        isSystem: profile.cli.kind === "system",
        isDefault: inspection.snapshot.defaults[this.provider] === profile.id,
        coraHalf: profile.cora,
        cora,
        terminal: connection ? terminalStatusFrom(connection, sessions(connection.id)) : null,
      });
    }
    const terminalOnly: UnifiedTerminalOnlyView[] = [];
    for (const connection of cli ?? []) {
      if (!connection.managed || linked.has(connection.id)) continue;
      terminalOnly.push({
        coraProfileId: null,
        cliProfileId: connection.id,
        label: connection.label,
        isCliDefault: connection.isDefault,
        terminal: terminalStatusFrom(connection, sessions(connection.id)),
      });
    }
    return { accounts, terminalOnly };
  }

  private watchProfile(profile: PiAccountProfile): void {
    const pair = this.pairFromProfile(profile);
    if (pair) this.mirror.watch(pair);
  }

  // The System login.

  /**
   * The offer line for a signed-in System login whose identity no row has
   * and the user has not dismissed. Read-only: nothing is registered.
   */
  async systemOffer(): Promise<UnifiedSystemOffer | null> {
    const login = await this.readSystem().catch(() => null);
    if (!login?.signedIn) return null;
    const snapshot = await this.piStore.registry.snapshot();
    const rows = snapshot.profiles.filter((profile) => profile.provider === this.provider);
    if (rows.some((profile) => profile.cli.kind === "system")) return null;
    if (login.identityFingerprint) {
      if (rows.some((profile) => profile.identityFingerprint === login.identityFingerprint)) {
        return null;
      }
      if (await this.piStore.registry.isSystemOfferDismissed(this.provider, login.identityFingerprint)) {
        return null;
      }
    } else if (login.email) {
      const email = normalizeEmail(login.email);
      if (rows.some((profile) => normalizeEmail(profile.accountEmail) === email)) return null;
    }
    return {
      ...(login.email ? { email: login.email } : {}),
      ...(login.apiKey ? { apiKey: true } : {}),
    };
  }

  /** Hide the offer until a different identity signs in to the System login. */
  async dismissSystemOffer(): Promise<void> {
    const login = await this.readSystem();
    if (!login.identityFingerprint) return;
    await this.piStore.registry.dismissSystemOffer(this.provider, login.identityFingerprint);
    this.broadcast();
  }

  /**
   * Use in Codara: a row whose terminals use the System login and whose
   * Cora half is not connected yet. Nothing of the login is read or copied.
   */
  async addSystemAccount(): Promise<PiAccountProfile> {
    return this.withMutation(async () => {
      const login = await this.readSystem();
      const { cliLabel } = this.adapter.labels;
      if (!login.signedIn) throw new Error(`${cliLabel} is not signed in on this computer`);
      const existing = await this.piStore.registry.systemProfile(this.provider);
      if (existing) return existing;
      if (login.identityFingerprint) {
        const same = (await this.piStore.registry.listProfiles(this.provider)).find(
          (profile) => profile.identityFingerprint === login.identityFingerprint,
        );
        if (same) throw new Error(`Already added as ${same.label}`);
      }
      const { profile } = await this.piStore.registry.registerProfile({
        provider: this.provider,
        label: login.email ?? `${cliLabel} login`,
        cliProfileId: SYSTEM_CLI_PROFILE_ID,
        cora: "none",
        explicitUserAdd: true,
        ...(login.identityFingerprint ? { identityFingerprint: login.identityFingerprint } : {}),
        ...(login.email ? { accountEmail: login.email } : {}),
      });
      await this.invalidateCaches().catch(() => undefined);
      this.defaultsChanged();
      this.broadcast();
      return profile;
    });
  }

  // Halves.

  /**
   * Give a row a managed CLI half from the credential it already holds. A
   * row on the System login keeps it; failure leaves the row without a CLI
   * half (the card offers Share) and never leaves a half-built managed
   * home behind.
   */
  async ensureCliHalf(
    coraProfileId: string,
    canonical: CanonicalCredential,
    identity?: AccountIdentity,
  ): Promise<string | null> {
    return this.withMutation(() => this.ensureCliHalfLocked(coraProfileId, canonical, identity));
  }

  /**
   * A credential the codec cannot turn into a fresh CLI file (Codex without
   * an id_token) is grown through the adapter, which persists the rotated
   * credential to Pi before answering.
   */
  private async growable(
    coraProfileId: string,
    canonical: CanonicalCredential,
  ): Promise<{ canonical: CanonicalCredential; record: Raw }> {
    let record = this.codec.cliRecordFromCanonical(canonical, null);
    if (record !== null) return { canonical, record };
    const refusal = new Error(
      `The Cora credential cannot be shared with ${this.adapter.labels.cliLabel}. Run ${this.adapter.labels.loginHint} in a terminal instead.`,
    );
    if (!this.adapter.growCliCredential) throw refusal;
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    const grown = await this.adapter.growCliCredential(
      canonical,
      authFile,
      AbortSignal.timeout(GROW_TIMEOUT_MS),
    );
    record = this.codec.cliRecordFromCanonical(grown, null);
    if (record === null) throw refusal;
    return { canonical: grown, record };
  }

  private async ensureCliHalfLocked(
    coraProfileId: string,
    canonical: CanonicalCredential,
    identity?: AccountIdentity,
  ): Promise<string | null> {
    const profile = await this.requireProfile(coraProfileId);
    if (profile.cli.kind === "system") return null;
    if (profile.cli.kind === "managed") {
      const cliProfileId = profile.cli.profileId;
      if (profile.cora !== "linked") {
        await this.piStore.registry.recordCoraHalf(profile.id, "linked");
      }
      const linked = await this.requireProfile(coraProfileId);
      this.watchProfile(linked);
      await this.mirror.reconcileNow(linked.id).catch(() => null);
      if (identity && this.adapter.afterCliHalfWritten) {
        await this.adapter
          .afterCliHalfWritten(this.adapter.locate(cliProfileId), identity)
          .catch(() => undefined);
      }
      return cliProfileId;
    }
    const grown = await this.growable(profile.id, canonical);
    const created = await this.store.createProfile({ label: profile.label });
    const cliProfileId = created.profile.id;
    const location = this.adapter.locate(cliProfileId);
    try {
      await this.adapter.prepareCliHome?.(cliProfileId);
      await this.adapter.writeCli(location, grown.record);
      if (identity && this.adapter.afterCliHalfWritten) {
        await this.adapter.afterCliHalfWritten(location, identity);
      }
      await this.piStore.registry.recordCliProfileId(profile.id, cliProfileId, "linked");
    } catch (error) {
      await this.adapter.clearCli(location).catch(() => undefined);
      await this.store.deleteProfile(cliProfileId).catch(() => undefined);
      throw error;
    }
    const linked = await this.requireProfile(coraProfileId);
    this.watchProfile(linked);
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[this.provider] === linked.id) {
      // The row was already Active while it had no CLI half, so terminals
      // ran on the System login; the half created now takes over.
      await this.applyActive(linked).catch((error: unknown) => {
        this.log(
          `[accounts] the ${this.adapter.labels.cliLabel} half of ${linked.id} was written but not made active: ${errorText(error)}`,
        );
      });
      this.defaultsChanged();
    }
    return cliProfileId;
  }

  // The Active account.

  /**
   * What the Active row means for the CLI: the per-CLI store's default
   * follows it (a managed id, or the System login's id), and a CLI with a
   * live slot (Claude) receives the account's login.
   */
  private async applyActive(profile: PiAccountProfile | null): Promise<void> {
    const target = profile?.cli.kind === "managed" ? profile.cli.profileId : this.systemId;
    const previousCliDefault = (await this.store.snapshot()).defaultProfileId;
    await this.store.setDefaultProfile(target);
    if (target === this.systemId || !this.adapter.activate) return;
    try {
      await this.adapter.activate(target);
    } catch (error) {
      await this.store.setDefaultProfile(previousCliDefault).catch(() => undefined);
      throw error;
    }
  }

  /** Make one account the Active one for Cora and the CLI together. */
  async useAccount(coraProfileId: string): Promise<void> {
    return this.withMutation(() => this.useAccountLocked(coraProfileId));
  }

  private async useAccountLocked(coraProfileId: string): Promise<void> {
    const profile = await this.requireProfile(coraProfileId);
    if (profile.cli.kind === "managed") {
      await this.reconcileProfile(profile.id);
      const [pi, cli] = await Promise.all([
        profile.cora === "linked" ? this.readPiCanonical(profile.id) : Promise.resolve(null),
        this.readCliCanonical(profile.cli.profileId),
      ]);
      if (!pi && !cli) {
        throw new UnifiedAccountNotConnectedError(profile, this.adapter.labels.cliLabel);
      }
    }
    const previousDefault = (await this.piStore.registry.snapshot()).defaults[this.provider] ?? null;
    await this.piStore.registry.setDefaultProfile(this.provider, profile.id);
    try {
      await this.applyActive(profile);
    } catch (error) {
      await this.piStore.registry
        .setDefaultProfile(this.provider, previousDefault)
        .catch(() => undefined);
      throw error;
    }
    await this.invalidateCaches().catch(() => undefined);
    this.defaultsChanged();
    this.broadcast();
  }

  /**
   * Use the System login for new sessions: its row when the user added one,
   * otherwise no Active account at all.
   */
  async useSystemLogin(): Promise<void> {
    return this.withMutation(async () => {
      const row = await this.piStore.registry.systemProfile(this.provider);
      if (row) {
        await this.useAccountLocked(row.id);
        return;
      }
      await this.piStore.registry.setDefaultProfile(this.provider, null);
      await this.applyActive(null);
      await this.invalidateCaches().catch(() => undefined);
      this.defaultsChanged();
      this.broadcast();
    });
  }

  // Share.

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
    if (profile.cli.kind === "system") {
      throw new Error(
        `${profile.label} uses the ${this.adapter.labels.cliLabel} login on this computer; it has nothing to share.`,
      );
    }
    const canonical = await this.readPiCanonical(profile.id);
    if (!canonical) {
      throw new UnifiedAccountNotConnectedError(profile, this.adapter.labels.cliLabel);
    }
    const identity = await this.adapter
      .connectTimeIdentity(canonical)
      .catch((): AccountIdentity => ({}));
    const cliProfileId = await this.ensureCliHalfLocked(profile.id, canonical, identity);
    if (!cliProfileId) throw new Error("This account has no terminal half to share");
    this.broadcast();
    return { coraProfileId: profile.id, cliProfileId };
  }

  private async shareCliLoginLocked(
    cliProfileId: string,
  ): Promise<{ coraProfileId: string; cliProfileId: string }> {
    const { cliLabel } = this.adapter.labels;
    if (!this.adapter.isManagedProfileId(cliProfileId)) {
      throw new TypeError(`Only a managed ${cliLabel} profile can be shared with Cora`);
    }
    const already = await this.piStore.registry.profileForCliProfileId(
      this.provider,
      cliProfileId,
    );
    if (already) return { coraProfileId: already.id, cliProfileId };
    const cliSnapshot = await this.store.snapshot();
    const managed = cliSnapshot.profiles.find((entry) => entry.id === cliProfileId);
    if (!managed) throw new Error(`Native ${cliLabel} account profile not found: ${cliProfileId}`);
    const canonical = await this.readCliCanonical(cliProfileId);
    if (!canonical) throw new Error(`This ${cliLabel} profile is not signed in`);
    const identity = await this.adapter
      .readCliIdentity(this.adapter.locate(cliProfileId))
      .catch((): NativeCliAccountIdentity => ({}));
    const rows = await this.piStore.registry.listProfiles(this.provider);
    const sameAccount = identity.fingerprint
      ? rows.find((entry) => entry.identityFingerprint === identity.fingerprint)
      : undefined;
    if (sameAccount && sameAccount.cli.kind !== "none") {
      throw new Error(
        `This sign-in belongs to ${sameAccount.label}, which already has a ${cliLabel} login.`,
      );
    }
    let profile: PiAccountProfile;
    if (sameAccount) {
      profile = await this.piStore.registry.recordCliProfileId(sameAccount.id, cliProfileId, "linked");
      if (!(await this.readPiCanonical(profile.id))) {
        await this.writePiCredential(profile.id, canonical);
      }
    } else {
      const registered = await this.piStore.registry.registerProfile({
        provider: this.provider,
        label: managed.label,
        cliProfileId,
        cora: "linked",
        explicitUserAdd: true,
        ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
        ...(identity.email ? { accountEmail: identity.email } : {}),
      });
      profile = registered.profile;
      await this.writePiCredential(profile.id, canonical);
    }
    this.watchProfile(profile);
    await this.mirror.reconcileNow(profile.id).catch(() => null);
    await this.invalidateCaches().catch(() => undefined);
    this.broadcast();
    return { coraProfileId: profile.id, cliProfileId };
  }

  private sweepLeases(): void {
    if (!this.sessionsHook) return;
    this.leases.sweep(this.sessionsHook.liveOwnerIds());
  }

  // Delete.

  /** Whether a terminal still runs in the managed home of a CLI half. */
  private homeHeld(cliProfileId: string): boolean {
    if (!this.adapter.managedHome(cliProfileId).holdsSessions) return false;
    this.sweepLeases();
    return this.leases.isLeased(cliProfileId);
  }

  private pendingPurgeFor(cliProfileId: string): PiAccountPendingPurge {
    return {
      path: this.adapter.managedHome(cliProfileId).path,
      reason: `${this.adapter.runtime} terminal still running`,
    };
  }

  /**
   * Remove a managed CLI half. A home a terminal still runs in (`held`)
   * loses its store entry now and its directory once the terminal exits;
   * otherwise the directory goes now. Answers whether it is gone.
   */
  private async removeCliHalf(cliProfileId: string, held: boolean): Promise<boolean> {
    const location = this.adapter.locate(cliProfileId);
    const home = this.adapter.managedHome(cliProfileId);
    const cli = await this.store.snapshot();
    if (cli.defaultProfileId === cliProfileId) await this.store.setDefaultProfile(this.systemId);
    const live = await this.adapter.activeCliProfileId?.().catch(() => undefined);
    if (live === cliProfileId) await this.adapter.releaseActive?.(cliProfileId);
    // What lives outside the directory (a Keychain item, a vault login)
    // goes now: a running terminal keeps the token it already loaded.
    await this.adapter.clearCli(location).catch(() => undefined);
    await this.store.deleteProfile(cliProfileId, held ? { keepDirectory: true } : {});
    if (held) return false;
    await purgeManagedPath(home.path, home.accountsRoot);
    return true;
  }

  async deleteAccount(
    coraProfileId: string,
    options: DeleteAccountOptions = {},
  ): Promise<DeleteAccountResult> {
    return this.withMutation(async () => {
      const profile = await this.requireProfile(coraProfileId);
      if (await options.ownershipGuard?.(profile)) {
        throw new PiAccountProfileProtectedError(profile.id);
      }
      const wasActive =
        (await this.piStore.registry.snapshot()).defaults[this.provider] === profile.id;
      const cliProfileId = profile.cli.kind === "managed" ? profile.cli.profileId : null;
      const held = cliProfileId !== null && this.homeHeld(cliProfileId);
      const guard = options.ownershipGuard ? { ownershipGuard: options.ownershipGuard } : {};
      let purgePending = held;
      this.deleting.add(profile.id);
      try {
        // Unwatched first, so no reconcile racing the delete can rebuild a
        // half from the other once its file is gone.
        await this.mirror.unwatch(profile.id);
        // The tombstone and the row's removal land in one registry write; a
        // managed home a terminal still holds is queued in that write too,
        // so a crash before the purge still purges it at the next boot.
        try {
          await this.piStore.deleteProfile(profile.id, {
            ...guard,
            ...(held && cliProfileId ? { pendingPurge: [this.pendingPurgeFor(cliProfileId)] } : {}),
          });
        } catch (error) {
          this.watchProfile(profile);
          throw error;
        }
        if (cliProfileId) {
          try {
            await this.removeCliHalf(cliProfileId, held);
          } catch (error) {
            // The row is gone either way; what is left of the half is
            // purged at the next boot.
            this.log(
              `[accounts] the ${this.adapter.labels.cliLabel} half of ${profile.id} was not removed yet: ${errorText(error)}`,
            );
            if (!held) {
              await this.piStore.registry
                .queuePendingPurge([this.pendingPurgeFor(cliProfileId)])
                .catch(() => undefined);
              purgePending = true;
            }
          }
        } else if (wasActive) {
          await this.store.setDefaultProfile(this.systemId).catch(() => undefined);
        }
      } finally {
        this.deleting.delete(profile.id);
      }
      await this.invalidateCaches().catch(() => undefined);
      if (wasActive) this.defaultsChanged();
      this.broadcast();
      return { deleted: true, purgePending };
    });
  }

  /** Delete a managed CLI profile no row links (a terminal-only half). */
  async deleteTerminalOnlyProfile(cliProfileId: string): Promise<{ deleted: boolean }> {
    return this.withMutation(async () => {
      const { cliLabel } = this.adapter.labels;
      if (!this.adapter.isManagedProfileId(cliProfileId)) {
        throw new TypeError(`Only a managed ${cliLabel} profile can be deleted here`);
      }
      const linked = await this.piStore.registry.profileForCliProfileId(
        this.provider,
        cliProfileId,
      );
      if (linked) {
        throw new Error(`This ${cliLabel} profile belongs to an account; delete the account instead`);
      }
      const snapshot = await this.store.snapshot();
      if (!snapshot.profiles.some((entry) => entry.id === cliProfileId)) {
        return { deleted: false };
      }
      const held = this.homeHeld(cliProfileId);
      if (held) await this.piStore.registry.queuePendingPurge([this.pendingPurgeFor(cliProfileId)]);
      await this.removeCliHalf(cliProfileId, held);
      this.broadcast();
      return { deleted: true };
    });
  }

  /**
   * Purge the managed homes of deleted accounts whose terminals have exited.
   * Runs at boot and whenever a terminal of this CLI releases its lease.
   */
  async purgePending(): Promise<string[]> {
    return this.withMutation(async () => {
      const snapshot = await this.piStore.registry.snapshot();
      if (snapshot.pendingPurge.length === 0) return [];
      const accountsRoot = this.adapter.managedAccountsRoot();
      this.sweepLeases();
      const done: string[] = [];
      for (const entry of snapshot.pendingPurge) {
        if (!isPathInside(entry.path, accountsRoot)) continue;
        if (this.leases.isLeased(basename(entry.path))) continue;
        try {
          await purgeManagedPath(entry.path, accountsRoot);
          done.push(entry.path);
        } catch (error) {
          this.log(`[accounts] could not remove ${entry.path}: ${errorText(error)}`);
        }
      }
      await this.piStore.registry.completePendingPurge(done);
      return done;
    });
  }

  // Startup pass pieces. Each re-derives its state from disk and is safe to
  // repeat; the migration module orders them.

  /**
   * A row whose managed half vanished keeps its Cora grant as its own; it
   * never silently falls back to another login.
   */
  async clearDanglingLinks(): Promise<string[]> {
    return this.withMutation(async () => {
      const [snapshot, cli] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.adapter.inspectCli(),
      ]);
      const managed = new Set(cli.filter((entry) => entry.managed).map((entry) => entry.id));
      const cleared: string[] = [];
      for (const profile of snapshot.profiles) {
        if (profile.provider !== this.provider || profile.cli.kind !== "managed") continue;
        if (managed.has(profile.cli.profileId)) continue;
        await this.piStore.registry.recordCliProfileId(
          profile.id,
          null,
          profile.cora === "linked" ? "own" : profile.cora,
        );
        await this.mirror.unwatch(profile.id);
        cleared.push(profile.id);
      }
      return cleared;
    });
  }

  /**
   * Project the Active row onto the CLI store's default, and put its login
   * into the live slot when the slot lags (a crash between the two writes).
   * Never moves the Active row itself.
   */
  async reprojectDefaults(): Promise<void> {
    return this.withMutation(async () => {
      const snapshot = await this.piStore.registry.snapshot();
      const defaultId = snapshot.defaults[this.provider];
      const row = defaultId
        ? snapshot.profiles.find((profile) => profile.id === defaultId) ?? null
        : null;
      try {
        const target = row?.cli.kind === "managed" ? row.cli.profileId : this.systemId;
        const cli = await this.store.snapshot();
        if (cli.defaultProfileId !== target) await this.store.setDefaultProfile(target);
        if (target !== this.systemId && this.adapter.activate && this.adapter.activeCliProfileId) {
          const live = await this.adapter.activeCliProfileId();
          if (live !== target) await this.adapter.activate(target);
        }
      } catch (error) {
        this.log(
          `[accounts] could not point ${this.adapter.labels.cliLabel} at the Active account: ${errorText(error)}`,
        );
      }
      this.defaultsChanged();
    });
  }

  /** Arm the mirror over every linked pair and reconcile each once. */
  async startMirror(): Promise<CredentialPair<Loc, Raw>[]> {
    const snapshot = await this.piStore.registry.snapshot();
    const pairs: CredentialPair<Loc, Raw>[] = [];
    for (const profile of snapshot.profiles) {
      const pair = this.pairFromProfile(profile);
      if (pair) pairs.push(pair);
    }
    const watched = new Set(pairs.map((pair) => pair.coraProfileId));
    for (const pair of this.mirror.watchedPairs(this.provider)) {
      if (!watched.has(pair.coraProfileId)) await this.mirror.unwatch(pair.coraProfileId);
    }
    for (const pair of pairs) this.mirror.watch(pair);
    await this.mirror.reconcileAll(this.provider);
    return pairs;
  }

  stop(): void {
    for (const pair of this.mirror.watchedPairs(this.provider)) {
      void this.mirror.unwatch(pair.coraProfileId);
    }
  }
}

/**
 * Equal fingerprints match; equal emails match only when a fingerprint is
 * missing on at least one side; differing fingerprints never match.
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
