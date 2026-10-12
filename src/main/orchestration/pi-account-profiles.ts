import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import { PI_SUBSCRIPTION_PROVIDERS } from "../../shared/agent-families";
import { withAccountSelectionLock } from "./account-selection-lock";

// Metadata-only account registry, version 2.
//
// This module deliberately does not read, accept, or persist OAuth credentials.
// A profile's opaque UUID chooses a private credential directory elsewhere,
// while this file remains safe to expose through a sanitized settings/RPC
// surface.
//
// The registry is the only source of accounts. Nothing creates a row from
// what it finds on disk: rows come from an explicit add, from "Use in
// Codara" on the System login offer, or from the one-time v1 migration. A
// delete leaves a tombstone, and a tombstoned identity or CLI profile is
// refused by registerProfile unless the caller says the user explicitly
// added it again, which clears the tombstone in the same write.

export const PI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const PI_ACCOUNT_PROFILES_VERSION = 2 as const;
export const PI_ACCOUNT_PROFILES_LEGACY_VERSION = 1 as const;
export const PI_ACCOUNT_PROFILE_LABEL_MAX_LENGTH = 80;
/** RFC 5321 caps an address at 254 characters; anything longer is not one. */
export const PI_ACCOUNT_EMAIL_MAX_LENGTH = 254;
/** Only the newest tombstones are kept; older deletes are long settled. */
export const PI_ACCOUNT_TOMBSTONE_LIMIT = 500;
export const PI_ACCOUNT_PENDING_PURGE_LIMIT = 200;
/**
 * The CLI profile id the per-CLI stores give the System login: the user's
 * own login in the CLI's own home, which Codara uses by setting no home
 * variable. In memory a System row reports it as its cliProfileId so every
 * CLI-side lookup keeps one key per half; on disk the row says
 * `cli: { kind: "system" }` and the literal is never written.
 */
export const SYSTEM_CLI_PROFILE_ID = "personal";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROVIDERS = new Set<PiSubscriptionProvider>(PI_SUBSCRIPTION_PROVIDERS);
const PROFILE_KEYS = new Set([
  "id",
  "provider",
  "label",
  "createdAt",
  "updatedAt",
  "identityFingerprint",
  "accountEmail",
  "cli",
  "cora",
]);
const LEGACY_PROFILE_KEYS = new Set([
  "id",
  "provider",
  "label",
  "createdAt",
  "updatedAt",
  "identityFingerprint",
  "accountEmail",
  "cliProfileId",
]);
const ROOT_KEYS = new Set([
  "version",
  "profiles",
  "defaults",
  "tombstones",
  "dismissedSystemOffers",
  "pendingPurge",
]);
const LEGACY_ROOT_KEYS = new Set(["version", "profiles", "defaults"]);
const DEFAULT_KEYS = new Set<PiSubscriptionProvider>(PI_SUBSCRIPTION_PROVIDERS);
const CORA_KINDS = new Set<PiAccountCoraHalf>(["linked", "own", "borrowed", "none"]);
const MAX_ID_GENERATION_ATTEMPTS = 32;

/** Where the account's terminals get their login. */
export type PiAccountCliHalf =
  | { kind: "managed"; profileId: string }
  | { kind: "system" }
  | { kind: "none" };

/**
 * Where Cora gets its login: "linked" shares one grant with a managed CLI
 * half (Codara keeps the two copies in step), "own" is an independent grant,
 * "borrowed" is a migrated access token without its refresh token, and
 * "none" means Cora is not connected to this account.
 */
export type PiAccountCoraHalf = "linked" | "own" | "borrowed" | "none";

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
   * matching key, and it is stripped from every remote projection.
   */
  accountEmail?: string;
  cli: PiAccountCliHalf;
  cora: PiAccountCoraHalf;
  /**
   * Derived from `cli`, never stored: the managed profile id, the System
   * login's SYSTEM_CLI_PROFILE_ID, or absent for an account without a
   * terminal half. Within a provider it is unique.
   */
  cliProfileId?: string;
}

export type PiAccountProfileDefaults = Partial<Record<PiSubscriptionProvider, string>>;

export interface PiAccountTombstone {
  provider: PiSubscriptionProvider;
  identityFingerprint?: string;
  /** A managed CLI profile id; never the System login. */
  cliProfileId?: string;
  deletedAt: string;
}

export interface PiAccountDismissedSystemOffer {
  provider: PiSubscriptionProvider;
  identityFingerprint: string;
}

/**
 * What a System login with no identity (an API-key Codex login, a Claude
 * login whose config names no account) is dismissed under. Shaped like a
 * fingerprint so a registry that holds one still parses in builds that
 * predate it; no account identity hashes to it.
 */
export function unidentifiedSystemOfferFingerprint(
  provider: PiSubscriptionProvider,
  login: { apiKey?: boolean },
): string {
  const marker = login.apiKey ? "apiKey" : "unidentified";
  return createHash("sha256").update(`codara:system-offer:${provider}:${marker}`).digest("hex");
}

export interface PiAccountPendingPurge {
  /** A managed home that a running terminal still held when its account was deleted. */
  path: string;
  keychainService?: string;
  reason: string;
}

export interface PiAccountProfilesSnapshot {
  version: typeof PI_ACCOUNT_PROFILES_VERSION;
  profiles: PiAccountProfile[];
  defaults: PiAccountProfileDefaults;
  tombstones: PiAccountTombstone[];
  dismissedSystemOffers: PiAccountDismissedSystemOffer[];
  pendingPurge: PiAccountPendingPurge[];
}

/** A v1 row exactly as it was stored, for the migration only. */
export interface PiAccountLegacyProfile {
  id: string;
  provider: PiSubscriptionProvider;
  label: string;
  createdAt: string;
  updatedAt: string;
  identityFingerprint?: string;
  accountEmail?: string;
  /** "personal" or a managed CLI profile id. */
  cliProfileId?: string;
}

export interface PiAccountLegacySnapshot {
  version: typeof PI_ACCOUNT_PROFILES_LEGACY_VERSION;
  profiles: PiAccountLegacyProfile[];
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
  /**
   * The CLI half: a managed profile id, SYSTEM_CLI_PROFILE_ID for the System
   * login, or absent for none.
   */
  cliProfileId?: string;
  /** Defaults to "linked" for a managed half and "own" otherwise. */
  cora?: PiAccountCoraHalf;
  /** New profiles become the provider default when none exists. */
  makeDefault?: boolean;
  /**
   * The user explicitly added this account (Add account, Use in Codara,
   * Share). Only such a call may register a tombstoned identity, and it
   * removes the tombstone in the same write.
   */
  explicitUserAdd?: boolean;
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
  /** Managed homes that could not be purged yet because a terminal holds them. */
  pendingPurge?: readonly PiAccountPendingPurge[];
  /**
   * The current System login's offer key, dismissed when the deleted row is
   * a System row that carries no fingerprint of its own.
   */
  systemOfferFingerprint?: string;
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
 * error body, or usage history, only the minimum signal needed for selection.
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

/** The CLI profile is already the other half of a different row of its provider. */
export class PiAccountProfileLinkCollisionError extends Error {
  readonly provider: PiSubscriptionProvider;
  readonly cliProfileId: string;
  readonly linkedProfileId: string;

  constructor(
    provider: PiSubscriptionProvider,
    cliProfileId: string,
    linkedProfileId: string,
  ) {
    super(
      cliProfileId === SYSTEM_CLI_PROFILE_ID
        ? `The ${provider} System login is already used by Pi account profile ${linkedProfileId}`
        : `CLI profile ${cliProfileId} (${provider}) is already linked to Pi account profile ${linkedProfileId}`,
    );
    this.name = "PiAccountProfileLinkCollisionError";
    this.provider = provider;
    this.cliProfileId = cliProfileId;
    this.linkedProfileId = linkedProfileId;
  }
}

/** The account was deleted; only an explicit add of it may register it again. */
export class PiAccountProfileTombstonedError extends Error {
  readonly provider: PiSubscriptionProvider;

  constructor(provider: PiSubscriptionProvider) {
    super(`This ${provider} account was removed from Codara; add it again to use it`);
    this.name = "PiAccountProfileTombstonedError";
    this.provider = provider;
  }
}

/**
 * The registry on disk is still version 1. It reads as an equivalent v2
 * snapshot, but nothing may change it before the accounts migration has
 * classified its rows (accounts-v2-migration.ts).
 */
export class PiAccountProfilesMigrationPendingError extends Error {
  constructor() {
    super("The account registry has not been migrated to version 2 yet");
    this.name = "PiAccountProfilesMigrationPendingError";
  }
}

const mutationTails = new Map<string, Promise<void>>();

export function emptyPiAccountProfilesSnapshot(): PiAccountProfilesSnapshot {
  return {
    version: PI_ACCOUNT_PROFILES_VERSION,
    profiles: [],
    defaults: {},
    tombstones: [],
    dismissedSystemOffers: [],
    pendingPurge: [],
  };
}

function cliProfileIdOf(cli: PiAccountCliHalf): string | undefined {
  if (cli.kind === "managed") return cli.profileId;
  if (cli.kind === "system") return SYSTEM_CLI_PROFILE_ID;
  return undefined;
}

function withDerived(profile: Omit<PiAccountProfile, "cliProfileId">): PiAccountProfile {
  const cliProfileId = cliProfileIdOf(profile.cli);
  return { ...profile, cli: { ...profile.cli }, ...(cliProfileId ? { cliProfileId } : {}) };
}

function cloneProfile(profile: PiAccountProfile): PiAccountProfile {
  const { cliProfileId: _derived, ...rest } = profile;
  void _derived;
  return withDerived(rest);
}

function cloneSnapshot(snapshot: PiAccountProfilesSnapshot): PiAccountProfilesSnapshot {
  return {
    version: snapshot.version,
    profiles: snapshot.profiles.map(cloneProfile),
    defaults: { ...snapshot.defaults },
    tombstones: snapshot.tombstones.map((entry) => ({ ...entry })),
    dismissedSystemOffers: snapshot.dismissedSystemOffers.map((entry) => ({ ...entry })),
    pendingPurge: snapshot.pendingPurge.map((entry) => ({ ...entry })),
  };
}

/** The stored form: the derived cliProfileId never reaches the file. */
function serializeSnapshot(snapshot: PiAccountProfilesSnapshot): string {
  const stored = {
    version: PI_ACCOUNT_PROFILES_VERSION,
    profiles: snapshot.profiles.map((profile) => {
      const { cliProfileId: _derived, ...rest } = profile;
      void _derived;
      return rest;
    }),
    defaults: snapshot.defaults,
    tombstones: snapshot.tombstones,
    dismissedSystemOffers: snapshot.dismissedSystemOffers,
    pendingPurge: snapshot.pendingPurge,
  };
  return `${JSON.stringify(stored, null, 2)}\n`;
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

/**
 * The CLI half named the way the per-CLI stores name it: the System login's
 * id or a lowercase UUIDv4 naming a managed CLI profile. Anything else is
 * refused rather than trimmed.
 */
function cliHalfFromId(value: unknown): PiAccountCliHalf {
  if (value === undefined || value === null) return { kind: "none" };
  if (typeof value !== "string") throw new TypeError("CLI profile id must be a string");
  if (value === SYSTEM_CLI_PROFILE_ID) return { kind: "system" };
  if (UUID_V4_PATTERN.test(value)) return { kind: "managed", profileId: value };
  throw new TypeError(`CLI profile id must be "${SYSTEM_CLI_PROFILE_ID}" or a lowercase UUIDv4`);
}

function parseCliHalf(value: unknown, context: string): PiAccountCliHalf {
  if (!isRecord(value)) throw new PiAccountProfilesCorruptError(`${context} must be an object`);
  if (value.kind === "managed") {
    assertOnlyKeys(value, new Set(["kind", "profileId"]), context);
    if (typeof value.profileId !== "string" || !UUID_V4_PATTERN.test(value.profileId)) {
      throw new PiAccountProfilesCorruptError(`${context}.profileId must be a lowercase UUIDv4`);
    }
    return { kind: "managed", profileId: value.profileId };
  }
  if (value.kind === "system" || value.kind === "none") {
    assertOnlyKeys(value, new Set(["kind"]), context);
    return { kind: value.kind };
  }
  throw new PiAccountProfilesCorruptError(`${context}.kind is unsupported`);
}

/** Links are unique within a provider, so the collision key carries both. */
function linkKey(provider: PiSubscriptionProvider, cliProfileId: string): string {
  return `${provider}:${cliProfileId}`;
}

interface ParsedRowCommon {
  id: string;
  provider: PiSubscriptionProvider;
  label: string;
  createdAt: string;
  updatedAt: string;
  identityFingerprint?: string;
  accountEmail?: string;
}

function parseRowCommon(
  raw: Record<string, unknown>,
  index: number,
  ids: Set<string>,
  fingerprints: Set<string>,
): ParsedRowCommon {
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
    throw new PiAccountProfilesCorruptError(`profiles[${index}].label must already be trimmed`);
  }
  assertCanonicalTimestamp(raw.createdAt, `profiles[${index}].createdAt`);
  assertCanonicalTimestamp(raw.updatedAt, `profiles[${index}].updatedAt`);
  if (raw.updatedAt < raw.createdAt) {
    throw new PiAccountProfilesCorruptError(`profiles[${index}].updatedAt cannot precede createdAt`);
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
  return {
    id: raw.id,
    provider: raw.provider,
    label,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(identityFingerprint ? { identityFingerprint } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}

function parseDefaults(
  value: Record<string, unknown>,
  profiles: ReadonlyArray<{ id: string; provider: PiSubscriptionProvider }>,
): PiAccountProfileDefaults {
  if (!isRecord(value.defaults)) {
    throw new PiAccountProfilesCorruptError("defaults must be an object");
  }
  assertOnlyKeys(value.defaults, DEFAULT_KEYS, "defaults");
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
  return defaults;
}

function parseTombstones(value: unknown): PiAccountTombstone[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PiAccountProfilesCorruptError("tombstones must be an array");
  return value.map((raw, index): PiAccountTombstone => {
    const context = `tombstones[${index}]`;
    if (!isRecord(raw)) throw new PiAccountProfilesCorruptError(`${context} must be an object`);
    assertOnlyKeys(raw, new Set(["provider", "identityFingerprint", "cliProfileId", "deletedAt"]), context);
    if (!isProvider(raw.provider)) {
      throw new PiAccountProfilesCorruptError(`${context}.provider is unsupported`);
    }
    let identityFingerprint: string | undefined;
    try {
      identityFingerprint = normalizeIdentityFingerprint(raw.identityFingerprint);
    } catch (error) {
      throw new PiAccountProfilesCorruptError(`${context}.identityFingerprint is invalid: ${(error as Error).message}`);
    }
    if (
      raw.cliProfileId !== undefined &&
      (typeof raw.cliProfileId !== "string" || !UUID_V4_PATTERN.test(raw.cliProfileId))
    ) {
      throw new PiAccountProfilesCorruptError(`${context}.cliProfileId must be a lowercase UUIDv4`);
    }
    assertCanonicalTimestamp(raw.deletedAt, `${context}.deletedAt`);
    return {
      provider: raw.provider,
      ...(identityFingerprint ? { identityFingerprint } : {}),
      ...(typeof raw.cliProfileId === "string" ? { cliProfileId: raw.cliProfileId } : {}),
      deletedAt: raw.deletedAt,
    };
  });
}

function parseDismissedOffers(value: unknown): PiAccountDismissedSystemOffer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PiAccountProfilesCorruptError("dismissedSystemOffers must be an array");
  }
  return value.map((raw, index): PiAccountDismissedSystemOffer => {
    const context = `dismissedSystemOffers[${index}]`;
    if (!isRecord(raw)) throw new PiAccountProfilesCorruptError(`${context} must be an object`);
    assertOnlyKeys(raw, new Set(["provider", "identityFingerprint"]), context);
    if (!isProvider(raw.provider)) {
      throw new PiAccountProfilesCorruptError(`${context}.provider is unsupported`);
    }
    if (typeof raw.identityFingerprint !== "string" || !IDENTITY_FINGERPRINT_PATTERN.test(raw.identityFingerprint)) {
      throw new PiAccountProfilesCorruptError(`${context}.identityFingerprint must be lowercase SHA-256 hex`);
    }
    return { provider: raw.provider, identityFingerprint: raw.identityFingerprint };
  });
}

function parsePendingPurge(value: unknown): PiAccountPendingPurge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PiAccountProfilesCorruptError("pendingPurge must be an array");
  return value.map((raw, index): PiAccountPendingPurge => {
    const context = `pendingPurge[${index}]`;
    if (!isRecord(raw)) throw new PiAccountProfilesCorruptError(`${context} must be an object`);
    assertOnlyKeys(raw, new Set(["path", "keychainService", "reason"]), context);
    if (typeof raw.path !== "string" || !raw.path || CONTROL_CHARACTER_PATTERN.test(raw.path)) {
      throw new PiAccountProfilesCorruptError(`${context}.path must be a path`);
    }
    if (raw.keychainService !== undefined && typeof raw.keychainService !== "string") {
      throw new PiAccountProfilesCorruptError(`${context}.keychainService must be a string`);
    }
    if (typeof raw.reason !== "string") {
      throw new PiAccountProfilesCorruptError(`${context}.reason must be a string`);
    }
    return {
      path: raw.path,
      ...(typeof raw.keychainService === "string" ? { keychainService: raw.keychainService } : {}),
      reason: raw.reason,
    };
  });
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
  const profiles: PiAccountProfile[] = [];
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const cliLinks = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new PiAccountProfilesCorruptError(`profiles[${index}] must be an object`);
    }
    assertOnlyKeys(raw, PROFILE_KEYS, `profiles[${index}]`);
    const common = parseRowCommon(raw, index, ids, fingerprints);
    const cli = parseCliHalf(raw.cli, `profiles[${index}].cli`);
    if (typeof raw.cora !== "string" || !CORA_KINDS.has(raw.cora as PiAccountCoraHalf)) {
      throw new PiAccountProfilesCorruptError(`profiles[${index}].cora is unsupported`);
    }
    const link = cliProfileIdOf(cli);
    if (link) {
      // Two rows of one provider sharing one CLI half would make the mirror
      // copy one account's tokens into another, and two System rows would
      // be two cards for the one login; the file is corrupt, not ambiguous.
      const key = linkKey(common.provider, link);
      if (cliLinks.has(key)) {
        throw new PiAccountProfilesCorruptError(
          link === SYSTEM_CLI_PROFILE_ID
            ? `more than one ${common.provider} profile uses the System login`
            : `duplicate CLI profile link "${link}" for provider "${common.provider}"`,
        );
      }
      cliLinks.add(key);
    }
    profiles.push(withDerived({ ...common, cli, cora: raw.cora as PiAccountCoraHalf }));
  }
  return {
    version: PI_ACCOUNT_PROFILES_VERSION,
    profiles,
    defaults: parseDefaults(value, profiles),
    tombstones: parseTombstones(value.tombstones),
    dismissedSystemOffers: parseDismissedOffers(value.dismissedSystemOffers),
    pendingPurge: parsePendingPurge(value.pendingPurge),
  };
}

/** A version 1 registry, validated as strictly as it was written. */
export function parsePiAccountProfilesV1(value: unknown): PiAccountLegacySnapshot {
  if (!isRecord(value)) throw new PiAccountProfilesCorruptError("root must be an object");
  assertOnlyKeys(value, LEGACY_ROOT_KEYS, "root");
  if (value.version !== PI_ACCOUNT_PROFILES_LEGACY_VERSION) {
    throw new PiAccountProfilesCorruptError(`unsupported version ${String(value.version)}`);
  }
  if (!Array.isArray(value.profiles)) {
    throw new PiAccountProfilesCorruptError("profiles must be an array");
  }
  const profiles: PiAccountLegacyProfile[] = [];
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const cliLinks = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new PiAccountProfilesCorruptError(`profiles[${index}] must be an object`);
    }
    assertOnlyKeys(raw, LEGACY_PROFILE_KEYS, `profiles[${index}]`);
    const common = parseRowCommon(raw, index, ids, fingerprints);
    let link: string | undefined;
    try {
      link = cliProfileIdOf(cliHalfFromId(raw.cliProfileId));
    } catch (error) {
      throw new PiAccountProfilesCorruptError(
        `profiles[${index}].cliProfileId is invalid: ${(error as Error).message}`,
      );
    }
    if (link) {
      const key = linkKey(common.provider, link);
      if (cliLinks.has(key)) {
        throw new PiAccountProfilesCorruptError(`duplicate CLI profile link "${link}"`);
      }
      cliLinks.add(key);
    }
    profiles.push({ ...common, ...(link ? { cliProfileId: link } : {}) });
  }
  return {
    version: PI_ACCOUNT_PROFILES_LEGACY_VERSION,
    profiles,
    defaults: parseDefaults(value, profiles),
  };
}

/**
 * What a v1 registry reads as before the migration ran: every row keeps its
 * halves, "personal" as the System login. The migration decides what each
 * row really becomes; this view only keeps reads working meanwhile.
 */
function legacyAsSnapshot(legacy: PiAccountLegacySnapshot): PiAccountProfilesSnapshot {
  return {
    ...emptyPiAccountProfilesSnapshot(),
    profiles: legacy.profiles.map((row) => {
      const { cliProfileId, ...common } = row;
      const cli = cliHalfFromId(cliProfileId);
      return withDerived({ ...common, cli, cora: cli.kind === "managed" ? "linked" : "own" });
    }),
    defaults: { ...legacy.defaults },
  };
}

interface DiskRead {
  snapshot: PiAccountProfilesSnapshot;
  legacy: boolean;
}

async function readFromDisk(filePath: string): Promise<DiskRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshot: emptyPiAccountProfilesSnapshot(), legacy: false };
    }
    if (error instanceof SyntaxError) {
      throw new PiAccountProfilesCorruptError(`file is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  if (isRecord(parsed) && parsed.version === PI_ACCOUNT_PROFILES_LEGACY_VERSION) {
    return { snapshot: legacyAsSnapshot(parsePiAccountProfilesV1(parsed)), legacy: true };
  }
  return { snapshot: parseSnapshot(parsed), legacy: false };
}

async function readSnapshotFromDisk(filePath: string): Promise<PiAccountProfilesSnapshot> {
  return (await readFromDisk(filePath)).snapshot;
}

async function persistSnapshotAtomically(
  rootDir: string,
  filePath: string,
  snapshot: PiAccountProfilesSnapshot,
): Promise<void> {
  // Validate the exact bytes before they replace the file: a snapshot the
  // parser would refuse must never become the registry.
  const contents = serializeSnapshot(snapshot);
  parseSnapshot(JSON.parse(contents) as unknown);
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
    await handle.writeFile(contents, "utf8");
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

/**
 * Serialized in process by a tail per file, and across processes by the
 * account-selection lock of the registry's directory: two Codara builds
 * running side by side share one registry.
 */
async function withMutationLock<T>(
  rootDir: string,
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = mutationTails.get(filePath) ?? Promise.resolve();
  const result = predecessor
    .catch(() => undefined)
    .then(() => withAccountSelectionLock(rootDir, operation));
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

function assertProvider(provider: unknown): asserts provider is PiSubscriptionProvider {
  if (!isProvider(provider)) throw new TypeError(`Unsupported account provider: ${String(provider)}`);
}

/** Whether a tombstone covers an identity or a managed CLI profile of a provider. */
export function isPiAccountTombstoned(
  snapshot: Pick<PiAccountProfilesSnapshot, "tombstones">,
  provider: PiSubscriptionProvider,
  identity: { identityFingerprint?: string; cliProfileId?: string },
): boolean {
  return snapshot.tombstones.some(
    (entry) =>
      entry.provider === provider &&
      ((identity.identityFingerprint !== undefined &&
        entry.identityFingerprint === identity.identityFingerprint) ||
        (identity.cliProfileId !== undefined &&
          identity.cliProfileId !== SYSTEM_CLI_PROFILE_ID &&
          entry.cliProfileId === identity.cliProfileId)),
  );
}

function withoutTombstones(
  tombstones: PiAccountTombstone[],
  provider: PiSubscriptionProvider,
  identity: { identityFingerprint?: string; cliProfileId?: string },
): PiAccountTombstone[] {
  return tombstones.filter(
    (entry) => !isPiAccountTombstoned({ tombstones: [entry] }, provider, identity),
  );
}

function appendTombstone(
  snapshot: PiAccountProfilesSnapshot,
  profile: PiAccountProfile,
  deletedAt: string,
): void {
  const cliProfileId = profile.cli.kind === "managed" ? profile.cli.profileId : undefined;
  if (!profile.identityFingerprint && !cliProfileId) return;
  const identity = {
    ...(profile.identityFingerprint ? { identityFingerprint: profile.identityFingerprint } : {}),
    ...(cliProfileId ? { cliProfileId } : {}),
  };
  snapshot.tombstones = [
    ...withoutTombstones(snapshot.tombstones, profile.provider, identity),
    { provider: profile.provider, ...identity, deletedAt },
  ].slice(-PI_ACCOUNT_TOMBSTONE_LIMIT);
}

/**
 * Pure, deterministic candidate ranking. Only profiles with an explicit
 * available, non-limited signal are eligible. Missing/unknown usage sorts
 * behind known usage but remains selectable as a safe degradation path.
 */
export function rankPiAccountCandidates(
  snapshot: Pick<PiAccountProfilesSnapshot, "profiles" | "defaults">,
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
    .filter((profile) => profile.provider === provider && profile.cora !== "none")
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

  /** One read-modify-write of a v2 registry; a v1 file is the migration's. */
  private mutate<T>(
    operation: (snapshot: PiAccountProfilesSnapshot) => Promise<T>,
  ): Promise<T> {
    return withMutationLock(this.rootDir, this.filePath, async () => {
      const read = await readFromDisk(this.filePath);
      if (read.legacy) throw new PiAccountProfilesMigrationPendingError();
      return operation(read.snapshot);
    });
  }

  private persist(snapshot: PiAccountProfilesSnapshot): Promise<void> {
    return persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
  }

  private stamp(current: PiAccountProfile): string {
    const clockNow = this.now().toISOString();
    // Never move updatedAt backwards when the system clock is corrected.
    return clockNow > current.updatedAt ? clockNow : current.updatedAt;
  }

  async snapshot(): Promise<PiAccountProfilesSnapshot> {
    return cloneSnapshot(await readSnapshotFromDisk(this.filePath));
  }

  /** Whether the registry on disk is still version 1 (the migration has not committed). */
  async needsMigration(): Promise<boolean> {
    return (await readFromDisk(this.filePath)).legacy;
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

  /** The provider's row that uses the System login, when the user created one. */
  async systemProfile(
    provider: PiSubscriptionProvider,
  ): Promise<PiAccountProfile | undefined> {
    assertProvider(provider);
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profile = snapshot.profiles.find(
      (entry) => entry.provider === provider && entry.cli.kind === "system",
    );
    return profile ? cloneProfile(profile) : undefined;
  }

  /** Reverse lookup from a provider's CLI profile id to the row linking it. */
  async profileForCliProfileId(
    provider: PiSubscriptionProvider,
    cliProfileIdInput: string,
  ): Promise<PiAccountProfile | undefined> {
    assertProvider(provider);
    const cliProfileId = cliProfileIdOf(cliHalfFromId(cliProfileIdInput));
    if (!cliProfileId) throw new TypeError("CLI profile id is required");
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profile = snapshot.profiles.find(
      (entry) => entry.provider === provider && entry.cliProfileId === cliProfileId,
    );
    return profile ? cloneProfile(profile) : undefined;
  }

  async isTombstoned(
    provider: PiSubscriptionProvider,
    identity: { identityFingerprint?: string; cliProfileId?: string },
  ): Promise<boolean> {
    assertProvider(provider);
    return isPiAccountTombstoned(await readSnapshotFromDisk(this.filePath), provider, identity);
  }

  async registerProfile(
    input: RegisterPiAccountProfileInput,
  ): Promise<RegisterPiAccountProfileResult> {
    assertProvider(input.provider);
    const label = normalizeLabel(input.label);
    const identityFingerprint = normalizeIdentityFingerprint(input.identityFingerprint);
    const accountEmail = normalizeAccountEmail(input.accountEmail);
    const cli = cliHalfFromId(input.cliProfileId);
    const cliProfileId = cliProfileIdOf(cli);
    if (input.cora !== undefined && !CORA_KINDS.has(input.cora)) {
      throw new TypeError("Unsupported Cora half");
    }
    const cora: PiAccountCoraHalf = input.cora ?? (cli.kind === "managed" ? "linked" : "own");
    return this.mutate(async (snapshot) => {
      const identity = {
        ...(identityFingerprint ? { identityFingerprint } : {}),
        ...(cli.kind === "managed" ? { cliProfileId: cli.profileId } : {}),
      };
      if (isPiAccountTombstoned(snapshot, input.provider, identity)) {
        if (!input.explicitUserAdd) throw new PiAccountProfileTombstonedError(input.provider);
        snapshot.tombstones = withoutTombstones(snapshot.tombstones, input.provider, identity);
      }
      if (cliProfileId) {
        const linked = snapshot.profiles.find(
          (profile) =>
            profile.provider === input.provider && profile.cliProfileId === cliProfileId,
        );
        // The only tolerated repeat is an idempotent re-registration of the
        // same fingerprinted account, which returns the existing row below.
        const sameAccount =
          identityFingerprint !== undefined &&
          linked?.identityFingerprint === identityFingerprint;
        if (linked && !sameAccount) {
          throw new PiAccountProfileLinkCollisionError(input.provider, cliProfileId, linked.id);
        }
      }
      if (identityFingerprint) {
        const duplicate = snapshot.profiles.find(
          (profile) =>
            profile.provider === input.provider &&
            profile.identityFingerprint === identityFingerprint,
        );
        if (duplicate) {
          if (input.makeDefault) snapshot.defaults[input.provider] = duplicate.id;
          await this.persist(snapshot);
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
      const profile = withDerived({
        id,
        provider: input.provider,
        label,
        createdAt: now,
        updatedAt: now,
        ...(identityFingerprint ? { identityFingerprint } : {}),
        ...(accountEmail ? { accountEmail } : {}),
        cli,
        cora,
      });
      snapshot.profiles.push(profile);
      if (!snapshot.defaults[input.provider] || input.makeDefault) {
        snapshot.defaults[input.provider] = profile.id;
      }
      await this.persist(snapshot);
      return {
        profile: cloneProfile(profile),
        created: true,
        snapshot: cloneSnapshot(snapshot),
      };
    });
  }

  /**
   * Attach an account digest to a profile that was registered before its
   * provider could report one: the Anthropic case, where the account uuid only
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
    return this.mutate(async (snapshot) => {
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
      const updated = withDerived({
        ...current,
        identityFingerprint,
        updatedAt: this.stamp(current),
      });
      snapshot.profiles[index] = updated;
      await this.persist(snapshot);
      return cloneProfile(updated);
    });
  }

  /**
   * Record the address a login reported for this account, so the card can say
   * which login it is. Unlike the fingerprint this is not an identity claim, so
   * a later login overwrites it; an account whose address changed upstream
   * should show the new one. Writing the address it already has is a no-op.
   */
  async recordAccountEmail(
    profileId: string,
    emailInput: string,
  ): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const accountEmail = normalizeAccountEmail(emailInput);
    if (!accountEmail) throw new TypeError("Account email is required");
    return this.mutate(async (snapshot) => {
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.accountEmail === accountEmail) return cloneProfile(current);
      const updated = withDerived({ ...current, accountEmail, updatedAt: this.stamp(current) });
      snapshot.profiles[index] = updated;
      await this.persist(snapshot);
      return cloneProfile(updated);
    });
  }

  /**
   * Pair a row with its CLI half (a managed profile id, or the System
   * login's id), or clear the pairing with null. A half already held by
   * another row of the provider is refused rather than moved: moving it
   * would silently hand one account's terminal to another card.
   */
  async recordCliProfileId(
    profileId: string,
    cliProfileIdInput: string | null,
    cora?: PiAccountCoraHalf,
  ): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const cli = cliHalfFromId(cliProfileIdInput);
    if (cliProfileIdInput !== null && cli.kind === "none") {
      throw new TypeError("CLI profile id is required");
    }
    if (cora !== undefined && !CORA_KINDS.has(cora)) throw new TypeError("Unsupported Cora half");
    const cliProfileId = cliProfileIdOf(cli);
    return this.mutate(async (snapshot) => {
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.cliProfileId === cliProfileId && (cora === undefined || current.cora === cora)) {
        return cloneProfile(current);
      }
      if (cliProfileId) {
        const linked = snapshot.profiles.find(
          (profile) =>
            profile.id !== profileId &&
            profile.provider === current.provider &&
            profile.cliProfileId === cliProfileId,
        );
        if (linked) {
          throw new PiAccountProfileLinkCollisionError(current.provider, cliProfileId, linked.id);
        }
      }
      const updated = withDerived({
        ...current,
        cli,
        cora: cora ?? current.cora,
        updatedAt: this.stamp(current),
      });
      snapshot.profiles[index] = updated;
      await this.persist(snapshot);
      return cloneProfile(updated);
    });
  }

  /** Record what Cora holds for this account (see PiAccountCoraHalf). */
  async recordCoraHalf(profileId: string, cora: PiAccountCoraHalf): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    if (!CORA_KINDS.has(cora)) throw new TypeError("Unsupported Cora half");
    return this.mutate(async (snapshot) => {
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.cora === cora) return cloneProfile(current);
      const updated = withDerived({ ...current, cora, updatedAt: this.stamp(current) });
      snapshot.profiles[index] = updated;
      await this.persist(snapshot);
      return cloneProfile(updated);
    });
  }

  async renameProfile(profileId: string, labelInput: string): Promise<PiAccountProfile> {
    assertProfileId(profileId);
    const label = normalizeLabel(labelInput);
    return this.mutate(async (snapshot) => {
      const index = snapshot.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new PiAccountProfileNotFoundError(profileId);
      const current = snapshot.profiles[index];
      if (current.label === label) return cloneProfile(current);
      const updated = withDerived({ ...current, label, updatedAt: this.stamp(current) });
      snapshot.profiles[index] = updated;
      await this.persist(snapshot);
      return cloneProfile(updated);
    });
  }

  /** The Active account of a provider; null falls back to the System login. */
  async setDefaultProfile(
    provider: PiSubscriptionProvider,
    profileId: string | null,
  ): Promise<PiAccountProfilesSnapshot> {
    assertProvider(provider);
    if (profileId !== null) assertProfileId(profileId);
    return this.mutate(async (snapshot) => {
      if (profileId === null) {
        if (snapshot.defaults[provider] === undefined) return cloneSnapshot(snapshot);
        delete snapshot.defaults[provider];
      } else {
        const profile = snapshot.profiles.find((entry) => entry.id === profileId);
        if (!profile) throw new PiAccountProfileNotFoundError(profileId);
        if (profile.provider !== provider) {
          throw new TypeError(`Profile ${profileId} does not belong to provider ${provider}`);
        }
        if (snapshot.defaults[provider] === profileId) return cloneSnapshot(snapshot);
        snapshot.defaults[provider] = profileId;
      }
      await this.persist(snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  /**
   * Remove a row for good: its tombstone and its removal land in one write,
   * and an Active row leaves no default behind, so the provider falls back
   * to the System login rather than to another account. A System row's
   * identity is also dismissed, so its offer does not come straight back;
   * a row with no fingerprint is dismissed under the caller's offer key.
   */
  async deleteProfile(
    profileId: string,
    options: DeletePiAccountProfileOptions = {},
  ): Promise<DeletePiAccountProfileResult> {
    assertProfileId(profileId);
    const protectedIds = new Set(options.protectedProfileIds ?? []);
    if (protectedIds.has(profileId)) throw new PiAccountProfileProtectedError(profileId);
    const systemOfferFingerprint = normalizeIdentityFingerprint(options.systemOfferFingerprint);

    return this.mutate(async (snapshot) => {
      const target = snapshot.profiles.find((profile) => profile.id === profileId);
      if (!target) return { deleted: false, snapshot: cloneSnapshot(snapshot) };
      const now = this.now().toISOString();
      snapshot.profiles = snapshot.profiles.filter((profile) => profile.id !== profileId);
      if (snapshot.defaults[target.provider] === profileId) delete snapshot.defaults[target.provider];
      appendTombstone(snapshot, target, now);
      const fingerprint = target.identityFingerprint ?? systemOfferFingerprint;
      if (target.cli.kind === "system" && fingerprint) {
        if (
          !snapshot.dismissedSystemOffers.some(
            (entry) => entry.provider === target.provider && entry.identityFingerprint === fingerprint,
          )
        ) {
          snapshot.dismissedSystemOffers.push({ provider: target.provider, identityFingerprint: fingerprint });
        }
      }
      for (const entry of options.pendingPurge ?? []) {
        if (!snapshot.pendingPurge.some((queued) => queued.path === entry.path)) {
          snapshot.pendingPurge.push({ ...entry });
        }
      }
      snapshot.pendingPurge = snapshot.pendingPurge.slice(-PI_ACCOUNT_PENDING_PURGE_LIMIT);
      await this.persist(snapshot);
      return { deleted: true, snapshot: cloneSnapshot(snapshot) };
    });
  }

  async dismissSystemOffer(
    provider: PiSubscriptionProvider,
    fingerprintInput: string,
  ): Promise<void> {
    assertProvider(provider);
    const identityFingerprint = normalizeIdentityFingerprint(fingerprintInput);
    if (!identityFingerprint) throw new TypeError("Account identity fingerprint is required");
    await this.mutate(async (snapshot) => {
      if (
        snapshot.dismissedSystemOffers.some(
          (entry) => entry.provider === provider && entry.identityFingerprint === identityFingerprint,
        )
      ) {
        return;
      }
      snapshot.dismissedSystemOffers.push({ provider, identityFingerprint });
      await this.persist(snapshot);
    });
  }

  async isSystemOfferDismissed(
    provider: PiSubscriptionProvider,
    identityFingerprint: string,
  ): Promise<boolean> {
    const snapshot = await readSnapshotFromDisk(this.filePath);
    return snapshot.dismissedSystemOffers.some(
      (entry) => entry.provider === provider && entry.identityFingerprint === identityFingerprint,
    );
  }

  async queuePendingPurge(entries: readonly PiAccountPendingPurge[]): Promise<void> {
    if (entries.length === 0) return;
    await this.mutate(async (snapshot) => {
      for (const entry of entries) {
        if (!snapshot.pendingPurge.some((queued) => queued.path === entry.path)) {
          snapshot.pendingPurge.push({ ...entry });
        }
      }
      snapshot.pendingPurge = snapshot.pendingPurge.slice(-PI_ACCOUNT_PENDING_PURGE_LIMIT);
      await this.persist(snapshot);
    });
  }

  async completePendingPurge(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const done = new Set(paths);
    await this.mutate(async (snapshot) => {
      const remaining = snapshot.pendingPurge.filter((entry) => !done.has(entry.path));
      if (remaining.length === snapshot.pendingPurge.length) return;
      snapshot.pendingPurge = remaining;
      await this.persist(snapshot);
    });
  }

  /**
   * The migration's commit point: replace a version 1 registry (or none)
   * with the v2 snapshot it computed. A registry that is already v2 is left
   * alone and returned, so a migration that resumes after a crash past this
   * point cannot overwrite what the user did since.
   */
  async commitMigration(
    next: PiAccountProfilesSnapshot,
  ): Promise<{ committed: boolean; snapshot: PiAccountProfilesSnapshot }> {
    return withMutationLock(this.rootDir, this.filePath, async () => {
      const exists = await fs.stat(this.filePath).then(() => true, () => false);
      const read = await readFromDisk(this.filePath);
      if (exists && !read.legacy) return { committed: false, snapshot: cloneSnapshot(read.snapshot) };
      const snapshot = cloneSnapshot(next);
      await this.persist(snapshot);
      return { committed: true, snapshot };
    });
  }
}
