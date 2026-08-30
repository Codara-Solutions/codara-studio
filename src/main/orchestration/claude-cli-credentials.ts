import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Claude Code's credential slot, read and written the way Claude Code itself
 * does it: on macOS the Keychain item for the config directory is consulted
 * first and the 0600 `.credentials.json` file second; elsewhere only the file
 * exists. Every write lands in both places so a terminal started against the
 * directory sees the same token Codara sees.
 *
 * Nothing here selects an account. Which directory a terminal runs in is the
 * account store's decision (CLAUDE_CONFIG_DIR per managed profile, unset for
 * the user's own ~/.claude); this module only moves bytes for one directory.
 */

export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const KEYCHAIN_TIMEOUT_MS = 10_000;

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

export function normalizeCredential(value: string | Buffer): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (Buffer.byteLength(text, "utf8") > MAX_AUTH_BYTES) {
    throw new Error("Claude account credential is unexpectedly large");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError();
    }
    const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
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
    return JSON.stringify(parsed);
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
  return normalizeCredential(await fs.readFile(path));
}

export async function atomicWriteCredential(
  destination: string,
  credential: string,
): Promise<void> {
  const normalized = normalizeCredential(credential);
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  // Refuse to replace a symlink or a world-readable file in place; the
  // check throws on both before any temporary file exists.
  await safeCredentialFile(destination);
  const temporary = join(
    directory,
    `.${CLAUDE_CREDENTIALS_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, normalized, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolvePromise, reject) => {
    execFile(
      "/usr/bin/security",
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
          resolvePromise(normalizeCredential(stdout.trim()));
        } catch {
          reject(new Error("Claude Code credential in Keychain is invalid"));
        }
      },
    );
  });
}

export function writeKeychainCredential(service: string, credential: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const normalized = normalizeCredential(credential);
  return new Promise((resolvePromise, reject) => {
    // `security -w` without a value opens an interactive prompt. Electron's
    // hidden main process has no controlling terminal, so that form hangs or
    // exits even when stdin is piped. Pass the bounded credential directly to
    // the argument-vector API: no shell is involved and stdout/stderr are
    // discarded. The process is short-lived and its argv is never logged.
    execFile(
      "/usr/bin/security",
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
  if (process.platform !== "darwin") return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    execFile(
      "/usr/bin/security",
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

export const defaultClaudeCliCredentialBackend: ClaudeCliCredentialBackend = {
  async read(configDir, configDirEnv) {
    const fromKeychain = keychainDisabled()
      ? null
      : await readKeychainCredential(claudeCliKeychainService(configDirEnv));
    return fromKeychain ?? readCredentialFile(claudeCredentialFile(configDir));
  },
  async write(configDir, configDirEnv, credential) {
    await atomicWriteCredential(claudeCredentialFile(configDir), credential);
    if (keychainDisabled()) return;
    await writeKeychainCredential(claudeCliKeychainService(configDirEnv), credential);
  },
  async clear(configDir, configDirEnv) {
    await removeCredentialFile(claudeCredentialFile(configDir));
    if (keychainDisabled()) return;
    await deleteKeychainCredential(claudeCliKeychainService(configDirEnv));
  },
};

/** Test seam: the file half of the backend with no Keychain at all. */
export const fileOnlyClaudeCliCredentialBackend: ClaudeCliCredentialBackend = {
  async read(configDir) {
    return readCredentialFile(claudeCredentialFile(configDir));
  },
  async write(configDir, _configDirEnv, credential) {
    await atomicWriteCredential(claudeCredentialFile(configDir), credential);
  },
  async clear(configDir) {
    await removeCredentialFile(claudeCredentialFile(configDir));
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
 * 0700 directory, atomic 0600 file, then the Keychain item on macOS. Writes
 * are whole records: the caller merges into the previous record itself so
 * fields Claude Code expects (scopes, subscriptionType) are never dropped.
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
