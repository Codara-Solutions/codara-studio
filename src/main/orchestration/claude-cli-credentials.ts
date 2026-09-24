import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { atomicWritePrivateFile } from "./native-cli-atomic-file";

/**
 * Claude Code's credential slot, read and written the way Claude Code itself
 * does it: on macOS the Keychain item for the config directory is consulted
 * first and the 0600 `.credentials.json` file second; elsewhere only the file
 * exists. A write lands in every store that already exists, and a store is
 * only ever created where Claude Code would create one: a Keychain item on
 * macOS when neither exists, the file everywhere else. Creating a Keychain
 * item beside a file Claude Code has fallen back to would shadow that file,
 * MCP grants included, on its next read.
 *
 * Writes replace only the keys they name. MCP grants and other fields in each
 * store survive, and never move to a different account. Nothing here selects
 * an account; this module only moves bytes for one directory.
 */

export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The secure-storage keys that belong to one Anthropic login. Claude Code
 * 2.1.281 deletes exactly these when it signs in as another account and
 * keeps every other key (mcpOAuth above all), so an account switch moves
 * these and nothing else.
 */
export const CLAUDE_ACCOUNT_SCOPED_STORE_KEYS = [
  "claudeAiOauth",
  "organizationUuid",
  "trustedDeviceToken",
  "enterpriseGateway",
  "designOauth",
] as const;

const REFRESH_LOCK_FILE = ".oauth_refresh.lock";
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_UPDATE_MS = 5_000;
const STORAGE_LOCK_FILE = ".storage-write";
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const KEYCHAIN_TIMEOUT_MS = 10_000;
const SECURITY_BINARY = "/usr/bin/security";

interface ClaudeCliCredentialSeams {
  platform: NodeJS.Platform;
  securityBinary: string;
}

const seams: ClaudeCliCredentialSeams = {
  platform: process.platform,
  securityBinary: SECURITY_BINARY,
};

/**
 * Test seam: point the backend at a fake `security` and a chosen platform so
 * a suite can exercise the macOS paths without touching the user's Keychain.
 * Production never calls this.
 */
export function setClaudeCliCredentialSeamsForTests(
  overrides: Partial<ClaudeCliCredentialSeams> | null,
): void {
  seams.platform = overrides?.platform ?? process.platform;
  seams.securityBinary = overrides?.securityBinary ?? SECURITY_BINARY;
}

export interface ClaudeCliCredentialBackend {
  read(configDir: string, configDirEnv: string | null): Promise<string | null>;
  write(
    configDir: string,
    configDirEnv: string | null,
    credential: string,
  ): Promise<void>;
  clear?(configDir: string, configDirEnv: string | null): Promise<void>;
}

/** The `claudeAiOauth` shape Claude Code stores. Unknown keys are preserved. */
export interface ClaudeCredentialRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

export function claudeCredentialFile(configDir: string): string {
  return join(resolve(configDir), CLAUDE_CREDENTIALS_FILE);
}

function normalizeCredentialStore(value: string | Buffer): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (Buffer.byteLength(text, "utf8") > MAX_AUTH_BYTES) {
    throw new Error("Claude account credential is unexpectedly large");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError();
    }
    return JSON.stringify(parsed);
  } catch {
    throw new Error("Claude account credential is invalid");
  }
}

export function normalizeCredential(value: string | Buffer): string {
  const normalized = normalizeCredentialStore(value);
  try {
    const oauth = (JSON.parse(normalized) as { claudeAiOauth?: unknown }).claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
      throw new TypeError();
    }
    const record = oauth as { accessToken?: unknown; refreshToken?: unknown };
    if (
      typeof record.accessToken !== "string" &&
      typeof record.refreshToken !== "string"
    ) {
      throw new TypeError();
    }
    return normalized;
  } catch {
    // Never include JSON.parse's source excerpt: it can contain token bytes.
    throw new Error("Claude account credential is invalid");
  }
}

export async function safeCredentialFile(path: string): Promise<boolean> {
  const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Claude account credential is not a regular file");
  }
  if (stat.size > MAX_AUTH_BYTES) {
    throw new Error("Claude account credential is unexpectedly large");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Claude account credential permissions are not private");
  }
  return true;
}

export async function readCredentialFile(path: string): Promise<string | null> {
  if (!(await safeCredentialFile(path))) return null;
  return normalizeCredentialStore(await fs.readFile(path));
}

export async function atomicWriteCredential(
  destination: string,
  credential: string,
): Promise<void> {
  await atomicWritePrivateFile(destination, normalizeCredentialStore(credential), {
    maxBytes: MAX_AUTH_BYTES,
  });
}

/**
 * Claude Code namespaces its Keychain item by the first eight hex characters
 * of the sha256 of the NFC-normalized CLAUDE_CONFIG_DIR; the base service is
 * used when the variable is unset. The spelling has to match the one Claude
 * Code hashes or the two sides refresh into items the other never reads.
 */
export function claudeCliKeychainService(configDirEnv: string | null): string {
  if (!configDirEnv) return KEYCHAIN_SERVICE;
  const suffix = createHash("sha256")
    .update(resolve(configDirEnv).normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

export function readKeychainCredential(service: string): Promise<string | null> {
  if (seams.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolvePromise, reject) => {
    execFile(
      seams.securityBinary,
      [
        "find-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: MAX_AUTH_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const code = (error as { code?: string | number }).code;
          // `security` uses a non-zero status when an item does not exist.
          if (code === 44 || code === "44") {
            resolvePromise(null);
            return;
          }
          reject(new Error("Claude Code credential could not be read from Keychain"));
          return;
        }
        try {
          resolvePromise(normalizeCredentialStore(stdout.trim()));
        } catch {
          reject(new Error("Claude Code credential in Keychain is invalid"));
        }
      },
    );
  });
}

export function writeKeychainCredential(service: string, credential: string): Promise<void> {
  if (seams.platform !== "darwin") return Promise.resolve();
  const normalized = normalizeCredentialStore(credential);
  return new Promise((resolvePromise, reject) => {
    // `security -w` without a value opens an interactive prompt. Electron's
    // hidden main process has no controlling terminal, so that form hangs or
    // exits even when stdin is piped. Pass the bounded credential directly to
    // the argument-vector API: no shell is involved and stdout/stderr are
    // discarded. The process is short-lived and its argv is never logged.
    execFile(
      seams.securityBinary,
      [
        "add-generic-password",
        "-U",
        "-a",
        userInfo().username,
        "-s",
        service,
        "-w",
        normalized,
      ],
      {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
      (error) => {
        if (!error) resolvePromise();
        else reject(new Error("Claude Code credential could not be written to Keychain"));
      },
    );
  });
}

export function deleteKeychainCredential(service: string): Promise<void> {
  if (seams.platform !== "darwin") return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    execFile(
      seams.securityBinary,
      [
        "delete-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service,
      ],
      {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
      (error) => {
        if (!error) {
          resolvePromise();
          return;
        }
        const code = (error as { code?: string | number }).code;
        if (code === 44 || code === "44") {
          resolvePromise();
          return;
        }
        reject(new Error("Claude Code credential could not be removed from Keychain"));
      },
    );
  });
}

async function removeCredentialFile(path: string): Promise<void> {
  if (!(await safeCredentialFile(path))) return;
  await fs.unlink(path);
}

/**
 * Test and CI seam: with CODARA_DISABLE_KEYCHAIN=1 the default backend never
 * spawns /usr/bin/security, so a suite pointed at temporary directories can
 * exercise the production backend without touching the user's Keychain.
 */
function keychainDisabled(): boolean {
  return process.env.CODARA_DISABLE_KEYCHAIN === "1";
}

/**
 * The fresher of two serialized credentials by their claudeAiOauth.expiresAt.
 * Claude Code 2.1.251 refreshes the personal macOS login into the FILE while
 * an earlier generation of the same login can sit in the Keychain item, so
 * the two stores hold different generations of one account. Never-regress
 * applies across stores exactly as it does across halves: the later expiry is
 * the login's present. Ties and an unparseable rival keep `first` (the
 * Keychain in the default backend) so single-store setups are unchanged.
 */
export function fresherCredentialString(first: string, second: string): string {
  const expiry = (raw: string): number | null => {
    try {
      const record = parseClaudeCredentialRecord(raw);
      if (!record) return null;
      const value = record.expiresAt;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return null;
    }
  };
  const a = expiry(first);
  const b = expiry(second);
  if (a === null) return b === null ? first : second;
  if (b === null) return first;
  return b > a ? second : first;
}

function loginFromStore(raw: string | null): string | null {
  return parseClaudeCredentialRecord(raw) === null ? null : raw;
}

export type ClaudeCredentialStoreObject = Record<string, unknown>;

/** Both backends of one config directory, as parsed objects. */
export interface ClaudeCredentialStores {
  /** The Keychain item; null when there is none or no Keychain is in use. */
  keychain: ClaudeCredentialStoreObject | null;
  /** `.credentials.json`; null when the file does not exist. */
  file: ClaudeCredentialStoreObject | null;
}

export interface ClaudeCredentialStoreUpdate<T> {
  /**
   * Applied to every store that is written: each existing store, or the one
   * Claude Code would create when none exists. Receives an empty object for a
   * store being created. Returning an empty object removes the store.
   */
  transform?: (store: ClaudeCredentialStoreObject) => ClaudeCredentialStoreObject;
  result: T;
}

export interface ClaudeCredentialStoreOptions {
  /** Test seam: never touch a Keychain, even on macOS. */
  fileOnly?: boolean;
}

function parseStoreObject(raw: string | null): ClaudeCredentialStoreObject | null {
  return raw === null
    ? null
    : (JSON.parse(normalizeCredentialStore(raw)) as ClaudeCredentialStoreObject);
}

function storeText(store: ClaudeCredentialStoreObject): string | null {
  return Object.keys(store).length === 0 ? null : JSON.stringify(store);
}

function useKeychainBackend(options: ClaudeCredentialStoreOptions): boolean {
  return !options.fileOnly && !keychainDisabled() && seams.platform === "darwin";
}

/** Both backends of a directory, read without the storage lock. Throws when either is unreadable. */
export async function readClaudeCredentialStores(
  configDir: string,
  configDirEnv: string | null,
  options: ClaudeCredentialStoreOptions = {},
): Promise<ClaudeCredentialStores> {
  const [keychain, file] = await Promise.all([
    useKeychainBackend(options)
      ? readKeychainCredential(claudeCliKeychainService(configDirEnv))
      : Promise.resolve(null),
    readCredentialFile(claudeCredentialFile(configDir)),
  ]);
  return { keychain: parseStoreObject(keychain), file: parseStoreObject(file) };
}

/**
 * Read both stores of a directory, change them under Claude Code's own
 * `.storage-write` lock, and write back only what changed. Claude Code
 * 2.1.281 takes the same proper-lockfile lock for every login and MCP
 * mutation and re-reads inside it, so neither side can replace the other's
 * write with a snapshot taken before the lock.
 *
 * The update callback sees what is stored now and returns how to change it
 * plus a result for the caller; it runs inside the lock, so a decision made
 * from the stores it was handed still holds when the write lands.
 */
export async function updateClaudeCredentialStores<T>(
  configDir: string,
  configDirEnv: string | null,
  update: (stores: ClaudeCredentialStores) => ClaudeCredentialStoreUpdate<T>,
  options: ClaudeCredentialStoreOptions = {},
): Promise<T> {
  const created = await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  let compromised = false;
  const release = await lock(join(configDir, STORAGE_LOCK_FILE), {
    realpath: false,
    retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
    stale: 15_000,
    onCompromised: () => { compromised = true; },
  });
  const assertLocked = (): void => {
    if (compromised) throw new Error("Claude credential write lock was lost");
  };
  let removedEverything = false;
  try {
    const file = claudeCredentialFile(configDir);
    const useKeychain = useKeychainBackend(options);
    const service = claudeCliKeychainService(configDirEnv);
    const fromFile = parseStoreObject(await readCredentialFile(file));
    const fromKeychain = useKeychain ? parseStoreObject(await readKeychainCredential(service)) : null;
    const { transform, result } = update({ keychain: fromKeychain, file: fromFile });
    if (!transform) return result;
    // The store Claude Code reads is the Keychain item when one exists and
    // the file otherwise; a missing item is only created when there is no
    // file it would shadow.
    const writeKeychain = useKeychain && (fromKeychain !== null || fromFile === null);
    const writeFile = fromFile !== null || !useKeychain;
    const beforeKeychain = fromKeychain === null ? null : storeText(fromKeychain);
    const beforeFile = fromFile === null ? null : storeText(fromFile);
    const nextKeychain = writeKeychain ? storeText(transform({ ...(fromKeychain ?? {}) })) : beforeKeychain;
    const nextFile = writeFile ? storeText(transform({ ...(fromFile ?? {}) })) : beforeFile;
    assertLocked();
    if (writeKeychain && nextKeychain !== beforeKeychain) {
      if (nextKeychain === null) await deleteKeychainCredential(service);
      else await writeKeychainCredential(service, nextKeychain);
    }
    assertLocked();
    if (writeFile && nextFile !== beforeFile) {
      if (nextFile === null) await removeCredentialFile(file);
      else await atomicWriteCredential(file, nextFile);
    }
    assertLocked();
    removedEverything = nextKeychain === null && nextFile === null;
    return result;
  } finally {
    await release();
    if (removedEverything && created) await fs.rmdir(configDir).catch(() => undefined);
  }
}

/** Remove both stores of a directory outright: the Keychain item and the file. */
export async function removeClaudeCredentialStores(
  configDir: string,
  configDirEnv: string | null,
  options: ClaudeCredentialStoreOptions = {},
): Promise<void> {
  if (useKeychainBackend(options)) {
    await deleteKeychainCredential(claudeCliKeychainService(configDirEnv));
  }
  await removeCredentialFile(claudeCredentialFile(configDir));
}

/** Only the Claude login moves between accounts; MCP grants belong to this store. */
async function mutateLogin(
  configDir: string,
  configDirEnv: string | null,
  credential: string | null,
  fileOnly = false,
): Promise<void> {
  const login =
    credential === null ? null : JSON.parse(normalizeCredential(credential)).claudeAiOauth;
  await updateClaudeCredentialStores(
    configDir,
    configDirEnv,
    () => ({
      result: undefined,
      transform: (store) => {
        if (login === null) delete store.claudeAiOauth;
        else store.claudeAiOauth = login;
        return store;
      },
    }),
    { fileOnly },
  );
}

/**
 * Hold Claude Code's own refresh locks on a config directory while
 * `operation` runs. Claude Code 2.1.281 takes both before it refreshes a
 * login (`.oauth_refresh.lock` inside the directory, and the legacy
 * `<directory>.lock` beside it), re-reads the store under them, and saves
 * with a compare-and-swap on the refresh token. Replacing the login while
 * holding them means no refresh is in flight: a refresh that started before
 * finishes first and its result is what gets moved, and one that starts
 * after sees the new login and adopts it instead of refreshing the old one.
 */
export async function withClaudeCodeRefreshLock<T>(
  configDir: string,
  operation: () => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const retries = {
    retries: options.retries ?? 30,
    minTimeout: 100,
    maxTimeout: 1000,
  };
  let compromised = false;
  const onCompromised = (): void => {
    compromised = true;
  };
  const common = {
    realpath: false,
    stale: REFRESH_LOCK_STALE_MS,
    update: REFRESH_LOCK_UPDATE_MS,
    retries,
    onCompromised,
  };
  const releaseCurrent = await lock(configDir, {
    ...common,
    lockfilePath: join(configDir, REFRESH_LOCK_FILE),
  });
  let releaseLegacy: (() => Promise<void>) | null = null;
  try {
    const real = await fs.realpath(configDir).catch(() => configDir);
    const legacy = `${real}.lock`;
    releaseLegacy = await lock(legacy, { ...common, lockfilePath: legacy });
    const result = await operation();
    if (compromised) throw new Error("Claude Code's refresh lock was lost");
    return result;
  } finally {
    if (releaseLegacy) await releaseLegacy().catch(() => undefined);
    await releaseCurrent().catch(() => undefined);
  }
}

export const defaultClaudeCliCredentialBackend: ClaudeCliCredentialBackend = {
  // Read both stores and let the fresher token win. A Keychain item that is
  // merely older than the file must never shadow it: mirroring a stale item
  // to Cora kills its session the moment the terminal rotates the refresh
  // token, which is exactly what happened when Claude Code started writing
  // its refreshes to .credentials.json.
  async read(configDir, configDirEnv) {
    const fromKeychain = keychainDisabled()
      ? null
      : loginFromStore(await readKeychainCredential(claudeCliKeychainService(configDirEnv)));
    if (fromKeychain === null) {
      return loginFromStore(await readCredentialFile(claudeCredentialFile(configDir)));
    }
    let fromFile: string | null = null;
    try {
      fromFile = loginFromStore(await readCredentialFile(claudeCredentialFile(configDir)));
    } catch {
      fromFile = null;
    }
    if (fromFile === null) return fromKeychain;
    return fresherCredentialString(fromKeychain, fromFile);
  },
  async write(configDir, configDirEnv, credential) {
    await mutateLogin(configDir, configDirEnv, credential);
  },
  async clear(configDir, configDirEnv) {
    await mutateLogin(configDir, configDirEnv, null);
  },
};

/** Test seam: the file half of the backend with no Keychain at all. */
export const fileOnlyClaudeCliCredentialBackend: ClaudeCliCredentialBackend = {
  async read(configDir) {
    return loginFromStore(await readCredentialFile(claudeCredentialFile(configDir)));
  },
  async write(configDir, _configDirEnv, credential) {
    await mutateLogin(configDir, _configDirEnv, credential, true);
  },
  async clear(configDir) {
    await mutateLogin(configDir, null, null, true);
  },
};

export interface ClaudeCliCredentialOptions {
  backend?: ClaudeCliCredentialBackend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The typed `claudeAiOauth` record inside a raw credential string, or null
 * when the slot holds nothing usable. Throws only for a slot whose bytes are
 * not a credential at all, so a caller can tell "signed out" from "unreadable".
 */
export function parseClaudeCredentialRecord(raw: string | null): ClaudeCredentialRecord | null {
  if (raw === null) return null;
  const store = JSON.parse(normalizeCredentialStore(raw)) as { claudeAiOauth?: unknown };
  if (store.claudeAiOauth === undefined || store.claudeAiOauth === null) return null;
  const parsed = JSON.parse(normalizeCredential(raw)) as { claudeAiOauth: Record<string, unknown> };
  const oauth = parsed.claudeAiOauth;
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const expiresAt =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : 0;
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
    : undefined;
  return {
    ...oauth,
    accessToken,
    refreshToken,
    expiresAt,
    ...(scopes ? { scopes } : {}),
    ...(typeof oauth.subscriptionType === "string"
      ? { subscriptionType: oauth.subscriptionType }
      : {}),
    ...(typeof oauth.rateLimitTier === "string"
      ? { rateLimitTier: oauth.rateLimitTier }
      : {}),
  };
}

export function serializeClaudeCredentialRecord(record: ClaudeCredentialRecord): string {
  if (!isRecord(record) || typeof record.accessToken !== "string") {
    throw new TypeError("Claude credential record must carry an access token");
  }
  return normalizeCredential(JSON.stringify({ claudeAiOauth: record }));
}

/**
 * Keychain first, file second, exactly the order Claude Code reads. The
 * personal profile is (~/.claude, null); a managed profile is (dir, dir).
 */
export async function readClaudeCredentialRecord(
  configDir: string,
  configDirEnv: string | null,
  options: ClaudeCliCredentialOptions = {},
): Promise<ClaudeCredentialRecord | null> {
  const backend = options.backend ?? defaultClaudeCliCredentialBackend;
  return parseClaudeCredentialRecord(await backend.read(configDir, configDirEnv));
}

/**
 * Replace only claudeAiOauth under Claude Code's storage lock. Callers merge
 * login fields (scopes, subscriptionType) into the previous login record;
 * the backend preserves the surrounding credential store independently.
 */
export async function writeClaudeCredentialRecord(
  configDir: string,
  configDirEnv: string | null,
  record: ClaudeCredentialRecord,
  options: ClaudeCliCredentialOptions = {},
): Promise<void> {
  const backend = options.backend ?? defaultClaudeCliCredentialBackend;
  await backend.write(configDir, configDirEnv, serializeClaudeCredentialRecord(record));
}

export async function clearClaudeCredentialRecord(
  configDir: string,
  configDirEnv: string | null,
  options: ClaudeCliCredentialOptions = {},
): Promise<void> {
  const backend = options.backend ?? defaultClaudeCliCredentialBackend;
  await backend.clear?.(configDir, configDirEnv);
}
