import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { withAccountSelectionLock } from "./account-selection-lock";
import {
  CLAUDE_CLI_ACCOUNTS_DIRECTORY,
  CLAUDE_CLI_CONFIG_FILE,
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  isClaudeCliManagedProfileId,
  normalizeClaudeCliProfileId,
  type ClaudeCliProfileId,
} from "./claude-cli-profile-ids";
import {
  CLAUDE_ACCOUNT_SCOPED_STORE_KEYS,
  fresherCredentialString,
  parseClaudeCredentialRecord,
  readClaudeCredentialStores,
  removeClaudeCredentialStores,
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
 * Claude Code accounts in one home. Every Claude terminal, in Studio or in
 * any other terminal app, runs against the user's own Claude home (~/.claude,
 * ~/.claude.json and the base Keychain item), so MCP grants, trust, settings,
 * history and keybindings exist exactly once. An account switch does what
 * `/login` as another account does in Claude Code itself: only the
 * account-scoped secure-storage keys and the `oauthAccount` block move.
 *
 *  - The live slot is the home's credential store. The marker
 *    (claude-cli/live-login.json) names the profile whose login it holds.
 *  - Every profile has a vault file (claude-cli/accounts/<id>/login.json, or
 *    claude-cli/personal-login.json for Account 1) holding its scoped keys
 *    and identity. While a profile is live its vault copy trails the live
 *    slot and is never read; a switch saves the live login into the
 *    outgoing profile's vault before the incoming vault is copied in.
 *  - A switch holds Claude Code's own refresh locks, so no refresh is in
 *    flight while the login moves. Running sessions keep going: Claude Code
 *    re-reads the store before each refresh check and adopts a login that
 *    changed underneath it, exactly as it does after a `/login` elsewhere.
 *
 * The marker journals a switch in progress, and the live login is attributed
 * by refresh token first and recorded account second, so a crash at any
 * point is finished by the next switch without saving one account's login
 * into another account's vault. A login that cannot be attributed is kept
 * in a backup file rather than overwritten.
 */

export const CLAUDE_CLI_LIVE_LOGIN_FILE = "live-login.json";
export const CLAUDE_CLI_VAULT_LOGIN_FILE = "login.json";
export const CLAUDE_CLI_PERSONAL_VAULT_FILE = "personal-login.json";
const STRAY_LOGIN_PREFIX = "stray-login-";
/** A login kept aside is recoverable by hand for a month, then removed. */
const STRAY_LOGIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_MCP_BASELINE_FILE = "mcp-servers.json";
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

/** Where the live Claude home is, plus the account root Codara owns. */
export interface ClaudeLoginSlotStore {
  readonly rootDir: string;
  readonly personalConfigDir: string;
  /** Null when CLAUDE_CONFIG_DIR is unset: `.claude.json` then sits beside the directory. */
  readonly personalConfigDirEnv: string | null;
}

export interface ClaudeLiveHome {
  configDir: string;
  configDirEnv: string | null;
  /** The directory that holds `.claude.json` when configDirEnv is null. */
  homeDir: string;
}

export function claudeLiveHome(store: ClaudeLoginSlotStore): ClaudeLiveHome {
  return {
    configDir: store.personalConfigDir,
    configDirEnv: store.personalConfigDirEnv,
    homeDir: dirname(resolve(store.personalConfigDir)),
  };
}

export function claudeCliVaultFile(rootDir: string, rawProfileId: string): string {
  const profileId = normalizeClaudeCliProfileId(rawProfileId);
  if (profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
    return join(resolve(rootDir), CLAUDE_CLI_PERSONAL_VAULT_FILE);
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

/** The live profile, defaulting to Account 1 before the marker exists. */
export async function readClaudeLiveProfileId(rootDir: string): Promise<ClaudeCliProfileId> {
  return (await readClaudeLiveSelection(rootDir))?.profileId ?? CLAUDE_CLI_PERSONAL_PROFILE_ID;
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

/** The login a profile holds right now: the live slot while it is live, its vault otherwise. */
export async function readClaudeProfileLogin(
  store: ClaudeLoginSlotStore,
  profileId: ClaudeCliProfileId,
  options: ClaudeCredentialStoreOptions = {},
): Promise<ClaudeProfileLoginRead> {
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
  if (!selection) return profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID;
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
   * Used by the delete hand-off.
   */
  allowSignedOut?: boolean;
  /** Whether a managed profile is still registered; a deleted one's login is not saved. */
  profileExists?: (profileId: ClaudeCliProfileId) => Promise<boolean>;
  /** Every registered profile, so a login `/login` put in the live slot can be attributed. */
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
  /** The profile the live login belongs to unless the evidence says otherwise. */
  owner: ClaudeCliProfileId;
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
  if (!input.liveAccountUuid || !input.ownerAccountUuid) return input.owner;
  if (input.ownerAccountUuid === input.liveAccountUuid) return input.owner;
  return input.vaults.find(
    (entry) => accountUuidOf(entry.login.oauthAccount) === input.liveAccountUuid,
  )?.profileId;
}

/**
 * Logins a switch or the migration could not attribute are kept aside so a
 * mistake is recoverable; they hold tokens, so they do not stay forever.
 */
async function pruneStrayLogins(rootDir: string, now: number): Promise<void> {
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
 * Move one profile's login into the live Claude home and the previous one
 * into its vault. Returns the profile that was live before.
 */
export async function activateClaudeCliAccount(
  store: ClaudeLoginSlotStore,
  rawProfileId: string | null | undefined,
  options: ActivateClaudeCliAccountOptions = {},
): Promise<ClaudeCliProfileId> {
  const target = normalizeClaudeCliProfileId(rawProfileId);
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
): Promise<ClaudeCliProfileId> {
  const selection = await readClaudeLiveSelection(store.rootDir);
  const interruptedFrom = selection?.switchingFrom;
  const owner = interruptedFrom ?? selection?.profileId ?? CLAUDE_CLI_PERSONAL_PROFILE_ID;
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

  const known = new Set<ClaudeCliProfileId>([CLAUDE_CLI_PERSONAL_PROFILE_ID, owner, target]);
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
      ownerAccountUuid: interruptedFrom
        ? vaultAccountUuid(vaults, owner)
        : (selection?.accountUuid ?? vaultAccountUuid(vaults, owner)),
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
  } else if (!interruptedFrom) {
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
  await writeLiveSelection(store.rootDir, { ...landed, switchingFrom: owner });
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

// ---------------------------------------------------------------------------
// Following a sign-in made in a terminal.

export interface ClaudeNativeLoginChange {
  /** The profile the marker names, whose login `/login` replaced. */
  from: ClaudeCliProfileId;
  /** The known profile the live login now belongs to. */
  to: ClaudeCliProfileId;
  accountUuid: string;
}

/**
 * Whether a `/login` in a terminal put another known account's login in the
 * live slot. Claude Code records the new account in `.claude.json`; the
 * token itself confirms it (`verifyAccountUuid` asks the account API), so a
 * stale record never moves the Active account. Null when nothing changed,
 * the account is unknown, or two profiles record it.
 */
export async function detectClaudeNativeLogin(
  store: ClaudeLoginSlotStore,
  knownProfileIds: readonly ClaudeCliProfileId[],
  verifyAccountUuid: (accessToken: string) => Promise<string | undefined>,
  options: ClaudeCredentialStoreOptions = {},
): Promise<ClaudeNativeLoginChange | null> {
  const selection = await readClaudeLiveSelection(store.rootDir).catch(() => null);
  if (!selection || selection.switchingFrom) return null;
  const home = claudeLiveHome(store);
  const liveAccountUuid = accountUuidOf(await readClaudeOauthAccount(home).catch(() => null));
  if (!liveAccountUuid) return null;
  const known = new Set<ClaudeCliProfileId>([CLAUDE_CLI_PERSONAL_PROFILE_ID, ...knownProfileIds]);
  const vaults = await readVaultIndex(store, known);
  // An owner whose account is unknown (the first marker had none to go by)
  // still yields to a login that exactly one other profile records; the
  // token check below keeps a stale record from moving anything.
  const ownerAccountUuid = selection.accountUuid ?? vaultAccountUuid(vaults, selection.profileId);
  if (ownerAccountUuid === liveAccountUuid) return null;
  const owners = vaults.filter(
    (entry) =>
      entry.profileId !== selection.profileId &&
      accountUuidOf(entry.login.oauthAccount) === liveAccountUuid,
  );
  if (owners.length !== 1) return null;
  const live = claudeLiveLoginRecord(
    await readClaudeCredentialStores(home.configDir, home.configDirEnv, options),
  );
  if (!live?.accessToken) return null;
  const verified = await verifyAccountUuid(live.accessToken).catch(() => undefined);
  if (verified?.trim().toLowerCase() !== liveAccountUuid) return null;
  return { from: selection.profileId, to: owners[0].profileId, accountUuid: liveAccountUuid };
}

/**
 * Make the profile a terminal `/login` signed in as the live one: its vault
 * takes the live login and the marker moves. The live slot is not touched;
 * the replaced profile keeps the login its vault (and Cora half) holds.
 * False when the slot changed since the detection.
 */
export async function adoptClaudeNativeLogin(
  store: ClaudeLoginSlotStore,
  change: ClaudeNativeLoginChange,
  options: ClaudeCredentialStoreOptions = {},
): Promise<boolean> {
  const home = claudeLiveHome(store);
  return withClaudeSelectionLock(store.rootDir, () =>
    withClaudeCodeRefreshLock(home.configDir, async () => {
      const selection = await readClaudeLiveSelection(store.rootDir);
      if (!selection || selection.switchingFrom || selection.profileId !== change.from) return false;
      const liveOauthAccount = await readClaudeOauthAccount(home);
      if (accountUuidOf(liveOauthAccount) !== change.accountUuid) return false;
      const live = liveScopedKeys(
        await readClaudeCredentialStores(home.configDir, home.configDirEnv, options),
      );
      if (!hasUsableLogin(live)) return false;
      await writeVaultedLogin(claudeCliVaultFile(store.rootDir, change.to), {
        store: live,
        ...(liveOauthAccount ? { oauthAccount: liveOauthAccount } : {}),
      });
      await writeLiveSelection(store.rootDir, { profileId: change.to, accountUuid: change.accountUuid });
      return true;
    }),
  );
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

// ---------------------------------------------------------------------------
// Leaving the per-directory model.

export interface MigrateClaudeToOneHomeInput extends ClaudeCredentialStoreOptions {
  store: ClaudeLoginSlotStore;
  /** Registered managed profiles, each once a CLAUDE_CONFIG_DIR of its own. */
  managedProfileIds: readonly string[];
  /** The profile new terminals used; its keybindings win when they are newer. */
  defaultProfileId?: ClaudeCliProfileId;
  log?: (message: string) => void;
}

export interface MigrateClaudeToOneHomeResult {
  /** The marker was written now: the first launch on the one-home model. */
  createdMarker: boolean;
  /** Profiles whose directory login moved into a vault. */
  vaulted: string[];
  /** MCP grants that reached the live store from an account directory. */
  mcpGrants: number;
  /** Projects whose trust and permissions reached `.claude.json` from an account directory. */
  projects: number;
  /** Profiles whose directory credential stores were removed. */
  retired: string[];
  /** Directories of accounts no longer registered, removed once their transcripts moved home. */
  orphans: string[];
}

/**
 * Copy the session transcripts of a retired account directory into the
 * live home's `projects/`, never replacing one that is already there. A
 * `projects` link into the home (how managed directories shared it) holds
 * nothing of its own.
 */
async function moveTranscriptsHome(legacyDir: string, homeConfigDir: string): Promise<number> {
  const source = join(legacyDir, "projects");
  const stat = await lstatOrNull(source);
  if (!stat?.isDirectory()) return 0;
  let moved = 0;
  const target = join(homeConfigDir, "projects");
  for (const project of await fs.readdir(source, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const from = join(source, project.name);
    const to = join(target, project.name);
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        await fs.copyFile(join(from, entry.name), join(to, entry.name), fsConstants.COPYFILE_EXCL);
        moved += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
  return moved;
}

/**
 * Account directories whose account is no longer registered (a delete that
 * predates the one home, or a crash between the directory and the
 * registry). One that still holds a login is left for the user; one that
 * holds none only keeps transcripts, which move home before it goes.
 */
async function retireOrphanAccountDirs(
  store: ClaudeLoginSlotStore,
  managedProfileIds: readonly string[],
  options: ClaudeCredentialStoreOptions,
  log: (message: string) => void,
): Promise<string[]> {
  const accountsDir = join(resolve(store.rootDir), CLAUDE_CLI_ACCOUNTS_DIRECTORY);
  const registered = new Set(managedProfileIds);
  const entries = await fs.readdir(accountsDir, { withFileTypes: true }).catch(() => []);
  const retired: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || registered.has(entry.name)) continue;
    if (!isClaudeCliManagedProfileId(entry.name)) continue;
    const dir = join(accountsDir, entry.name);
    try {
      const stores = await readClaudeCredentialStores(dir, dir, options);
      const vault = await readClaudeVaultedLogin(claudeCliVaultFile(store.rootDir, entry.name));
      if (stores.keychain || stores.file || vault.kind !== "none") continue;
      const moved = await moveTranscriptsHome(dir, store.personalConfigDir);
      await fs.rm(dir, { recursive: true, force: true });
      retired.push(entry.name);
      log(
        `[accounts] removed the directory of an account that is no longer registered (${moved} transcript(s) moved to the Claude home)`,
      );
    } catch (error) {
      log(
        `[accounts] an unregistered Claude account directory was left in place: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return retired;
}

/** Which of two stored MCP grants is healthier: a refresh token, then the later expiry, then any token. */
function mcpGrantRank(entry: unknown): [number, number, number] {
  if (!isRecord(entry)) return [0, 0, 0];
  return [
    nonEmpty(entry.refreshToken) ? 1 : 0,
    typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0,
    nonEmpty(entry.accessToken) ? 1 : 0,
  ];
}

function mcpGrantIsBetter(candidate: unknown, current: unknown): boolean {
  const a = mcpGrantRank(candidate);
  const b = mcpGrantRank(current);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/**
 * Fold one directory store's non-account keys into the live store: each MCP
 * grant is taken when the live store has none or a weaker one for that
 * server, and any other key the live store lacks is carried over. Account
 * keys never move here; they go to the profile's vault.
 */
function mergeSharedKeys(
  live: ClaudeCredentialStoreObject,
  legacy: ClaudeCredentialStoreObject,
): { store: ClaudeCredentialStoreObject; grants: number } {
  const scoped = new Set<string>(CLAUDE_ACCOUNT_SCOPED_STORE_KEYS);
  let grants = 0;
  for (const [key, value] of Object.entries(legacy)) {
    if (scoped.has(key)) continue;
    if (key === "mcpOAuth" && isRecord(value)) {
      const merged: Record<string, unknown> = isRecord(live.mcpOAuth) ? { ...live.mcpOAuth } : {};
      for (const [server, grant] of Object.entries(value)) {
        if (!(server in merged) || mcpGrantIsBetter(grant, merged[server])) {
          merged[server] = grant;
          grants += 1;
        }
      }
      live.mcpOAuth = merged;
      continue;
    }
    if (!(key in live)) live[key] = value;
  }
  return { store: live, grants };
}

/**
 * Carry what a Codara-launched session learned in an account directory's
 * `.claude.json` over to the live one: projects the live file has never
 * seen (trust, allowed tools, local-scope MCP servers) and user-scope MCP
 * servers it lacks. Entries the live file already has always win.
 */
function mergeLegacyConfig(
  live: Record<string, unknown>,
  legacy: Record<string, unknown>,
): { config: Record<string, unknown>; projects: number; changed: boolean } {
  let projects = 0;
  let changed = false;
  if (isRecord(legacy.projects)) {
    const merged: Record<string, unknown> = isRecord(live.projects) ? { ...live.projects } : {};
    for (const [path, entry] of Object.entries(legacy.projects)) {
      if (path in merged) continue;
      merged[path] = entry;
      projects += 1;
    }
    if (projects > 0) {
      live.projects = merged;
      changed = true;
    }
  }
  if (isRecord(legacy.mcpServers)) {
    const merged: Record<string, unknown> = isRecord(live.mcpServers) ? { ...live.mcpServers } : {};
    let added = 0;
    for (const [name, server] of Object.entries(legacy.mcpServers)) {
      if (name in merged) continue;
      merged[name] = server;
      added += 1;
    }
    if (added > 0) {
      live.mcpServers = merged;
      changed = true;
    }
  }
  return { config: live, projects, changed };
}

async function readLegacyConfig(configDir: string): Promise<Record<string, unknown> | null> {
  for (const name of [".config.json", CLAUDE_CLI_CONFIG_FILE]) {
    try {
      const config = await readConfigObject(join(configDir, name));
      if (config) return config;
    } catch {
      // An unreadable legacy config carries nothing over.
    }
  }
  return null;
}

/**
 * The account directory's own keybindings replace the live ones when they
 * are newer: Claude Code wrote them from a Codara terminal, so they are the
 * latest the user chose. The replaced file is kept beside it.
 */
async function adoptLegacyKeybindings(
  legacyDir: string,
  liveDir: string,
  log: (message: string) => void,
): Promise<void> {
  const legacy = join(legacyDir, "keybindings.json");
  const live = join(liveDir, "keybindings.json");
  const legacyStats = await lstatOrNull(legacy).catch(() => null);
  if (!legacyStats?.isFile() || legacyStats.isSymbolicLink()) return;
  const liveStats = await lstatOrNull(live).catch(() => null);
  if (liveStats && (!liveStats.isFile() || liveStats.isSymbolicLink())) return;
  const legacyBytes = await fs.readFile(legacy);
  if (liveStats) {
    if (liveStats.mtimeMs >= legacyStats.mtimeMs) return;
    const liveBytes = await fs.readFile(live);
    if (liveBytes.equals(legacyBytes)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(`${live}.codara-backup-${stamp}`, liveBytes, { flag: "wx", mode: 0o600 });
  }
  await fs.mkdir(liveDir, { recursive: true });
  const temporary = join(liveDir, `.keybindings.json.codara-${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(temporary, legacyBytes, { flag: "wx", mode: liveStats ? liveStats.mode & 0o777 : 0o644 });
  await fs.rename(temporary, live);
  log("[accounts] kept the Claude keybindings last edited from a Codara terminal");
}

/**
 * The idempotent step from one CLAUDE_CONFIG_DIR per account to one home.
 * Runs in the startup pass before any Claude terminal launches, so no Codara
 * session still reads an account directory. Each directory's login becomes
 * its profile's vault (an existing vault is newer and wins), its MCP grants
 * and projects join the live home, and only then are its credential stores
 * removed so no grant ever has two live holders. A directory with nothing
 * left to move costs two reads.
 */
export async function migrateClaudeToOneHome(
  input: MigrateClaudeToOneHomeInput,
): Promise<MigrateClaudeToOneHomeResult> {
  const { store } = input;
  const log = input.log ?? (() => undefined);
  const options: ClaudeCredentialStoreOptions = input.fileOnly ? { fileOnly: true } : {};
  const home = claudeLiveHome(store);
  const result: MigrateClaudeToOneHomeResult = {
    createdMarker: false,
    vaulted: [],
    mcpGrants: 0,
    projects: 0,
    retired: [],
    orphans: [],
  };
  await withClaudeSelectionLock(store.rootDir, async () => {
    if (!(await readClaudeLiveSelection(store.rootDir))) {
      // Before this model the home only ever held the user's own login.
      const accountUuid = accountUuidOf(await readClaudeOauthAccount(home));
      await writeLiveSelection(store.rootDir, {
        profileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
        ...(accountUuid ? { accountUuid } : {}),
      });
      result.createdMarker = true;
    }
  });

  for (const profileId of input.managedProfileIds) {
    if (!isClaudeCliManagedProfileId(profileId)) continue;
    const legacyDir = join(resolve(store.rootDir), CLAUDE_CLI_ACCOUNTS_DIRECTORY, profileId);
    if (!(await lstatOrNull(legacyDir).catch(() => null))?.isDirectory()) continue;
    try {
      await withClaudeSelectionLock(store.rootDir, async () => {
        const stores = await readClaudeCredentialStores(legacyDir, legacyDir, options);
        const legacyConfig = await readLegacyConfig(legacyDir);
        if (stores.keychain || stores.file) {
          const scoped = liveScopedKeys(stores);
          const vaultFile = claudeCliVaultFile(store.rootDir, profileId);
          const vault = await readClaudeVaultedLogin(vaultFile);
          if (vault.kind === "unreadable") {
            throw new Error("the account's vault is unreadable");
          }
          const vaultHasLogin = vault.kind === "value" && hasUsableLogin(vault.login.store);
          if (vaultHasLogin && vault.kind === "value" && hasUsableLogin(scoped)) {
            // Both hold a login: a pass that stopped halfway, or a session
            // still pointed at the directory that refreshed since. The later
            // generation is the account's present; an earlier one is spent.
            const fromDirectory = claudeLoginRecordOf(scoped);
            const fromVault = claudeLoginRecordOf(vault.login.store);
            const directoryIsNewer =
              fromDirectory !== null &&
              fromDirectory.refreshToken !== fromVault?.refreshToken &&
              fromDirectory.expiresAt > (fromVault?.expiresAt ?? 0);
            if (directoryIsNewer) {
              const live = (await readClaudeLiveProfileId(store.rootDir)) === profileId;
              if (live) {
                // The live slot is this account's own login; the directory's
                // is kept aside rather than overwrite it or be lost.
                await writeVaultedLogin(strayLoginFile(store.rootDir), {
                  store: scoped,
                  ...(vault.login.oauthAccount ? { oauthAccount: vault.login.oauthAccount } : {}),
                });
                log("[accounts] a newer Claude login found in an account directory was kept aside beside the live one");
              } else {
                await writeVaultedLogin(vaultFile, { ...vault.login, store: scoped });
                result.vaulted.push(profileId);
              }
            }
          } else if (!vaultHasLogin && hasUsableLogin(scoped)) {
            const oauthAccount =
              (vault.kind === "value" ? vault.login.oauthAccount : undefined) ??
              (isRecord(legacyConfig?.oauthAccount) ? legacyConfig.oauthAccount : undefined);
            await writeVaultedLogin(vaultFile, {
              store: scoped,
              ...(oauthAccount ? { oauthAccount } : {}),
            });
            result.vaulted.push(profileId);
          }
          for (const legacy of [stores.file, stores.keychain]) {
            if (!legacy) continue;
            let grants = 0;
            await updateClaudeCredentialStores(
              home.configDir,
              home.configDirEnv,
              () => ({
                result: undefined,
                transform: (current) => {
                  const merged = mergeSharedKeys(current, legacy);
                  grants = Math.max(grants, merged.grants);
                  return merged.store;
                },
              }),
              options,
            );
            result.mcpGrants += grants;
          }
        }
        if (legacyConfig) {
          let projects = 0;
          await updateClaudeGlobalConfig(home, (config) => {
            const merged = mergeLegacyConfig(config, legacyConfig);
            projects = merged.projects;
            return merged.changed ? merged.config : null;
          });
          result.projects += projects;
        }
        if (profileId === input.defaultProfileId) {
          await adoptLegacyKeybindings(legacyDir, home.configDir, log).catch(() => undefined);
        }
        if (stores.keychain || stores.file) {
          await removeClaudeCredentialStores(legacyDir, legacyDir, options);
          result.retired.push(profileId);
        }
      });
    } catch (error) {
      log(
        `[accounts] Claude account ${profileId} could not move to the shared home yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // The baseline the per-account MCP server sync kept; one home needs none.
  await fs.rm(join(resolve(store.rootDir), RETIRED_MCP_BASELINE_FILE), { force: true }).catch(
    () => undefined,
  );
  result.orphans = await withClaudeSelectionLock(store.rootDir, () =>
    retireOrphanAccountDirs(store, input.managedProfileIds, options, log),
  );
  await pruneStrayLogins(store.rootDir, Date.now()).catch(() => undefined);
  // The first marker names the home's account from `.claude.json`, which the
  // retired slot swap could leave naming a managed account. A personal marker
  // that names an account a managed vault records is that stale copy: the
  // personal login's account is unknown then, not the managed one's.
  await withClaudeSelectionLock(store.rootDir, async () => {
    const selection = await readClaudeLiveSelection(store.rootDir);
    if (selection?.profileId !== CLAUDE_CLI_PERSONAL_PROFILE_ID || !selection.accountUuid) return;
    const managed = await readVaultIndex(
      store,
      input.managedProfileIds.filter(isClaudeCliManagedProfileId),
    );
    if (managed.some((entry) => accountUuidOf(entry.login.oauthAccount) === selection.accountUuid)) {
      await writeLiveSelection(store.rootDir, {
        profileId: selection.profileId,
        ...(selection.switchingFrom ? { switchingFrom: selection.switchingFrom } : {}),
      });
    }
  }).catch(() => undefined);
  if (result.vaulted.length > 0 || result.mcpGrants > 0 || result.projects > 0) {
    log(
      `[accounts] Claude accounts now share one home: ${result.vaulted.length} login(s) vaulted, ${result.mcpGrants} MCP grant(s) and ${result.projects} project(s) carried over`,
    );
  }
  return result;
}
