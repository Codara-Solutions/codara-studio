import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CODARA_GROK_CLI_DIRNAME,
  codaraHomeDir,
  isCodaraManagedCliPath,
} from "./codara-managed-cli-roots";
import { ensureSharedCliState } from "./native-cli-shared-state";

export const GROK_CLI_PERSONAL_PROFILE_ID = "personal" as const;
export const GROK_CLI_ACCOUNT_PROFILES_VERSION = 1 as const;
export const GROK_CLI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const GROK_CLI_ACCOUNTS_DIRECTORY = "accounts";
export const GROK_CLI_AUTH_FILE = "auth.json";
export const GROK_CLI_PROFILE_LABEL_MAX_LENGTH = 80;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_KEYS = new Set(["id", "label", "createdAt", "updatedAt"]);
const ROOT_KEYS = new Set(["version", "profiles", "defaultProfileId"]);
const MAX_ID_GENERATION_ATTEMPTS = 32;
const DELETING_DIRECTORY_PATTERN =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.deleting-([0-9a-f]+)$/;

const mutationTails = new Map<string, Promise<void>>();

export type GrokCliProfileId =
  | typeof GROK_CLI_PERSONAL_PROFILE_ID
  | string;

export interface GrokCliManagedProfile {
  /** Opaque UUIDv4. Never derived from a provider identity or credential. */
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrokCliAccountProfilesSnapshot {
  version: typeof GROK_CLI_ACCOUNT_PROFILES_VERSION;
  profiles: GrokCliManagedProfile[];
  defaultProfileId: GrokCliProfileId;
}

export interface GrokCliProfileConnection {
  /** Opaque local id. `personal` is the synthetic pre-feature Grok home. */
  id: GrokCliProfileId;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  inUse: boolean;
  error?: "Sign in required" | "Credential file is unsafe";
}

export type GrokCliAuthCheckReason = "missing" | "unsafe";

export interface GrokCliAuthCheckResult {
  connected: boolean;
  reason?: GrokCliAuthCheckReason;
}

export interface GrokCliAuthCheckInput {
  profileId: GrokCliProfileId;
  managed: boolean;
  homeDir: string;
  authFile: string;
}

export type GrokCliAuthChecker = (
  input: Readonly<GrokCliAuthCheckInput>,
) => GrokCliAuthCheckResult | Promise<GrokCliAuthCheckResult>;

export interface GrokCliProfileLeaseView {
  isLeased(profileId: GrokCliProfileId): boolean;
  /**
   * Optional atomic guard supplied by the production lease registry. It
   * closes the check→rename race: no new launch can acquire this profile
   * while a destructive mutation is in flight.
   */
  runWhileUnleased?<T>(
    profileId: GrokCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface GrokCliAccountProfileStoreOptions {
  /** Existing Grok home represented by the synthetic `personal` profile. */
  personalHomeDir?: string;
  /** Test seam. Production uses cryptographically random UUIDv4 values. */
  idFactory?: () => string;
  /** Test seam. */
  now?: () => Date;
  /**
   * Token-blind auth inspection. The default only lstat(2)s auth.json and
   * checks its mode; it never reads credential bytes.
   */
  authChecker?: GrokCliAuthChecker;
  /** Process-local live native-Grok ownership guard. */
  leases?: GrokCliProfileLeaseView;
}

export interface GrokCliAccountInspection {
  profiles: GrokCliProfileConnection[];
  defaultProfileId: GrokCliProfileId;
  reconciliation: GrokCliAccountReconciliation;
}

export interface GrokCliAccountReconciliation {
  restoredProfileIds: string[];
  removedDeletingDirectories: string[];
  /** Preserved rather than deleted: an orphan may contain a valid login. */
  orphanProfileIds: string[];
}

export interface GrokCliResolvedProfile {
  profileId: GrokCliProfileId;
  label: string;
  managed: boolean;
  /** Main-process-only path. Never place this object on IPC/RPC surfaces. */
  homeDir: string;
  /** Main-process-only path. */
  authFile: string;
  connected: boolean;
}

export interface ResolveGrokCliProfileInput {
  /**
   * Absent/null/empty is legacy data and therefore means `personal`.
   * New-session callers that want the configured default must opt in with
   * useDefault=true, removing ambiguity from persisted ownership.
   */
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
}

export interface CreateGrokCliProfileInput {
  label: string;
}

export interface CreateGrokCliProfileResult {
  profile: GrokCliManagedProfile;
  snapshot: GrokCliAccountProfilesSnapshot;
}

export interface DeleteGrokCliProfileResult {
  deleted: boolean;
  snapshot: GrokCliAccountProfilesSnapshot;
}

export class GrokCliAccountProfilesCorruptError extends Error {
  constructor(message: string) {
    super(`Invalid native Grok account profile registry: ${message}`);
    this.name = "GrokCliAccountProfilesCorruptError";
  }
}

export class GrokCliAccountProfileSafetyError extends Error {
  constructor(message: string) {
    super(`Unsafe native Grok account store: ${message}`);
    this.name = "GrokCliAccountProfileSafetyError";
  }
}

export class GrokCliAccountProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Native Grok account profile not found: ${profileId}`);
    this.name = "GrokCliAccountProfileNotFoundError";
  }
}

export class GrokCliAccountProfileLeasedError extends Error {
  readonly profileId: GrokCliProfileId;

  constructor(profileId: GrokCliProfileId) {
    super(`Native Grok account profile is active and cannot be deleted: ${profileId}`);
    this.name = "GrokCliAccountProfileLeasedError";
    this.profileId = profileId;
  }
}

export class GrokCliDefaultProfileDeletionError extends Error {
  constructor(profileId: string) {
    super(
      `Native Grok account profile is the current default; choose another default before deleting ${profileId}`,
    );
    this.name = "GrokCliDefaultProfileDeletionError";
  }
}

export class GrokCliAccountProfileIdCollisionError extends Error {
  constructor() {
    super(
      `Unable to allocate a unique native Grok account profile id after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
    );
    this.name = "GrokCliAccountProfileIdCollisionError";
  }
}

export function codaraGrokCliAccountRootDir(): string {
  return join(codaraHomeDir(), CODARA_GROK_CLI_DIRNAME);
}

/**
 * A retired feature exported GROK_HOME from the user's shell profile, so a
 * Studio launched from a shell that still carries that export inherits a
 * selector that names a Codara-managed directory. That is never the user's own
 * login (see codara-managed-cli-roots.ts); a custom directory outside Codara's
 * roots still is.
 */
export function defaultPersonalGrokHomeDir(): string {
  const configured = process.env.GROK_HOME?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) return resolve(configured);
  return resolve(join(homedir(), ".grok"));
}

export function isGrokCliManagedProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function normalizeGrokCliProfileId(
  value: unknown,
  label = "Native Grok account profile id",
): GrokCliProfileId {
  if (value === undefined || value === null || value === "") {
    return GROK_CLI_PERSONAL_PROFILE_ID;
  }
  if (value === GROK_CLI_PERSONAL_PROFILE_ID || isGrokCliManagedProfileId(value)) {
    return value;
  }
  throw new TypeError(`${label} must be "personal" or a lowercase UUIDv4`);
}

export function grokCliManagedProfilePaths(
  rootDir: string,
  rawProfileId: string,
): { homeDir: string; authFile: string } {
  if (!isGrokCliManagedProfileId(rawProfileId)) {
    throw new TypeError("Managed native Grok profile id must be a lowercase UUIDv4");
  }
  const accountsDir = resolve(rootDir, GROK_CLI_ACCOUNTS_DIRECTORY);
  const homeDir = resolve(accountsDir, rawProfileId);
  if (dirname(homeDir) !== accountsDir || basename(homeDir) !== rawProfileId) {
    throw new GrokCliAccountProfileSafetyError("profile path escaped the accounts directory");
  }
  return { homeDir, authFile: join(homeDir, GROK_CLI_AUTH_FILE) };
}

function emptySnapshot(): GrokCliAccountProfilesSnapshot {
  return {
    version: GROK_CLI_ACCOUNT_PROFILES_VERSION,
    profiles: [],
    defaultProfileId: GROK_CLI_PERSONAL_PROFILE_ID,
  };
}

function cloneProfile(profile: GrokCliManagedProfile): GrokCliManagedProfile {
  return { ...profile };
}

function cloneSnapshot(
  snapshot: GrokCliAccountProfilesSnapshot,
): GrokCliAccountProfilesSnapshot {
  return {
    version: snapshot.version,
    profiles: snapshot.profiles.map(cloneProfile),
    defaultProfileId: snapshot.defaultProfileId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new GrokCliAccountProfilesCorruptError(
      `${context} contains unexpected field "${unexpected}"`,
    );
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Native Grok account label must be a string");
  }
  const label = value.trim();
  if (!label) throw new TypeError("Native Grok account label cannot be empty");
  if (label.length > GROK_CLI_PROFILE_LABEL_MAX_LENGTH) {
    throw new TypeError(
      `Native Grok account label cannot exceed ${GROK_CLI_PROFILE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    throw new TypeError("Native Grok account label cannot contain control characters");
  }
  return label;
}

function assertCanonicalTimestamp(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string") {
    throw new GrokCliAccountProfilesCorruptError(`${context} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new GrokCliAccountProfilesCorruptError(
      `${context} must be a canonical ISO timestamp`,
    );
  }
}

function parseSnapshot(value: unknown): GrokCliAccountProfilesSnapshot {
  if (!isRecord(value)) {
    throw new GrokCliAccountProfilesCorruptError("root must be an object");
  }
  assertOnlyKeys(value, ROOT_KEYS, "root");
  if (value.version !== GROK_CLI_ACCOUNT_PROFILES_VERSION) {
    throw new GrokCliAccountProfilesCorruptError(
      `unsupported version ${String(value.version)}`,
    );
  }
  if (!Array.isArray(value.profiles)) {
    throw new GrokCliAccountProfilesCorruptError("profiles must be an array");
  }

  const profiles: GrokCliManagedProfile[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new GrokCliAccountProfilesCorruptError(
        `profiles[${index}] must be an object`,
      );
    }
    assertOnlyKeys(raw, PROFILE_KEYS, `profiles[${index}]`);
    if (!isGrokCliManagedProfileId(raw.id)) {
      throw new GrokCliAccountProfilesCorruptError(
        `profiles[${index}].id must be a lowercase UUIDv4`,
      );
    }
    if (ids.has(raw.id)) {
      throw new GrokCliAccountProfilesCorruptError(`duplicate profile id "${raw.id}"`);
    }
    let label: string;
    try {
      label = normalizeLabel(raw.label);
    } catch (error) {
      throw new GrokCliAccountProfilesCorruptError(
        `profiles[${index}].label is invalid: ${(error as Error).message}`,
      );
    }
    if (label !== raw.label) {
      throw new GrokCliAccountProfilesCorruptError(
        `profiles[${index}].label must already be trimmed`,
      );
    }
    assertCanonicalTimestamp(raw.createdAt, `profiles[${index}].createdAt`);
    assertCanonicalTimestamp(raw.updatedAt, `profiles[${index}].updatedAt`);
    if (raw.updatedAt < raw.createdAt) {
      throw new GrokCliAccountProfilesCorruptError(
        `profiles[${index}].updatedAt cannot precede createdAt`,
      );
    }
    ids.add(raw.id);
    profiles.push({
      id: raw.id,
      label,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  let defaultProfileId: GrokCliProfileId;
  try {
    defaultProfileId = normalizeGrokCliProfileId(
      value.defaultProfileId,
      "defaultProfileId",
    );
  } catch (error) {
    throw new GrokCliAccountProfilesCorruptError(
      `defaultProfileId is invalid: ${(error as Error).message}`,
    );
  }
  if (
    defaultProfileId !== GROK_CLI_PERSONAL_PROFILE_ID &&
    !profiles.some((profile) => profile.id === defaultProfileId)
  ) {
    throw new GrokCliAccountProfilesCorruptError(
      "defaultProfileId must reference a managed profile or personal",
    );
  }
  return {
    version: GROK_CLI_ACCOUNT_PROFILES_VERSION,
    profiles,
    defaultProfileId,
  };
}

async function assertSafeDirectory(
  path: string,
  options: { create: boolean },
): Promise<void> {
  let stats = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats && options.create) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    stats = await fs.lstat(path);
  }
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GrokCliAccountProfileSafetyError(
      "an account-store directory is a symlink or not a directory",
    );
  }
  if (process.platform !== "win32") await fs.chmod(path, 0o700);
}

async function assertSafeRegularFile(
  path: string,
  options: { allowMissing: boolean; requirePrivate: boolean },
): Promise<boolean> {
  const stats = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) {
    if (options.allowMissing) return false;
    throw new GrokCliAccountProfileSafetyError("required account-store file is missing");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new GrokCliAccountProfileSafetyError(
      "an account-store file is a symlink or not a regular file",
    );
  }
  if (
    options.requirePrivate &&
    process.platform !== "win32" &&
    (stats.mode & 0o077) !== 0
  ) {
    throw new GrokCliAccountProfileSafetyError(
      "an account-store file is readable by group or other users",
    );
  }
  return true;
}

async function readSnapshotFromDisk(
  filePath: string,
): Promise<GrokCliAccountProfilesSnapshot> {
  const exists = await assertSafeRegularFile(filePath, {
    allowMissing: true,
    requirePrivate: true,
  });
  if (!exists) return emptySnapshot();
  try {
    return parseSnapshot(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof GrokCliAccountProfilesCorruptError) throw error;
    if (error instanceof SyntaxError) {
      throw new GrokCliAccountProfilesCorruptError(
        `file is not valid JSON: ${error.message}`,
      );
    }
    throw error;
  }
}

async function persistSnapshotAtomically(
  rootDir: string,
  filePath: string,
  snapshot: GrokCliAccountProfilesSnapshot,
): Promise<void> {
  await assertSafeDirectory(rootDir, { create: true });
  await assertSafeRegularFile(filePath, {
    allowMissing: true,
    requirePrivate: true,
  });
  const temporaryPath = join(
    rootDir,
    `.${GROK_CLI_ACCOUNT_PROFILES_FILE}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
    try {
      const directory = await fs.open(rootDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Atomic rename remains valid on filesystems that cannot fsync a dir.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withMutationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = predecessor.catch(() => undefined).then(() => current);
  mutationTails.set(key, queued);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === queued) mutationTails.delete(key);
  }
}

export async function defaultGrokCliAuthChecker(
  input: Readonly<GrokCliAuthCheckInput>,
): Promise<GrokCliAuthCheckResult> {
  const homeStats = await fs.lstat(input.homeDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!homeStats) return { connected: false, reason: "missing" };
  if (homeStats.isSymbolicLink() || !homeStats.isDirectory()) {
    return { connected: false, reason: "unsafe" };
  }
  const authStats = await fs.lstat(input.authFile).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!authStats) return { connected: false, reason: "missing" };
  if (
    authStats.isSymbolicLink() ||
    !authStats.isFile() ||
    (process.platform !== "win32" && (authStats.mode & 0o077) !== 0)
  ) {
    return { connected: false, reason: "unsafe" };
  }
  return { connected: true };
}

export class GrokCliAccountProfileStore {
  readonly rootDir: string;
  readonly accountsDir: string;
  readonly filePath: string;
  readonly personalHomeDir: string;
  readonly personalAuthFile: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly authChecker: GrokCliAuthChecker;
  private readonly leases?: GrokCliProfileLeaseView;

  constructor(
    rootDir: string = codaraGrokCliAccountRootDir(),
    options: GrokCliAccountProfileStoreOptions = {},
  ) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Native Grok account root must be a non-empty path");
    }
    this.rootDir = resolve(rootDir);
    this.accountsDir = resolve(this.rootDir, GROK_CLI_ACCOUNTS_DIRECTORY);
    if (dirname(this.accountsDir) !== this.rootDir) {
      throw new GrokCliAccountProfileSafetyError(
        "accounts directory escaped the native Grok root",
      );
    }
    this.filePath = join(this.rootDir, GROK_CLI_ACCOUNT_PROFILES_FILE);
    this.personalHomeDir = resolve(
      options.personalHomeDir?.trim() || defaultPersonalGrokHomeDir(),
    );
    this.personalAuthFile = join(this.personalHomeDir, GROK_CLI_AUTH_FILE);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.authChecker = options.authChecker ?? defaultGrokCliAuthChecker;
    this.leases = options.leases;
  }

  private async ensureStoreDirectories(): Promise<void> {
    await assertSafeDirectory(this.rootDir, { create: true });
    await assertSafeDirectory(this.accountsDir, { create: true });
  }

  /**
   * Managed accounts share the user-state surfaces (sessions, history,
   * config, prompts) with the personal Grok home so switching accounts
   * behaves like logout+login in one home; auth.json stays per-account.
   *
   * Best-effort by design: resolution must never start failing because a
   * symlink could not be made. A leased profile is skipped entirely — every
   * launch resolves BEFORE acquiring its lease, so the first spawn of a
   * profile always healed its directory, and migrating a real directory out
   * from under a live CLI would lose its writes. The per-profile mutation key
   * serializes concurrent resolutions of the same profile without blocking
   * other profiles or the metadata lock.
   */
  private async ensureManagedSharedState(
    profileId: string,
    homeDir: string,
  ): Promise<void> {
    if (process.platform === "win32") return;
    if (this.leases?.isLeased(profileId)) return;
    try {
      await withMutationLock(`${this.filePath}::share::${profileId}`, async () => {
        if (this.leases?.isLeased(profileId)) return;
        await ensureSharedCliState({
          managedDir: homeDir,
          personalDir: this.personalHomeDir,
          runtime: "grok",
        });
      });
    } catch {
      // ensureSharedCliState reports per-name outcomes and never throws; this
      // guard keeps even an unexpected failure out of the launch path.
    }
  }

  private async reconcileLocked(
    snapshot?: GrokCliAccountProfilesSnapshot,
  ): Promise<GrokCliAccountReconciliation> {
    await this.ensureStoreDirectories();
    const current = snapshot ?? (await readSnapshotFromDisk(this.filePath));
    const registered = new Set(current.profiles.map((profile) => profile.id));
    const restoredProfileIds: string[] = [];
    const removedDeletingDirectories: string[] = [];
    const entries = await fs.readdir(this.accountsDir, { withFileTypes: true });
    const stages = entries
      .map((entry) => ({ entry, match: DELETING_DIRECTORY_PATTERN.exec(entry.name) }))
      .filter(
        (
          item,
        ): item is {
          entry: import("node:fs").Dirent;
          match: RegExpExecArray;
        } => item.match !== null,
      )
      .sort((left, right) => left.entry.name.localeCompare(right.entry.name));

    for (const { entry, match } of stages) {
      const profileId = match[1];
      const staged = join(this.accountsDir, entry.name);
      const stagedStats = await fs.lstat(staged);
      if (
        entry.isSymbolicLink() ||
        stagedStats.isSymbolicLink() ||
        !stagedStats.isDirectory()
      ) {
        throw new GrokCliAccountProfileSafetyError(
          "a staged deletion entry is a symlink or not a directory",
        );
      }
      const { homeDir } = grokCliManagedProfilePaths(this.rootDir, profileId);
      if (registered.has(profileId)) {
        const original = await fs.lstat(homeDir).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (!original) {
          await fs.rename(staged, homeDir);
          if (process.platform !== "win32") await fs.chmod(homeDir, 0o700);
          restoredProfileIds.push(profileId);
        } else {
          if (original.isSymbolicLink() || !original.isDirectory()) {
            throw new GrokCliAccountProfileSafetyError(
              "a registered account home is a symlink or not a directory",
            );
          }
          await fs.rm(staged, { recursive: true, force: true });
          removedDeletingDirectories.push(entry.name);
        }
      } else {
        await fs.rm(staged, { recursive: true, force: true });
        removedDeletingDirectories.push(entry.name);
      }
    }

    const refreshed = await fs.readdir(this.accountsDir, { withFileTypes: true });
    const orphanProfileIds: string[] = [];
    for (const entry of refreshed) {
      if (!isGrokCliManagedProfileId(entry.name) || registered.has(entry.name)) {
        continue;
      }
      const path = join(this.accountsDir, entry.name);
      const stats = await fs.lstat(path);
      if (entry.isSymbolicLink() || stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new GrokCliAccountProfileSafetyError(
          "an orphan account entry is a symlink or not a directory",
        );
      }
      // Never delete an orphan automatically; it may be the only copy of a
      // successful Grok login after a metadata-write crash.
      orphanProfileIds.push(entry.name);
    }
    return {
      restoredProfileIds: [...new Set(restoredProfileIds)].sort(),
      removedDeletingDirectories: removedDeletingDirectories.sort(),
      orphanProfileIds: orphanProfileIds.sort(),
    };
  }

  async reconcile(): Promise<GrokCliAccountReconciliation> {
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      return this.reconcileLocked(snapshot);
    });
  }

  async snapshot(): Promise<GrokCliAccountProfilesSnapshot> {
    await this.ensureStoreDirectories();
    return cloneSnapshot(await readSnapshotFromDisk(this.filePath));
  }

  async inspect(): Promise<GrokCliAccountInspection> {
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const reconciliation = await this.reconcileLocked(snapshot);
      const profiles: GrokCliProfileConnection[] = [];
      const candidates: Array<{
        id: GrokCliProfileId;
        label: string;
        managed: boolean;
        homeDir: string;
        authFile: string;
      }> = [
        {
          id: GROK_CLI_PERSONAL_PROFILE_ID,
          label: "Account 1",
          managed: false,
          homeDir: dirname(this.personalAuthFile),
          authFile: this.personalAuthFile,
        },
        ...snapshot.profiles.map((profile) => {
          const paths = grokCliManagedProfilePaths(this.rootDir, profile.id);
          return {
            id: profile.id,
            label: profile.label,
            managed: true,
            ...paths,
          };
        }),
      ];
      for (const candidate of candidates) {
        let status: GrokCliAuthCheckResult;
        try {
          status = await this.authChecker({
            profileId: candidate.id,
            managed: candidate.managed,
            homeDir: candidate.homeDir,
            authFile: candidate.authFile,
          });
        } catch {
          status = { connected: false, reason: "unsafe" };
        }
        profiles.push({
          id: candidate.id,
          label: candidate.label,
          managed: candidate.managed,
          isDefault: candidate.id === snapshot.defaultProfileId,
          connected: status.connected === true,
          inUse: this.leases?.isLeased(candidate.id) ?? false,
          ...(!status.connected
            ? {
                error:
                  status.reason === "unsafe"
                    ? ("Credential file is unsafe" as const)
                    : ("Sign in required" as const),
              }
            : {}),
        });
      }
      return {
        profiles,
        defaultProfileId: snapshot.defaultProfileId,
        reconciliation,
      };
    });
  }

  async createProfile(
    input: CreateGrokCliProfileInput,
  ): Promise<CreateGrokCliProfileResult> {
    const label = normalizeLabel(input.label);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      let snapshot = await readSnapshotFromDisk(this.filePath);
      await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const existingIds = new Set(snapshot.profiles.map((profile) => profile.id));
      let id: string | null = null;
      let homeDir: string | null = null;
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        const candidate = this.idFactory();
        if (!isGrokCliManagedProfileId(candidate)) {
          throw new TypeError("Generated native Grok profile id must be a lowercase UUIDv4");
        }
        if (existingIds.has(candidate)) continue;
        const paths = grokCliManagedProfilePaths(this.rootDir, candidate);
        const exists = await fs.lstat(paths.homeDir).then(() => true).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!exists) {
          id = candidate;
          homeDir = paths.homeDir;
          break;
        }
      }
      if (!id || !homeDir) throw new GrokCliAccountProfileIdCollisionError();

      await fs.mkdir(homeDir, { mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(homeDir, 0o700);
      // A fresh directory takes the pure "managed entry missing" branch of
      // the heal: every shared name becomes a link before first use.
      await this.ensureManagedSharedState(id, homeDir);
      const timestamp = this.now().toISOString();
      const profile: GrokCliManagedProfile = {
        id,
        label,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot.profiles.push(profile);
      try {
        await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      } catch (error) {
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { profile: cloneProfile(profile), snapshot: cloneSnapshot(snapshot) };
    });
  }

  async renameProfile(
    rawProfileId: string,
    labelInput: string,
  ): Promise<GrokCliManagedProfile> {
    if (!isGrokCliManagedProfileId(rawProfileId)) {
      throw new TypeError("Only a managed native Grok profile can be renamed");
    }
    const label = normalizeLabel(labelInput);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex(
        (profile) => profile.id === rawProfileId,
      );
      if (index < 0) throw new GrokCliAccountProfileNotFoundError(rawProfileId);
      const current = snapshot.profiles[index];
      if (current.label === label) return cloneProfile(current);
      const clockNow = this.now().toISOString();
      const profile = {
        ...current,
        label,
        updatedAt: clockNow > current.updatedAt ? clockNow : current.updatedAt,
      };
      snapshot.profiles[index] = profile;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneProfile(profile);
    });
  }

  async setDefaultProfile(
    rawProfileId: string | null | undefined,
  ): Promise<GrokCliAccountProfilesSnapshot> {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      if (
        profileId !== GROK_CLI_PERSONAL_PROFILE_ID &&
        !snapshot.profiles.some((profile) => profile.id === profileId)
      ) {
        throw new GrokCliAccountProfileNotFoundError(profileId);
      }
      if (profileId !== GROK_CLI_PERSONAL_PROFILE_ID) {
        const { homeDir, authFile } = grokCliManagedProfilePaths(
          this.rootDir,
          profileId,
        );
        const status = await Promise.resolve(
          this.authChecker({
            profileId,
            managed: true,
            homeDir,
            authFile,
          }),
        ).catch(() => ({ connected: false, reason: "unsafe" as const }));
        if (!status.connected) {
          throw new Error("A native Grok account must be connected before it can be default");
        }
      }
      if (snapshot.defaultProfileId === profileId) return cloneSnapshot(snapshot);
      // Changing the default is safe while another profile is leased: leases
      // freeze exact ids, and the default affects only future resolutions.
      snapshot.defaultProfileId = profileId;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  async resolveProfile(
    input: ResolveGrokCliProfileInput = {},
  ): Promise<GrokCliResolvedProfile> {
    await this.ensureStoreDirectories();
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profileId =
      input.profileId === undefined ||
      input.profileId === null ||
      input.profileId === ""
        ? input.useDefault
          ? snapshot.defaultProfileId
          : GROK_CLI_PERSONAL_PROFILE_ID
        : normalizeGrokCliProfileId(input.profileId);
    let label = "Account 1";
    let managed = false;
    let homeDir = dirname(this.personalAuthFile);
    let authFile = this.personalAuthFile;
    if (profileId !== GROK_CLI_PERSONAL_PROFILE_ID) {
      const profile = snapshot.profiles.find((entry) => entry.id === profileId);
      if (!profile) throw new GrokCliAccountProfileNotFoundError(profileId);
      label = profile.label;
      managed = true;
      ({ homeDir, authFile } = grokCliManagedProfilePaths(this.rootDir, profileId));
      await assertSafeDirectory(homeDir, { create: false });
      await this.ensureManagedSharedState(profileId, homeDir);
    }
    const status = await Promise.resolve(
      this.authChecker({
        profileId,
        managed,
        homeDir,
        authFile,
      }),
    ).catch(() => ({ connected: false, reason: "unsafe" as const }));
    if (input.requireConnected && !status.connected) {
      throw new Error("Selected native Grok account is not connected");
    }
    return {
      profileId,
      label,
      managed,
      homeDir,
      authFile,
      connected: status.connected === true,
    };
  }

  async deleteProfile(
    rawProfileId: string,
  ): Promise<DeleteGrokCliProfileResult> {
    if (!isGrokCliManagedProfileId(rawProfileId)) {
      if (rawProfileId === GROK_CLI_PERSONAL_PROFILE_ID) {
        throw new TypeError("The existing personal Grok home cannot be deleted");
      }
      throw new TypeError("Managed native Grok profile id must be a lowercase UUIDv4");
    }
    const mutate = () => withMutationLock(this.filePath, async () => {
      let snapshot = await readSnapshotFromDisk(this.filePath);
      await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const target = snapshot.profiles.find((profile) => profile.id === rawProfileId);
      if (!target) return { deleted: false, snapshot: cloneSnapshot(snapshot) };
      if (snapshot.defaultProfileId === rawProfileId) {
        throw new GrokCliDefaultProfileDeletionError(rawProfileId);
      }
      if (this.leases?.isLeased(rawProfileId)) {
        throw new GrokCliAccountProfileLeasedError(rawProfileId);
      }

      // Serialize against the shared-state heal for this profile: a heal
      // mid-migration keeps rollouts in a temporary stage inside the home,
      // and deleting the home in that window would destroy state the heal
      // was moving into the personal ~/.grok.
      return withMutationLock(
        `${this.filePath}::share::${rawProfileId}`,
        async () => {
          const { homeDir } = grokCliManagedProfilePaths(this.rootDir, rawProfileId);
          const staged = join(
            this.accountsDir,
            `.${rawProfileId}.deleting-${randomBytes(8).toString("hex")}`,
          );
          const homeStats = await fs.lstat(homeDir).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (homeStats && (homeStats.isSymbolicLink() || !homeStats.isDirectory())) {
            throw new GrokCliAccountProfileSafetyError(
              "the account home selected for deletion is unsafe",
            );
          }
          if (homeStats) await fs.rename(homeDir, staged);
          const next: GrokCliAccountProfilesSnapshot = {
            ...snapshot,
            profiles: snapshot.profiles.filter((profile) => profile.id !== rawProfileId),
          };
          try {
            await persistSnapshotAtomically(this.rootDir, this.filePath, next);
          } catch (error) {
            if (homeStats) await fs.rename(staged, homeDir).catch(() => undefined);
            throw error;
          }
          if (homeStats) await fs.rm(staged, { recursive: true, force: true });
          return { deleted: true, snapshot: cloneSnapshot(next) };
        },
      );
    });
    if (this.leases?.runWhileUnleased) {
      return this.leases.runWhileUnleased(rawProfileId, mutate);
    }
    if (this.leases?.isLeased(rawProfileId)) {
      throw new GrokCliAccountProfileLeasedError(rawProfileId);
    }
    return mutate();
  }
}
