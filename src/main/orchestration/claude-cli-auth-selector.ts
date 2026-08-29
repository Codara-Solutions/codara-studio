import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  claudeCliManagedProfileConfigDir,
  normalizeClaudeCliProfileId,
  type ClaudeCliAccountProfileStore,
  type ClaudeCliProfileId,
} from "./claude-cli-account-profiles";

const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const ACTIVE_AUTH_FILE = "active-auth.json";
const PERSONAL_DIRECTORY = "personal";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const KEYCHAIN_TIMEOUT_MS = 10_000;
const mutationTails = new Map<string, Promise<void>>();

interface ActiveAuthSelection {
  version: 1;
  profileId: ClaudeCliProfileId;
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

type ClaudeSelectorStore = Pick<
  ClaudeCliAccountProfileStore,
  "rootDir" | "personalConfigDir" | "personalConfigDirEnv"
> &
  Partial<
    Pick<
      ClaudeCliAccountProfileStore,
      "personalProfileConfigDir" | "personalProfileConfigDirEnv"
    >
  >;

function credentialFile(configDir: string): string {
  return join(resolve(configDir), CLAUDE_CREDENTIALS_FILE);
}

export function claudeCliPersonalCredentialFile(rootDir: string): string {
  return join(resolve(rootDir), PERSONAL_DIRECTORY, CLAUDE_CREDENTIALS_FILE);
}

export function claudeCliPersonalConfigDir(rootDir: string): string {
  return join(resolve(rootDir), PERSONAL_DIRECTORY);
}

function activeSelectionFile(rootDir: string): string {
  return join(resolve(rootDir), ACTIVE_AUTH_FILE);
}

function normalizeCredential(value: string | Buffer): string {
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

async function safeCredentialFile(path: string): Promise<boolean> {
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

async function readCredentialFile(path: string): Promise<string | null> {
  if (!(await safeCredentialFile(path))) return null;
  return normalizeCredential(await fs.readFile(path));
}

async function atomicWriteCredential(
  destination: string,
  credential: string,
): Promise<void> {
  const normalized = normalizeCredential(credential);
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  if (await safeCredentialFile(destination)) {
    // The destination passed the same symlink and permission checks above.
  }
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

async function seedPersonalIdentityVault(store: ClaudeSelectorStore): Promise<void> {
  const destination = join(
    claudeCliPersonalConfigDir(store.rootDir),
    ".claude.json",
  );
  const existing = await fs.lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (existing) return;
  const candidates = [
    join(store.personalConfigDir, ".config.json"),
    join(
      store.personalConfigDirEnv ?? dirname(store.personalConfigDir),
      ".claude.json",
    ),
  ];
  let oauthAccount: unknown;
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_AUTH_BYTES) {
        continue;
      }
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as {
        oauthAccount?: unknown;
      };
      if (
        parsed.oauthAccount &&
        typeof parsed.oauthAccount === "object" &&
        !Array.isArray(parsed.oauthAccount)
      ) {
        oauthAccount = parsed.oauthAccount;
        break;
      }
    } catch {
      // Identity is display-only. A missing or unusual source must never make
      // authentication migration fail.
    }
  }
  if (!oauthAccount) return;
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `..claude.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ oauthAccount })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function keychainService(configDirEnv: string | null): string {
  if (!configDirEnv) return KEYCHAIN_SERVICE;
  const suffix = createHash("sha256")
    .update(resolve(configDirEnv).normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

function readKeychainCredential(service: string): Promise<string | null> {
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

function writeKeychainCredential(service: string, credential: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const normalized = normalizeCredential(credential);
  return new Promise((resolvePromise, reject) => {
    // `security -w` without a value opens an interactive prompt. Electron's
    // hidden main process has no controlling terminal, so that form hangs or
    // exits even when stdin is piped. Pass the bounded credential directly to
    // the argument-vector API: no shell is involved and stdout/stderr are
    // discarded. The process is short-lived and never logged.
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

function deleteKeychainCredential(service: string): Promise<void> {
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

export const defaultClaudeCliCredentialBackend: ClaudeCliCredentialBackend = {
  async read(configDir, configDirEnv) {
    const fromKeychain = await readKeychainCredential(
      keychainService(configDirEnv),
    );
    return fromKeychain ?? readCredentialFile(credentialFile(configDir));
  },
  async write(configDir, configDirEnv, credential) {
    await atomicWriteCredential(credentialFile(configDir), credential);
    await writeKeychainCredential(keychainService(configDirEnv), credential);
  },
  async clear(configDir, configDirEnv) {
    await removeCredentialFile(credentialFile(configDir));
    await deleteKeychainCredential(keychainService(configDirEnv));
  },
};

async function writeSelection(
  rootDir: string,
  profileId: ClaudeCliProfileId,
): Promise<void> {
  const destination = activeSelectionFile(rootDir);
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const payload: ActiveAuthSelection = { version: 1, profileId };
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readSelection(
  rootDir: string,
): Promise<ClaudeCliProfileId | null> {
  const file = activeSelectionFile(rootDir);
  if (!(await safeCredentialFile(file))) return null;
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    version?: unknown;
    profileId?: unknown;
  };
  if (parsed.version !== 1) {
    throw new Error("Unsupported Claude auth selector version");
  }
  return normalizeClaudeCliProfileId(
    parsed.profileId,
    "Active Claude account profile id",
  );
}

function profileLocation(
  store: ClaudeSelectorStore,
  profileId: ClaudeCliProfileId,
): { configDir: string; configDirEnv: string | null; vaultFile: string } {
  if (profileId === CLAUDE_CLI_PERSONAL_PROFILE_ID) {
    const hasExplicitProfileConfig =
      store.personalProfileConfigDir !== undefined;
    const configDir = hasExplicitProfileConfig
      ? store.personalProfileConfigDir!
      : claudeCliPersonalConfigDir(store.rootDir);
    return {
      configDir,
      configDirEnv: hasExplicitProfileConfig
        ? store.personalProfileConfigDirEnv ?? null
        : configDir,
      vaultFile: claudeCliPersonalCredentialFile(store.rootDir),
    };
  }
  const configDir = claudeCliManagedProfileConfigDir(store.rootDir, profileId);
  return {
    configDir,
    configDirEnv: configDir,
    vaultFile: credentialFile(configDir),
  };
}

async function withSelectionLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(rootDir);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

async function ensureVaultUnlocked(
  store: ClaudeSelectorStore,
  backend: ClaudeCliCredentialBackend,
): Promise<ClaudeCliProfileId> {
  const marker = await readSelection(store.rootDir);
  const personalVault = claudeCliPersonalCredentialFile(store.rootDir);
  if (!(await safeCredentialFile(personalVault))) {
    const live = await backend.read(
      store.personalConfigDir,
      store.personalConfigDirEnv,
    );
    if (live) await atomicWriteCredential(personalVault, live);
  }
  await seedPersonalIdentityVault(store).catch(() => undefined);
  const selected = marker ?? CLAUDE_CLI_PERSONAL_PROFILE_ID;
  if (marker === null) await writeSelection(store.rootDir, selected);
  return selected;
}

/** Preserve the historical Claude Code login before the first account switch. */
export async function ensureClaudeCliAuthVault(
  store: ClaudeSelectorStore,
  backend: ClaudeCliCredentialBackend = defaultClaudeCliCredentialBackend,
): Promise<ClaudeCliProfileId> {
  return withSelectionLock(store.rootDir, () =>
    ensureVaultUnlocked(store, backend),
  );
}

/**
 * Makes one saved login active in Claude Code's official credential slot.
 * The previous OAuth credential is saved first; preferences and history stay
 * in place. New terminals therefore agree inside and outside Codara Studio.
 */
export async function activateClaudeCliAccount(
  store: ClaudeSelectorStore,
  rawProfileId: string | null | undefined,
  backend: ClaudeCliCredentialBackend = defaultClaudeCliCredentialBackend,
): Promise<ClaudeCliProfileId> {
  return withSelectionLock(store.rootDir, async () => {
    const selected = normalizeClaudeCliProfileId(rawProfileId);
    const previous = await ensureVaultUnlocked(store, backend);
    const live = await backend.read(
      store.personalConfigDir,
      store.personalConfigDirEnv,
    );
    if (live) {
      const previousLocation = profileLocation(store, previous);
      await atomicWriteCredential(previousLocation.vaultFile, live);
      await backend.write(
        previousLocation.configDir,
        previousLocation.configDirEnv,
        live,
      );
    }

    const selectedLocation = profileLocation(store, selected);
    const selectedCredential =
      (await backend.read(
        selectedLocation.configDir,
        selectedLocation.configDirEnv,
      )) ?? (await readCredentialFile(selectedLocation.vaultFile));
    if (!selectedCredential) {
      throw new Error("Selected Claude account is not signed in");
    }
    await atomicWriteCredential(selectedLocation.vaultFile, selectedCredential);
    await backend.write(
      store.personalConfigDir,
      store.personalConfigDirEnv,
      selectedCredential,
    );
    await writeSelection(store.rootDir, selected);
    return previous;
  });
}

/** Clear a signed-out slot, and the official live slot when it was active. */
export async function finalizeClaudeCliLogout(
  store: ClaudeSelectorStore,
  rawProfileId: string | null | undefined,
  backend: ClaudeCliCredentialBackend = defaultClaudeCliCredentialBackend,
): Promise<void> {
  return withSelectionLock(store.rootDir, async () => {
    const profileId = normalizeClaudeCliProfileId(rawProfileId);
    const active = (await readSelection(store.rootDir)) ??
      CLAUDE_CLI_PERSONAL_PROFILE_ID;
    const location = profileLocation(store, profileId);
    await removeCredentialFile(location.vaultFile);
    await backend.clear?.(location.configDir, location.configDirEnv);
    if (active === profileId) {
      await backend.clear?.(
        store.personalConfigDir,
        store.personalConfigDirEnv,
      );
    }
  });
}
