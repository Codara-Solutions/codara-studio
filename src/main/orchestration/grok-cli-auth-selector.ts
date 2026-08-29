import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  GROK_CLI_AUTH_FILE,
  GROK_CLI_PERSONAL_PROFILE_ID,
  grokCliManagedProfilePaths,
  normalizeGrokCliProfileId,
  type GrokCliAccountProfileStore,
  type GrokCliProfileId,
} from "./grok-cli-account-profiles";

const ACTIVE_AUTH_FILE = "active-auth.json";
const PERSONAL_DIRECTORY = "personal";
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const mutationTails = new Map<string, Promise<void>>();

interface ActiveAuthSelection {
  version: 1;
  profileId: GrokCliProfileId;
}

export function grokCliPersonalAuthFile(rootDir: string): string {
  return join(resolve(rootDir), PERSONAL_DIRECTORY, GROK_CLI_AUTH_FILE);
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
    throw new Error("Grok account credential is not a regular file");
  }
  if (stat.size > MAX_AUTH_BYTES) {
    throw new Error("Grok account credential is unexpectedly large");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Grok account credential permissions are not private");
  }
  return true;
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  if (!(await safeRegularFile(source))) {
    throw new Error("Selected Grok account is not signed in");
  }
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  if (await safeRegularFile(destination)) {
    // The destination passed the same symlink and permission checks above.
  }
  const temporary = join(
    directory,
    `.${GROK_CLI_AUTH_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
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

async function writeSelection(
  rootDir: string,
  profileId: GrokCliProfileId,
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

async function readSelection(rootDir: string): Promise<GrokCliProfileId | null> {
  const file = activeSelectionFile(rootDir);
  if (!(await safeRegularFile(file))) return null;
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    version?: unknown;
    profileId?: unknown;
  };
  if (parsed.version !== 1) throw new Error("Unsupported Grok auth selector version");
  return normalizeGrokCliProfileId(parsed.profileId, "Active Grok account profile id");
}

function storedAuthFile(
  store: Pick<GrokCliAccountProfileStore, "rootDir">,
  profileId: GrokCliProfileId,
): string {
  return profileId === GROK_CLI_PERSONAL_PROFILE_ID
    ? grokCliPersonalAuthFile(store.rootDir)
    : grokCliManagedProfilePaths(store.rootDir, profileId).authFile;
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
  store: Pick<GrokCliAccountProfileStore, "rootDir" | "personalHomeDir">,
): Promise<GrokCliProfileId> {
  const rootDir = resolve(store.rootDir);
  const personalAuth = grokCliPersonalAuthFile(rootDir);
  const marker = await readSelection(rootDir);
  if (!(await safeRegularFile(personalAuth))) {
    const livePersonalAuth = join(store.personalHomeDir, GROK_CLI_AUTH_FILE);
    if (await safeRegularFile(livePersonalAuth)) {
      await atomicCopy(livePersonalAuth, personalAuth);
    }
  }
  const selected = marker ?? GROK_CLI_PERSONAL_PROFILE_ID;
  if (marker === null) await writeSelection(rootDir, selected);
  return selected;
}

/** Preserve the historical ~/.grok login before the first account switch. */
export async function ensureGrokCliAuthVault(
  store: Pick<GrokCliAccountProfileStore, "rootDir" | "personalHomeDir">,
): Promise<GrokCliProfileId> {
  return withSelectionLock(store.rootDir, () => ensureVaultUnlocked(store));
}

/**
 * Makes one saved login active in the official ~/.grok home. Only auth.json
 * moves, so every newly opened Grok process sees the same selected account.
 */
export async function activateGrokCliAccount(
  store: Pick<GrokCliAccountProfileStore, "rootDir" | "personalHomeDir">,
  rawProfileId: string | null | undefined,
): Promise<GrokCliProfileId> {
  return withSelectionLock(store.rootDir, async () => {
    const selected = normalizeGrokCliProfileId(rawProfileId);
    const previous = await ensureVaultUnlocked(store);
    const liveAuth = join(store.personalHomeDir, GROK_CLI_AUTH_FILE);
    if (await safeRegularFile(liveAuth)) {
      await atomicCopy(liveAuth, storedAuthFile(store, previous));
    }
    await atomicCopy(storedAuthFile(store, selected), liveAuth);
    await writeSelection(store.rootDir, selected);
    return previous;
  });
}

/** Clear a signed-out slot, and the official live slot when it was active. */
export async function finalizeGrokCliLogout(
  store: Pick<GrokCliAccountProfileStore, "rootDir" | "personalHomeDir">,
  rawProfileId: string | null | undefined,
): Promise<void> {
  return withSelectionLock(store.rootDir, async () => {
    const profileId = normalizeGrokCliProfileId(rawProfileId);
    const active = (await readSelection(store.rootDir)) ??
      GROK_CLI_PERSONAL_PROFILE_ID;
    await removeCredential(storedAuthFile(store, profileId));
    if (active === profileId) {
      await removeCredential(join(store.personalHomeDir, GROK_CLI_AUTH_FILE));
    }
  });
}
