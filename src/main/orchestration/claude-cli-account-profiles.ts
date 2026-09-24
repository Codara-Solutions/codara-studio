import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildClaudeCliProfileEnvironment } from "./claude-cli-profile-environment";
import {
  CODARA_CLAUDE_CLI_DIRNAME,
  codaraHomeDir,
  isCodaraManagedCliPath,
} from "./codara-managed-cli-roots";
import {
  CLAUDE_CLI_ACCOUNTS_DIRECTORY,
  CLAUDE_CLI_CONFIG_FILE,
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  isClaudeCliManagedProfileId,
  normalizeClaudeCliProfileId,
  type ClaudeCliProfileId,
} from "./claude-cli-profile-ids";
import { readClaudeProfileLogin } from "./claude-cli-live-login";

export {
  CLAUDE_CLI_ACCOUNTS_DIRECTORY,
  CLAUDE_CLI_CONFIG_FILE,
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  isClaudeCliManagedProfileId,
  normalizeClaudeCliProfileId,
  type ClaudeCliProfileId,
};

const execFileAsync = promisify(execFile);

export const CLAUDE_CLI_ACCOUNT_PROFILES_VERSION = 1 as const;
export const CLAUDE_CLI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const CLAUDE_CLI_PROFILE_LABEL_MAX_LENGTH = 80;

/** Refuse to parse an implausibly large config rather than stall. */
const CONFIG_MAX_BYTES = 32 * 1024 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_KEYS = new Set(["id", "label", "createdAt", "updatedAt"]);
const ROOT_KEYS = new Set(["version", "profiles", "defaultProfileId"]);
const MAX_ID_GENERATION_ATTEMPTS = 32;
const AUTH_STATUS_TIMEOUT_MS = 5_000;
const AUTH_STATUS_MAX_BUFFER_BYTES = 16 * 1024;
const DELETING_DIRECTORY_PATTERN =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.deleting-([0-9a-f]+)$/;

const mutationTails = new Map<string, Promise<void>>();

function normalizeManagedClaudePath(value: string): string {
  // Claude Code 2.1.220 derives the macOS Keychain namespace from the
  // NFC-normalized config-directory path. Persist and reuse that same spelling
  // for Codara-owned roots so a decomposed Unicode path cannot select a
  // different credential slot after restart.
  return resolve(value).normalize("NFC");
}

export interface ClaudeCliManagedProfile {
  /** Opaque UUIDv4. Never derived from an Anthropic identity or credential. */
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaudeCliAccountProfilesSnapshot {
  version: typeof CLAUDE_CLI_ACCOUNT_PROFILES_VERSION;
  profiles: ClaudeCliManagedProfile[];
  defaultProfileId: ClaudeCliProfileId;
}

export interface ClaudeCliProfileConnection {
  /** Opaque local id. `personal` represents the pre-feature Claude login. */
  id: ClaudeCliProfileId;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  /** The stored access token has lapsed; Claude Code refreshes it on launch. */
  expired: boolean;
  /** A refresh token is present, so an expired access token is not a sign-out. */
  canRefresh: boolean;
  inUse: boolean;
  error?:
    | "Sign in required"
    | "Config directory is unsafe"
    | "Could not verify sign-in";
}

export type ClaudeCliAuthCheckReason = "missing" | "unsafe" | "unavailable";

export interface ClaudeCliAuthCheckResult {
  connected: boolean;
  reason?: ClaudeCliAuthCheckReason;
  /** Raw access-token expiry in epoch ms when the credential reports one. */
  expiresAt?: number | null;
  canRefresh?: boolean;
}

export interface ClaudeCliAuthCheckInput {
  profileId: ClaudeCliProfileId;
  managed: boolean;
  /** The account store root: where the live-login marker and the vaults are. */
  rootDir: string;
  /**
   * Main-process-only. The Claude home every terminal runs in, whichever
   * profile it is launched for. Never expose this object through IPC/RPC.
   */
  configDir: string;
  /**
   * Exact selector for the child. Null means CLAUDE_CONFIG_DIR was
   * originally unset and must remain unset.
   */
  configDirEnv: string | null;
}

export type ClaudeCliAuthChecker = (
  input: Readonly<ClaudeCliAuthCheckInput>,
) => ClaudeCliAuthCheckResult | Promise<ClaudeCliAuthCheckResult>;

export interface ClaudeCliProfileLeaseView {
  isLeased(profileId: ClaudeCliProfileId): boolean;
}

export interface ClaudeCliAccountProfileStoreOptions {
  /** Existing Claude state surface represented by synthetic `personal`. */
  personalConfigDir?: string;
  /**
   * Test/embedding seam for the inherited legacy selector. Omit to snapshot
   * process.env.CLAUDE_CONFIG_DIR; null preserves the legacy unset behavior.
   */
  personalConfigDirEnv?: string | null;
  idFactory?: () => string;
  now?: () => Date;
  /** Token-blind checker; production reads the profile's live or vaulted login. */
  authChecker?: ClaudeCliAuthChecker;
  /** Test/deployment seam for the supported Claude CLI executable. */
  claudeExecutable?: string;
  leases?: ClaudeCliProfileLeaseView;
}

export interface ClaudeCliAccountInspection {
  profiles: ClaudeCliProfileConnection[];
  defaultProfileId: ClaudeCliProfileId;
  reconciliation: ClaudeCliAccountReconciliation;
}

export interface ClaudeCliAccountReconciliation {
  restoredProfileIds: string[];
  removedDeletingDirectories: string[];
  /** Preserved rather than deleted because an orphan may contain a login. */
  orphanProfileIds: string[];
}

export interface ClaudeCliResolvedProfile {
  profileId: ClaudeCliProfileId;
  label: string;
  managed: boolean;
  /** Main-process-only. The one Claude home, for every profile. */
  configDir: string;
  /** Main-process-only; null preserves an originally-unset selector. */
  configDirEnv: string | null;
  connected: boolean;
}

export interface ResolveClaudeCliProfileInput {
  /**
   * Absent/null/empty is legacy persisted data and therefore means personal.
   * New sessions must opt in to the mutable configured default explicitly.
   */
  profileId?: string | null;
  useDefault?: boolean;
  requireConnected?: boolean;
}

export interface CreateClaudeCliProfileInput {
  label: string;
}

export interface CreateClaudeCliProfileResult {
  profile: ClaudeCliManagedProfile;
  snapshot: ClaudeCliAccountProfilesSnapshot;
}

export interface DeleteClaudeCliProfileResult {
  deleted: boolean;
  snapshot: ClaudeCliAccountProfilesSnapshot;
}

export class ClaudeCliAccountProfilesCorruptError extends Error {
  constructor(message: string) {
    super(`Invalid native Claude account profile registry: ${message}`);
    this.name = "ClaudeCliAccountProfilesCorruptError";
  }
}

export class ClaudeCliAccountProfileSafetyError extends Error {
  constructor(message: string) {
    super(`Unsafe native Claude account store: ${message}`);
    this.name = "ClaudeCliAccountProfileSafetyError";
  }
}

export class ClaudeCliAccountProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Native Claude account profile not found: ${profileId}`);
    this.name = "ClaudeCliAccountProfileNotFoundError";
  }
}

export class ClaudeCliAccountProfileLeasedError extends Error {
  readonly profileId: ClaudeCliProfileId;

  constructor(profileId: ClaudeCliProfileId) {
    super(`Native Claude account profile is active and cannot be deleted: ${profileId}`);
    this.name = "ClaudeCliAccountProfileLeasedError";
    this.profileId = profileId;
  }
}

export class ClaudeCliDefaultProfileDeletionError extends Error {
  constructor(profileId: string) {
    super(
      `Native Claude account profile is the current default; choose another default before deleting ${profileId}`,
    );
    this.name = "ClaudeCliDefaultProfileDeletionError";
  }
}

export class ClaudeCliAccountProfileIdCollisionError extends Error {
  constructor() {
    super(
      `Unable to allocate a unique native Claude account profile id after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
    );
    this.name = "ClaudeCliAccountProfileIdCollisionError";
  }
}

export function codaraClaudeCliAccountRootDir(): string {
  return normalizeManagedClaudePath(
    join(codaraHomeDir(), CODARA_CLAUDE_CLI_DIRNAME),
  );
}

/**
 * The inherited selector, but only when it names a directory of the user's
 * own. Studio may have been started from a shell that still points
 * CLAUDE_CONFIG_DIR at a Codara account directory from the per-directory
 * model (see codara-managed-cli-roots.ts); treating that as the user's home
 * would make every terminal run in a retired account directory.
 */
export function defaultPersonalClaudeConfigDirEnv(): string | null {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return null;
  if (isCodaraManagedCliPath(configured)) return null;
  return resolve(configured);
}

export function defaultPersonalClaudeConfigDir(): string {
  return defaultPersonalClaudeConfigDirEnv() ?? resolve(join(homedir(), ".claude"));
}

/**
 * A managed profile's own directory under the account root. It holds the
 * profile's vaulted login; before the one-home model it was also the
 * CLAUDE_CONFIG_DIR its terminals ran in.
 */
export function claudeCliManagedProfileConfigDir(
  rootDir: string,
  rawProfileId: string,
): string {
  if (!isClaudeCliManagedProfileId(rawProfileId)) {
    throw new TypeError("Managed native Claude profile id must be a lowercase UUIDv4");
  }
  const accountsDir = normalizeManagedClaudePath(
    join(rootDir, CLAUDE_CLI_ACCOUNTS_DIRECTORY),
  );
  const configDir = normalizeManagedClaudePath(join(accountsDir, rawProfileId));
  if (dirname(configDir) !== accountsDir || basename(configDir) !== rawProfileId) {
    throw new ClaudeCliAccountProfileSafetyError(
      "profile path escaped the accounts directory",
    );
  }
  return configDir;
}

function emptySnapshot(): ClaudeCliAccountProfilesSnapshot {
  return {
    version: CLAUDE_CLI_ACCOUNT_PROFILES_VERSION,
    profiles: [],
    defaultProfileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
  };
}

function cloneSnapshot(
  snapshot: ClaudeCliAccountProfilesSnapshot,
): ClaudeCliAccountProfilesSnapshot {
  return {
    version: snapshot.version,
    profiles: snapshot.profiles.map((profile) => ({ ...profile })),
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
    throw new ClaudeCliAccountProfilesCorruptError(
      `${context} contains unexpected field "${unexpected}"`,
    );
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Native Claude account label must be a string");
  }
  const label = value.trim();
  if (!label) throw new TypeError("Native Claude account label cannot be empty");
  if (label.length > CLAUDE_CLI_PROFILE_LABEL_MAX_LENGTH) {
    throw new TypeError(
      `Native Claude account label cannot exceed ${CLAUDE_CLI_PROFILE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    throw new TypeError("Native Claude account label cannot contain control characters");
  }
  return label;
}

function assertCanonicalTimestamp(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ClaudeCliAccountProfilesCorruptError(`${context} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ClaudeCliAccountProfilesCorruptError(
      `${context} must be a canonical ISO timestamp`,
    );
  }
}

function parseSnapshot(value: unknown): ClaudeCliAccountProfilesSnapshot {
  if (!isRecord(value)) {
    throw new ClaudeCliAccountProfilesCorruptError("root must be an object");
  }
  assertOnlyKeys(value, ROOT_KEYS, "root");
  if (value.version !== CLAUDE_CLI_ACCOUNT_PROFILES_VERSION) {
    throw new ClaudeCliAccountProfilesCorruptError(
      `unsupported version ${String(value.version)}`,
    );
  }
  if (!Array.isArray(value.profiles)) {
    throw new ClaudeCliAccountProfilesCorruptError("profiles must be an array");
  }

  const profiles: ClaudeCliManagedProfile[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    if (!isRecord(raw)) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `profiles[${index}] must be an object`,
      );
    }
    assertOnlyKeys(raw, PROFILE_KEYS, `profiles[${index}]`);
    if (!isClaudeCliManagedProfileId(raw.id)) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `profiles[${index}].id must be a lowercase UUIDv4`,
      );
    }
    if (ids.has(raw.id)) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `duplicate profile id "${raw.id}"`,
      );
    }
    let label: string;
    try {
      label = normalizeLabel(raw.label);
    } catch (error) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `profiles[${index}].label is invalid: ${(error as Error).message}`,
      );
    }
    if (label !== raw.label) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `profiles[${index}].label must already be trimmed`,
      );
    }
    assertCanonicalTimestamp(raw.createdAt, `profiles[${index}].createdAt`);
    assertCanonicalTimestamp(raw.updatedAt, `profiles[${index}].updatedAt`);
    if (raw.updatedAt < raw.createdAt) {
      throw new ClaudeCliAccountProfilesCorruptError(
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

  let defaultProfileId: ClaudeCliProfileId;
  try {
    defaultProfileId = normalizeClaudeCliProfileId(
      value.defaultProfileId,
      "defaultProfileId",
    );
  } catch (error) {
    throw new ClaudeCliAccountProfilesCorruptError(
      `defaultProfileId is invalid: ${(error as Error).message}`,
    );
  }
  if (
    defaultProfileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID &&
    !profiles.some((profile) => profile.id === defaultProfileId)
  ) {
    throw new ClaudeCliAccountProfilesCorruptError(
      "defaultProfileId must reference a managed profile or personal",
    );
  }
  return {
    version: CLAUDE_CLI_ACCOUNT_PROFILES_VERSION,
    profiles,
    defaultProfileId,
  };
}

async function lstatOrNull(path: string): Promise<import("node:fs").Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function assertSafeDirectory(
  path: string,
  options: {
    create: boolean;
    repairMode: boolean;
    requirePrivate?: boolean;
  },
): Promise<boolean> {
  let stats = await lstatOrNull(path);
  if (!stats && options.create) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    stats = await fs.lstat(path);
  }
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ClaudeCliAccountProfileSafetyError(
      "an account-store directory is a symlink or not a directory",
    );
  }
  if (
    options.requirePrivate !== false &&
    process.platform !== "win32" &&
    (stats.mode & 0o077) !== 0
  ) {
    if (!options.repairMode) {
      throw new ClaudeCliAccountProfileSafetyError(
        "an account-store directory is accessible by group or other users",
      );
    }
    await fs.chmod(path, 0o700);
  }
  return true;
}

async function assertSafeRegularFile(
  path: string,
  options: { allowMissing: boolean },
): Promise<boolean> {
  const stats = await lstatOrNull(path);
  if (!stats) {
    if (options.allowMissing) return false;
    throw new ClaudeCliAccountProfileSafetyError("required account-store file is missing");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ClaudeCliAccountProfileSafetyError(
      "an account-store file is a symlink or not a regular file",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new ClaudeCliAccountProfileSafetyError(
      "an account-store file is readable by group or other users",
    );
  }
  return true;
}

async function readSnapshotFromDisk(
  filePath: string,
): Promise<ClaudeCliAccountProfilesSnapshot> {
  const exists = await assertSafeRegularFile(filePath, { allowMissing: true });
  if (!exists) return emptySnapshot();
  try {
    return parseSnapshot(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof ClaudeCliAccountProfilesCorruptError) throw error;
    if (error instanceof SyntaxError) {
      throw new ClaudeCliAccountProfilesCorruptError(
        `file is not valid JSON: ${error.message}`,
      );
    }
    throw error;
  }
}

async function persistSnapshotAtomically(
  rootDir: string,
  filePath: string,
  snapshot: ClaudeCliAccountProfilesSnapshot,
): Promise<void> {
  await assertSafeDirectory(rootDir, { create: true, repairMode: true });
  await assertSafeRegularFile(filePath, { allowMissing: true });
  const temporaryPath = join(
    rootDir,
    `.${CLAUDE_CLI_ACCOUNT_PROFILES_FILE}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
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
      // Atomic rename remains valid where directory fsync is unavailable.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a JSON object, or null for anything missing, unsafe, or unparseable. */
async function readJsonRecordIfSafe(
  path: string,
): Promise<Record<string, unknown> | null> {
  const stats = await lstatOrNull(path).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null;
  if (stats.size > CONFIG_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writePrivateJsonFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/** Atomic replacement of a private JSON file that may already exist. */
async function replacePrivateJsonFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writePrivateJsonFile(temporary, value);
    await fs.rename(temporary, path);
    if (process.platform !== "win32") await fs.chmod(path, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface ManagedClaudeIdentity {
  accountUuid: string;
  emailAddress?: string;
  organizationUuid?: string;
}

/**
 * Records which Anthropic account a Claude config directory holds, the way
 * Claude Code records it after its own login (`oauthAccount` in
 * .claude.json). Every other key in the file is kept as is.
 */
export async function writeManagedClaudeIdentity(
  configDir: string,
  identity: ManagedClaudeIdentity,
): Promise<void> {
  if (typeof identity.accountUuid !== "string" || !identity.accountUuid.trim()) {
    throw new TypeError("Managed Claude identity requires an account uuid");
  }
  const configPath = join(configDir, CLAUDE_CLI_CONFIG_FILE);
  const existing = (await readJsonRecordIfSafe(configPath)) ?? {};
  const previous = isRecord(existing.oauthAccount) ? existing.oauthAccount : {};
  const oauthAccount: Record<string, unknown> = {
    ...previous,
    accountUuid: identity.accountUuid.trim().toLowerCase(),
    ...(identity.emailAddress ? { emailAddress: identity.emailAddress } : {}),
    ...(identity.organizationUuid
      ? { organizationUuid: identity.organizationUuid }
      : {}),
  };
  await replacePrivateJsonFile(configPath, { ...existing, oauthAccount });
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

function parseLoggedInOnly(output: unknown): boolean | null {
  const text =
    typeof output === "string"
      ? output
      : Buffer.isBuffer(output)
        ? output.toString("utf8")
        : "";
  if (!text || Buffer.byteLength(text, "utf8") > AUTH_STATUS_MAX_BUFFER_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") return null;
    // Deliberately extract exactly one boolean. Account identifiers, emails,
    // organization metadata, and any future fields are discarded immediately.
    return parsed.loggedIn;
  } catch {
    return null;
  }
}

/** `claude auth status --json` against the live home, reduced to one boolean. */
export async function defaultClaudeCliAuthChecker(
  input: Readonly<ClaudeCliAuthCheckInput>,
  options: { claudeExecutable?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeCliAuthCheckResult> {
  let exists = false;
  try {
    exists = await assertSafeDirectory(input.configDir, {
      create: false,
      repairMode: false,
      // ~/.claude is commonly 0755 and owned outside Codara; accept a real
      // non-symlink directory without chmod.
      requirePrivate: false,
    });
  } catch (error) {
    if (error instanceof ClaudeCliAccountProfileSafetyError) {
      return { connected: false, reason: "unsafe" };
    }
    throw error;
  }

  const executable = options.claudeExecutable?.trim() || "claude";
  if (CONTROL_CHARACTER_PATTERN.test(executable)) {
    return { connected: false, reason: "unsafe" };
  }
  const env = buildClaudeCliProfileEnvironment(
    options.baseEnv ?? process.env,
    input.configDirEnv,
  );
  let output: unknown = null;
  try {
    const result = await execFileAsync(
      executable,
      ["auth", "status", "--json"],
      {
        // With no state directory yet, preserve the caller's cwd and let
        // Claude report its keychain/global auth status.
        ...(exists ? { cwd: input.configDir } : {}),
        env,
        windowsHide: true,
        timeout: AUTH_STATUS_TIMEOUT_MS,
        maxBuffer: AUTH_STATUS_MAX_BUFFER_BYTES,
      },
    );
    output = result.stdout;
  } catch (error) {
    // Logged-out Claude currently exits non-zero while still printing its
    // supported JSON status. Read only that bounded stdout; never inspect a
    // credential file or propagate raw output/error text.
    output = (error as { stdout?: unknown }).stdout;
  }
  const loggedIn = parseLoggedInOnly(output);
  if (loggedIn === null) return { connected: false, reason: "unavailable" };
  return loggedIn
    ? { connected: true }
    : { connected: false, reason: "missing" };
}

/** Live-profile fallback verdicts, so a signed-out home costs one spawn a minute, not one per card. */
const liveFallbackCache = new Map<
  string,
  { checkedAt: number; result: ClaudeCliAuthCheckResult }
>();
const LIVE_FALLBACK_TTL_MS = 60_000;

export interface ClaudeCredentialAuthCheckerOptions {
  now?: () => number;
  /** Test seam: read the live slot's file only, never a Keychain. */
  fileOnly?: boolean;
  /**
   * Consulted for the live profile only, when the live slot holds no OAuth
   * login: the user may still be signed in through a mechanism that stores
   * no OAuth credential (an API key helper, an environment token). Null
   * disables the fallback; production runs `claude auth status --json`.
   */
  liveFallback?: ClaudeCliAuthChecker | null;
}

/**
 * Token-blind connection status from the profile's login itself: the live
 * slot while the profile is live, its vault otherwise. Connected when a
 * token is present, with the raw expiry alongside so the card can say
 * "refreshing" rather than "signed out" for a lapsed access token. A vaulted
 * profile never spawns a Claude subprocess.
 */
export async function claudeCredentialAuthChecker(
  input: Readonly<ClaudeCliAuthCheckInput>,
  options: ClaudeCredentialAuthCheckerOptions = {},
): Promise<ClaudeCliAuthCheckResult> {
  const read = await readClaudeProfileLogin(
    {
      rootDir: input.rootDir,
      personalConfigDir: input.configDir,
      personalConfigDirEnv: input.configDirEnv,
    },
    input.profileId,
    options.fileOnly ? { fileOnly: true } : {},
  );
  if (read.kind === "unreadable") return { connected: false, reason: "unavailable" };
  const record = read.record;
  if (record && (record.refreshToken || record.accessToken)) {
    const expiresAt = record.expiresAt > 0 ? record.expiresAt : null;
    return {
      connected: true,
      expiresAt,
      canRefresh: record.refreshToken.length > 0,
    };
  }
  if (!read.live) return { connected: false, reason: "missing" };
  const fallback =
    options.liveFallback === undefined
      ? (probe: Readonly<ClaudeCliAuthCheckInput>) => defaultClaudeCliAuthChecker(probe)
      : options.liveFallback;
  if (!fallback) return { connected: false, reason: "missing" };
  const now = options.now?.() ?? Date.now();
  const cached = liveFallbackCache.get(input.configDir);
  if (cached && now - cached.checkedAt < LIVE_FALLBACK_TTL_MS) return cached.result;
  const result = await Promise.resolve(fallback(input)).catch(
    (): ClaudeCliAuthCheckResult => ({ connected: false, reason: "unavailable" }),
  );
  liveFallbackCache.set(input.configDir, { checkedAt: now, result });
  return result;
}

/**
 * The Claude account registry. Every profile, Account 1 included, is a
 * login rather than a directory: terminals always run in the user's own
 * Claude home, the live profile's login sits in that home's credential
 * store, and every other profile's login waits in its vault (see
 * claude-cli-live-login.ts). A managed profile keeps a directory under the
 * account root to hold that vault.
 */
export class ClaudeCliAccountProfileStore {
  readonly rootDir: string;
  readonly accountsDir: string;
  readonly filePath: string;
  readonly personalConfigDir: string;
  readonly personalConfigDirEnv: string | null;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly authChecker: ClaudeCliAuthChecker;
  private readonly leases?: ClaudeCliProfileLeaseView;

  constructor(
    rootDir: string = codaraClaudeCliAccountRootDir(),
    options: ClaudeCliAccountProfileStoreOptions = {},
  ) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("Native Claude account root must be a non-empty path");
    }
    this.rootDir = normalizeManagedClaudePath(rootDir);
    this.accountsDir = normalizeManagedClaudePath(
      join(this.rootDir, CLAUDE_CLI_ACCOUNTS_DIRECTORY),
    );
    if (dirname(this.accountsDir) !== this.rootDir) {
      throw new ClaudeCliAccountProfileSafetyError(
        "accounts directory escaped the native Claude root",
      );
    }
    this.filePath = join(this.rootDir, CLAUDE_CLI_ACCOUNT_PROFILES_FILE);
    const hasPersonalConfigEnvOption = Object.prototype.hasOwnProperty.call(
      options,
      "personalConfigDirEnv",
    );
    const inheritedPersonalConfigDirEnv = hasPersonalConfigEnvOption
      ? options.personalConfigDirEnv
      : defaultPersonalClaudeConfigDirEnv();
    this.personalConfigDirEnv =
      typeof inheritedPersonalConfigDirEnv === "string" &&
      inheritedPersonalConfigDirEnv.trim()
        ? resolve(inheritedPersonalConfigDirEnv)
        : null;
    this.personalConfigDir = resolve(
      options.personalConfigDir?.trim() ||
        this.personalConfigDirEnv ||
        defaultPersonalClaudeConfigDir(),
    );
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.leases = options.leases;
    this.authChecker =
      options.authChecker ??
      ((input) =>
        claudeCredentialAuthChecker(input, {
          liveFallback: (probe) =>
            defaultClaudeCliAuthChecker(probe, {
              claudeExecutable: options.claudeExecutable,
            }),
        }));
  }

  private checkInput(profileId: ClaudeCliProfileId, managed: boolean): ClaudeCliAuthCheckInput {
    return {
      profileId,
      managed,
      rootDir: this.rootDir,
      configDir: this.personalConfigDir,
      configDirEnv: this.personalConfigDirEnv,
    };
  }

  private async ensureStoreDirectories(): Promise<void> {
    await assertSafeDirectory(this.rootDir, { create: true, repairMode: true });
    await assertSafeDirectory(this.accountsDir, { create: true, repairMode: true });
  }

  private async reconcileLocked(
    snapshot?: ClaudeCliAccountProfilesSnapshot,
  ): Promise<ClaudeCliAccountReconciliation> {
    await this.ensureStoreDirectories();
    const current = snapshot ?? (await readSnapshotFromDisk(this.filePath));
    const registered = new Set(current.profiles.map((profile) => profile.id));
    const restoredProfileIds: string[] = [];
    const removedDeletingDirectories: string[] = [];
    const orphanProfileIds: string[] = [];
    const entries = await fs.readdir(this.accountsDir, { withFileTypes: true });

    for (const entry of entries) {
      const deleting = DELETING_DIRECTORY_PATTERN.exec(entry.name);
      const managedId = isClaudeCliManagedProfileId(entry.name)
        ? entry.name
        : null;
      if (!deleting && !managedId) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ClaudeCliAccountProfileSafetyError(
          `account entry "${entry.name}" is a symlink or not a directory`,
        );
      }
      if (deleting) {
        const profileId = deleting[1];
        const stagePath = join(this.accountsDir, entry.name);
        const configDir = claudeCliManagedProfileConfigDir(this.rootDir, profileId);
        const liveStats = await lstatOrNull(configDir);
        if (registered.has(profileId) && !liveStats) {
          await fs.rename(stagePath, configDir);
          restoredProfileIds.push(profileId);
        } else if (!registered.has(profileId)) {
          await fs.rm(stagePath, { recursive: true, force: true });
          removedDeletingDirectories.push(entry.name);
        }
        continue;
      }
      if (managedId && !registered.has(managedId)) {
        orphanProfileIds.push(managedId);
      }
    }

    return {
      restoredProfileIds: restoredProfileIds.sort(),
      removedDeletingDirectories: removedDeletingDirectories.sort(),
      orphanProfileIds: orphanProfileIds.sort(),
    };
  }

  async reconcile(): Promise<ClaudeCliAccountReconciliation> {
    return withMutationLock(this.filePath, () => this.reconcileLocked());
  }

  async snapshot(): Promise<ClaudeCliAccountProfilesSnapshot> {
    await this.ensureStoreDirectories();
    return cloneSnapshot(await readSnapshotFromDisk(this.filePath));
  }

  async inspect(): Promise<ClaudeCliAccountInspection> {
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      let snapshot = await readSnapshotFromDisk(this.filePath);
      const reconciliation = await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const profiles: ClaudeCliProfileConnection[] = [];
      const candidates: Array<{
        id: ClaudeCliProfileId;
        label: string;
        managed: boolean;
      }> = [
        { id: CLAUDE_CLI_PERSONAL_PROFILE_ID, label: "Account 1", managed: false },
        ...snapshot.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          managed: true,
        })),
      ];

      for (const candidate of candidates) {
        let status: ClaudeCliAuthCheckResult;
        try {
          status = await this.authChecker(this.checkInput(candidate.id, candidate.managed));
        } catch {
          status = { connected: false, reason: "unavailable" };
        }
        const expiresAt = typeof status.expiresAt === "number" ? status.expiresAt : null;
        profiles.push({
          id: candidate.id,
          label: candidate.label,
          managed: candidate.managed,
          isDefault: candidate.id === snapshot.defaultProfileId,
          connected: status.connected === true,
          expired:
            status.connected === true &&
            expiresAt !== null &&
            expiresAt <= this.now().getTime(),
          canRefresh: status.connected === true && status.canRefresh === true,
          inUse: this.leases?.isLeased(candidate.id) ?? false,
          ...(!status.connected
            ? {
                error:
                  status.reason === "unsafe"
                    ? ("Config directory is unsafe" as const)
                    : status.reason === "unavailable"
                      ? ("Could not verify sign-in" as const)
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
    input: CreateClaudeCliProfileInput,
  ): Promise<CreateClaudeCliProfileResult> {
    const label = normalizeLabel(input.label);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      let snapshot = await readSnapshotFromDisk(this.filePath);
      await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const existingIds = new Set(snapshot.profiles.map((profile) => profile.id));
      let id: string | null = null;
      let profileDir: string | null = null;
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        const candidate = this.idFactory();
        if (!isClaudeCliManagedProfileId(candidate)) {
          throw new TypeError(
            "Generated native Claude profile id must be a lowercase UUIDv4",
          );
        }
        if (existingIds.has(candidate)) continue;
        const candidateDir = claudeCliManagedProfileConfigDir(
          this.rootDir,
          candidate,
        );
        if (!(await lstatOrNull(candidateDir))) {
          id = candidate;
          profileDir = candidateDir;
          break;
        }
      }
      if (!id || !profileDir) throw new ClaudeCliAccountProfileIdCollisionError();

      await fs.mkdir(profileDir, { mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(profileDir, 0o700);
      const timestamp = this.now().toISOString();
      const profile: ClaudeCliManagedProfile = {
        id,
        label,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      snapshot.profiles.push(profile);
      try {
        await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      } catch (error) {
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { profile: { ...profile }, snapshot: cloneSnapshot(snapshot) };
    });
  }

  async renameProfile(
    rawProfileId: string,
    labelInput: string,
  ): Promise<ClaudeCliManagedProfile> {
    if (!isClaudeCliManagedProfileId(rawProfileId)) {
      throw new TypeError("Only a managed native Claude profile can be renamed");
    }
    const label = normalizeLabel(labelInput);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      const index = snapshot.profiles.findIndex(
        (profile) => profile.id === rawProfileId,
      );
      if (index < 0) throw new ClaudeCliAccountProfileNotFoundError(rawProfileId);
      const current = snapshot.profiles[index];
      if (current.label === label) return { ...current };
      const clockNow = this.now().toISOString();
      const profile = {
        ...current,
        label,
        updatedAt: clockNow > current.updatedAt ? clockNow : current.updatedAt,
      };
      snapshot.profiles[index] = profile;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return { ...profile };
    });
  }

  async setDefaultProfile(
    rawProfileId: string | null | undefined,
  ): Promise<ClaudeCliAccountProfilesSnapshot> {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    return withMutationLock(this.filePath, async () => {
      await this.ensureStoreDirectories();
      const snapshot = await readSnapshotFromDisk(this.filePath);
      if (
        profileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID &&
        !snapshot.profiles.some((profile) => profile.id === profileId)
      ) {
        throw new ClaudeCliAccountProfileNotFoundError(profileId);
      }
      if (profileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        const status = await Promise.resolve(
          this.authChecker(this.checkInput(profileId, true)),
        ).catch(() => ({ connected: false, reason: "unavailable" as const }));
        if (!status.connected) {
          throw new Error(
            "A native Claude account must be connected before it can be default",
          );
        }
      }
      if (snapshot.defaultProfileId === profileId) return cloneSnapshot(snapshot);
      snapshot.defaultProfileId = profileId;
      await persistSnapshotAtomically(this.rootDir, this.filePath, snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  /**
   * The profile a launch is for. Every profile runs in the same Claude home
   * with the same environment; the id only says which account the launch
   * was made for.
   */
  async resolveProfile(
    input: ResolveClaudeCliProfileInput = {},
  ): Promise<ClaudeCliResolvedProfile> {
    await this.ensureStoreDirectories();
    const snapshot = await readSnapshotFromDisk(this.filePath);
    const profileId =
      input.profileId === undefined ||
      input.profileId === null ||
      input.profileId === ""
        ? input.useDefault
          ? snapshot.defaultProfileId
          : CLAUDE_CLI_PERSONAL_PROFILE_ID
        : normalizeClaudeCliProfileId(input.profileId);
    let label = "Account 1";
    let managed = false;
    if (profileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID) {
      const profile = snapshot.profiles.find((entry) => entry.id === profileId);
      if (!profile) throw new ClaudeCliAccountProfileNotFoundError(profileId);
      label = profile.label;
      managed = true;
    }
    const status = await Promise.resolve(
      this.authChecker(this.checkInput(profileId, managed)),
    ).catch(() => ({ connected: false, reason: "unavailable" as const }));
    if (input.requireConnected && !status.connected) {
      throw new Error("Selected native Claude account is not connected");
    }
    return {
      profileId,
      label,
      managed,
      configDir: this.personalConfigDir,
      configDirEnv: this.personalConfigDirEnv,
      connected: status.connected === true,
    };
  }

  /**
   * Remove a managed profile and its directory (its vault with it). No
   * terminal runs inside a profile's directory, so a terminal launched while
   * the profile was live never blocks the delete; the account service hands
   * the live slot to another profile first.
   */
  async deleteProfile(
    rawProfileId: string,
  ): Promise<DeleteClaudeCliProfileResult> {
    if (!isClaudeCliManagedProfileId(rawProfileId)) {
      if (rawProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        throw new TypeError("The existing personal Claude config cannot be deleted");
      }
      throw new TypeError("Managed native Claude profile id must be a lowercase UUIDv4");
    }
    return withMutationLock(this.filePath, async () => {
      let snapshot = await readSnapshotFromDisk(this.filePath);
      await this.reconcileLocked(snapshot);
      snapshot = await readSnapshotFromDisk(this.filePath);
      const target = snapshot.profiles.find(
        (profile) => profile.id === rawProfileId,
      );
      if (!target) return { deleted: false, snapshot: cloneSnapshot(snapshot) };
      if (snapshot.defaultProfileId === rawProfileId) {
        throw new ClaudeCliDefaultProfileDeletionError(rawProfileId);
      }
      const profileDir = claudeCliManagedProfileConfigDir(this.rootDir, rawProfileId);
      const staged = join(
        this.accountsDir,
        `.${rawProfileId}.deleting-${randomBytes(8).toString("hex")}`,
      );
      const profileStats = await lstatOrNull(profileDir);
      if (
        profileStats &&
        (profileStats.isSymbolicLink() || !profileStats.isDirectory())
      ) {
        throw new ClaudeCliAccountProfileSafetyError(
          "the account directory selected for deletion is unsafe",
        );
      }
      if (
        profileStats &&
        process.platform !== "win32" &&
        (profileStats.mode & 0o077) !== 0
      ) {
        throw new ClaudeCliAccountProfileSafetyError(
          "the account directory selected for deletion is not private",
        );
      }
      if (profileStats) await fs.rename(profileDir, staged);
      const next: ClaudeCliAccountProfilesSnapshot = {
        ...snapshot,
        profiles: snapshot.profiles.filter(
          (profile) => profile.id !== rawProfileId,
        ),
      };
      try {
        await persistSnapshotAtomically(this.rootDir, this.filePath, next);
      } catch (error) {
        if (profileStats) {
          await fs.rename(staged, profileDir).catch(() => undefined);
        }
        throw error;
      }
      if (profileStats) await fs.rm(staged, { recursive: true, force: true });
      return { deleted: true, snapshot: cloneSnapshot(next) };
    });
  }
}
