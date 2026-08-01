import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CODARA_CODEX_CLI_DIRNAME,
  codaraHomeDir,
  isCodaraManagedCliPath,
} from "./codara-managed-cli-roots";

export const CODEX_CLI_PERSONAL_PROFILE_ID = "personal" as const;
export const CODEX_CLI_ACCOUNT_PROFILES_VERSION = 1 as const;
export const CODEX_CLI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const CODEX_CLI_ACCOUNTS_DIRECTORY = "accounts";
export const CODEX_CLI_AUTH_FILE = "auth.json";
export const CODEX_CLI_PROFILE_LABEL_MAX_LENGTH = 80;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_KEYS = new Set(["id", "label", "createdAt", "updatedAt"]);
const ROOT_KEYS = new Set(["version", "profiles", "defaultProfileId"]);
const MAX_ID_GENERATION_ATTEMPTS = 32;
const DELETING_DIRECTORY_PATTERN =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.deleting-([0-9a-f]+)$/;

const mutationTails = new Map<string, Promise<void>>();

export type CodexCliProfileId =
  | typeof CODEX_CLI_PERSONAL_PROFILE_ID
  | string;

export interface CodexCliManagedProfile {
  /** Opaque UUIDv4. Never derived from a provider identity or credential. */
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexCliAccountProfilesSnapshot {
  version: typeof CODEX_CLI_ACCOUNT_PROFILES_VERSION;
  profiles: CodexCliManagedProfile[];
  defaultProfileId: CodexCliProfileId;
}

export interface CodexCliProfileConnection {
  /** Opaque local id. `personal` is the synthetic pre-feature Codex home. */
  id: CodexCliProfileId;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  inUse: boolean;
  error?: "Sign in required" | "Credential file is unsafe";
}

export type CodexCliAuthCheckReason = "missing" | "unsafe";

export interface CodexCliAuthCheckResult {
  connected: boolean;
  reason?: CodexCliAuthCheckReason;
}

export interface CodexCliAuthCheckInput {
  profileId: CodexCliProfileId;
  managed: boolean;
  homeDir: string;
  authFile: string;
}

export type CodexCliAuthChecker = (
  input: Readonly<CodexCliAuthCheckInput>,
) => CodexCliAuthCheckResult | Promise<CodexCliAuthCheckResult>;

export interface CodexCliProfileLeaseView {
  isLeased(profileId: CodexCliProfileId): boolean;
  /**
   * Optional atomic guard supplied by the production lease registry. It
   * closes the check→rename race: no new launch can acquire this profile
   * while a destructive mutation is in flight.
   */
  runWhileUnleased?<T>(
    profileId: CodexCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface CodexCliAccountProfileStoreOptions {
  /** Existing Codex home represented by the synthetic `personal` profile. */
  personalHomeDir?: string;
  /** Test seam. Production uses cryptographically random UUIDv4 values. */
  idFactory?: () => string;
  /** Test seam. */
  now?: () => Date;
  /**
   * Token-blind auth inspection. The default only lstat(2)s auth.json and
   * checks its mode; it never reads credential bytes.
   */
  authChecker?: CodexCliAuthChecker;
  /** Process-local live native-Codex ownership guard. */
  leases?: CodexCliProfileLeaseView;
}

export interface CodexCliAccountInspection {
  profiles: CodexCliProfileConnection[];
  defaultProfileId: CodexCliProfileId;
  reconciliation: CodexCliAccountReconciliation;
}

export interface CodexCliAccountReconciliation {
  restoredProfileIds: string[];
  removedDeletingDirectories: string[];
  /** Preserved rather than deleted: an orphan may contain a valid login. */
  orphanProfileIds: string[];
}

export interface CodexCliResolvedProfile {
  profileId: CodexCliProfileId;
  label: string;
  managed: boolean;
  /** Main-process-only path. Never place this object on IPC/RPC surfaces. */
  homeDir: string;
  /** Main-process-only path. */
  authFile: string;
  connected: boolean;
}

export interface ResolveCodexCliProfileInput {
  /**
   * Absent/null/empty is legacy data and therefore means `personal`.
   * New-session callers that want the configured default must opt in with
   * useDefault=true, removing ambiguity from persisted ownership.
   */
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
}

export interface CreateCodexCliProfileInput {
  label: string;
}

export interface CreateCodexCliProfileResult {
  profile: CodexCliManagedProfile;
  snapshot: CodexCliAccountProfilesSnapshot;
}

export interface DeleteCodexCliProfileResult {
  deleted: boolean;
  snapshot: CodexCliAccountProfilesSnapshot;
}

export class CodexCliAccountProfilesCorruptError extends Error {
  constructor(message: string) {
    super(`Invalid native Codex account profile registry: ${message}`);
    this.name = "CodexCliAccountProfilesCorruptError";
  }
}

export class CodexCliAccountProfileSafetyError extends Error {
  constructor(message: string) {
    super(`Unsafe native Codex account store: ${message}`);
    this.name = "CodexCliAccountProfileSafetyError";
  }
}

export class CodexCliAccountProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Native Codex account profile not found: ${profileId}`);
    this.name = "CodexCliAccountProfileNotFoundError";
  }
}

export class CodexCliAccountProfileLeasedError extends Error {
  readonly profileId: CodexCliProfileId;

  constructor(profileId: CodexCliProfileId) {
    super(`Native Codex account profile is active and cannot be deleted: ${profileId}`);
    this.name = "CodexCliAccountProfileLeasedError";
    this.profileId = profileId;
  }
}

export class CodexCliDefaultProfileDeletionError extends Error {
  constructor(profileId: string) {
    super(
      `Native Codex account profile is the current default; choose another default before deleting ${profileId}`,
    );
    this.name = "CodexCliDefaultProfileDeletionError";
  }
}

export class CodexCliAccountProfileIdCollisionError extends Error {
  constructor() {
    super(
      `Unable to allocate a unique native Codex account profile id after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
    );
    this.name = "CodexCliAccountProfileIdCollisionError";
  }
}

export function codaraCodexCliAccountRootDir(): string {
  return join(codaraHomeDir(), CODARA_CODEX_CLI_DIRNAME);
}

/**
 * A retired feature exported CODEX_HOME from the user's shell profile, so a
 * Studio launched from a shell that still carries that export inherits a
 * selector that names a Codara-managed directory. That is never the user's own
 * login (see codara-managed-cli-roots.ts); a custom directory outside Codara's
 * roots still is.
 */
export function defaultPersonalCodexHomeDir(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) return resolve(configured);
  return resolve(join(homedir(), ".codex"));
}

export function isCodexCliManagedProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function normalizeCodexCliProfileId(
  value: unknown,
  label = "Native Codex account profile id",
): CodexCliProfileId {
  if (value === undefined || value === null || value === "") {
    return CODEX_CLI_PERSONAL_PROFILE_ID;
  }
  if (value === CODEX_CLI_PERSONAL_PROFILE_ID || isCodexCliManagedProfileId(value)) {
    return value;
  }
  throw new TypeError(`${label} must be "personal" or a lowercase UUIDv4`);
}

export function codexCliManagedProfilePaths(
  rootDir: string,
  rawProfileId: string,
): { homeDir: string; authFile: string } {
  if (!isCodexCliManagedProfileId(rawProfileId)) {
    throw new TypeError("Managed native Codex profile id must be a lowercase UUIDv4");
  }
  const accountsDir = resolve(rootDir, CODEX_CLI_ACCOUNTS_DIRECTORY);
  const homeDir = resolve(accountsDir, rawProfileId);
  if (dirname(homeDir) !== accountsDir || basename(homeDir) !== rawProfileId) {
    throw new CodexCliAccountProfileSafetyError("profile path escaped the accounts directory");
  }
  return { homeDir, authFile: join(homeDir, CODEX_CLI_AUTH_FILE) };
}

function emptySnapshot(): CodexCliAccountProfilesSnapshot {
  return {
    version: CODEX_CLI_ACCOUNT_PROFILES_VERSION,
    profiles: [],
    defaultProfileId: CODEX_CLI_PERSONAL_PROFILE_ID,
  };
}

function cloneProfile(profile: CodexCliManagedProfile): CodexCliManagedProfile {
  return { ...profile };
}

function cloneSnapshot(
  snapshot: CodexCliAccountProfilesSnapshot,
): CodexCliAccountProfilesSnapshot {
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
    throw new CodexCliAccountProfilesCorruptError(
      `${context} contains unexpected field "${unexpected}"`,
    );
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Native Codex account label must be a string");
  }
  const label = value.trim();
  if (!label) throw new TypeError("Native Codex account label cannot be empty");
  if (label.length > CODEX_CLI_PROFILE_LABEL_MAX_LENGTH) {
    throw new TypeError(
      `Native Codex account label cannot exceed ${CODEX_CLI_PROFILE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    throw new TypeError("Native Codex account label cannot contain control characters");
  }
  return label;
}

function assertCanonicalTimestamp(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string") {
    throw new CodexCliAccountProfilesCorruptError(`${context} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CodexCliAccountProfilesCorruptError(
      `${context} must be a canonical ISO timestamp`,
    );
  }
}

function parseSnapshot(value: unknown): CodexCliAccountProfilesSnapshot {
  if (!isRecord(value)) {
    throw new CodexCliAccountProfilesCorruptError("root must be an object");
  }
  assertOnlyKeys(value, ROOT_KEYS, "root");
  if (value.version !== CODEX_CLI_ACCOUNT_PROFILES_VERSION) {
    throw new CodexCliAccountProfilesCorruptError(
      `unsupported version ${String(value.version)}`,
    );
  }
  if (!Array.isArray(value.profiles)) {
    throw new CodexCliAccountProfilesCorruptError("profiles must be an array");
  }

  const profiles: CodexCliManagedProfile[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new CodexCliAccountProfilesCorruptError(
        `profiles[${index}] must be an object`,
      );
    }
    assertOnlyKeys(raw, PROFILE_KEYS, `profiles[${index}]`);
    if (!isCodexCliManagedProfileId(raw.id)) {
      throw new CodexCliAccountProfilesCorruptError(
        `profiles[${index}].id must be a lowercase UUIDv4`,
      );
    }
    if (ids.has(raw.id)) {
      throw new CodexCliAccountProfilesCorruptError(`duplicate profile id "${raw.id}"`);
    }
    let label: string;
    try {
      label = normalizeLabel(raw.label);
    } catch (error) {
      throw new CodexCliAccountProfilesCorruptError(
        `profiles[${index}].label is invalid: ${(error as Error).message}`,
      );
    }
    if (label !== raw.label) {
      throw new CodexCliAccountProfilesCorruptError(
        `profiles[${index}].label must already be trimmed`,
      );
    }
    assertCanonicalTimestamp(raw.createdAt, `profiles[${index}].createdAt`);
    assertCanonicalTimestamp(raw.updatedAt, `profiles[${index}].updatedAt`);
    if (raw.updatedAt < raw.createdAt) {
      throw new CodexCliAccountProfilesCorruptError(
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

  let defaultProfileId: CodexCliProfileId;
  try {
    defaultProfileId = normalizeCodexCliProfileId(
      value.defaultProfileId,
      "defaultProfileId",
    );
  } catch (error) {
    throw new CodexCliAccountProfilesCorruptError(
      `defaultProfileId is invalid: ${(error as Error).message}`,
    );
  }
  if (
    defaultProfileId !== CODEX_CLI_PERSONAL_PROFILE_ID &&
    !profiles.some((profile) => profile.id === defaultProfileId)
  ) {
    throw new CodexCliAccountProfilesCorruptError(
      "defaultProfileId must reference a managed profile or personal",
    );
  }
  return {
    version: CODEX_CLI_ACCOUNT_PROFILES_VERSION,
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
    throw new CodexCliAccountProfileSafetyError(
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
    throw new CodexCliAccountProfileSafetyError("required account-store file is missing");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexCliAccountProfileSafetyError(
      "an account-store file is a symlink or not a regular file",
    );
  }
  if (
    options.requirePrivate &&
    process.platform !== "win32" &&
    (stats.mode & 0o077) !== 0
  ) {
    throw new CodexCliAccountProfileSafetyError(
      "an account-store file is readable by group or other users",
    );
  }
  return true;
}

async function readSnapshotFromDisk(
  filePath: string,
): Promise<CodexCliAccountProfilesSnapshot> {
  const exists = await assertSafeRegularFile(filePath, {
    allowMissing: true,
    requirePrivate: true,
  });
  if (!exists) return emptySnapshot();
  try {
    return parseSnapshot(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof CodexCliAccountProfilesCorruptError) throw error;
    if (error instanceof SyntaxError) {
      throw new CodexCliAccountProfilesCorruptError(
        `file is not valid JSON: ${error.message}`,
      );
    }
    throw error;
  }
}

async function persistSnapshotAtomically(
  rootDir: string,
  filePath: string,
  snapshot: CodexCliAccountProfilesSnapshot,
): Promise<void> {
  await assertSafeDirectory(rootDir, { create: true });
  await assertSafeRegularFile(filePath, {
    allowMissing: true,
    requirePrivate: true,
  });
  const temporaryPath = join(
    rootDir,
    `.${CODEX_CLI_ACCOUNT_PROFILES_FILE}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
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

export async function defaultCodexCliAuthChecker(
  input: Readonly<CodexCliAuthCheckInput>,
): Promise<CodexCliAuthCheckResult> {
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

export class CodexCliAccountProfileStore {
  readonly rootDir: string;
  readonly accountsDir: string;
  readonly filePath: string;
  readonly personalHomeDir: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly authChecker: CodexCliAuthChecker;
  private readonly leases?: CodexCliProfileLeaseView;

  constructor(
    rootDir: string = codaraCodexCliAccountRootDir(),
    options: CodexCliAccountProfileStoreOptions = {},
  ) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Native Codex account root must be a non-empty path");
    }
    this.rootDir = resolve(rootDir);
    this.accountsDir = resolve(this.rootDir, CODEX_CLI_ACCOUNTS_DIRECTORY);
    if (dirname(this.accountsDir) !== this.rootDir) {
      throw new CodexCliAccountProfileSafetyError(
        "accounts directory escaped the native Codex root",
      );
    }
    this.filePath = join(this.rootDir, CODEX_CLI_ACCOUNT_PROFILES_FILE);
    this.personalHomeDir = resolve(
      options.personalHomeDir?.trim() || defaultPersonalCodexHomeDir(),
    );
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.authChecker = options.authChecker ?? defaultCodexCliAuthChecker;
    this.leases = options.leases;
  }

  private async ensureStoreDirectories(): Promise<void> {
    await assertSafeDirectory(this.rootDir, { create: true });
    await assertSafeDirectory(this.accountsDir, { create: true });
  }

  private async reconcileLocked(
    snapshot?: CodexCliAccountProfilesSnapshot,
  ): Promise<CodexCliAccountReconciliation> {
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
        throw new CodexCliAccountProfileSafetyError(
          "a staged deletion entry is a symlink or not a directory",
        );
      }
      const { homeDir } = codexCliManagedProfilePaths(this.rootDir, profileId);
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
            throw new CodexCliAccountProfileSafetyError(
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
      if (!isCodexCliManagedProfileId(entry.name) || registered.has(entry.name)) {
        continue;
      }
      const path = join(this.accountsDir, entry.name);
      const stats = await fs.lstat(path);
      if (entry.isSymbolicLink() || stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new CodexCliAccountProfileSafetyError(
          "an orphan account entry is a symlink or not a directory",
        );
      }
      // Never delete an orphan automatically; it may be the only copy of a
      // successful Codex login after a metadata-write crash.
      orphanProfileIds.push(entry.name);
    }
    return {
      restoredProfileIds: [...new Set(restoredProfileIds)].sort(),
      removedDeletingDirectories: removedDeletingDirectories.sort(),
      orphanProfileIds: orphanProfileIds.sort(),
    };
  }

  async reconcile(): Promise<CodexCliAccountReconciliation> {
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      return this.reconcileLocked(snapshot);
    });
  }

  async snapshot(): Promise<CodexCliAccountProfilesSnapshot> {
    await this.ensureStoreDirectories();
    return cloneSnapshot(await readSnapshotFromDisk(this.filePath));
  }

  async inspect(): Promise<CodexCliAccountInspection> {
    return withMutationLock(this.filePath, async () => {
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const reconciliation = await this.reconcileLocked(snapshot);
      const profiles: CodexCliProfileConnection[] = [];
      const candidates: Array<{
        id: CodexCliProfileId;
        label: string;
        managed: boolean;
        homeDir: string;
        authFile: string;
      }> = [
        {
          id: CODEX_CLI_PERSONAL_PROFILE_ID,
          label: "Existing Codex login",
          managed: false,
          homeDir: this.personalHomeDir,
          authFile: join(this.personalHomeDir, CODEX_CLI_AUTH_FILE),
        },
        ...snapshot.profiles.map((profile) => {
          const paths = codexCliManagedProfilePaths(this.rootDir, profile.id);
          return {
            id: profile.id,
            label: profile.label,
            managed: true,
            ...paths,
          };
        }),
      ];
      for (const candidate of candidates) {
        let status: CodexCliAuthCheckResult;
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
    input: CreateCodexCliProfileInput,
  ): Promise<CreateCodexCliProfileResult> {
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
        if (!isCodexCliManagedProfileId(candidate)) {
          throw new TypeError("Generated native Codex profile id must be a lowercase UUIDv4");
        }
        if (existingIds.has(candidate)) continue;
        const paths = codexCliManagedProfilePaths(this.rootDir, candidate);
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
      if (!id || !homeDir) throw new CodexCliAccountProfileIdCollisionError();

      await fs.mkdir(homeDir, { mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(homeDir, 0o700);
      const timestamp = this.now().toISOString();
      const profile: CodexCliManagedProfile = {
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
  ): Promise<CodexCliManagedProfile> {
    if (!isCodexCliManagedProfileId(rawProfileId)) {
      throw new TypeError("Only a managed native Codex profile can be renamed");
    }
    const label = normalizeLabel(labelInput);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex(
        (profile) => profile.id === rawProfileId,
      );
      if (index < 0) throw new CodexCliAccountProfileNotFoundError(rawProfileId);
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
  ): Promise<CodexCliAccountProfilesSnapshot> {
    const profileId = normalizeCodexCliProfileId(rawProfileId);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      if (
        profileId !== CODEX_CLI_PERSONAL_PROFILE_ID &&
        !snapshot.profiles.some((profile) => profile.id === profileId)
      ) {
        throw new CodexCliAccountProfileNotFoundError(profileId);
      }
      if (profileId !== CODEX_CLI_PERSONAL_PROFILE_ID) {
        const { homeDir, authFile } = codexCliManagedProfilePaths(
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
          throw new Error("A native Codex account must be connected before it can be default");
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
    input: ResolveCodexCliProfileInput = {},
  ): Promise<CodexCliResolvedProfile> {
    await this.ensureStoreDirectories();
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profileId =
      input.profileId === undefined ||
      input.profileId === null ||
      input.profileId === ""
        ? input.useDefault
          ? snapshot.defaultProfileId
          : CODEX_CLI_PERSONAL_PROFILE_ID
        : normalizeCodexCliProfileId(input.profileId);
    let label = "Existing Codex login";
    let managed = false;
    let homeDir = this.personalHomeDir;
    let authFile = join(homeDir, CODEX_CLI_AUTH_FILE);
    if (profileId !== CODEX_CLI_PERSONAL_PROFILE_ID) {
      const profile = snapshot.profiles.find((entry) => entry.id === profileId);
      if (!profile) throw new CodexCliAccountProfileNotFoundError(profileId);
      label = profile.label;
      managed = true;
      ({ homeDir, authFile } = codexCliManagedProfilePaths(this.rootDir, profileId));
      await assertSafeDirectory(homeDir, { create: false });
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
      throw new Error("Selected native Codex account is not connected");
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
  ): Promise<DeleteCodexCliProfileResult> {
    if (!isCodexCliManagedProfileId(rawProfileId)) {
      if (rawProfileId === CODEX_CLI_PERSONAL_PROFILE_ID) {
        throw new TypeError("The existing personal Codex home cannot be deleted");
      }
      throw new TypeError("Managed native Codex profile id must be a lowercase UUIDv4");
    }
    const mutate = () => withMutationLock(this.filePath, async () => {
      let snapshot = await readSnapshotFromDisk(this.filePath);
      await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const target = snapshot.profiles.find((profile) => profile.id === rawProfileId);
      if (!target) return { deleted: false, snapshot: cloneSnapshot(snapshot) };
      if (snapshot.defaultProfileId === rawProfileId) {
        throw new CodexCliDefaultProfileDeletionError(rawProfileId);
      }
      if (this.leases?.isLeased(rawProfileId)) {
        throw new CodexCliAccountProfileLeasedError(rawProfileId);
      }

      const { homeDir } = codexCliManagedProfilePaths(this.rootDir, rawProfileId);
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
        throw new CodexCliAccountProfileSafetyError(
          "the account home selected for deletion is unsafe",
        );
      }
      if (homeStats) await fs.rename(homeDir, staged);
      const next: CodexCliAccountProfilesSnapshot = {
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
    });
    if (this.leases?.runWhileUnleased) {
      return this.leases.runWhileUnleased(rawProfileId, mutate);
    }
    if (this.leases?.isLeased(rawProfileId)) {
      throw new CodexCliAccountProfileLeasedError(rawProfileId);
    }
    return mutate();
  }
}
