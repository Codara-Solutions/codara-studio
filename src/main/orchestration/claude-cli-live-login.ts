import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { assertCodaraOwnedWrite } from "../outside-write-guard";
import { withAccountSelectionLock } from "./account-selection-lock";
import {
  CLAUDE_CLI_ACCOUNTS_DIRECTORY,
  CLAUDE_CLI_CONFIG_FILE,
  isClaudeCliManagedProfileId,
  normalizeClaudeCliProfileId,
  type ClaudeCliProfileId,
} from "./claude-cli-profile-ids";
import {
  CLAUDE_ACCOUNT_SCOPED_STORE_KEYS,
  fresherCredentialString,
  parseClaudeCredentialRecord,
  readClaudeCredentialStores,
  updateClaudeCredentialStores,
  withClaudeCodeRefreshLock,
  type ClaudeCredentialRecord,
  type ClaudeCredentialStoreObject,
  type ClaudeCredentialStoreOptions,
  type ClaudeCredentialStores,
} from "./claude-cli-credentials";
import {
  atomicWritePrivateFile,
  readPrivateJsonFile,
  removePrivateFile,
} from "./native-cli-atomic-file";
import {
  anthropicAccountFingerprint,
  normalizeAccountEmail,
  type NativeCliAccountIdentity,
} from "./native-cli-account-identity";

/**
 * Claude Code accounts in one Codara-owned live slot. Every Claude terminal
 * and worker Codara starts on a managed account runs with CLAUDE_CONFIG_DIR
 * at <codaraHome>/claude-cli/live/home, whose shared state links into the
 * user's own Claude home (cli-account-homes.ts). The user's own login, the
 * System login, is never read for secrets, written, refreshed or locked here:
 * a terminal on it simply runs without the variable.
 *
 *  - The live slot is that home's credential store. The marker
 *    (claude-cli/live-login.json) names the managed profile whose login it
 *    holds; no marker means the slot holds nobody's login.
 *  - Every managed profile has a vault file (claude-cli/accounts/<id>/login.json)
 *    holding its scoped keys and identity. While a profile is live its vault
 *    copy trails the live slot and is never read; a switch saves the live
 *    login, refreshed tokens included, into the outgoing profile's vault
 *    before the incoming vault is copied in.
 *  - A switch holds Claude Code's own refresh locks on the slot, so no refresh
 *    is in flight while the login moves. Running sessions keep going: Claude
 *    Code re-reads the store before each request and sends the new login on
 *    the very next one (pinned by scripts/smoke-claude-live-slot-hotswap.cjs).
 *
 * The marker journals a switch in progress, and the live login is attributed
 * by refresh token first and recorded account second, so a crash at any
 * point is finished by the next switch without saving one account's login
 * into another account's vault. A login that cannot be attributed is kept
 * in a backup file rather than overwritten.
 */

export const CLAUDE_CLI_LIVE_LOGIN_FILE = "live-login.json";
export const CLAUDE_CLI_VAULT_LOGIN_FILE = "login.json";
/** The live slot's CLAUDE_CONFIG_DIR, relative to the Claude account root. */
export const CLAUDE_CLI_LIVE_HOME = join("live", "home");
const STRAY_LOGIN_PREFIX = "stray-login-";
/** A login kept aside is recoverable by hand for a month, then removed. */
const STRAY_LOGIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LIVE_LOGIN_VERSION = 1;
const VAULT_VERSION = 1;
const CONFIG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * `.claude.json` keys Claude Code 2.1.281 clears when the signed-in account
 * changes: the identity and caches computed for the previous account.
 */
export const CLAUDE_ACCOUNT_SCOPED_CONFIG_KEYS = [
  "oauthAccount",
  "additionalModelOptionsCache",
  "additionalModelOptionsAnsweredAt",
  "additionalModelCostsCache",
  "modelAccessCache",
  "orgModelDefaultCache",
  "cachedArtifactRoster",
  "artifactRosterDenied",
  "lastSeenOrgDefaultUpdatedAt",
  "clientDataCache",
  "clientDataCacheSlots",
  "autoCompactWindowsCache",
  "cachedUsageUtilization",
  "githubWebConnectionStatusCache",
  "startupPrefetchedAt",
] as const;

/** The account root Codara owns, with the live slot inside it. */
export interface ClaudeLoginSlotStore {
  readonly rootDir: string;
  /** The live slot's CLAUDE_CONFIG_DIR, always set for every launch on a managed account. */
  readonly liveConfigDir: string;
}

export interface ClaudeLiveHome {
  configDir: string;
  configDirEnv: string | null;
  /** The directory that holds `.claude.json` when configDirEnv is null. */
  homeDir: string;
}

export function claudeLiveConfigDir(rootDir: string): string {
  return resolve(rootDir, CLAUDE_CLI_LIVE_HOME).normalize("NFC");
}

export function claudeLiveHome(store: ClaudeLoginSlotStore): ClaudeLiveHome {
  return {
    configDir: store.liveConfigDir,
    configDirEnv: store.liveConfigDir,
    homeDir: dirname(resolve(store.liveConfigDir)),
  };
}

export function claudeCliVaultFile(rootDir: string, rawProfileId: string): string {
  const profileId = normalizeClaudeCliProfileId(rawProfileId);
  if (!isClaudeCliManagedProfileId(profileId)) {
    throw new TypeError("Only a managed Claude account has a vault");
  }
  return join(resolve(rootDir), CLAUDE_CLI_ACCOUNTS_DIRECTORY, profileId, CLAUDE_CLI_VAULT_LOGIN_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// The live-login marker.

export interface ClaudeLiveSelection {
  profileId: ClaudeCliProfileId;
  /** The account the live login was issued for, when known. */
  accountUuid?: string;
  /** Set while a switch from this profile is in flight; cleared when it lands. */
  switchingFrom?: ClaudeCliProfileId;
}

function liveSelectionFile(rootDir: string): string {
  return join(resolve(rootDir), CLAUDE_CLI_LIVE_LOGIN_FILE);
}

/** The profile whose login sits in the live slot, or null before the first run. */
export async function readClaudeLiveSelection(rootDir: string): Promise<ClaudeLiveSelection | null> {
  const read = await readPrivateJsonFile(liveSelectionFile(rootDir));
  if (read.kind === "none") return null;
  if (read.kind === "unreadable" || !isRecord(read.value)) {
    throw new Error("The Claude live-login marker is unreadable");
  }
  const value = read.value;
  if (value.version !== LIVE_LOGIN_VERSION) {
    throw new Error("Unsupported Claude live-login marker version");
  }
  const selection: ClaudeLiveSelection = {
    profileId: normalizeClaudeCliProfileId(value.profileId, "Live Claude account profile id"),
  };
  if (nonEmpty(value.accountUuid)) selection.accountUuid = value.accountUuid;
  if (value.switchingFrom !== undefined && value.switchingFrom !== null) {
    selection.switchingFrom = normalizeClaudeCliProfileId(
      value.switchingFrom,
      "Previous live Claude account profile id",
    );
  }
  return selection;
}

async function writeLiveSelection(rootDir: string, selection: ClaudeLiveSelection): Promise<void> {
  await atomicWritePrivateFile(
    liveSelectionFile(rootDir),
    `${JSON.stringify({ version: LIVE_LOGIN_VERSION, ...selection })}\n`,
  );
}

/** The managed profile whose login sits in the live slot, or null when it holds none. */
export async function readClaudeLiveProfileId(rootDir: string): Promise<ClaudeCliProfileId | null> {
  const profileId = (await readClaudeLiveSelection(rootDir))?.profileId;
  return profileId && isClaudeCliManagedProfileId(profileId) ? profileId : null;
}


/**
 * Serialize every change of the live slot inside this process. The
 * credential mirror re-reads and writes a Claude slot under this lock, so a
 * switch can never land one account's refreshed login in another's slot.
 */
export async function withClaudeSelectionLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withAccountSelectionLock(rootDir, operation);
}

// ---------------------------------------------------------------------------
// Vault files.

export interface ClaudeVaultedLogin {
  /** Account-scoped secure-storage keys, exactly as Claude Code stored them. */
  store: ClaudeCredentialStoreObject;
  /** The `oauthAccount` block Claude Code keeps in `.claude.json`. */
  oauthAccount?: Record<string, unknown>;
}

export type ClaudeVaultRead =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "value"; login: ClaudeVaultedLogin };

export async function readClaudeVaultedLogin(file: string): Promise<ClaudeVaultRead> {
  const read = await readPrivateJsonFile(file);
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "unreadable" || !isRecord(read.value)) return { kind: "unreadable" };
  const value = read.value;
  if (value.version !== VAULT_VERSION || !isRecord(value.store)) return { kind: "unreadable" };
  return {
    kind: "value",
    login: {
      store: scopedKeysOf(value.store),
      ...(isRecord(value.oauthAccount) ? { oauthAccount: value.oauthAccount } : {}),
    },
  };
}

async function writeVaultedLogin(file: string, login: ClaudeVaultedLogin): Promise<void> {
  await atomicWritePrivateFile(
    file,
    `${JSON.stringify(
      {
        version: VAULT_VERSION,
        store: login.store,
        ...(login.oauthAccount ? { oauthAccount: login.oauthAccount } : {}),
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function scopedKeysOf(store: ClaudeCredentialStoreObject | null): ClaudeCredentialStoreObject {
  const scoped: ClaudeCredentialStoreObject = {};
  if (!store) return scoped;
  for (const key of CLAUDE_ACCOUNT_SCOPED_STORE_KEYS) {
    if (store[key] !== undefined) scoped[key] = store[key];
  }
  return scoped;
}

/** The login record inside a set of scoped keys, or null when it holds none. */
export function claudeLoginRecordOf(
  store: ClaudeCredentialStoreObject | null | undefined,
): ClaudeCredentialRecord | null {
  if (!store || !isRecord(store.claudeAiOauth)) return null;
  try {
    return parseClaudeCredentialRecord(JSON.stringify({ claudeAiOauth: store.claudeAiOauth }));
  } catch {
    return null;
  }
}

/** A login with at least one token. A record Claude Code blanked after a dead refresh has none. */
function hasUsableLogin(store: ClaudeCredentialStoreObject | null | undefined): boolean {
  const record = claudeLoginRecordOf(store);
  return record !== null && (record.accessToken.length > 0 || record.refreshToken.length > 0);
}

// ---------------------------------------------------------------------------
// The live credential store.

/**
 * The scoped keys of the login Claude Code is using: the Keychain item when
 * one exists, the file otherwise, except that the login record itself comes
 * from whichever store holds the fresher generation (Claude Code has been
 * seen refreshing into the file while an older item lingered).
 */
function liveScopedKeys(stores: ClaudeCredentialStores): ClaudeCredentialStoreObject {
  const base = scopedKeysOf(stores.keychain ?? stores.file);
  const fromKeychain = stores.keychain?.claudeAiOauth;
  const fromFile = stores.file?.claudeAiOauth;
  if (isRecord(fromKeychain) && isRecord(fromFile)) {
    const fresher = fresherCredentialString(
      JSON.stringify({ claudeAiOauth: fromKeychain }),
      JSON.stringify({ claudeAiOauth: fromFile }),
    );
    base.claudeAiOauth = (JSON.parse(fresher) as { claudeAiOauth: unknown }).claudeAiOauth;
  } else if (isRecord(fromFile) && base.claudeAiOauth === undefined) {
    base.claudeAiOauth = fromFile;
  }
  return base;
}

/** The login record Claude Code is using in a home, by the same rule as a switch. */
export function claudeLiveLoginRecord(stores: ClaudeCredentialStores): ClaudeCredentialRecord | null {
  return claudeLoginRecordOf(liveScopedKeys(stores));
}

function replaceScopedKeys(
  store: ClaudeCredentialStoreObject,
  incoming: ClaudeCredentialStoreObject,
): ClaudeCredentialStoreObject {
  for (const key of CLAUDE_ACCOUNT_SCOPED_STORE_KEYS) delete store[key];
  for (const [key, value] of Object.entries(incoming)) store[key] = value;
  return store;
}

// ---------------------------------------------------------------------------
// `.claude.json`.

async function lstatOrNull(path: string): Promise<import("node:fs").Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * The global config file Claude Code reads for a home: a legacy
 * `.config.json` inside the config directory when one exists, otherwise
 * `.claude.json` in CLAUDE_CONFIG_DIR, or in the home directory when that
 * variable is unset.
 */
export async function claudeGlobalConfigFile(home: ClaudeLiveHome): Promise<string> {
  const legacy = join(home.configDir, ".config.json");
  const stats = await lstatOrNull(legacy).catch(() => null);
  if (stats?.isFile()) return legacy;
  return join(home.configDirEnv ?? home.homeDir, CLAUDE_CLI_CONFIG_FILE);
}

async function readConfigObject(file: string): Promise<Record<string, unknown> | null> {
  const stats = await lstatOrNull(file);
  if (!stats) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > CONFIG_MAX_BYTES) {
    throw new Error("Claude Code's config file is not a regular file");
  }
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Code's config file is not an object");
  return parsed;
}

export async function readClaudeOauthAccount(
  home: ClaudeLiveHome,
): Promise<Record<string, unknown> | null> {
  try {
    const config = await readConfigObject(await claudeGlobalConfigFile(home));
    return config && isRecord(config.oauthAccount) ? config.oauthAccount : null;
  } catch {
    return null;
  }
}

/**
 * Change `.claude.json` under the lock Claude Code 2.1.281 takes for its own
 * config writes (`<file>.lock`), re-reading inside it so a concurrent save of
 * project state is never lost. The file keeps its mode; an unparsable file is
 * left alone rather than replaced.
 */
export async function updateClaudeGlobalConfig(
  home: ClaudeLiveHome,
  transform: (config: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<boolean> {
  const file = await claudeGlobalConfigFile(home);
  assertCodaraOwnedWrite(file);
  await fs.mkdir(dirname(file), { recursive: true });
  const release = await lock(file, {
    realpath: false,
    lockfilePath: `${file}.lock`,
    retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    const stats = await lstatOrNull(file);
    const current = (await readConfigObject(file)) ?? {};
    const next = transform({ ...current });
    if (next === null) return false;
    const mode = stats ? stats.mode & 0o777 : 0o600;
    const temporary = join(
      dirname(file),
      `.${basename(file)}.codara-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode });
      if (process.platform !== "win32") await fs.chmod(temporary, mode);
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return true;
  } finally {
    await release().catch(() => undefined);
  }
}

function accountUuidOf(oauthAccount: Record<string, unknown> | null | undefined): string | undefined {
  const raw = oauthAccount?.accountUuid;
  return nonEmpty(raw) && raw.trim() ? raw.trim().toLowerCase() : undefined;
}

export function claudeIdentityOf(
  oauthAccount: Record<string, unknown> | null | undefined,
): NativeCliAccountIdentity {
  const accountUuid = accountUuidOf(oauthAccount);
  const email = normalizeAccountEmail(oauthAccount?.emailAddress);
  return {
    ...(accountUuid ? { fingerprint: anthropicAccountFingerprint(accountUuid) } : {}),
    ...(email ? { email } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading and writing one profile's slot.

export interface ClaudeProfileSlot {
  live: boolean;
  vaultFile: string;
}

export async function claudeProfileSlot(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
): Promise<ClaudeProfileSlot> {
  return {
    live: (await readClaudeLiveProfileId(store.rootDir)) === profileId,
    vaultFile: claudeCliVaultFile(store.rootDir, profileId),
  };
}

export type ClaudeProfileLoginRead =
  | { kind: "unreadable" }
  | {
      kind: "login";
      live: boolean;
      /** Null when the slot holds no login record at all (signed out). */
      record: ClaudeCredentialRecord | null;
    };

/**
 * The login a managed profile holds right now: the live slot while it is
 * live, its vault otherwise. The System login is never read here: its
 * secrets are not Codara's, so it answers unreadable and every caller then
 * does nothing.
 */
export async function readClaudeProfileLogin(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  options: ClaudeCredentialStoreOptions = {},
): Promise<ClaudeProfileLoginRead> {
  if (!isClaudeCliManagedProfileId(profileId)) return { kind: "unreadable" };
  try {
    const slot = await claudeProfileSlot(store, profileId);
    if (slot.live) {
      const home = claudeLiveHome(store);
      const stores = await readClaudeCredentialStores(home.configDir, home.configDirEnv, options);
      return { kind: "login", live: true, record: claudeLoginRecordOf(liveScopedKeys(stores)) };
    }
    const vault = await readClaudeVaultedLogin(slot.vaultFile);
    if (vault.kind === "unreadable") return { kind: "unreadable" };
    return {
      kind: "login",
      live: false,
      record: vault.kind === "value" ? claudeLoginRecordOf(vault.login.store) : null,
    };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Whether the live slot holds the login of `profileId`, the profile the
 * marker names. Claude Code records the account of every `/login` in
 * `.claude.json`; a record naming another account than the profile's means
 * a terminal signed in as someone else, and nothing may then treat the
 * live login as this profile's (refresh it into this profile's vault, hand
 * it to this profile's Cora half). An account unknown on either side counts
 * as the profile's own, since nothing says otherwise. False mid-switch.
 */
export async function claudeLiveSlotHoldsProfile(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  expectedFingerprint?: string,
): Promise<boolean> {
  const selection = await readClaudeLiveSelection(store.rootDir).catch(() => null);
  if (!selection || !isClaudeCliManagedProfileId(profileId)) return false;
  if (selection.switchingFrom || selection.profileId !== profileId) return false;
  const liveAccountUuid = accountUuidOf(
    await readClaudeOauthAccount(claudeLiveHome(store)).catch(() => null),
  );
  if (!liveAccountUuid) return true;
  let expected = selection.accountUuid;
  if (!expected) {
    const vault = await readClaudeVaultedLogin(claudeCliVaultFile(store.rootDir, profileId));
    expected = vault.kind === "value" ? accountUuidOf(vault.login.oauthAccount) : undefined;
  }
  if (expected && expected !== liveAccountUuid) return false;
  if (expectedFingerprint && anthropicAccountFingerprint(liveAccountUuid) !== expectedFingerprint) {
    return false;
  }
  return true;
}

/**
 * The account the System login records in the user's own `.claude.json`.
 * Read only, and only the non-secret oauthAccount block.
 */
export async function readClaudeSystemIdentity(home: {
  personalConfigDir: string;
  personalConfigDirEnv: string | null;
}): Promise<NativeCliAccountIdentity> {
  return claudeIdentityOf(
    await readClaudeOauthAccount({
      configDir: home.personalConfigDir,
      configDirEnv: home.personalConfigDirEnv,
      homeDir: dirname(resolve(home.personalConfigDir)),
    }),
  );
}

/** The account a profile's slot records, from `.claude.json` while live and the vault otherwise. */
export async function readClaudeProfileIdentity(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
): Promise<NativeCliAccountIdentity> {
  const slot = await claudeProfileSlot(store, profileId).catch(() => null);
  if (!slot) return {};
  if (slot.live) return claudeIdentityOf(await readClaudeOauthAccount(claudeLiveHome(store)));
  const vault = await readClaudeVaultedLogin(slot.vaultFile);
  return vault.kind === "value" ? claudeIdentityOf(vault.login.oauthAccount) : {};
}

/**
 * Replace a profile's login record. While the profile is live the live slot
 * changes (MCP grants and every other key stay) and the vault copy trails
 * it; otherwise only the vault changes. Callers hold the selection lock.
 */
export async function writeClaudeProfileLogin(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  record: ClaudeCredentialRecord,
  options: ClaudeCredentialStoreOptions = {},
): Promise<void> {
  const slot = await claudeProfileSlot(store, profileId);
  const vault = await readClaudeVaultedLogin(slot.vaultFile);
  if (vault.kind === "unreadable") throw new Error("The Claude account vault is unreadable");
  if (slot.live) {
    const home = claudeLiveHome(store);
    await updateClaudeCredentialStores(
      home.configDir,
      home.configDirEnv,
      () => ({
        result: undefined,
        transform: (current) => {
          current.claudeAiOauth = record;
          return current;
        },
      }),
      options,
    );
  }
  await writeClaudeVaultLogin(store, profileId, record);
}

/**
 * Replace only the vault copy of a profile's login, for a caller that has
 * already written the live slot under its own compare-and-swap. Callers hold
 * the selection lock.
 */
export async function writeClaudeVaultLogin(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  record: ClaudeCredentialRecord,
): Promise<void> {
  const file = claudeCliVaultFile(store.rootDir, profileId);
  const vault = await readClaudeVaultedLogin(file);
  if (vault.kind === "unreadable") throw new Error("The Claude account vault is unreadable");
  const previous = vault.kind === "value" ? vault.login : { store: {} };
  await writeVaultedLogin(file, {
    ...previous,
    store: { ...previous.store, claudeAiOauth: record },
  });
}

/** Record which account a profile's login belongs to. */
export async function writeClaudeProfileIdentity(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  oauthAccount: Record<string, unknown>,
): Promise<void> {
  const slot = await claudeProfileSlot(store, profileId);
  // Fields of the same account are merged in; another account's record is
  // replaced whole, never left with the previous account's name and org.
  const merged = (existing: unknown): Record<string, unknown> => {
    if (!isRecord(existing)) return oauthAccount;
    const existingUuid = accountUuidOf(existing);
    const incomingUuid = accountUuidOf(oauthAccount);
    if (existingUuid && incomingUuid && existingUuid !== incomingUuid) return oauthAccount;
    return { ...existing, ...oauthAccount };
  };
  if (slot.live) {
    await updateClaudeGlobalConfig(claudeLiveHome(store), (config) => ({
      ...config,
      oauthAccount: merged(config.oauthAccount),
    }));
    const accountUuid = accountUuidOf(oauthAccount);
    const selection = await readClaudeLiveSelection(store.rootDir);
    if (selection && accountUuid && selection.accountUuid !== accountUuid) {
      await writeLiveSelection(store.rootDir, { ...selection, accountUuid });
    }
  }
  const vault = await readClaudeVaultedLogin(slot.vaultFile);
  if (vault.kind === "unreadable") return;
  if (vault.kind === "none" && !slot.live) {
    await writeVaultedLogin(slot.vaultFile, { store: {}, oauthAccount });
    return;
  }
  if (vault.kind === "value") {
    await writeVaultedLogin(slot.vaultFile, {
      ...vault.login,
      oauthAccount: merged(vault.login.oauthAccount),
    });
  }
}

/**
 * Forget which account a vaulted profile's login belongs to, for a record
 * that no longer describes the login it sits next to. Nothing happens while
 * the profile is live: `.claude.json` is Claude Code's, and it re-reads the
 * account itself. Callers hold the selection lock.
 */
export async function forgetClaudeVaultIdentity(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
): Promise<void> {
  const slot = await claudeProfileSlot(store, profileId);
  if (slot.live) return;
  const vault = await readClaudeVaultedLogin(slot.vaultFile);
  if (vault.kind !== "value" || !vault.login.oauthAccount) return;
  await writeVaultedLogin(slot.vaultFile, { store: vault.login.store });
}

/**
 * Sign one profile out. A vaulted profile loses its vault; the live profile
 * also loses the scoped keys in the live slot (MCP grants stay), the way a
 * `/logout` followed by `/login` as nobody would leave it.
 */
export async function clearClaudeProfileLogin(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  options: ClaudeCredentialStoreOptions = {},
): Promise<void> {
  const slot = await claudeProfileSlot(store, profileId);
  if (slot.live) {
    const home = claudeLiveHome(store);
    await updateClaudeCredentialStores(
      home.configDir,
      home.configDirEnv,
      () => ({ result: undefined, transform: (current) => replaceScopedKeys(current, {}) }),
      options,
    );
  }
  await removePrivateFile(slot.vaultFile).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Switching.

export interface ActivateClaudeCliAccountOptions extends ClaudeCredentialStoreOptions {
  /**
   * Let a signed-out profile take the live slot: the previous login is still
   * saved to its vault, the live slot keeps no login and the marker moves.
   */
  allowSignedOut?: boolean;
  /** Whether a managed profile is still registered; a deleted one's login is not saved. */
  profileExists?: (profileId: ClaudeCliProfileId) => Promise<boolean>;
  /** Every registered profile, so a login a `/login` put in the live slot can be attributed. */
  knownProfileIds?: () => Promise<ClaudeCliProfileId[]>;
  /** Test seam: how long to wait for Claude Code's refresh lock. */
  refreshLockRetries?: number;
  log?: (message: string) => void;
}

interface VaultIndexEntry {
  profileId: ClaudeCliProfileId;
  login: ClaudeVaultedLogin;
}

async function readVaultIndex(
  store: ClaudeLoginSlotStore,
  profileIds: Iterable<ClaudeCliProfileId>,
): Promise<VaultIndexEntry[]> {
  const entries: VaultIndexEntry[] = [];
  for (const profileId of profileIds) {
    if (!isClaudeCliManagedProfileId(profileId)) continue;
    const read = await readClaudeVaultedLogin(claudeCliVaultFile(store.rootDir, profileId));
    if (read.kind === "value") entries.push({ profileId, login: read.login });
  }
  return entries;
}

function vaultAccountUuid(
  vaults: readonly VaultIndexEntry[],
  profileId: ClaudeCliProfileId,
): string | undefined {
  return accountUuidOf(vaults.find((entry) => entry.profileId === profileId)?.login.oauthAccount);
}

interface AttributionInput {
  live: ClaudeCredentialStoreObject;
  liveAccountUuid: string | undefined;
  /** The profile the live login belongs to unless the evidence says otherwise; null for nobody. */
  owner: ClaudeCliProfileId | null;
  ownerAccountUuid: string | undefined;
  vaults: readonly VaultIndexEntry[];
  /** A switch was interrupted: only exact evidence names an owner. */
  interrupted: { target: ClaudeCliProfileId; targetAccountUuid: string | undefined } | null;
}

/**
 * Whose login the live slot holds. The refresh token decides first: a vault
 * copy with the same one is the same generation of the same login. Claude
 * Code rotates it on every refresh, so the recorded account decides next,
 * preferring the marker's owner; with nothing recorded the marker is
 * trusted. Undefined means nobody can be named safely.
 */
function attributeLiveLogin(input: AttributionInput): ClaudeCliProfileId | undefined {
  const refreshToken = claudeLoginRecordOf(input.live)?.refreshToken;
  if (refreshToken) {
    const exact = input.vaults.find(
      (entry) => claudeLoginRecordOf(entry.login.store)?.refreshToken === refreshToken,
    );
    if (exact) return exact.profileId;
  }
  if (input.interrupted) {
    // `.claude.json` is rewritten after the credential, so naming the switch
    // target proves the credential moved too; anything else is ambiguous.
    const { target, targetAccountUuid } = input.interrupted;
    if (input.liveAccountUuid && targetAccountUuid === input.liveAccountUuid) return target;
    return undefined;
  }
  if (input.owner !== null) {
    if (!input.liveAccountUuid || !input.ownerAccountUuid) return input.owner;
    if (input.ownerAccountUuid === input.liveAccountUuid) return input.owner;
  }
  if (!input.liveAccountUuid) return undefined;
  return input.vaults.find(
    (entry) => accountUuidOf(entry.login.oauthAccount) === input.liveAccountUuid,
  )?.profileId;
}

/**
 * Logins a switch or the migration could not attribute are kept aside so a
 * mistake is recoverable; they hold tokens, so they do not stay forever.
 */
export async function pruneClaudeStrayLogins(rootDir: string, now = Date.now()): Promise<void> {
  const dir = resolve(rootDir);
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(STRAY_LOGIN_PREFIX) || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    const stat = await lstatOrNull(file).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > STRAY_LOGIN_RETENTION_MS) {
      await fs.rm(file, { force: true });
    }
  }
}

function strayLoginFile(rootDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(resolve(rootDir), `${STRAY_LOGIN_PREFIX}${stamp}-${randomBytes(3).toString("hex")}.json`);
}

/**
 * Move one managed profile's login into the live slot and the previous one
 * into its vault: the hot swap. Returns the profile that was live before.
 * Choosing the System login moves nothing: sessions already running in the
 * slot keep their account, and new terminals run without the slot.
 */
export async function activateClaudeCliAccount(
  store: ClaudeLoginSlotStore,
  rawProfileId: string | null | undefined,
  options: ActivateClaudeCliAccountOptions = {},
): Promise<ClaudeCliProfileId | null> {
  const target = normalizeClaudeCliProfileId(rawProfileId);
  if (!isClaudeCliManagedProfileId(target)) {
    return readClaudeLiveProfileId(store.rootDir).catch(() => null);
  }
  const home = claudeLiveHome(store);
  return withClaudeSelectionLock(store.rootDir, () =>
    withClaudeCodeRefreshLock(
      home.configDir,
      () => activateLocked(store, home, target, options),
      options.refreshLockRetries === undefined ? {} : { retries: options.refreshLockRetries },
    ),
  );
}

async function activateLocked(
  store: ClaudeLoginSlotStore,
  home: ClaudeLiveHome,
  target: ClaudeCliProfileId,
  options: ActivateClaudeCliAccountOptions,
): Promise<ClaudeCliProfileId | null> {
  const selection = await readClaudeLiveSelection(store.rootDir);
  const managedOrNull = (value: ClaudeCliProfileId | undefined): ClaudeCliProfileId | null =>
    value && isClaudeCliManagedProfileId(value) ? value : null;
  const interruptedFrom = managedOrNull(selection?.switchingFrom);
  const owner = interruptedFrom ?? managedOrNull(selection?.profileId);
  const live = liveScopedKeys(
    await readClaudeCredentialStores(home.configDir, home.configDirEnv, options),
  );

  if (!interruptedFrom && owner === target) {
    // Re-selecting the live profile never round-trips its login through the
    // vault: the live slot is authoritative and the vault copy only trails.
    if (!options.allowSignedOut && !hasUsableLogin(live)) {
      throw new Error("The selected Claude account is not signed in");
    }
    return owner;
  }

  const known = new Set<ClaudeCliProfileId>([target, ...(owner ? [owner] : [])]);
  for (const profileId of (await options.knownProfileIds?.().catch(() => [])) ?? []) {
    known.add(profileId);
  }
  const vaults = await readVaultIndex(store, known);
  const liveOauthAccount = await readClaudeOauthAccount(home);
  const liveAccountUuid = accountUuidOf(liveOauthAccount);

  if (hasUsableLogin(live)) {
    const belongsTo = attributeLiveLogin({
      live,
      liveAccountUuid,
      owner,
      ownerAccountUuid: owner
        ? interruptedFrom
          ? vaultAccountUuid(vaults, owner)
          : (selection?.accountUuid ?? vaultAccountUuid(vaults, owner))
        : undefined,
      vaults,
      interrupted:
        interruptedFrom && selection
          ? {
              target: selection.profileId,
              targetAccountUuid: vaultAccountUuid(vaults, selection.profileId),
            }
          : null,
    });
    await saveLiveLogin(store, belongsTo, live, liveOauthAccount, liveAccountUuid, vaults, options);
  } else if (!interruptedFrom && owner) {
    // The live profile signed out (`/logout`) or Claude Code blanked a login
    // whose refresh token was already spent. Either way its trailing vault
    // copy is an older generation of the same dead login and must not come
    // back on a later switch; the recorded account stays for display.
    const previous = vaults.find((entry) => entry.profileId === owner)?.login;
    if (previous && hasUsableLogin(previous.store)) {
      await writeVaultedLogin(claudeCliVaultFile(store.rootDir, owner), {
        store: {},
        ...(previous.oauthAccount ? { oauthAccount: previous.oauthAccount } : {}),
      });
    }
  }

  // Read after the save: when the live login was the target's own (a switch
  // interrupted after the credential moved), its freshest copy is the one
  // just written.
  const targetVault = await readClaudeVaultedLogin(claudeCliVaultFile(store.rootDir, target));
  if (targetVault.kind === "unreadable") {
    throw new Error("The selected Claude account's saved login is unreadable");
  }
  const incoming =
    targetVault.kind === "value" && hasUsableLogin(targetVault.login.store)
      ? targetVault.login
      : null;
  if (!incoming && !options.allowSignedOut) {
    throw new Error("The selected Claude account is not signed in");
  }
  const incomingAccountUuid = accountUuidOf(incoming?.oauthAccount);
  const landed: ClaudeLiveSelection = {
    profileId: target,
    ...(incomingAccountUuid ? { accountUuid: incomingAccountUuid } : {}),
  };
  // The marker journals the switch before the live slot changes, so a crash
  // in between is finished by the next activation instead of attributing the
  // new login to the old profile.
  await writeLiveSelection(store.rootDir, owner ? { ...landed, switchingFrom: owner } : landed);
  await updateClaudeCredentialStores(
    home.configDir,
    home.configDirEnv,
    () => ({
      result: undefined,
      transform: (current) => replaceScopedKeys(current, incoming?.store ?? {}),
    }),
    options,
  );
  await updateClaudeGlobalConfig(home, (config) => {
    for (const key of CLAUDE_ACCOUNT_SCOPED_CONFIG_KEYS) delete config[key];
    if (incoming?.oauthAccount) config.oauthAccount = incoming.oauthAccount;
    return config;
  }).catch((error) => {
    options.log?.(
      `[accounts] Claude Code's config could not record the new account: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  await writeLiveSelection(store.rootDir, landed);
  return owner;
}

async function saveLiveLogin(
  store: ClaudeLoginSlotStore,
  belongsTo: ClaudeCliProfileId | undefined,
  live: ClaudeCredentialStoreObject,
  liveOauthAccount: Record<string, unknown> | null,
  liveAccountUuid: string | undefined,
  vaults: readonly VaultIndexEntry[],
  options: ActivateClaudeCliAccountOptions,
): Promise<void> {
  if (belongsTo === undefined) {
    const file = strayLoginFile(store.rootDir);
    await writeVaultedLogin(file, {
      store: live,
      ...(liveOauthAccount ? { oauthAccount: liveOauthAccount } : {}),
    });
    options.log?.(
      `[accounts] the live Claude login could not be attributed to an account; it was kept in ${basename(file)} instead of being saved into another account's vault`,
    );
    return;
  }
  if (
    isClaudeCliManagedProfileId(belongsTo) &&
    options.profileExists &&
    !(await options.profileExists(belongsTo))
  ) {
    options.log?.(
      "[accounts] the live Claude login belonged to a profile that no longer exists; it is dropped rather than saved",
    );
    return;
  }
  const previous = vaults.find((entry) => entry.profileId === belongsTo)?.login;
  const previousAccountUuid = accountUuidOf(previous?.oauthAccount);
  // `.claude.json` names the live login's account unless a crash (or the
  // retired slot swap) left it naming another account: the other side of a
  // switch, or any account another profile's vault records. The vault's own
  // record wins then, and no record beats a wrong one.
  const namesAnotherProfile =
    liveAccountUuid !== undefined &&
    vaults.some(
      (entry) =>
        entry.profileId !== belongsTo && accountUuidOf(entry.login.oauthAccount) === liveAccountUuid,
    );
  const oauthAccount =
    liveOauthAccount &&
    !namesAnotherProfile &&
    (!previousAccountUuid || previousAccountUuid === liveAccountUuid)
      ? liveOauthAccount
      : previous?.oauthAccount;
  await writeVaultedLogin(claudeCliVaultFile(store.rootDir, belongsTo), {
    store: live,
    ...(oauthAccount ? { oauthAccount } : {}),
  });
}

/**
 * Empty the live slot when the account it holds is deleted: its scoped keys
 * leave the store (MCP grants stay), the identity leaves the slot's
 * `.claude.json` and the marker goes, so no later switch can save the
 * deleted login back into a vault. A slot holding another account is left
 * alone. Callers hold the selection lock.
 */
export async function releaseClaudeLiveSlot(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  options: ClaudeCredentialStoreOptions = {},
): Promise<boolean> {
  const selection = await readClaudeLiveSelection(store.rootDir).catch(() => null);
  if (!selection) return false;
  if (selection.profileId !== profileId && selection.switchingFrom !== profileId) return false;
  const home = claudeLiveHome(store);
  await withClaudeCodeRefreshLock(home.configDir, async () => {
    await updateClaudeCredentialStores(
      home.configDir,
      home.configDirEnv,
      () => ({ result: undefined, transform: (current) => replaceScopedKeys(current, {}) }),
      options,
    );
    await updateClaudeGlobalConfig(home, (config) => {
      for (const key of CLAUDE_ACCOUNT_SCOPED_CONFIG_KEYS) delete config[key];
      return config;
    }).catch(() => undefined);
    await removePrivateFile(liveSelectionFile(store.rootDir)).catch(() => undefined);
  });
  return true;
}
