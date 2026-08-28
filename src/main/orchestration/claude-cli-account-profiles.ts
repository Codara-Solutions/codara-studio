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
import { ensureSharedCliState } from "./native-cli-shared-state";

const execFileAsync = promisify(execFile);

export const CLAUDE_CLI_PERSONAL_PROFILE_ID = "personal" as const;
export const CLAUDE_CLI_ACCOUNT_PROFILES_VERSION = 1 as const;
export const CLAUDE_CLI_ACCOUNT_PROFILES_FILE = "account-profiles.json";
export const CLAUDE_CLI_ACCOUNTS_DIRECTORY = "accounts";
export const CLAUDE_CLI_PROFILE_LABEL_MAX_LENGTH = 80;

/**
 * Non-credential preferences copied into a freshly created managed account so
 * the CLI does not drop the terminal into its first-run wizard.
 *
 * Claude Code 2.1.220 gates the whole onboarding flow (theme picker, security
 * notes, terminal setup) on `hasCompletedOnboarding` in its global config file,
 * and writes `hasCompletedOnboarding` + `lastOnboardingVersion` when the flow
 * finishes. Anthropic's own eval harness seeds a config directory the same
 * way. The theme the wizard would ask for is NOT seeded here: settings.json is
 * shared with the personal config directory through a symlink (see
 * native-cli-shared-state.ts), so the personal theme — and every other
 * setting — arrives through the link instead of a diverging copy.
 *
 * The list below is exhaustive and closed. Nothing identity- or
 * credential-bearing (oauthAccount, userID, anonymousId, machineID, projects,
 * mcpServers, customApiKeyResponses, hooks, env, …) is ever considered: a
 * managed account is a separate login, and copying any of that would either
 * cross accounts or carry the personal machine's identity into one.
 */
export const CLAUDE_CLI_SEEDED_CONFIG_KEYS = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
] as const;
export const CLAUDE_CLI_CONFIG_FILE = ".claude.json";
/** Refuse to parse an implausibly large personal config rather than stall. */
const PERSONAL_CONFIG_MAX_BYTES = 32 * 1024 * 1024;
const ONBOARDING_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

export type ClaudeCliProfileId =
  | typeof CLAUDE_CLI_PERSONAL_PROFILE_ID
  | string;

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
  /** Opaque local id. `personal` represents the pre-feature Claude home. */
  id: ClaudeCliProfileId;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
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
}

export interface ClaudeCliAuthCheckInput {
  profileId: ClaudeCliProfileId;
  managed: boolean;
  /** Main-process-only. Never expose this object through IPC/RPC. */
  configDir: string;
  /**
   * Exact legacy selector for the child. Null means CLAUDE_CONFIG_DIR was
   * originally unset and must remain unset; managed profiles always set it.
   */
  configDirEnv: string | null;
}

export type ClaudeCliAuthChecker = (
  input: Readonly<ClaudeCliAuthCheckInput>,
) => ClaudeCliAuthCheckResult | Promise<ClaudeCliAuthCheckResult>;

export interface ClaudeCliProfileLeaseView {
  isLeased(profileId: ClaudeCliProfileId): boolean;
  runWhileUnleased?<T>(
    profileId: ClaudeCliProfileId,
    operation: () => Promise<T>,
  ): Promise<T>;
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
  /** Token-blind checker; production uses `claude auth status --json`. */
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
  /** Main-process-only. */
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
 * own. Studio may have been started from a shell that already points
 * CLAUDE_CONFIG_DIR at the Active managed account (see
 * codara-managed-cli-roots.ts); treating that as the personal login would make
 * "personal" resolve to a Codara-managed account and follow it around.
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

export function isClaudeCliManagedProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function normalizeClaudeCliProfileId(
  value: unknown,
  label = "Native Claude account profile id",
): ClaudeCliProfileId {
  if (value === undefined || value === null || value === "") {
    return CLAUDE_CLI_PERSONAL_PROFILE_ID;
  }
  if (value === CLAUDE_CLI_PERSONAL_PROFILE_ID || isClaudeCliManagedProfileId(value)) {
    return value;
  }
  throw new TypeError(`${label} must be "personal" or a lowercase UUIDv4`);
}

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

/**
 * Where Claude Code 2.1.220 reads its global config from, in its own order: a
 * `.config.json` inside the config directory when one exists, otherwise
 * `$CLAUDE_CONFIG_DIR/.claude.json` — and `~/.claude.json` when the selector is
 * unset, which is why this cannot simply join the personal config directory.
 */
function personalClaudeConfigFiles(
  personalConfigDir: string,
  personalConfigDirEnv: string | null,
): string[] {
  return [
    join(personalConfigDir, ".config.json"),
    personalConfigDirEnv
      ? join(personalConfigDirEnv, CLAUDE_CLI_CONFIG_FILE)
      : join(homedir(), CLAUDE_CLI_CONFIG_FILE),
  ];
}

/** Reads a JSON object, or null for anything missing, unsafe, or unparseable. */
async function readJsonRecordIfSafe(
  path: string,
): Promise<Record<string, unknown> | null> {
  const stats = await lstatOrNull(path).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null;
  if (stats.size > PERSONAL_CONFIG_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readFirstJsonRecord(
  paths: readonly string[],
): Promise<Record<string, unknown> | null> {
  for (const path of paths) {
    const record = await readJsonRecordIfSafe(path);
    if (record) return record;
  }
  return null;
}

export function pickClaudeCliFirstRunConfig(
  personal: Record<string, unknown> | null,
): Record<string, unknown> {
  const seeded: Record<string, unknown> = {};
  // Claiming the wizard is done for an account whose owner never finished it
  // would be a guess, so this mirrors the personal state instead of asserting.
  if (!personal || personal.hasCompletedOnboarding !== true) return seeded;
  seeded.hasCompletedOnboarding = true;
  const version = personal.lastOnboardingVersion;
  if (typeof version === "string" && ONBOARDING_VERSION_PATTERN.test(version)) {
    seeded.lastOnboardingVersion = version;
  }
  return seeded;
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

export interface SeedClaudeCliFirstRunInput {
  /** A just-created, still-empty managed account directory. */
  configDir: string;
  personalConfigDir: string;
  personalConfigDirEnv: string | null;
}

export interface SeedClaudeCliFirstRunResult {
  configKeys: string[];
}

/**
 * Copies the allowlisted first-run onboarding flags into a new managed
 * account's .claude.json. The theme (and every other setting) is deliberately
 * NOT seeded: settings.json is shared with the personal config directory via
 * a symlink (native-cli-shared-state.ts), so seeding a copy here would fork
 * the two files at the moment of creation.
 *
 * Best-effort by design: a missing, unreadable, or unusual personal config
 * leaves the new account exactly as it was created, because a working account
 * with one extra wizard is better than a failed account creation. Skipping the
 * wizard also skips its sign-in step, which is what the Accounts panel's
 * "not signed in yet" hint exists to say up front.
 */
export async function seedManagedClaudeCliFirstRunPreferences(
  input: SeedClaudeCliFirstRunInput,
): Promise<SeedClaudeCliFirstRunResult> {
  const empty: SeedClaudeCliFirstRunResult = { configKeys: [] };
  let personalConfig: Record<string, unknown> | null;
  try {
    personalConfig = await readFirstJsonRecord(
      personalClaudeConfigFiles(input.personalConfigDir, input.personalConfigDirEnv),
    );
  } catch {
    return empty;
  }

  const config = pickClaudeCliFirstRunConfig(personalConfig);
  if (Object.keys(config).length === 0) return empty;
  const configPath = join(input.configDir, CLAUDE_CLI_CONFIG_FILE);
  try {
    await writePrivateJsonFile(configPath, config);
  } catch {
    return empty;
  }
  return { configKeys: Object.keys(config) };
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

export async function defaultClaudeCliAuthChecker(
  input: Readonly<ClaudeCliAuthCheckInput>,
  options: { claudeExecutable?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeCliAuthCheckResult> {
  let exists = false;
  try {
    exists = await assertSafeDirectory(input.configDir, {
      create: false,
      repairMode: false,
      // Existing ~/.claude is commonly 0755. It is owned outside this
      // feature, so accept a real non-symlink directory without chmod. Every
      // managed ~/.codarastudio/claude-cli/accounts/* directory remains 0700-only.
      requirePrivate: input.managed,
    });
  } catch (error) {
    if (error instanceof ClaudeCliAccountProfileSafetyError) {
      return { connected: false, reason: "unsafe" };
    }
    throw error;
  }
  if (!exists && input.managed) {
    return { connected: false, reason: "missing" };
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
        // For personal with no state directory yet, preserve the caller's cwd
        // and let Claude report its legacy keychain/global auth status.
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
        defaultClaudeCliAuthChecker(input, {
          claudeExecutable: options.claudeExecutable,
        }));
  }

  private async ensureStoreDirectories(): Promise<void> {
    await assertSafeDirectory(this.rootDir, { create: true, repairMode: true });
    await assertSafeDirectory(this.accountsDir, { create: true, repairMode: true });
  }

  /**
   * Managed accounts share the user-state surfaces (chats, settings, history)
   * with the personal Claude home so switching accounts behaves like
   * logout+login in one home; only credentials and identity stay per-account.
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
    configDir: string,
  ): Promise<void> {
    if (process.platform === "win32") return;
    if (this.leases?.isLeased(profileId)) return;
    try {
      await withMutationLock(`${this.filePath}::share::${profileId}`, async () => {
        if (this.leases?.isLeased(profileId)) return;
        await ensureSharedCliState({
          managedDir: configDir,
          personalDir: this.personalConfigDir,
          runtime: "claude",
        });
      });
    } catch {
      // ensureSharedCliState reports per-name outcomes and never throws; this
      // guard keeps even an unexpected failure out of the launch path.
    }
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
        configDir: string;
      }> = [
        {
          id: CLAUDE_CLI_PERSONAL_PROFILE_ID,
          label: "Existing Claude login",
          managed: false,
          configDir: this.personalConfigDir,
        },
        ...snapshot.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          managed: true,
          configDir: claudeCliManagedProfileConfigDir(this.rootDir, profile.id),
        })),
      ];

      for (const candidate of candidates) {
        let status: ClaudeCliAuthCheckResult;
        try {
          status = await this.authChecker({
            profileId: candidate.id,
            managed: candidate.managed,
            configDir: candidate.configDir,
            configDirEnv: candidate.managed
              ? candidate.configDir
              : this.personalConfigDirEnv,
          });
        } catch {
          status = { connected: false, reason: "unavailable" };
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
      let configDir: string | null = null;
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
          configDir = candidateDir;
          break;
        }
      }
      if (!id || !configDir) throw new ClaudeCliAccountProfileIdCollisionError();

      await fs.mkdir(configDir, { mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(configDir, 0o700);
      await seedManagedClaudeCliFirstRunPreferences({
        configDir,
        personalConfigDir: this.personalConfigDir,
        personalConfigDirEnv: this.personalConfigDirEnv,
      });
      // A fresh directory takes the pure "managed entry missing" branch of
      // the heal: every shared name becomes a link before first use.
      await this.ensureManagedSharedState(id, configDir);
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
        await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
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
        const configDir = claudeCliManagedProfileConfigDir(this.rootDir, profileId);
        const status = await Promise.resolve(
          this.authChecker({
            profileId,
            managed: true,
            configDir,
            configDirEnv: configDir,
          }),
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
    let label = "Existing Claude login";
    let managed = false;
    let configDir = this.personalConfigDir;
    let configDirEnv = this.personalConfigDirEnv;
    if (profileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID) {
      const profile = snapshot.profiles.find((entry) => entry.id === profileId);
      if (!profile) throw new ClaudeCliAccountProfileNotFoundError(profileId);
      label = profile.label;
      managed = true;
      configDir = claudeCliManagedProfileConfigDir(this.rootDir, profileId);
      configDirEnv = configDir;
      await assertSafeDirectory(configDir, { create: false, repairMode: false });
      await this.ensureManagedSharedState(profileId, configDir);
    }
    const status = await Promise.resolve(
      this.authChecker({ profileId, managed, configDir, configDirEnv }),
    ).catch(() => ({ connected: false, reason: "unavailable" as const }));
    if (input.requireConnected && !status.connected) {
      throw new Error("Selected native Claude account is not connected");
    }
    return {
      profileId,
      label,
      managed,
      configDir,
      configDirEnv,
      connected: status.connected === true,
    };
  }

  async deleteProfile(
    rawProfileId: string,
  ): Promise<DeleteClaudeCliProfileResult> {
    if (!isClaudeCliManagedProfileId(rawProfileId)) {
      if (rawProfileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
        throw new TypeError("The existing personal Claude config cannot be deleted");
      }
      throw new TypeError("Managed native Claude profile id must be a lowercase UUIDv4");
    }
    const mutate = () =>
      withMutationLock(this.filePath, async () => {
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
        if (this.leases?.isLeased(rawProfileId)) {
          throw new ClaudeCliAccountProfileLeasedError(rawProfileId);
        }

        // Serialize against the shared-state heal for this profile: a heal
        // mid-migration keeps transcripts in a temporary stage inside the
        // config directory, and deleting the directory in that window would
        // destroy state the heal was moving into the personal home.
        return withMutationLock(
          `${this.filePath}::share::${rawProfileId}`,
          async () => {
            const configDir = claudeCliManagedProfileConfigDir(
              this.rootDir,
              rawProfileId,
            );
            const staged = join(
              this.accountsDir,
              `.${rawProfileId}.deleting-${randomBytes(8).toString("hex")}`,
            );
            const configStats = await lstatOrNull(configDir);
            if (
              configStats &&
              (configStats.isSymbolicLink() || !configStats.isDirectory())
            ) {
              throw new ClaudeCliAccountProfileSafetyError(
                "the account config directory selected for deletion is unsafe",
              );
            }
            if (
              configStats &&
              process.platform !== "win32" &&
              (configStats.mode & 0o077) !== 0
            ) {
              throw new ClaudeCliAccountProfileSafetyError(
                "the account config directory selected for deletion is not private",
              );
            }
            if (configStats) await fs.rename(configDir, staged);
            const next: ClaudeCliAccountProfilesSnapshot = {
              ...snapshot,
              profiles: snapshot.profiles.filter(
                (profile) => profile.id !== rawProfileId,
              ),
            };
            try {
              await persistSnapshotAtomically(this.rootDir, this.filePath, next);
            } catch (error) {
              if (configStats) {
                await fs.rename(staged, configDir).catch(() => undefined);
              }
              throw error;
            }
            if (configStats) await fs.rm(staged, { recursive: true, force: true });
            return { deleted: true, snapshot: cloneSnapshot(next) };
          },
        );
      });

    if (this.leases?.runWhileUnleased) {
      return this.leases.runWhileUnleased(rawProfileId, mutate);
    }
    if (this.leases?.isLeased(rawProfileId)) {
      throw new ClaudeCliAccountProfileLeasedError(rawProfileId);
    }
    return mutate();
  }
}
