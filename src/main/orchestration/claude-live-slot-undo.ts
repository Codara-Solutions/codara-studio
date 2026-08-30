import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  claudeCliManagedProfileConfigDir,
  isClaudeCliManagedProfileId,
  writeManagedClaudeIdentity,
} from "./claude-cli-account-profiles";
import {
  defaultClaudeCliCredentialBackend,
  type ClaudeCliCredentialBackend,
} from "./claude-cli-credentials";

/**
 * The retired Claude selector swapped a managed account's credential INTO
 * ~/.claude and vaulted the personal login under claude-cli/personal. The
 * startup pass undoes that swap once; the function is idempotent and
 * re-derives its state from disk, so a crash mid-way is finished by the
 * next launch.
 */

const ACTIVE_AUTH_FILE = "active-auth.json";
const PERSONAL_VAULT_DIRECTORY = "personal";
const RETIRED_VAULT_PATTERN = /^\.personal\.retired-[0-9a-f]+$/;

export interface UndoLiveSlotSwapInput {
  claudeRootDir: string;
  personalConfigDir: string;
  personalConfigDirEnv: string | null;
  /** Where ~/.claude.json lives when CLAUDE_CONFIG_DIR is unset; defaults to the parent of personalConfigDir. */
  homeDir?: string;
  /** Whether the managed profile the marker names still exists in the registry. */
  managedProfileExists?: (profileId: string) => Promise<boolean>;
  backend?: ClaudeCliCredentialBackend;
  log?: (message: string) => void;
}

export interface UndoLiveSlotSwapResult {
  /** The managed profile whose credential was moved out of ~/.claude, if any. */
  restoredFrom: string | null;
  /** True when the vaulted personal credential was written back to ~/.claude. */
  personalRestored: boolean;
  /** True when the personal identity was written back into ~/.claude.json. */
  identityRestored: boolean;
  retiredVaultDir: string | null;
  removedRetiredDirs: string[];
  /** Set when ~/.claude could not be read: the marker and vault stay for the next launch. */
  deferred: string | null;
}

async function lstatOrNull(path: string): Promise<import("node:fs").Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function readSelection(rootDir: string): Promise<string | null> {
  const file = join(rootDir, ACTIVE_AUTH_FILE);
  const stats = await lstatOrNull(file);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { profileId?: unknown };
    return typeof parsed.profileId === "string" ? parsed.profileId : null;
  } catch {
    return null;
  }
}

async function readVaultedOauthAccount(
  vaultDir: string,
): Promise<{ accountUuid: string; emailAddress?: string; organizationUuid?: string } | null> {
  try {
    const file = join(vaultDir, ".claude.json");
    const stats = await fs.lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { oauthAccount?: unknown };
    const account = parsed.oauthAccount;
    if (!account || typeof account !== "object" || Array.isArray(account)) return null;
    const record = account as Record<string, unknown>;
    if (typeof record.accountUuid !== "string" || !record.accountUuid.trim()) return null;
    return {
      accountUuid: record.accountUuid,
      ...(typeof record.emailAddress === "string" ? { emailAddress: record.emailAddress } : {}),
      ...(typeof record.organizationUuid === "string"
        ? { organizationUuid: record.organizationUuid }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The selector swapped only the credential; ~/.claude.json kept naming
 * whichever login last ran against ~/.claude, and the personal identity was
 * vaulted beside the credential. Put it back with the credential, or Account
 * 1 pairs on the managed account's identity.
 */
async function restorePersonalIdentity(
  input: UndoLiveSlotSwapInput,
  vaultDir: string,
): Promise<boolean> {
  const identity = await readVaultedOauthAccount(vaultDir);
  if (!identity) return false;
  const identityDir =
    input.personalConfigDirEnv ?? input.homeDir ?? dirname(resolve(input.personalConfigDir));
  try {
    await writeManagedClaudeIdentity(identityDir, identity);
    return true;
  } catch (error) {
    input.log?.(
      `[accounts] the personal Claude identity could not be restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * The retired selector swapped a managed account's credential INTO ~/.claude
 * and vaulted the personal login under claude-cli/personal. If that swap is
 * still in effect, ~/.claude holds the managed account's freshest token:
 * give it back to that account's own directory, put the personal login back,
 * then retire the vault and the selection marker. When the marker is absent
 * or names personal, only the cleanup runs.
 */
export async function undoLiveSlotSwap(
  input: UndoLiveSlotSwapInput,
): Promise<UndoLiveSlotSwapResult> {
  const backend = input.backend ?? defaultClaudeCliCredentialBackend;
  const rootDir = resolve(input.claudeRootDir);
  const vaultDir = join(rootDir, PERSONAL_VAULT_DIRECTORY);
  const result: UndoLiveSlotSwapResult = {
    restoredFrom: null,
    personalRestored: false,
    identityRestored: false,
    retiredVaultDir: null,
    removedRetiredDirs: [],
    deferred: null,
  };

  // Retired vaults from an earlier launch are removed now; the one retired
  // below is removed by the next launch, so a crash mid-pass keeps its bytes.
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!RETIRED_VAULT_PATTERN.test(entry.name) || !entry.isDirectory()) continue;
    await fs.rm(join(rootDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    result.removedRetiredDirs.push(entry.name);
  }

  const selected = await readSelection(rootDir);
  const vaultExists = (await lstatOrNull(vaultDir))?.isDirectory() === true;
  if (selected && isClaudeCliManagedProfileId(selected)) {
    // ~/.claude holds the managed account's freshest token, possibly the only
    // refresh token still valid after a rotation. "Absent" and "unreadable"
    // (a locked Keychain, a `security` timeout) must not be confused: on a
    // read failure nothing is written and the marker stays, so the next
    // launch repeats the restore instead of signing the account out for good.
    let live: string | null;
    try {
      live = await backend.read(input.personalConfigDir, input.personalConfigDirEnv);
    } catch (error) {
      result.deferred = error instanceof Error ? error.message : String(error);
      input.log?.(
        `[accounts] ~/.claude could not be read; the login vault is kept for the next launch: ${result.deferred}`,
      );
      return result;
    }
    if (live) {
      const exists = input.managedProfileExists
        ? await input.managedProfileExists(selected)
        : true;
      if (exists) {
        const managedDir = claudeCliManagedProfileConfigDir(rootDir, selected);
        await backend.write(managedDir, managedDir, live);
        result.restoredFrom = selected;
      } else {
        // A stale marker (a crash between the delete and the marker rewrite)
        // must not conjure a directory no registry row will ever reference.
        input.log?.(
          `[accounts] the login vault marker names a Claude Code profile that no longer exists (${selected}); its token is not copied anywhere`,
        );
      }
    }
    if (vaultExists) {
      const vaulted = await backend.read(vaultDir, vaultDir).catch(() => null);
      if (vaulted) {
        await backend.write(input.personalConfigDir, input.personalConfigDirEnv, vaulted);
        const verified = await backend
          .read(input.personalConfigDir, input.personalConfigDirEnv)
          .catch(() => null);
        if (verified !== vaulted) {
          throw new Error("The personal Claude login could not be restored to ~/.claude");
        }
        result.personalRestored = true;
        result.identityRestored = await restorePersonalIdentity(input, vaultDir);
      } else if (live) {
        input.log?.(
          "[accounts] the personal Claude login vault is empty; ~/.claude keeps the credential it holds",
        );
      }
    }
  }

  await fs.rm(join(rootDir, ACTIVE_AUTH_FILE), { force: true }).catch(() => undefined);
  if (vaultExists) {
    const retired = join(rootDir, `.personal.retired-${randomBytes(6).toString("hex")}`);
    await fs.rename(vaultDir, retired);
    result.retiredVaultDir = retired;
    await backend.clear?.(vaultDir, vaultDir).catch(() => undefined);
  }
  return result;
}
