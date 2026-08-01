import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";

// Metadata-only account profile registry.
//
// This module deliberately does not read, accept, or persist OAuth credentials.
// A future auth integration can use a profile's opaque UUID to choose a private
// credential directory, while this file remains safe to expose through a
// sanitized settings/RPC surface.

export const PI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const PI_ACCOUNT_PROFILES_VERSION = 1 as const;
export const PI_ACCOUNT_PROFILE_LABEL_MAX_LENGTH = 80;
/** RFC 5321 caps an address at 254 characters; anything longer is not one. */
export const PI_ACCOUNT_EMAIL_MAX_LENGTH = 254;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROVIDERS = new Set<PiSubscriptionProvider>(["anthropic", "openai-codex"]);
const PROFILE_KEYS = new Set([
  "id",
  "provider",
  "label",
  "createdAt",
  "updatedAt",
  "identityFingerprint",
  "accountEmail",
]);
const ROOT_KEYS = new Set(["version", "profiles", "defaults"]);
const DEFAULT_KEYS = new Set<PiSubscriptionProvider>(["anthropic", "openai-codex"]);
const MAX_ID_GENERATION_ATTEMPTS = 32;

export interface PiAccountProfile {
  /** Random UUIDv4. It is never derived from an email, vendor id, or label. */
  id: string;
  provider: PiSubscriptionProvider;
  label: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Optional caller-produced SHA-256 fingerprint of a stable, non-secret
   * provider account identity. The raw identity is never persisted here.
   */
  identityFingerprint?: string;
  /**
   * The account's email address, captured while a login finished, so Settings
   * can say which login a card is. It is display metadata, never a routing or
   * matching key — profiles are still identified by id and paired by
   * identityFingerprint — and it is stripped from every remote projection.
   */
  accountEmail?: string;
}

export type PiAccountProfileDefaults = Partial<Record<PiSubscriptionProvider, string>>;

export interface PiAccountProfilesSnapshot {
  version: typeof PI_ACCOUNT_PROFILES_VERSION;
  profiles: PiAccountProfile[];
  defaults: PiAccountProfileDefaults;
}

export interface RegisterPiAccountProfileInput {
  provider: PiSubscriptionProvider;
  label: string;
  /**
   * Optional lowercase SHA-256 hex. Within one provider, registering the same
   * fingerprint is idempotent and returns the existing profile.
   */
  identityFingerprint?: string;
  /** Optional account email for display. See PiAccountProfile.accountEmail. */
  accountEmail?: string;
  /** New profiles become the provider default when none exists. */
  makeDefault?: boolean;
}

export interface RegisterPiAccountProfileResult {
  profile: PiAccountProfile;
  created: boolean;
  snapshot: PiAccountProfilesSnapshot;
}

export interface DeletePiAccountProfileOptions {
  /**
   * IDs with a live manager/worker owner. Deleting one throws before any disk
   * mutation, so the integration must explicitly stop or rotate those owners.
   */
  protectedProfileIds?: ReadonlySet<string> | readonly string[];
}

export interface DeletePiAccountProfileResult {
  deleted: boolean;
  snapshot: PiAccountProfilesSnapshot;
}

export interface PiAccountProfileRegistryOptions {
  /** Test seam; production callers should leave this unset. */
  idFactory?: () => string;
  /** Test seam; production callers should leave this unset. */
  now?: () => Date;
}

/**
 * Sanitized routing input. It contains no token, account id, email, provider
 * error body, or usage history—only the minimum signal needed for selection.
 */
export interface PiAccountSanitizedHeadroom {
  profileId: string;
  /** False for disconnected, expired, disabled, or otherwise unusable auth. */
  available: boolean;
  limitReached: boolean;
  /** Conservative remaining percentage, or null when usage is unknown. */
  headroomPercent: number | null;
}

export interface PiAccountCandidate {
  profile: PiAccountProfile;
  headroomPercent: number | null;
}

export interface RankPiAccountCandidatesOptions {
  /**
   * An explicit per-run/per-turn pin. It wins while eligible, regardless of
   * headroom. If it is unavailable or limited, normal ranking resumes.
   */
  preferredProfileId?: string | null;
}

export class PiAccountProfilesCorruptError extends Error {
  constructor(message: string) {
    super(`Invalid Pi account profile registry: ${message}`);
    this.name = "PiAccountProfilesCorruptError";
  }
}

export class PiAccountProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Pi account profile not found: ${profileId}`);
    this.name = "PiAccountProfileNotFoundError";
  }
}

export class PiAccountProfileProtectedError extends Error {
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Pi account profile is active and cannot be deleted: ${profileId}`);
    this.name = "PiAccountProfileProtectedError";
    this.profileId = profileId;
  }
}

export class PiAccountProfileIdCollisionError extends Error {
  constructor() {
    super(
      `Unable to allocate a unique Pi account profile id after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
    );
    this.name = "PiAccountProfileIdCollisionError";
  }
}

const mutationTails = new Map<string, Promise<void>>();

function emptySnapshot(): PiAccountProfilesSnapshot {
  return {
    version: PI_ACCOUNT_PROFILES_VERSION,
    profiles: [],
    defaults: {},
  };
}

function cloneProfile(profile: PiAccountProfile): PiAccountProfile {
  return { ...profile };
}

function cloneSnapshot(snapshot: PiAccountProfilesSnapshot): PiAccountProfilesSnapshot {
  return {
    version: snapshot.version,
    profiles: snapshot.profiles.map(cloneProfile),
    defaults: { ...snapshot.defaults },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new PiAccountProfilesCorruptError(`${context} contains unexpected field "${unexpected}"`);
  }
}

function isProvider(value: unknown): value is PiSubscriptionProvider {
  return typeof value === "string" && PROVIDERS.has(value as PiSubscriptionProvider);
}

function assertProfileId(value: unknown, context = "profile id"): asserts value is string {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new PiAccountProfilesCorruptError(`${context} must be a lowercase UUIDv4`);
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Account profile label must be a string");
  const label = value.trim();
  if (!label) throw new TypeError("Account profile label cannot be empty");
  if (label.length > PI_ACCOUNT_PROFILE_LABEL_MAX_LENGTH) {
    throw new TypeError(
      `Account profile label cannot exceed ${PI_ACCOUNT_PROFILE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    throw new TypeError("Account profile label cannot contain control characters");
  }
  return label;
}

function assertCanonicalTimestamp(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string") {
    throw new PiAccountProfilesCorruptError(`${context} must be an ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new PiAccountProfilesCorruptError(`${context} must be a canonical ISO timestamp`);
  }
}

function normalizeIdentityFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !IDENTITY_FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError("Account identity fingerprint must be lowercase SHA-256 hex");
  }
  return value;
}

/**
 * A stored email only has to be safe to render: a bounded single-line string.
 * A file that carries anything else is corrupt rather than silently trimmed.
 */
function normalizeAccountEmail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("Account email must be a string");
  }
  const email = value.trim();
  if (email !== value) throw new TypeError("Account email must already be trimmed");
  if (email.length < 3 || email.length > PI_ACCOUNT_EMAIL_MAX_LENGTH) {
    throw new TypeError(
      `Account email must be between 3 and ${PI_ACCOUNT_EMAIL_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(email)) {
    throw new TypeError("Account email cannot contain control characters");
  }
  if (!email.includes("@")) throw new TypeError("Account email must contain @");
  return email;
}

function parseSnapshot(value: unknown): PiAccountProfilesSnapshot {
  if (!isRecord(value)) throw new PiAccountProfilesCorruptError("root must be an object");
  assertOnlyKeys(value, ROOT_KEYS, "root");
  if (value.version !== PI_ACCOUNT_PROFILES_VERSION) {
    throw new PiAccountProfilesCorruptError(
      `unsupported version ${String(value.version)} (expected ${PI_ACCOUNT_PROFILES_VERSION})`,
    );
  }
  if (!Array.isArray(value.profiles)) {
    throw new PiAccountProfilesCorruptError("profiles must be an array");
  }
  if (!isRecord(value.defaults)) {
    throw new PiAccountProfilesCorruptError("defaults must be an object");
  }
  assertOnlyKeys(value.defaults, DEFAULT_KEYS, "defaults");

  const profiles: PiAccountProfile[] = [];
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new PiAccountProfilesCorruptError(`profiles[${index}] must be an object`);
    }
    assertOnlyKeys(raw, PROFILE_KEYS, `profiles[${index}]`);
    assertProfileId(raw.id, `profiles[${index}].id`);
    if (ids.has(raw.id)) {
      throw new PiAccountProfilesCorruptError(`duplicate profile id "${raw.id}"`);
    }
    if (!isProvider(raw.provider)) {
      throw new PiAccountProfilesCorruptError(`profiles[${index}].provider is unsupported`);
    }
    let label: string;
    try {
      label = normalizeLabel(raw.label);
    } catch (error) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].label is invalid: ${(error as Error).message}`,
      );
    }
    if (label !== raw.label) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].label must already be trimmed`,
      );
    }
    assertCanonicalTimestamp(raw.createdAt, `profiles[${index}].createdAt`);
    assertCanonicalTimestamp(raw.updatedAt, `profiles[${index}].updatedAt`);
    if (raw.updatedAt < raw.createdAt) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].updatedAt cannot precede createdAt`,
      );
    }

    let identityFingerprint: string | undefined;
    try {
      identityFingerprint = normalizeIdentityFingerprint(raw.identityFingerprint);
    } catch (error) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].identityFingerprint is invalid: ${(error as Error).message}`,
      );
    }
    let accountEmail: string | undefined;
    try {
      accountEmail = normalizeAccountEmail(raw.accountEmail);
    } catch (error) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].accountEmail is invalid: ${(error as Error).message}`,
      );
    }
    if (identityFingerprint) {
      const dedupeIdentity = `${raw.provider}:${identityFingerprint}`;
      if (fingerprints.has(dedupeIdentity)) {
        throw new PiAccountProfilesCorruptError(
          `duplicate identity fingerprint for provider "${raw.provider}"`,
        );
      }
      fingerprints.add(dedupeIdentity);
    }
    ids.add(raw.id);
    profiles.push({
      id: raw.id,
      provider: raw.provider,
      label,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(identityFingerprint ? { identityFingerprint } : {}),
      ...(accountEmail ? { accountEmail } : {}),
    });
  }

  const defaults: PiAccountProfileDefaults = {};
  for (const provider of PROVIDERS) {
    const profileId = value.defaults[provider];
    if (profileId === undefined) continue;
    assertProfileId(profileId, `defaults.${provider}`);
    const profile = profiles.find((entry) => entry.id === profileId);
    if (!profile || profile.provider !== provider) {
      throw new PiAccountProfilesCorruptError(
        `defaults.${provider} must reference a ${provider} profile`,
      );
    }
    defaults[provider] = profileId;
  }

  return {
    version: PI_ACCOUNT_PROFILES_VERSION,
    profiles,
    defaults,
  };
}

async function readSnapshotFromDisk(filePath: string): Promise<PiAccountProfilesSnapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseSnapshot(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySnapshot();
    if (error instanceof PiAccountProfilesCorruptError) throw error;
    if (error instanceof SyntaxError) {
      throw new PiAccountProfilesCorruptError(`file is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function persistSnapshotAtomically(
  rootDir: string,
  filePath: string,
  snapshot: PiAccountProfilesSnapshot,
): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    rootDir,
    `.${PI_ACCOUNT_PROFILES_FILE}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    // "wx" prevents a random-name collision from opening an existing file.
    // Explicit 0600 also protects the temporary inode before its atomic rename.
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, 0o600);

    // Best-effort directory fsync makes the rename durable on filesystems that
    // support opening directories. Windows and some network filesystems do not.
    try {
      const directory = await fs.open(rootDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file contents and rename are still atomic.
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function withMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = mutationTails.get(filePath) ?? Promise.resolve();
  const result = predecessor.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(filePath, tail);
  try {
    return await result;
  } finally {
    if (mutationTails.get(filePath) === tail) mutationTails.delete(filePath);
  }
}

function nextDefaultAfterDeletion(
  profiles: PiAccountProfile[],
  provider: PiSubscriptionProvider,
): string | undefined {
  return profiles
    .filter((profile) => profile.provider === provider)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    ?.id;
}

function assertProvider(provider: unknown): asserts provider is PiSubscriptionProvider {
  if (!isProvider(provider)) throw new TypeError(`Unsupported account provider: ${String(provider)}`);
}

/**
 * Pure, deterministic candidate ranking. Only profiles with an explicit
 * available, non-limited signal are eligible. Missing/unknown usage sorts
 * behind known usage but remains selectable as a safe degradation path.
 */
export function rankPiAccountCandidates(
  snapshot: PiAccountProfilesSnapshot,
  provider: PiSubscriptionProvider,
  headroom: readonly PiAccountSanitizedHeadroom[],
  options: RankPiAccountCandidatesOptions = {},
): PiAccountCandidate[] {
  assertProvider(provider);
  const byProfile = new Map<string, PiAccountSanitizedHeadroom>();
  for (const signal of headroom) {
    assertProfileId(signal.profileId, "headroom profileId");
    if (byProfile.has(signal.profileId)) {
      throw new TypeError(`Duplicate headroom signal for profile ${signal.profileId}`);
    }
    if (
      signal.headroomPercent !== null &&
      (!Number.isFinite(signal.headroomPercent) ||
        signal.headroomPercent < 0 ||
        signal.headroomPercent > 100)
    ) {
      throw new TypeError(
        `Headroom for profile ${signal.profileId} must be null or between 0 and 100`,
      );
    }
    if (typeof signal.available !== "boolean" || typeof signal.limitReached !== "boolean") {
      throw new TypeError(`Headroom flags for profile ${signal.profileId} must be boolean`);
    }
    byProfile.set(signal.profileId, signal);
  }

  const preferredProfileId = options.preferredProfileId ?? null;
  if (preferredProfileId !== null) {
    assertProfileId(preferredProfileId, "preferred profileId");
  }
  const defaultProfileId = snapshot.defaults[provider] ?? null;

  return snapshot.profiles
    .filter((profile) => profile.provider === provider)
    .flatMap((profile): PiAccountCandidate[] => {
      const signal = byProfile.get(profile.id);
      if (!signal || !signal.available || signal.limitReached) return [];
      return [{ profile: cloneProfile(profile), headroomPercent: signal.headroomPercent }];
    })
    // Effective precedence:
    //   explicit pin → user's active account → known headroom → higher
    //   headroom → createdAt
    // The comparator's own keys are pin → known headroom → higher headroom →
    // provider default → createdAt. The active account occupies the pin slot
    // rather than a separate one: the implicit router passes
    // snapshot.defaults[provider] as preferredProfileId, which is why the
    // account the user marked Active in Settings outranks a rival with more
    // cached headroom (the provider-default key below then never decides
    // anything for that caller). One live login at a time is the model the
    // Active badge promises, so the user's pick must win.
    // Failover still works because only usable accounts reach this comparator:
    // the filter above already dropped disconnected and limit-reached
    // profiles, so an exhausted active account falls out and headroom decides
    // the fallback.
    .sort((left, right) => {
      const leftPreferred = left.profile.id === preferredProfileId;
      const rightPreferred = right.profile.id === preferredProfileId;
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;

      const leftKnown = left.headroomPercent !== null;
      const rightKnown = right.headroomPercent !== null;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (
        left.headroomPercent !== null &&
        right.headroomPercent !== null &&
        left.headroomPercent !== right.headroomPercent
      ) {
        return right.headroomPercent - left.headroomPercent;
      }

      const leftDefault = left.profile.id === defaultProfileId;
      const rightDefault = right.profile.id === defaultProfileId;
      if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
      return (
        left.profile.createdAt.localeCompare(right.profile.createdAt) ||
        left.profile.id.localeCompare(right.profile.id)
      );
    });
}

export function selectPiAccountCandidate(
  snapshot: PiAccountProfilesSnapshot,
  provider: PiSubscriptionProvider,
  headroom: readonly PiAccountSanitizedHeadroom[],
  options: RankPiAccountCandidatesOptions = {},
): PiAccountCandidate | null {
  return rankPiAccountCandidates(snapshot, provider, headroom, options)[0] ?? null;
}

export class PiAccountProfileRegistry {
  readonly rootDir: string;
  readonly filePath: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(rootDir: string, options: PiAccountProfileRegistryOptions = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Pi account profile root must be a non-empty path");
    }
    this.rootDir = resolve(rootDir);
    this.filePath = join(this.rootDir, PI_ACCOUNT_PROFILES_FILE);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(): Promise<PiAccountProfilesSnapshot> {
    return cloneSnapshot(await readSnapshotFromDisk(this.filePath));
  }

  async listProfiles(provider?: PiSubscriptionProvider): Promise<PiAccountProfile[]> {
    if (provider !== undefined) assertProvider(provider);
    const snapshot = await readSnapshotFromDisk(this.filePath);
    return snapshot.profiles
      .filter((profile) => provider === undefined || profile.provider === provider)
      .map(cloneProfile);
  }

  async getProfile(profileId: string): Promise<PiAccountProfile | null> {
    assertProfileId(profileId);
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profile = snapshot.profiles.find((entry) => entry.id === profileId);
    return profile ? cloneProfile(profile) : null;
  }

  async getDefaultProfile(
    provider: PiSubscriptionProvider,
  ): Promise<PiAccountProfile | null> {
    assertProvider(provider);
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const defaultId = snapshot.defaults[provider];
    const profile = defaultId
      ? snapshot.profiles.find((entry) => entry.id === defaultId)
      : undefined;
    return profile ? cloneProfile(profile) : null;
  }

  async registerProfile(
    input: RegisterPiAccountProfileInput,
  ): Promise<RegisterPiAccountProfileResult> {
    assertProvider(input.provider);
    const label = normalizeLabel(input.label);
    const identityFingerprint = normalizeIdentityFingerprint(input.identityFingerprint);
    const accountEmail = normalizeAccountEmail(input.accountEmail);
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      if (identityFingerprint) {
        const duplicate = snapshot.profiles.find(
          (profile) =>
            profile.provider === input.provider &&
            profile.identityFingerprint === identityFingerprint,
        );
        if (duplicate) {
          if (input.makeDefault && snapshot.defaults[input.provider] !== duplicate.id) {
            snapshot.defaults[input.provider] = duplicate.id;
            await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
          }
          return {
            profile: cloneProfile(duplicate),
            created: false,
            snapshot: cloneSnapshot(snapshot),
          };
        }
      }

      const existingIds = new Set(snapshot.profiles.map((profile) => profile.id));
      let id: string | null = null;
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        const candidate = this.idFactory();
        assertProfileId(candidate, "generated profile id");
        if (!existingIds.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) throw new PiAccountProfileIdCollisionError();

      const now = this.now().toISOString();
      const profile: PiAccountProfile = {
        id,
        provider: input.provider,
        label,
        createdAt: now,
        updatedAt: now,
        ...(identityFingerprint ? { identityFingerprint } : {}),
        ...(accountEmail ? { accountEmail } : {}),
      };
      snapshot.profiles.push(profile);
      if (!snapshot.defaults[input.provider] || input.makeDefault) {
        snapshot.defaults[input.provider] = profile.id;
      }
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return {
        profile: cloneProfile(profile),
        created: true,
        snapshot: cloneSnapshot(snapshot),
      };
    });
  }

  /**
   * Attach an account digest to a profile that was registered before its
   * provider could report one — the Anthropic case, where the account uuid only
   * becomes available while a login is finishing.
   *
   * It never overwrites and never fails a login: a profile that already carries
   * a digest keeps it, and a digest another profile of the same provider
   * already claims is left alone rather than being duplicated, because the
   * stored file rejects two profiles of one provider sharing an identity. Both
   * cases return the profile unchanged, so the account merely stays unpaired.
   */
  async recordIdentityFingerprint(
    profileId: string,
    fingerprintInput: string,
  ): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const identityFingerprint = normalizeIdentityFingerprint(fingerprintInput);
    if (!identityFingerprint) throw new TypeError("Account identity fingerprint is required");
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.identityFingerprint) return cloneProfile(current);
      const claimed = snapshot.profiles.some(
        (profile) =>
          profile.provider === current.provider &&
          profile.identityFingerprint === identityFingerprint,
      );
      if (claimed) return cloneProfile(current);
      const clockNow = this.now().toISOString();
      const updated: PiAccountProfile = {
        ...current,
        identityFingerprint,
        updatedAt: clockNow > current.updatedAt ? clockNow : current.updatedAt,
      };
      snapshot.profiles[index] = updated;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneProfile(updated);
    });
  }

  /**
   * Record the address a login reported for this account, so the card can say
   * which login it is. Unlike the fingerprint this is not an identity claim, so
   * a later login overwrites it — an account whose address changed upstream
   * should show the new one. Writing the address it already has is a no-op.
   */
  async recordAccountEmail(
    profileId: string,
    emailInput: string,
  ): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const accountEmail = normalizeAccountEmail(emailInput);
    if (!accountEmail) throw new TypeError("Account email is required");
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.accountEmail === accountEmail) return cloneProfile(current);
      const clockNow = this.now().toISOString();
      const updated: PiAccountProfile = {
        ...current,
        accountEmail,
        updatedAt: clockNow > current.updatedAt ? clockNow : current.updatedAt,
      };
      snapshot.profiles[index] = updated;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneProfile(updated);
    });
  }

  async renameProfile(profileId: string, labelInput: string): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const label = normalizeLabel(labelInput);
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.label === label) return cloneProfile(current);
      const clockNow = this.now().toISOString();
      const updated: PiAccountProfile = {
        ...current,
        label,
        // Never move updatedAt backwards when the system clock is corrected.
        updatedAt: clockNow > current.updatedAt ? clockNow : current.updatedAt,
      };
      snapshot.profiles[index] = updated;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneProfile(updated);
    });
  }

  async setDefaultProfile(
    provider: PiSubscriptionProvider,
    profileId: string | null,
  ): Promise<PiAccountProfilesSnapshot> {
    assertProvider(provider);
    if (profileId !== null) assertProfileId(profileId);
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      if (profileId === null) {
        delete snapshot.defaults[provider];
      } else {
        const profile = snapshot.profiles.find((entry) => entry.id === profileId);
        if (!profile) throw new PiAccountProfileNotFoundError(profileId);
        if (profile.provider !== provider) {
          throw new TypeError(`Profile ${profileId} does not belong to provider ${provider}`);
        }
        snapshot.defaults[provider] = profileId;
      }
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  async deleteProfile(
    profileId: string,
    options: DeletePiAccountProfileOptions = {},
  ): Promise<DeletePiAccountProfileResult> {
    assertProfileId(profileId);
    const protectedIds = new Set(options.protectedProfileIds ?? []);
    if (protectedIds.has(profileId)) throw new PiAccountProfileProtectedError(profileId);

    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const target = snapshot.profiles.find((profile) => profile.id === profileId);
      if (!target) return { deleted: false, snapshot: cloneSnapshot(snapshot) };
      snapshot.profiles = snapshot.profiles.filter((profile) => profile.id !== profileId);
      if (snapshot.defaults[target.provider] === profileId) {
        const replacement = nextDefaultAfterDeletion(snapshot.profiles, target.provider);
        if (replacement) snapshot.defaults[target.provider] = replacement;
        else delete snapshot.defaults[target.provider];
      }
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return { deleted: true, snapshot: cloneSnapshot(snapshot) };
    });
  }
}

export function createPiAccountProfileRegistry(
  rootDir: string,
  options: PiAccountProfileRegistryOptions = {},
): PiAccountProfileRegistry {
  return new PiAccountProfileRegistry(rootDir, options);
}
