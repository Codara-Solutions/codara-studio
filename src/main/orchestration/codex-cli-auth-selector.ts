import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codexAccountIdFromAccessToken } from "./account-adapters/codex-credential-codec";
import {
  CODEX_CLI_AUTH_FILE,
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codexCliManagedProfilePaths,
  normalizeCodexCliProfileId,
  type CodexCliAccountProfileStore,
  type CodexCliProfileId,
} from "./codex-cli-account-profiles";
import { readPrivateJsonFile } from "./native-cli-atomic-file";

const ACTIVE_AUTH_FILE = "active-auth.json";
const PERSONAL_DIRECTORY = "personal";
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const mutationTails = new Map<string, Promise<void>>();

interface ActiveAuthSelection {
  version: 1;
  profileId: CodexCliProfileId;
}

export function codexCliPersonalAuthFile(rootDir: string): string {
  return join(resolve(rootDir), PERSONAL_DIRECTORY, CODEX_CLI_AUTH_FILE);
}

function activeSelectionFile(rootDir: string): string {
  return join(resolve(rootDir), ACTIVE_AUTH_FILE);
}

async function safeRegularFile(path: string): Promise<boolean> {
  const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Codex account credential is not a regular file");
  }
  if (stat.size > MAX_AUTH_BYTES) {
    throw new Error("Codex account credential is unexpectedly large");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Codex account credential permissions are not private");
  }
  return true;
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  if (!(await safeRegularFile(source))) {
    throw new Error("Selected Codex account is not signed in");
  }
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  if (await safeRegularFile(destination)) {
    // The destination passed the same symlink and permission checks above.
  }
  const temporary = join(
    directory,
    `.${CODEX_CLI_AUTH_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeCredential(path: string): Promise<void> {
  if (!(await safeRegularFile(path))) return;
  await fs.unlink(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The ChatGPT account a credential file was issued for, or undefined when
 * the file does not say (unparsable bytes, an API-key login). Only the
 * account id is looked at; no token leaves this function.
 */
async function credentialAccountId(path: string): Promise<string | undefined> {
  const read = await readPrivateJsonFile(path).catch(() => null);
  if (!read || read.kind !== "value" || !isRecord(read.value)) return undefined;
  const tokens = read.value.tokens;
  if (!isRecord(tokens)) return undefined;
  if (typeof tokens.account_id === "string" && tokens.account_id.length > 0) {
    return tokens.account_id;
  }
  return codexAccountIdFromAccessToken(tokens.access_token);
}

/**
 * Whether the live file may be saved into a slot: true unless both name an
 * account and the accounts differ. A `codex login` as someone else while a
 * profile owned the live file is an external login, not that profile's
 * rotation; saving it would rewrite the profile as the other account.
 */
async function sameAccountOrUnknown(liveAuth: string, slot: string): Promise<boolean> {
  const [live, stored] = await Promise.all([
    credentialAccountId(liveAuth),
    credentialAccountId(slot),
  ]);
  return !live || !stored || live === stored;
}

async function writeSelection(
  rootDir: string,
  profileId: CodexCliProfileId,
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

/** The profile whose login sits in ~/.codex/auth.json right now, per the marker. */
export async function readCodexCliSelection(rootDir: string): Promise<CodexCliProfileId | null> {
  return readSelection(rootDir);
}

async function readSelection(rootDir: string): Promise<CodexCliProfileId | null> {
  const file = activeSelectionFile(rootDir);
  if (!(await safeRegularFile(file))) return null;
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    version?: unknown;
    profileId?: unknown;
  };
  if (parsed.version !== 1) throw new Error("Unsupported Codex auth selector version");
  return normalizeCodexCliProfileId(parsed.profileId, "Active Codex account profile id");
}

function storedAuthFile(
  store: Pick<CodexCliAccountProfileStore, "rootDir">,
  profileId: CodexCliProfileId,
): string {
  return profileId === CODEX_CLI_PERSONAL_PROFILE_ID
    ? codexCliPersonalAuthFile(store.rootDir)
    : codexCliManagedProfilePaths(store.rootDir, profileId).authFile;
}

/**
 * Serialize against every switch of the live slot. The credential mirror
 * re-reads and writes the Codex side under this lock so a switch mid-debounce
 * cannot land the previous account's token in the new live file.
 */
export function withCodexSelectionLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withSelectionLock(rootDir, operation);
}

async function withSelectionLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
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
  store: Pick<CodexCliAccountProfileStore, "rootDir" | "personalHomeDir">,
): Promise<CodexCliProfileId> {
  const rootDir = resolve(store.rootDir);
  const personalAuth = codexCliPersonalAuthFile(rootDir);
  const marker = await readSelection(rootDir);
  if (!(await safeRegularFile(personalAuth))) {
    // The personal backup is missing. When the personal slot is (or is about
    // to become) the active one, the live ~/.codex/auth.json IS the personal
    // credential: first run, or a sign-out followed by a fresh `codex login`
    // in a terminal. Re-seed from it when present; absent means signed out,
    // which is a state, never an error (an inspect must not fail on it).
    // When a managed account owns the live slot, the backup is legitimately
    // absent and the live file must not be mistaken for the personal login.
    if (marker === null || marker === CODEX_CLI_PERSONAL_PROFILE_ID) {
      const livePersonalAuth = join(store.personalHomeDir, CODEX_CLI_AUTH_FILE);
      if (await safeRegularFile(livePersonalAuth)) {
        await atomicCopy(livePersonalAuth, personalAuth);
      }
    }
  }
  const selected = marker ?? CODEX_CLI_PERSONAL_PROFILE_ID;
  if (marker === null) await writeSelection(rootDir, selected);
  return selected;
}

/**
 * Migrates the old CODEX_HOME selector to an auth-only vault. The first copy
 * preserves the historical ~/.codex login before any managed credential can
 * replace it. No credential bytes are parsed or exposed.
 */
export async function ensureCodexCliAuthVault(
  store: Pick<CodexCliAccountProfileStore, "rootDir" | "personalHomeDir">,
): Promise<CodexCliProfileId> {
  return withSelectionLock(store.rootDir, () => ensureVaultUnlocked(store));
}

export interface ActivateCodexCliAccountOptions {
  /**
   * Let a signed-out profile take the live slot: the previous login is still
   * saved to its vault slot, the live file is removed and the marker moves.
   * Used by the delete hand-off, so an account can be deleted even when the
   * only remaining account is signed out.
   */
  allowSignedOut?: boolean;
  /**
   * Whether a managed profile id is still registered. The live file is not
   * saved into the slot of a profile that no longer exists (a marker left
   * behind by a delete), which would otherwise recreate its directory.
   */
  profileExists?: (profileId: CodexCliProfileId) => Promise<boolean>;
  log?: (message: string) => void;
}

/**
 * Makes one saved account active in the single official ~/.codex state home.
 * Only auth.json moves. Config, sessions, skills, memory and databases never
 * move and CODEX_HOME is never changed.
 *
 * The live file is the live profile's slot, so an absent live file means
 * that profile signed out (`codex logout`): its vault copy goes with it
 * rather than resurrecting the login on the way back. Re-selecting the live
 * profile never round-trips the live file through the vault: codex-rs
 * rewrites auth.json in place on refresh, and a rotation landing between
 * the two copies would be replaced by the snapshot taken before it.
 */
export async function activateCodexCliAccount(
  store: Pick<CodexCliAccountProfileStore, "rootDir" | "personalHomeDir">,
  rawProfileId: string | null | undefined,
  options: ActivateCodexCliAccountOptions = {},
): Promise<CodexCliProfileId> {
  return withSelectionLock(store.rootDir, async () => {
    const selected = normalizeCodexCliProfileId(rawProfileId);
    const previous = await ensureVaultUnlocked(store);
    const liveAuth = join(store.personalHomeDir, CODEX_CLI_AUTH_FILE);
    const previousSlot = storedAuthFile(store, previous);
    const liveSignedIn = await safeRegularFile(liveAuth);
    if (previous === selected) {
      if (liveSignedIn) {
        if (await sameAccountOrUnknown(liveAuth, previousSlot)) {
          await atomicCopy(liveAuth, previousSlot);
        }
        return previous;
      }
      await removeCredential(previousSlot);
      if (!options.allowSignedOut) throw new Error("Selected Codex account is not signed in");
      return previous;
    }
    const target = storedAuthFile(store, selected);
    const targetSignedIn = await safeRegularFile(target);
    if (!targetSignedIn && !options.allowSignedOut) {
      throw new Error("Selected Codex account is not signed in");
    }
    if (!liveSignedIn) {
      await removeCredential(previousSlot);
    } else if (
      previous !== CODEX_CLI_PERSONAL_PROFILE_ID &&
      options.profileExists &&
      !(await options.profileExists(previous))
    ) {
      options.log?.(
        `[accounts] the live Codex login belonged to a profile that no longer exists; it is dropped rather than saved`,
      );
    } else if (await sameAccountOrUnknown(liveAuth, previousSlot)) {
      await atomicCopy(liveAuth, previousSlot);
    } else {
      options.log?.(
        `[accounts] ~/.codex/auth.json held a login of another account than the live Codex profile; it is dropped rather than saved into that profile's slot`,
      );
    }
    if (targetSignedIn) await atomicCopy(target, liveAuth);
    else await removeCredential(liveAuth);
    await writeSelection(store.rootDir, selected);
    return previous;
  });
}
