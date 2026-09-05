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
 * exists. A managed directory is written in both places so a terminal started
 * against it sees the same token Codara sees; the personal slot on macOS
 * updates the Keychain and an existing credential file, without creating a
 * file for a login that uses only the Keychain.
 *
 * Only claudeAiOauth is changed. MCP grants and other fields in each store
 * survive writes and sign-outs, and never move to a different account.
 * Nothing here selects an account. Which directory a terminal runs in is the
 * account store's decision (CLAUDE_CONFIG_DIR per managed profile, unset for
 * the user's own ~/.claude); this module only moves bytes for one directory.
 */

export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
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

/** Only the Claude login moves between accounts; MCP grants belong to this store. */
function replaceLogin(raw: string | null, credential: string | null): string | null {
  const store = raw === null ? {} : JSON.parse(normalizeCredentialStore(raw));
  if (credential === null) delete store.claudeAiOauth;
  else store.claudeAiOauth = JSON.parse(normalizeCredential(credential)).claudeAiOauth;
  return Object.keys(store).length === 0 ? null : JSON.stringify(store);
}

async function mutateLogin(
  configDir: string,
  configDirEnv: string | null,
  credential: string | null,
  fileOnly = false,
): Promise<void> {
  if (credential !== null) normalizeCredential(credential);
  const created = await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  let compromised = false;
  // Claude Code 2.1.261 uses this same proper-lockfile lock for login and MCP
  // mutations. Reading inside it prevents a concurrent MCP refresh from
  // being replaced by the snapshot taken before the lock was acquired.
  const release = await lock(join(configDir, ".storage-write"), {
    realpath: false,
    retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
    stale: 15_000,
    onCompromised: () => { compromised = true; },
  });
  const assertLocked = (): void => {
    if (compromised) throw new Error("Claude credential write lock was lost");
  };
  try {
    const file = claudeCredentialFile(configDir);
    const useKeychain = !fileOnly && !keychainDisabled() && seams.platform === "darwin";
    const service = claudeCliKeychainService(configDirEnv);
    const fromFile = await readCredentialFile(file);
    const fromKeychain = useKeychain ? await readKeychainCredential(service) : null;
    // Preserve each backend's own fields. A newer Claude token in one store
    // says nothing about the freshness of an MCP token in the other store.
    const nextFile = replaceLogin(fromFile, credential);
    const nextKeychain = replaceLogin(fromKeychain, credential);
    const writeFile = !useKeychain || configDirEnv !== null || fromFile !== null;
    assertLocked();
    if (useKeychain && nextKeychain !== fromKeychain) {
      if (nextKeychain === null) await deleteKeychainCredential(service);
      else await writeKeychainCredential(service, nextKeychain);
    }
    assertLocked();
    if (writeFile && nextFile !== fromFile) {
      if (nextFile === null) await removeCredentialFile(file);
      else await atomicWriteCredential(file, nextFile);
    }
    assertLocked();
  } finally {
    await release();
    if (credential === null && created) await fs.rmdir(configDir).catch(() => undefined);
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
