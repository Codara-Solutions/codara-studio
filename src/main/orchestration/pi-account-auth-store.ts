import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import type { PiSubscriptionProvider } from "@shared/types";
import {
  familyForSubscription,
  isPiSubscriptionProvider,
  PI_SUBSCRIPTION_PROVIDERS,
} from "../../shared/agent-families";

import { jwtEmailClaim, jwtSubjectClaim } from "./native-cli-account-identity";
import {
  PiAccountProfileProtectedError,
  PiAccountProfileRegistry,
  type PiAccountProfile,
  type PiAccountProfilesSnapshot,
} from "./pi-account-profiles";
import {
  inspectPiSubscriptionAuth,
} from "./pi-runtime";

export const PI_ACCOUNT_AUTH_DIRECTORY = "accounts";
export const PI_ACCOUNT_AUTH_FILE = "auth.json";

const PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORTED_PROVIDERS: readonly PiSubscriptionProvider[] = PI_SUBSCRIPTION_PROVIDERS;
const mutationTails = new Map<string, Promise<void>>();

export interface PiAccountRuntimeProfile {
  accountProfileId?: string;
  profile?: PiAccountProfile;
  configDir: string;
  authFile: string;
}

export interface ResolvePiAccountRuntimeProfileInput {
  provider: PiSubscriptionProvider;
  preferredAccountProfileId?: string | null;
  /** Require an explicit preferredAccountProfileId rather than using a default. */
  requirePreferred?: boolean;
}

export interface PiAccountProfileAuthStatus {
  profileId: string;
  provider: PiSubscriptionProvider;
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
  expiresAt: number | null;
  error?: string;
  /**
   * Anonymous sha256 of the vendor account id, read back from the stored
   * credential. The registry records the same digest at login; this covers
   * profiles connected before that field existed. Undefined for Anthropic,
   * whose credential carries no account id.
   */
  accountFingerprint?: string;
  /**
   * The account's email address, read back from the stored credential's OpenID
   * claims. Undefined for Anthropic, whose credential is opaque — that address
   * is captured at connect time and lives on the registry profile instead.
   */
  accountEmail?: string;
}

export interface PiAccountAuthReconciliation {
  migratedProfileIds: string[];
  missingCredentialProfileIds: string[];
  orphanCredentialProfileIds: string[];
}

export interface PiAccountAuthInspection {
  snapshot: PiAccountProfilesSnapshot;
  statuses: PiAccountProfileAuthStatus[];
  reconciliation: PiAccountAuthReconciliation;
}

export interface PreparePiAccountCredentialTargetInput {
  provider: PiSubscriptionProvider;
  profileId?: string;
  label?: string;
  identityFingerprint?: string;
  /** Display-only address for the account this credential belongs to. */
  accountEmail?: string;
  makeDefault?: boolean;
}

export interface PreparedPiAccountCredentialTarget {
  profile: PiAccountProfile;
  created: boolean;
  configDir: string;
  authFile: string;
}

export type PiAccountProfileOwnershipGuard = (
  profile: PiAccountProfile,
) => boolean | Promise<boolean>;

export interface DeletePiAccountCredentialProfileOptions {
  ownershipGuard?: PiAccountProfileOwnershipGuard;
}

/** Process-local lease for OAuth implementations that bind fixed callback ports. */
export class PiOAuthLoginGate {
  private activeRequestId: string | null = null;

  acquire(requestId: string): () => void {
    if (!requestId) throw new TypeError("OAuth request id cannot be empty");
    if (this.activeRequestId !== null) {
      throw new Error("Another Pi subscription login is already in progress");
    }
    this.activeRequestId = requestId;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.activeRequestId === requestId) this.activeRequestId = null;
    };
  }

  active(): boolean {
    return this.activeRequestId !== null;
  }
}

function providerFrom(value: unknown): PiSubscriptionProvider {
  if (isPiSubscriptionProvider(value)) return value;
  throw new TypeError("Unsupported Pi subscription provider");
}

function profileIdFrom(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError("Pi account profile id must be a lowercase UUIDv4");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOAuthCredential(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0;
}

function safeStatusError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "Subscription credentials are missing.";
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([?&#](?:code|state|access_token|refresh_token)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9._-]{20,})\b/g, "[redacted]")
    .slice(0, 300);
}

function defaultCodaraHome(): string {
  const override =
    process.env.CODARA_HOME_DIR ??
    process.env.SPARK_HOME_DIR ??
    process.env.SPARK_USER_DATA_DIR;
  return override?.trim() || join(homedir(), ".Codara");
}

export function codaraPiAccountRootDir(): string {
  return join(defaultCodaraHome(), "pi-agent");
}

export function piAccountProfilePaths(
  piRootDir: string,
  rawProfileId: string,
): { configDir: string; authFile: string } {
  const profileId = profileIdFrom(rawProfileId);
  const accountsDir = resolve(piRootDir, PI_ACCOUNT_AUTH_DIRECTORY);
  const configDir = resolve(accountsDir, profileId);
  if (dirname(configDir) !== accountsDir || basename(configDir) !== profileId) {
    throw new Error("Pi account profile path escaped the account directory");
  }
  return { configDir, authFile: join(configDir, PI_ACCOUNT_AUTH_FILE) };
}

function legacyPaths(piRootDir: string): { configDir: string; authFile: string } {
  const configDir = resolve(piRootDir);
  return { configDir, authFile: join(configDir, PI_ACCOUNT_AUTH_FILE) };
}

async function withMutationLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(rootDir);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  mutationTails.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === queued) mutationTails.delete(key);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(path, 0o700);
}

async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, path);
    if (process.platform !== "win32") await fs.chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  const stats = await fs.stat(path).catch(() => null);
  if (!stats) return null;
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Pi subscription auth must not be readable by group or other users");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    // JSON.parse may quote token fragments. Never propagate its error.
    throw new Error("Pi subscription auth store is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Pi subscription auth store must contain an object");
  return parsed;
}

/**
 * Unsalted sha256 of the vendor account id. Unsalted deliberately: the native
 * Codex CLI reads the same ChatGPT account id out of its own credential file
 * and hashes it the same way, and Settings pairs the two accounts by comparing
 * the digests.
 *
 * Anthropic credentials hold no account id, so nothing can be derived from a
 * stored one here. Their digest is captured once while a login is finishing —
 * see connectTimeIdentityFingerprint in pi-subscription-auth.ts — and lives on
 * the registry profile from then on.
 */
function identityFingerprint(
  provider: PiSubscriptionProvider,
  credential: Record<string, unknown>,
): string | undefined {
  if (provider === "openai-codex") {
    const accountId =
      typeof credential.accountId === "string"
        ? credential.accountId
        : typeof credential.account_id === "string"
          ? credential.account_id
          : null;
    return accountId
      ? createHash("sha256").update(accountId).digest("hex")
      : undefined;
  }
  if (provider === "xai") {
    const subject =
      jwtSubjectClaim(credential.access) ??
      (typeof credential.accountId === "string" ? credential.accountId : null) ??
      (typeof credential.account_id === "string" ? credential.account_id : null);
    return subject ? createHash("sha256").update(subject).digest("hex") : undefined;
  }
  return undefined;
}

/**
 * The address inside a Codex credential's OpenID claims. Codex's access token
 * is the JWT its own CLI already reads the account id out of; the `email` claim
 * is taken from it for display and nothing else. No signature is checked, no
 * other claim is kept, and the token never leaves this process.
 *
 * Anthropic credentials are opaque tokens with no claims to read, so their
 * address is captured from the OAuth profile endpoint while the login finishes
 * — see connectTimeIdentity in pi-subscription-auth.ts.
 */
function credentialAccountEmail(
  provider: PiSubscriptionProvider,
  credential: Record<string, unknown>,
): string | undefined {
  if (provider !== "openai-codex" && provider !== "xai") return undefined;
  return (
    jwtEmailClaim(credential.idToken) ??
    jwtEmailClaim(credential.id_token) ??
    jwtEmailClaim(credential.access)
  );
}

function sameOAuthCredential(left: unknown, right: unknown): boolean {
  if (!isOAuthCredential(left) || !isOAuthCredential(right)) return false;
  return left.access === right.access &&
    left.refresh === right.refresh &&
    left.expires === right.expires;
}

export function piAccountCredentialIdentityFingerprint(
  provider: PiSubscriptionProvider,
  credential: unknown,
): string | undefined {
  providerFrom(provider);
  if (!isOAuthCredential(credential)) {
    throw new TypeError("Pi account credential must be an OAuth credential");
  }
  return identityFingerprint(provider, credential);
}

/** Display-only account address carried by a freshly issued credential. */
export function piAccountCredentialAccountEmail(
  provider: PiSubscriptionProvider,
  credential: unknown,
): string | undefined {
  providerFrom(provider);
  if (!isOAuthCredential(credential)) {
    throw new TypeError("Pi account credential must be an OAuth credential");
  }
  return credentialAccountEmail(provider, credential);
}

function defaultProfileLabel(provider: PiSubscriptionProvider): string {
  return familyForSubscription(provider).planLabel;
}

async function inspectProfileStatus(
  rootDir: string,
  profile: PiAccountProfile,
): Promise<PiAccountProfileAuthStatus> {
  const { authFile } = piAccountProfilePaths(rootDir, profile.id);
  try {
    const stored = await readJsonObject(authFile);
    if (!stored || Object.keys(stored).some((key) => key !== profile.provider)) {
      throw new Error("Pi account auth store contains credentials for the wrong provider");
    }
    const status = await inspectPiSubscriptionAuth(authFile, profile.provider);
    const credential = stored[profile.provider];
    const fingerprint = isOAuthCredential(credential)
      ? identityFingerprint(profile.provider, credential)
      : undefined;
    const email = isOAuthCredential(credential)
      ? credentialAccountEmail(profile.provider, credential)
      : undefined;
    return {
      profileId: profile.id,
      provider: profile.provider,
      connected: true,
      expired: status.expired,
      canRefresh: status.canRefresh,
      expiresAt: status.expiresAt,
      ...(fingerprint ? { accountFingerprint: fingerprint } : {}),
      ...(email ? { accountEmail: email } : {}),
    };
  } catch (error) {
    return {
      profileId: profile.id,
      provider: profile.provider,
      connected: false,
      expired: false,
      canRefresh: false,
      expiresAt: null,
      error: safeStatusError(error),
    };
  }
}

async function migrateLegacyAuthLocked(
  rootDir: string,
  registry: PiAccountProfileRegistry,
): Promise<string[]> {
  const legacy = legacyPaths(rootDir);
  const parsed = await readJsonObject(legacy.authFile);
  if (!parsed) return [];

  const supported = SUPPORTED_PROVIDERS.filter((provider) =>
    isOAuthCredential(parsed[provider]),
  );
  if (supported.length === 0) return [];

  const migratedProfileIds: string[] = [];
  for (const provider of supported) {
    const credential = parsed[provider] as Record<string, unknown>;
    const fingerprint = identityFingerprint(provider, credential);
    const snapshot = await registry.snapshot();
    const providerProfiles = snapshot.profiles.filter((profile) => profile.provider === provider);
    let profile = fingerprint
      ? providerProfiles.find((entry) => entry.identityFingerprint === fingerprint)
      : undefined;
    if (!profile && !fingerprint) {
      // Anthropic exposes no stable account identity. Exact credential equality
      // identifies a retry after a crash; otherwise only reuse a disconnected
      // default. Never retire a second legacy account into an unrelated live
      // profile merely because both belong to Anthropic.
      for (const candidate of providerProfiles) {
        const candidateAuth = await readJsonObject(
          piAccountProfilePaths(rootDir, candidate.id).authFile,
        ).catch(() => null);
        if (sameOAuthCredential(candidateAuth?.[provider], credential)) {
          profile = candidate;
          break;
        }
      }
      if (!profile && snapshot.defaults[provider]) {
        const candidate = providerProfiles.find(
          (entry) => entry.id === snapshot.defaults[provider],
        );
        if (candidate) {
          const candidateStatus = await inspectProfileStatus(rootDir, candidate);
          if (!candidateStatus.connected) profile = candidate;
        }
      }
    }
    if (!profile) {
      profile = (await registry.registerProfile({
        provider,
        label: defaultProfileLabel(provider),
        ...(fingerprint ? { identityFingerprint: fingerprint } : {}),
      })).profile;
    }

    const target = piAccountProfilePaths(rootDir, profile.id);
    const existing = await inspectProfileStatus(rootDir, profile);
    if (!existing.connected) {
      await writePrivateJsonAtomic(target.authFile, { [provider]: credential });
    }
    // Validate the committed copy before retiring this provider from legacy.
    await inspectPiSubscriptionAuth(target.authFile, provider);
    migratedProfileIds.push(profile.id);
  }

  const remaining = { ...parsed };
  for (const provider of supported) delete remaining[provider];
  if (Object.keys(remaining).length === 0) {
    await fs.rm(legacy.authFile, { force: true });
  } else {
    await writePrivateJsonAtomic(legacy.authFile, remaining);
  }
  return migratedProfileIds;
}

async function reconcileDeletingDirectoriesLocked(
  rootDir: string,
  snapshot: PiAccountProfilesSnapshot,
): Promise<void> {
  const accountsDir = join(resolve(rootDir), PI_ACCOUNT_AUTH_DIRECTORY);
  const names = await fs.readdir(accountsDir).catch(() => [] as string[]);
  const profileIds = new Set(snapshot.profiles.map((profile) => profile.id));
  for (const name of names) {
    const match = /^\.([0-9a-f-]{36})\.deleting-[0-9a-f]+$/.exec(name);
    if (!match || !PROFILE_ID_PATTERN.test(match[1])) continue;
    const staged = join(accountsDir, name);
    const original = join(accountsDir, match[1]);
    if (profileIds.has(match[1])) {
      const originalExists = await fs.stat(original).then(() => true).catch(() => false);
      if (!originalExists) await fs.rename(staged, original);
    } else {
      await fs.rm(staged, { recursive: true, force: true });
    }
  }
}

export class PiAccountAuthStore {
  readonly rootDir: string;
  readonly registry: PiAccountProfileRegistry;

  constructor(rootDir: string, registry?: PiAccountProfileRegistry) {
    this.rootDir = resolve(rootDir);
    this.registry = registry ?? new PiAccountProfileRegistry(this.rootDir);
  }

  async inspect(): Promise<PiAccountAuthInspection> {
    return withMutationLock(this.rootDir, async () => {
      await ensurePrivateDirectory(this.rootDir);
      await ensurePrivateDirectory(join(this.rootDir, PI_ACCOUNT_AUTH_DIRECTORY));
      let snapshot = await this.registry.snapshot();
      await reconcileDeletingDirectoriesLocked(this.rootDir, snapshot);
      const migratedProfileIds = await migrateLegacyAuthLocked(this.rootDir, this.registry);
      snapshot = await this.registry.snapshot();
      const statuses = await Promise.all(
        snapshot.profiles.map((profile) => inspectProfileStatus(this.rootDir, profile)),
      );
      const missingCredentialProfileIds = statuses
        .filter((status) => !status.connected)
        .map((status) => status.profileId);
      const registeredIds = new Set(snapshot.profiles.map((profile) => profile.id));
      const accountNames = await fs.readdir(
        join(this.rootDir, PI_ACCOUNT_AUTH_DIRECTORY),
        { withFileTypes: true },
      ).catch(() => [] as import("node:fs").Dirent[]);
      const orphanCredentialProfileIds = accountNames
        .filter((entry) =>
          entry.isDirectory() &&
          PROFILE_ID_PATTERN.test(entry.name) &&
          !registeredIds.has(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
      return {
        snapshot,
        statuses,
        reconciliation: {
          migratedProfileIds: [...new Set(migratedProfileIds)],
          missingCredentialProfileIds,
          orphanCredentialProfileIds,
        },
      };
    });
  }

  async resolve(
    input: ResolvePiAccountRuntimeProfileInput,
  ): Promise<PiAccountRuntimeProfile> {
    const provider = providerFrom(input.provider);
    const inspection = await this.inspect();
    const preferred = input.preferredAccountProfileId
      ? profileIdFrom(input.preferredAccountProfileId)
      : null;
    if (input.requirePreferred && !preferred) {
      throw new Error("An explicit Pi account profile is required");
    }

    let profile: PiAccountProfile | undefined;
    if (preferred) {
      profile = inspection.snapshot.profiles.find((entry) => entry.id === preferred);
      if (!profile) throw new Error(`Pi account profile not found: ${preferred}`);
      if (profile.provider !== provider) {
        throw new Error(`Pi account profile ${preferred} does not belong to provider ${provider}`);
      }
      const status = inspection.statuses.find((entry) => entry.profileId === preferred);
      if (!status?.connected) {
        throw new Error(`Pi account profile ${preferred} is not connected`);
      }
    } else {
      const defaultId = inspection.snapshot.defaults[provider];
      const connectedIds = new Set(
        inspection.statuses
          .filter((status) => status.provider === provider && status.connected)
          .map((status) => status.profileId),
      );
      profile = inspection.snapshot.profiles.find(
        (entry) => entry.id === defaultId && connectedIds.has(entry.id),
      );
      profile ??= inspection.snapshot.profiles.find(
        (entry) => entry.provider === provider && connectedIds.has(entry.id),
      );
    }

    if (!profile) return legacyPaths(this.rootDir);
    return {
      accountProfileId: profile.id,
      profile,
      ...piAccountProfilePaths(this.rootDir, profile.id),
    };
  }

  async prepareCredentialTarget(
    input: PreparePiAccountCredentialTargetInput,
  ): Promise<PreparedPiAccountCredentialTarget> {
    const provider = providerFrom(input.provider);
    const inspection = await this.inspect();
    if (input.profileId) {
      const profileId = profileIdFrom(input.profileId);
      const profile = await this.registry.getProfile(profileId);
      if (!profile) throw new Error(`Pi account profile not found: ${profileId}`);
      if (profile.provider !== provider) {
        throw new Error(`Pi account profile ${profileId} does not belong to provider ${provider}`);
      }
      if (
        profile.identityFingerprint &&
        input.identityFingerprint &&
        profile.identityFingerprint !== input.identityFingerprint
      ) {
        throw new Error("This login belongs to a different account. Use Add account instead.");
      }
      // A profile with no digest of its own cannot vouch for who just signed
      // in — but another profile of the same provider already holding this
      // digest can. Accepting it here would file one account's credential
      // under a second, mislabelled profile, so say whose sign-in it is.
      if (!profile.identityFingerprint && input.identityFingerprint) {
        const claimed = inspection.snapshot.profiles.find(
          (entry) =>
            entry.id !== profile.id &&
            entry.provider === provider &&
            entry.identityFingerprint === input.identityFingerprint,
        );
        if (claimed) {
          throw new Error(
            `This sign-in belongs to ${claimed.label}, which is already connected. ` +
              `Reconnect that account instead, or delete it first.`,
          );
        }
      }
      // An Anthropic account connected before Codara could identify it has no
      // digest yet. Reconnecting is the next moment one is available, so record
      // it then — that is what lets an older account merge with its Claude Code
      // sign-in without the user doing anything but reconnecting.
      let stamped =
        !profile.identityFingerprint && input.identityFingerprint
          ? await this.registry.recordIdentityFingerprint(
              profile.id,
              input.identityFingerprint,
            )
          : profile;
      // The address is display metadata, so unlike the digest it is refreshed
      // whenever a login reports a different one.
      if (input.accountEmail && stamped.accountEmail !== input.accountEmail) {
        stamped = await this.registry.recordAccountEmail(
          profile.id,
          input.accountEmail,
        );
      }
      if (input.makeDefault) await this.registry.setDefaultProfile(provider, profile.id);
      return {
        profile: stamped,
        created: false,
        ...piAccountProfilePaths(this.rootDir, profile.id),
      };
    }

    const registered = await this.registry.registerProfile({
      provider,
      label: input.label?.trim() || defaultProfileLabel(provider),
      ...(input.identityFingerprint ? { identityFingerprint: input.identityFingerprint } : {}),
      ...(input.accountEmail ? { accountEmail: input.accountEmail } : {}),
      ...(input.makeDefault ? { makeDefault: true } : {}),
    });
    return {
      profile: registered.profile,
      created: registered.created,
      ...piAccountProfilePaths(this.rootDir, registered.profile.id),
    };
  }

  async renameProfile(profileId: string, label: string): Promise<PiAccountProfile> {
    await this.inspect();
    return this.registry.renameProfile(profileIdFrom(profileId), label);
  }

  async setDefaultProfile(
    provider: PiSubscriptionProvider,
    profileId: string,
  ): Promise<PiAccountProfilesSnapshot> {
    await this.inspect();
    return this.registry.setDefaultProfile(providerFrom(provider), profileIdFrom(profileId));
  }

  async deleteProfile(
    rawProfileId: string,
    options: DeletePiAccountCredentialProfileOptions = {},
  ): Promise<PiAccountProfilesSnapshot> {
    const profileId = profileIdFrom(rawProfileId);
    return withMutationLock(this.rootDir, async () => {
      const profile = await this.registry.getProfile(profileId);
      if (!profile) return this.registry.snapshot();
      if (await options.ownershipGuard?.(profile)) {
        throw new PiAccountProfileProtectedError(profileId);
      }
      const { configDir } = piAccountProfilePaths(this.rootDir, profileId);
      const staged = join(
        dirname(configDir),
        `.${profileId}.deleting-${randomBytes(6).toString("hex")}`,
      );
      const exists = await fs.stat(configDir).then(() => true).catch(() => false);
      if (exists) await fs.rename(configDir, staged);
      try {
        const result = await this.registry.deleteProfile(profileId, {
          protectedProfileIds: options.ownershipGuard ? [] : undefined,
        });
        await fs.rm(staged, { recursive: true, force: true });
        return result.snapshot;
      } catch (error) {
        if (exists) await fs.rename(staged, configDir).catch(() => undefined);
        throw error;
      }
    });
  }
}

let defaultStore: PiAccountAuthStore | null = null;

export function defaultPiAccountAuthStore(): PiAccountAuthStore {
  const rootDir = codaraPiAccountRootDir();
  if (!defaultStore || defaultStore.rootDir !== resolve(rootDir)) {
    defaultStore = new PiAccountAuthStore(rootDir);
  }
  return defaultStore;
}

export function inspectPiAccountProfileAuthStore(): Promise<PiAccountAuthInspection> {
  return defaultPiAccountAuthStore().inspect();
}

export function resolvePiAccountRuntimeProfile(
  input: ResolvePiAccountRuntimeProfileInput,
): Promise<PiAccountRuntimeProfile> {
  return defaultPiAccountAuthStore().resolve(input);
}

export function preparePiAccountCredentialTarget(
  input: PreparePiAccountCredentialTargetInput,
): Promise<PreparedPiAccountCredentialTarget> {
  return defaultPiAccountAuthStore().prepareCredentialTarget(input);
}

export function renamePiAccountProfile(
  profileId: string,
  label: string,
): Promise<PiAccountProfile> {
  return defaultPiAccountAuthStore().renameProfile(profileId, label);
}

export function setDefaultPiAccountProfile(
  provider: PiSubscriptionProvider,
  profileId: string,
): Promise<PiAccountProfilesSnapshot> {
  return defaultPiAccountAuthStore().setDefaultProfile(provider, profileId);
}

export function deletePiAccountCredentialProfile(
  profileId: string,
  options?: DeletePiAccountCredentialProfileOptions,
): Promise<PiAccountProfilesSnapshot> {
  return defaultPiAccountAuthStore().deleteProfile(profileId, options);
}
