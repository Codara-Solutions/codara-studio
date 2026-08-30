import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import type { PiSubscriptionProvider } from "@shared/types";
import type {
  AccountIdentity,
  AccountProviderAdapter,
  CliProfileStatus,
  SwitchContext,
} from "./account-adapters/account-adapter";
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
  nextDefaultAfterDeletion,
  PiAccountProfileProtectedError,
  type PiAccountProfile,
} from "./pi-account-profiles";
import { loadPiAuthStorage, type PiAuthStorageLoader } from "./pi-auth-storage";
import {
  UnifiedAccountNotConnectedError,
  UnifiedAccountSessionsError,
} from "./unified-account-errors";

export { UnifiedAccountNotConnectedError, UnifiedAccountSessionsError };

/**
 * One account, two halves, for any provider. The Pi registry row is the
 * account; its cliProfileId names the CLI half ("personal" for the user's
 * own login in the CLI's default home, a managed profile otherwise). Which
 * CLI, where its slots are and what a switch has to do first is the
 * adapter's business; everything that touches both halves at once lives
 * here, behind one in-process mutation tail so a switch, a share and a
 * delete can never interleave:
 *
 *  - useAccount writes the Pi default and the CLI default in one step with
 *    rollback, after the adapter's switch side effects (Codex closes its
 *    sessions, once the caller agreed) and before them (Codex activates the
 *    marker).
 *  - deleteAccount refuses first (a delete the user then abandons changes
 *    nothing), hands both sides to Account 1 or the oldest remaining
 *    account, unlinks the halves so no racing reconcile can rebuild one,
 *    removes the Pi half, closes only that account's terminals (after
 *    confirmation), then removes the CLI half.
 *  - shareLogin turns a half into a whole in either direction.
 *  - ensureAccountOne creates or pairs the row for the personal login.
 *
 * No path, token or environment leaves this module through IPC; callers get
 * ids and booleans.
 */

const ACCOUNT_ONE_LABEL = "Account 1";
const PERSONAL_PROBE_INTERVAL_MS = 60_000;
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
  isAccount1: boolean;
  isDefault: boolean;
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

export type PiSubscriptionShareLoginInput =
  | { coraProfileId: string }
  | { cliProfileId: string };

export interface UseAccountOptions {
  /** Allow the switch to close running sessions of the CLI (Codex only needs this). */
  closeSessions?: boolean;
}

export interface DeleteAccountOptions {
  closeSessions?: boolean;
  ownershipGuard?: PiAccountProfileOwnershipGuard;
}

export interface DeleteAccountResult {
  deleted: boolean;
  closedSessionCount: number;
}

export interface UnifiedTerminalSessions {
  liveOwnerIds(): ReadonlySet<string>;
  disposeProfileSessions(cliProfileId: string): Promise<{ closedSessionCount: number }>;
}

export type UnifiedSessionShutdown = () => Promise<{ closedSessionCount: number }>;

export interface UnifiedAccountServiceOptions {
  piStore?: PiAccountAuthStore;
  mirror?: CredentialMirror;
  loadAuthStorage?: PiAuthStorageLoader;
  invalidateCaches?: () => Promise<void>;
  /** Wired by the IPC layer; the service itself never imports Electron. */
  broadcast?: () => void;
  sessions?: UnifiedTerminalSessions;
  /** Closes every session of the CLI before a switch that needs it (Codex). */
  sessionShutdown?: UnifiedSessionShutdown;
  /**
   * Runs after either default moved (a switch, a hand-off, a repair, Account
   * 1 taking an empty default): the shell pointer is rewritten from it.
   */
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
  private personalWatchers: FSWatcher[] = [];
  private personalProbe: NodeJS.Timeout | null = null;
  /**
   * The personal login that turned out to belong to a row already paired
   * with a managed profile. The probe keeps watching for a different login
   * but stops re-deriving this one on every event.
   */
  private rejectedPersonalLogin: { access: string; fingerprint: string | null } | null = null;
  /** Rows mid-delete: every reconcile entry point answers null for them. */
  private readonly deleting = new Set<string>();
  private broadcastHook: (() => void) | null;
  private sessionsHook: UnifiedTerminalSessions | null;
  private sessionShutdownHook: UnifiedSessionShutdown | null;
  private defaultsChangedHook: (() => void | Promise<void>) | null;

  constructor(adapter: AccountProviderAdapter<Loc, Raw>, options: UnifiedAccountServiceOptions = {}) {
    this.adapter = adapter;
    this.provider = adapter.provider;
    this.options = options;
    this.broadcastHook = options.broadcast ?? null;
    this.sessionsHook = options.sessions ?? null;
    this.sessionShutdownHook = options.sessionShutdown ?? null;
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

  private get personalId(): string {
    return this.adapter.personalId;
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

  setSessionShutdown(hook: UnifiedSessionShutdown | null): void {
    this.sessionShutdownHook = hook;
  }

  setDefaultsChanged(hook: (() => void | Promise<void>) | null): void {
    this.defaultsChangedHook = hook;
  }

  /** Best effort and off the mutation path: a pointer write never fails an account mutation. */
  private defaultsChanged(): void {
    try {
      void Promise.resolve(this.defaultsChangedHook?.()).catch((error: unknown) => {
        this.log(
          `[accounts] the active-account pointer was not written: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
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

  /** The mirror pair for a linked row; null for an unlinked one. */
  pairFromProfile(profile: PiAccountProfile): CredentialPair<Loc, Raw> | null {
    if (profile.provider !== this.provider || !profile.cliProfileId) return null;
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, profile.id);
    return {
      provider: this.provider,
      coraProfileId: profile.id,
      cliProfileId: profile.cliProfileId,
      authFile,
      location: this.adapter.locate(profile.cliProfileId),
      adapter: this.adapter,
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

  /** Terminal status per CLI profile id, from one credential read each. */
  async terminalStatuses(): Promise<Map<string, UnifiedTerminalStatus>> {
    const statuses = new Map<string, UnifiedTerminalStatus>();
    try {
      const connections = await this.adapter.inspectCli();
      this.sweepLeases();
      for (const connection of connections) {
        statuses.set(
          connection.id,
          terminalStatusFrom(connection, this.liveSessionCount(connection.id)),
        );
      }
    } catch (error) {
      this.log(
        `[accounts] ${this.adapter.labels.cliLabel} profile inspection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
        isAccount1: cliProfileId === this.personalId,
        isDefault: inspection.snapshot.defaults[this.provider] === profile.id,
        cora,
        terminal: connection
          ? terminalStatusFrom(connection, this.liveSessionCount(connection.id))
          : null,
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
        terminal: terminalStatusFrom(connection, this.liveSessionCount(connection.id)),
      });
    }
    return { accounts, terminalOnly };
  }

  private async watchProfile(profile: PiAccountProfile): Promise<void> {
    const pair = this.pairFromProfile(profile);
    if (pair) this.mirror.watch(pair);
  }

  /**
   * The row for the user's own personal login. Created (or paired with an
   * existing unlinked row of the same account) the first time the personal
   * slot holds a credential; nothing happens while it holds none.
   */
  async ensureAccountOne(): Promise<PiAccountProfile | null> {
    return this.withMutation(() => this.ensureAccountOneLocked());
  }

  private async ensureAccountOneLocked(): Promise<PiAccountProfile | null> {
    const existing = await this.piStore.registry.accountOneProfile(this.provider);
    if (existing) {
      await this.watchProfile(existing);
      if (existing.identityFingerprint) {
        this.stopPersonalProbe();
        return existing;
      }
      // Registered while the identity was unreachable (offline first
      // launch). The fingerprint is what folds a later browser sign-in of
      // the same account into this row instead of a second one, so keep
      // trying to learn it until it is known.
      const backfilled = await this.backfillAccountOneIdentity(existing);
      if (backfilled.identityFingerprint) this.stopPersonalProbe();
      else this.startPersonalProbe();
      return backfilled;
    }
    const canonical = await this.readCliCanonical(this.personalId);
    if (!canonical) {
      this.startPersonalProbe();
      return null;
    }
    if (this.rejectedPersonalLogin?.access === canonical.access) return null;
    const identity = await this.personalIdentity(canonical);
    if (
      this.rejectedPersonalLogin?.fingerprint &&
      identity.fingerprint === this.rejectedPersonalLogin.fingerprint
    ) {
      this.rejectedPersonalLogin = { access: canonical.access, fingerprint: identity.fingerprint };
      return null;
    }
    const snapshot = await this.piStore.registry.snapshot();
    const unlinked = snapshot.profiles.filter(
      (profile) => profile.provider === this.provider && !profile.cliProfileId,
    );
    const match = findMatchingRow(unlinked, identity);
    let profile: PiAccountProfile;
    if (match) {
      profile = await this.piStore.registry.recordCliProfileId(match.id, this.personalId);
      if (!match.identityFingerprint && identity.fingerprint) {
        await this.piStore.registry
          .recordIdentityFingerprint(match.id, identity.fingerprint)
          .catch(() => undefined);
      }
      this.log(
        `[accounts] paired ${match.id} with the personal ${this.adapter.labels.cliLabel} login by ${
          match.identityFingerprint && identity.fingerprint ? "fingerprint" : "email"
        }`,
      );
    } else {
      const registered = await this.piStore.registry.registerProfile({
        provider: this.provider,
        label: ACCOUNT_ONE_LABEL,
        cliProfileId: this.personalId,
        ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
        ...(identity.email ? { accountEmail: identity.email } : {}),
      });
      profile = registered.profile;
      if (profile.cliProfileId !== this.personalId) {
        // The same account is already a managed profile's row; the personal
        // login stays a plain terminal login rather than a second row.
        this.rejectedPersonalLogin = {
          access: canonical.access,
          fingerprint: identity.fingerprint ?? null,
        };
        this.log(
          `[accounts] the personal ${this.adapter.labels.cliLabel} login belongs to ${profile.id}, which is already paired with a managed profile`,
        );
        return null;
      }
      if (registered.created) {
        await this.writePiCredential(profile.id, canonical);
      }
    }
    this.rejectedPersonalLogin = null;
    await this.watchProfile(profile);
    await this.mirror.reconcileNow(profile.id).catch(() => null);
    if (profile.identityFingerprint) this.stopPersonalProbe();
    else this.startPersonalProbe();
    await this.invalidateCaches().catch(() => undefined);
    // Registering may have taken an empty Cora default; the CLI default is
    // repaired by the startup pass, but a shell should follow now.
    this.defaultsChanged();
    this.broadcast();
    return profile;
  }

  /**
   * Who the personal slot is signed in as. The token is authoritative: the
   * provider answers for the credential itself, while the CLI's own config
   * only records whichever login last ran against the personal home (the
   * retired selector left it naming a managed account). The file is the
   * offline fallback, and when both answer differently the token wins.
   */
  private async personalIdentity(canonical: CanonicalCredential): Promise<AccountIdentity> {
    const personal = this.adapter.locate(this.personalId);
    const [fromToken, fromFile] = await Promise.all([
      this.adapter.connectTimeIdentity(canonical).catch((): AccountIdentity => ({})),
      this.adapter.readCliIdentity(personal).catch((): NativeCliAccountIdentity => ({})),
    ]);
    if (!fromToken.fingerprint) {
      return { ...fromToken, ...fromFile, ...(fromToken.email ? { email: fromToken.email } : {}) };
    }
    if (fromFile.fingerprint && fromFile.fingerprint !== fromToken.fingerprint) {
      this.log(
        `[accounts] the ${this.adapter.labels.cliLabel} config names a different account than the personal login; the login decides`,
      );
      return fromToken;
    }
    return { ...fromToken, email: fromToken.email ?? fromFile.email };
  }

  private async backfillAccountOneIdentity(existing: PiAccountProfile): Promise<PiAccountProfile> {
    const canonical = await this.readCliCanonical(this.personalId);
    if (!canonical) return existing;
    const identity = await this.personalIdentity(canonical);
    if (!identity.fingerprint) return existing;
    let profile = existing;
    try {
      profile = await this.piStore.registry.recordIdentityFingerprint(
        existing.id,
        identity.fingerprint,
      );
      if (identity.email && !profile.accountEmail) {
        profile = await this.piStore.registry.recordAccountEmail(profile.id, identity.email);
      }
    } catch (error) {
      this.log(
        `[accounts] could not record the identity of Account 1: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return existing;
    }
    this.broadcast();
    return profile;
  }

  /**
   * While no Account 1 row exists, watch the personal slot for a login to
   * appear. A slot no watcher sees (the Keychain) is probed slowly instead.
   */
  private startPersonalProbe(): void {
    if (this.personalWatchers.length > 0 || this.personalProbe) return;
    for (const target of this.adapter.personalProbePaths()) {
      try {
        const watcher = watch(target.directory, { persistent: false });
        watcher.on("change", (_event, filename) => {
          const name = typeof filename === "string" ? filename : filename?.toString();
          if (target.file !== undefined && name !== undefined && name !== target.file) return;
          void this.ensureAccountOne().catch(() => null);
        });
        watcher.on("error", () => {
          watcher.close();
          this.personalWatchers = this.personalWatchers.filter((entry) => entry !== watcher);
        });
        this.personalWatchers.push(watcher);
      } catch {
        // No personal home yet; the probe below covers its creation.
      }
    }
    if (this.adapter.pollWhenWatchBlind || this.personalWatchers.length === 0) {
      this.personalProbe = setInterval(() => {
        void this.ensureAccountOne().catch(() => null);
      }, PERSONAL_PROBE_INTERVAL_MS);
      this.personalProbe.unref?.();
    }
  }

  private stopPersonalProbe(): void {
    for (const watcher of this.personalWatchers) watcher.close();
    this.personalWatchers = [];
    if (this.personalProbe) clearInterval(this.personalProbe);
    this.personalProbe = null;
  }

  /**
   * Give a row its CLI half from the credential it already holds. Failure
   * leaves the row unlinked (the card offers Share) and never leaves a
   * half-built managed directory behind.
   */
  async ensureCliHalf(
    coraProfileId: string,
    canonical: CanonicalCredential,
    identity?: AccountIdentity,
  ): Promise<string> {
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
    if (!this.adapter.growCliCredential) {
      throw new Error(
        `The Cora credential cannot be shared with ${this.adapter.labels.cliLabel}. Run ${this.adapter.labels.loginHint} in a terminal instead.`,
      );
    }
    const { authFile } = piAccountProfilePaths(this.piStore.rootDir, coraProfileId);
    const grown = await this.adapter.growCliCredential(
      canonical,
      authFile,
      AbortSignal.timeout(GROW_TIMEOUT_MS),
    );
    record = this.codec.cliRecordFromCanonical(grown, null);
    if (record === null) {
      throw new Error(
        `The Cora credential cannot be shared with ${this.adapter.labels.cliLabel}. Run ${this.adapter.labels.loginHint} in a terminal instead.`,
      );
    }
    return { canonical: grown, record };
  }

  private async ensureCliHalfLocked(
    coraProfileId: string,
    canonical: CanonicalCredential,
    identity?: AccountIdentity,
  ): Promise<string> {
    const profile = await this.requireProfile(coraProfileId);
    if (profile.cliProfileId) {
      await this.watchProfile(profile);
      await this.mirror.reconcileNow(profile.id).catch(() => null);
      if (identity && profile.cliProfileId !== this.personalId && this.adapter.afterCliHalfWritten) {
        await this.adapter
          .afterCliHalfWritten(this.adapter.locate(profile.cliProfileId), identity)
          .catch(() => undefined);
      }
      return profile.cliProfileId;
    }
    const grown = await this.growable(profile.id, canonical);
    const created = await this.store.createProfile({ label: profile.label });
    const cliProfileId = created.profile.id;
    const location = this.adapter.locate(cliProfileId);
    try {
      await this.adapter.writeCli(location, grown.record);
      if (identity && this.adapter.afterCliHalfWritten) {
        await this.adapter.afterCliHalfWritten(location, identity);
      }
      await this.piStore.registry.recordCliProfileId(profile.id, cliProfileId);
    } catch (error) {
      await this.adapter.clearCli(location).catch(() => undefined);
      await this.store.deleteProfile(cliProfileId).catch(() => undefined);
      throw error;
    }
    const linked = await this.requireProfile(coraProfileId);
    await this.watchProfile(linked);
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[this.provider] === linked.id) {
      // The row was already the Cora default while it had no half, so the
      // CLI rested on Account 1. The half created now must take the CLI
      // default with it, or new terminals keep launching on Account 1 until
      // the next launch repairs the defaults.
      await this.useAccountLocked(linked.id, {});
    }
    return cliProfileId;
  }

  /** Switch Cora and the CLI to one account together. */
  async useAccount(
    coraProfileId: string,
    options: UseAccountOptions = {},
  ): Promise<{ closedSessionCount: number }> {
    return this.withMutation(() => this.useAccountLocked(coraProfileId, options));
  }

  /** Studio panes holding a lease on any profile of this CLI, dead ones swept. */
  private async liveTerminalSessionCount(): Promise<number> {
    this.sweepLeases();
    const ids = [this.personalId, ...(await this.store.snapshot()).profiles.map((entry) => entry.id)];
    const owners = new Set<string>();
    for (const id of ids) {
      for (const owner of this.leases.owners(id)) {
        if (owner.startsWith("terminal:")) owners.add(owner);
      }
    }
    return owners.size;
  }

  private switchContext(closeSessions: boolean): SwitchContext {
    return {
      closeSessions,
      liveSessionCount: () => this.liveTerminalSessionCount(),
      sessionShutdown: this.sessionShutdownHook,
    };
  }

  private async useAccountLocked(
    coraProfileId: string,
    options: UseAccountOptions,
  ): Promise<{ closedSessionCount: number }> {
    const profile = await this.requireProfile(coraProfileId);
    await this.reconcileProfile(profile.id);
    const [pi, cli] = await Promise.all([
      this.readPiCanonical(profile.id),
      profile.cliProfileId ? this.readCliCanonical(profile.cliProfileId) : Promise.resolve(null),
    ]);
    if (!pi && !cli) {
      throw new UnifiedAccountNotConnectedError(profile, this.adapter.labels.cliLabel);
    }
    const target = profile.cliProfileId ?? this.personalId;
    let closedSessionCount = 0;
    if (this.adapter.switchSideEffects) {
      closedSessionCount = (
        await this.adapter.switchSideEffects.beforeSwitch(
          target,
          this.switchContext(options.closeSessions === true),
        )
      ).closedSessionCount;
      this.sweepLeases();
    }
    const before = await this.piStore.registry.snapshot();
    const previousDefault = before.defaults[this.provider] ?? null;
    const previousCliDefault = (await this.store.snapshot()).defaultProfileId;
    await this.piStore.registry.setDefaultProfile(this.provider, profile.id);
    try {
      await this.store.setDefaultProfile(target);
    } catch (error) {
      await this.piStore.registry
        .setDefaultProfile(this.provider, previousDefault)
        .catch(() => undefined);
      throw error;
    }
    if (this.adapter.switchSideEffects) {
      try {
        await this.adapter.switchSideEffects.afterDefault(target);
      } catch (error) {
        await this.store.setDefaultProfile(previousCliDefault).catch(() => undefined);
        await this.piStore.registry
          .setDefaultProfile(this.provider, previousDefault)
          .catch(() => undefined);
        throw error;
      }
    }
    await this.invalidateCaches().catch(() => undefined);
    this.defaultsChanged();
    this.broadcast();
    return { closedSessionCount };
  }

  /**
   * Make the CLI's live selection follow its store default (the Codex
   * marker can lag after a crash or a rolled-back switch). A no-op for CLIs
   * whose default is the selection.
   */
  async alignActive(): Promise<void> {
    if (!this.adapter.activeCliProfileId || !this.adapter.switchSideEffects) return;
    const [active, snapshot] = await Promise.all([
      this.adapter.activeCliProfileId(),
      this.store.snapshot(),
    ]);
    if (active === snapshot.defaultProfileId) return;
    await this.adapter.switchSideEffects.afterDefault(snapshot.defaultProfileId, {
      allowSignedOut: true,
    });
  }

  /**
   * The Cora row a CLI profile id stands for, for callers that still speak
   * in terminal ids: the linked row, or Account 1 for "personal".
   */
  async coraProfileForCli(cliProfileId: string): Promise<PiAccountProfile | undefined> {
    return this.piStore.registry.profileForCliProfileId(this.provider, cliProfileId);
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
    if (!canonical) {
      throw new UnifiedAccountNotConnectedError(profile, this.adapter.labels.cliLabel);
    }
    const identity = await this.adapter
      .connectTimeIdentity(canonical)
      .catch((): AccountIdentity => ({}));
    const cliProfileId = await this.ensureCliHalfLocked(profile.id, canonical, identity);
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[this.provider] === profile.id) {
      await this.useAccountLocked(profile.id, {});
    } else {
      this.broadcast();
    }
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
    const snapshot = await this.piStore.registry.snapshot();
    const sameAccount = identity.fingerprint
      ? snapshot.profiles.find(
          (entry) =>
            entry.provider === this.provider && entry.identityFingerprint === identity.fingerprint,
        )
      : undefined;
    if (sameAccount?.cliProfileId) {
      throw new Error(
        `This sign-in belongs to ${sameAccount.label}, which already has a ${cliLabel} profile.`,
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
        provider: this.provider,
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
    if (cliSnapshot.defaultProfileId === cliProfileId) {
      await this.useAccountLocked(profile.id, {});
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
    const location = this.adapter.locate(cliProfileId);
    const cli = await this.store.snapshot();
    if (cli.defaultProfileId === cliProfileId) {
      // The CLI default can lag the Cora default (a rolled-back switch, a
      // repair that could only log). A half still holding it moves to the
      // active row's half, or to personal, so the store never refuses the
      // delete for it.
      const snapshot = await this.piStore.registry.snapshot();
      const active = snapshot.profiles.find(
        (profile) => profile.id === snapshot.defaults[this.provider],
      );
      const next =
        active?.cliProfileId && active.cliProfileId !== cliProfileId
          ? active.cliProfileId
          : this.personalId;
      await this.store.setDefaultProfile(next);
      await this.adapter.switchSideEffects
        ?.afterDefault(next, { allowSignedOut: true })
        .catch(() => undefined);
    }
    await this.store.deleteProfile(cliProfileId);
    // The directory is gone; this removes what lives outside it (a Keychain
    // item, a vault copy).
    await this.adapter.clearCli(location).catch(() => undefined);
  }

  /**
   * Hand the defaults on before a row disappears: Account 1 first, then the
   * oldest remaining account, so deleting the active account never strands
   * connected ones behind an empty default. Nothing connected means nothing
   * to hand to, and both defaults go empty.
   */
  private async handOffDefault(coraProfileId: string, closeSessions: boolean): Promise<void> {
    const snapshot = await this.piStore.registry.snapshot();
    if (snapshot.defaults[this.provider] !== coraProfileId) return;
    const remaining = snapshot.profiles.filter(
      (profile) => profile.provider === this.provider && profile.id !== coraProfileId,
    );
    while (remaining.length > 0) {
      const nextId = nextDefaultAfterDeletion(remaining, this.provider);
      if (!nextId) break;
      remaining.splice(
        remaining.findIndex((profile) => profile.id === nextId),
        1,
      );
      try {
        await this.useAccountLocked(nextId, { closeSessions });
        return;
      } catch (error) {
        // Signed out on both sides (a CLI logout that already reached
        // Cora): try the next one rather than refusing the delete.
        if (!(error instanceof UnifiedAccountNotConnectedError)) throw error;
      }
    }
    await this.store.setDefaultProfile(this.personalId);
    await this.piStore.registry.setDefaultProfile(this.provider, null);
    // A CLI whose live selection is a marker (Codex) must follow even to a
    // signed-out personal slot, or a later switch resurrects the deleted
    // account's live file.
    await this.adapter.switchSideEffects
      ?.afterDefault(this.personalId, { allowSignedOut: true })
      .catch((error) => {
        this.log(
          `[accounts] could not hand the ${this.adapter.labels.cliLabel} selection to Account 1: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    this.defaultsChanged();
  }

  async deleteAccount(
    coraProfileId: string,
    options: DeleteAccountOptions = {},
  ): Promise<DeleteAccountResult> {
    return this.withMutation(async () => {
      const profile = await this.requireProfile(coraProfileId);
      if (profile.cliProfileId === this.personalId) {
        throw new PiAccountProfileProtectedError(profile.id);
      }
      if (await options.ownershipGuard?.(profile)) {
        throw new PiAccountProfileProtectedError(profile.id);
      }
      const cliProfileId = profile.cliProfileId;
      const closeSessions = options.closeSessions === true;
      // Every refusal comes before anything moves: the card asks about the
      // terminals in a second step, and a delete the user then abandons must
      // not have switched Cora and the CLI to another account.
      if (cliProfileId) {
        this.sweepLeases();
        if (this.leases.isLeased(cliProfileId) && (!closeSessions || !this.sessionsHook)) {
          throw new UnifiedAccountSessionsError(this.leases.owners(cliProfileId).length);
        }
      }
      await this.handOffDefault(profile.id, closeSessions);
      const guard = options.ownershipGuard ? { ownershipGuard: options.ownershipGuard } : {};
      let closedSessionCount = 0;
      if (!cliProfileId) {
        await this.piStore.deleteProfile(profile.id, guard);
      } else {
        // Unlink before either half goes. A reconcile racing the delete (the
        // usage poller, a Cora launch, the lease-release hook of the
        // terminals closed below) then resolves no pair and cannot rebuild
        // the half from the other once its slot is gone; the mirror is
        // drained so an in-flight read lands first.
        this.deleting.add(profile.id);
        try {
          await this.piStore.registry.recordCliProfileId(profile.id, null);
          await this.mirror.unwatch(profile.id);
          try {
            await this.piStore.deleteProfile(profile.id, guard);
          } catch (error) {
            // The Pi half refused (an active run started meanwhile, an
            // unreadable run store): the row stays whole, not half-deleted.
            const restored = await this.piStore.registry
              .recordCliProfileId(profile.id, cliProfileId)
              .catch(() => null);
            if (restored) await this.watchProfile(restored);
            throw error;
          }
          if (this.sessionsHook && this.leases.isLeased(cliProfileId)) {
            closedSessionCount = (await this.sessionsHook.disposeProfileSessions(cliProfileId))
              .closedSessionCount;
            this.sweepLeases();
          }
          // From here a failure leaves a terminal-only card the user can
          // delete again, never an account with a missing half.
          await this.removeCliHalf(cliProfileId);
        } finally {
          this.deleting.delete(profile.id);
        }
      }
      await this.invalidateCaches().catch(() => undefined);
      this.broadcast();
      return { deleted: true, closedSessionCount };
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
      const [snapshot, cli] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.adapter.inspectCli(),
      ]);
      const managed = new Set(cli.filter((entry) => entry.managed).map((entry) => entry.id));
      const cleared: string[] = [];
      for (const profile of snapshot.profiles) {
        if (
          profile.provider !== this.provider ||
          !profile.cliProfileId ||
          profile.cliProfileId === this.personalId ||
          managed.has(profile.cliProfileId)
        ) {
          continue;
        }
        await this.piStore.registry.recordCliProfileId(profile.id, null);
        await this.mirror.unwatch(profile.id);
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
  async pairHalves(): Promise<
    Array<{ coraProfileId: string; cliProfileId: string; by: "fingerprint" | "email" }>
  > {
    return this.withMutation(async () => {
      const [snapshot, cli] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.store.snapshot(),
      ]);
      const linked = new Set(
        snapshot.profiles
          .filter((profile) => profile.provider === this.provider)
          .map((profile) => profile.cliProfileId)
          .filter(Boolean),
      );
      const candidates = snapshot.profiles.filter(
        (profile) => profile.provider === this.provider && !profile.cliProfileId,
      );
      const paired: Array<{
        coraProfileId: string;
        cliProfileId: string;
        by: "fingerprint" | "email";
      }> = [];
      if (candidates.length === 0) return paired;
      for (const managed of cli.profiles) {
        if (linked.has(managed.id)) continue;
        const identity = await this.adapter
          .readCliIdentity(this.adapter.locate(managed.id))
          .catch((): NativeCliAccountIdentity => ({}));
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
        this.log(
          `[accounts] paired ${match.id} with ${this.adapter.labels.cliLabel} profile ${managed.id} by ${by}`,
        );
        const pair = this.pairFromProfile(profile);
        if (pair) await reconcilePair(pair, this.reconcileOptions()).catch(() => null);
        paired.push({ coraProfileId: match.id, cliProfileId: managed.id, by });
      }
      return paired;
    });
  }

  /** Make the CLI default follow the Cora default, or derive one from the other. */
  async repairDefaults(): Promise<void> {
    return this.withMutation(async () => {
      const [snapshot, cli] = await Promise.all([
        this.piStore.registry.snapshot(),
        this.store.snapshot(),
      ]);
      const rows = snapshot.profiles.filter((profile) => profile.provider === this.provider);
      const defaultId = snapshot.defaults[this.provider];
      const row = defaultId ? rows.find((profile) => profile.id === defaultId) : undefined;
      if (row) {
        const link = row.cliProfileId ?? this.personalId;
        if (cli.defaultProfileId !== link) {
          await this.store.setDefaultProfile(link).catch((error) => {
            this.log(
              `[accounts] could not point ${this.adapter.labels.cliLabel} at the active account: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
        await this.alignActiveLogged();
        return;
      }
      const accountOne = rows.find((profile) => profile.cliProfileId === this.personalId);
      if (cli.defaultProfileId === this.personalId) {
        if (accountOne) await this.piStore.registry.setDefaultProfile(this.provider, accountOne.id);
        await this.alignActiveLogged();
        return;
      }
      const linkedRow = rows.find((profile) => profile.cliProfileId === cli.defaultProfileId);
      if (linkedRow) {
        await this.piStore.registry.setDefaultProfile(this.provider, linkedRow.id);
      }
      // An unlinked managed default stays where it is; its card offers Share.
      await this.alignActiveLogged();
    });
  }

  private async alignActiveLogged(): Promise<void> {
    await this.alignActive().catch((error) => {
      this.log(
        `[accounts] could not align the ${this.adapter.labels.cliLabel} selection with its default: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    this.defaultsChanged();
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
    if (
      !snapshot.profiles.some(
        (profile) => profile.provider === this.provider && profile.cliProfileId === this.personalId,
      )
    ) {
      this.startPersonalProbe();
    }
    return pairs;
  }

  rearmMirror(): void {
    this.mirror.rearm();
  }

  stop(): void {
    this.stopPersonalProbe();
    for (const pair of this.mirror.watchedPairs(this.provider)) {
      void this.mirror.unwatch(pair.coraProfileId);
    }
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
