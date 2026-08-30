import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalFromGrokFile,
  grokAuthSlot,
  type GrokAuthFile,
} from "./account-adapters/grok-credential-codec";
import { compareCredentials, type CanonicalCredential } from "./credential-mirror";
import {
  GROK_CLI_AUTH_FILE,
  grokCliManagedProfilePaths,
  isGrokCliManagedProfileId,
} from "./grok-cli-account-profiles";
import {
  atomicWritePrivateFile,
  readPrivateJsonFile,
  removePrivateFile,
} from "./native-cli-atomic-file";
import { jwtStringClaim } from "./native-cli-account-identity";

/**
 * The retired Grok selector swapped a managed account's auth.json INTO
 * ~/.grok and vaulted the personal login under grok-cli/personal, with a
 * marker naming the swap. Managed accounts now run in their own GROK_HOME,
 * so the swap is undone once: the fresher of ~/.grok and the managed home
 * ends up in the managed home, the personal login goes back to ~/.grok
 * unless a newer personal login already landed there, and the vault and
 * the marker retire. Every step re-derives its state from disk, so a crash
 * mid-way is finished by the next launch, and an unreadable file defers the
 * whole step rather than risking the only valid refresh token.
 */

const ACTIVE_AUTH_FILE = "active-auth.json";
const PERSONAL_VAULT_DIRECTORY = "personal";
const RETIRED_VAULT_PATTERN = /^\.personal\.retired-[0-9a-f]+$/;
/**
 * What the login subprocess left in the vault besides the credential:
 * Grok's own bookkeeping for a home that no longer serves as one.
 */
const VAULT_ARTIFACTS = [
  "auth.json.lock",
  "active_sessions.json",
  "active_sessions.lock",
  "managed_config.lock",
  ".config-init.lock",
  ".metadata_version",
  "agent_id",
  "README.md",
  "docs",
  "logs",
];

export interface UndoGrokLiveSlotSwapInput {
  grokRootDir: string;
  personalHomeDir: string;
  /** Whether the managed profile the marker names still exists in the registry. */
  managedProfileExists?: (profileId: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export interface UndoGrokLiveSlotSwapResult {
  /** The managed profile whose fresher credential was moved out of ~/.grok, if any. */
  restoredFrom: string | null;
  /** True when the vaulted personal credential was written back to ~/.grok. */
  personalRestored: boolean;
  retiredVaultDir: string | null;
  removedRetiredDirs: string[];
  /** Set when a file could not be read: marker and vault stay for the next launch. */
  deferred: string | null;
}

type SlotRead =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "slot"; file: GrokAuthFile; canonical: CanonicalCredential | null };

async function readSlotFile(path: string): Promise<SlotRead> {
  const read = await readPrivateJsonFile(path);
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "unreadable") return { kind: "unreadable" };
  if (read.value === null || typeof read.value !== "object" || Array.isArray(read.value)) {
    return { kind: "unreadable" };
  }
  const file = read.value as GrokAuthFile;
  return { kind: "slot", file, canonical: canonicalFromGrokFile(file) };
}

async function readSelection(rootDir: string): Promise<string | null> {
  const read = await readPrivateJsonFile(join(rootDir, ACTIVE_AUTH_FILE));
  if (read.kind !== "value") return null;
  const profileId = (read.value as { profileId?: unknown })?.profileId;
  return typeof profileId === "string" ? profileId : null;
}

/** Who a slot belongs to: the slot's user_id, else the token's subject. */
function subjectOf(slot: SlotRead): string | undefined {
  if (slot.kind !== "slot" || !slot.canonical) return undefined;
  const found = grokAuthSlot(slot.file);
  const userId = found?.slot.user_id;
  if (typeof userId === "string" && userId.length > 0) return userId;
  return jwtStringClaim(slot.canonical.access, "sub");
}

/** True when `candidate` is at least as fresh as `reference` (or reference is absent). */
function atLeastAsFresh(
  candidate: CanonicalCredential | null,
  reference: CanonicalCredential | null,
): boolean {
  if (!reference) return true;
  if (!candidate) return false;
  const verdict = compareCredentials(candidate, reference);
  return verdict === "equal" || verdict === "pi-newer" || verdict === "conflict";
}

async function writeSlot(path: string, file: GrokAuthFile, privateDirectory: boolean): Promise<void> {
  await atomicWritePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`, { privateDirectory });
}

export async function undoGrokLiveSlotSwap(
  input: UndoGrokLiveSlotSwapInput,
): Promise<UndoGrokLiveSlotSwapResult> {
  const rootDir = resolve(input.grokRootDir);
  const vaultDir = join(rootDir, PERSONAL_VAULT_DIRECTORY);
  const backupFile = join(vaultDir, GROK_CLI_AUTH_FILE);
  const liveFile = join(resolve(input.personalHomeDir), GROK_CLI_AUTH_FILE);
  const result: UndoGrokLiveSlotSwapResult = {
    restoredFrom: null,
    personalRestored: false,
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
  const vaultExists = await fs.lstat(vaultDir).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (selected === null && !vaultExists) return result;

  const defer = (what: string): UndoGrokLiveSlotSwapResult => {
    result.deferred = what;
    input.log?.(
      `[accounts] ${what} could not be read; the Grok login vault is kept for the next launch`,
    );
    return result;
  };
  const live = await readSlotFile(liveFile);
  if (live.kind === "unreadable") return defer("~/.grok/auth.json");
  const backup = vaultExists ? await readSlotFile(backupFile) : { kind: "none" as const };
  if (backup.kind === "unreadable") return defer("the vaulted Grok login");
  const liveCanonical = live.kind === "slot" ? live.canonical : null;
  const backupCanonical = backup.kind === "slot" ? backup.canonical : null;

  if (selected && isGrokCliManagedProfileId(selected)) {
    const exists = input.managedProfileExists ? await input.managedProfileExists(selected) : true;
    let liveIsManaged = liveCanonical !== null;
    if (exists) {
      const managedPaths = grokCliManagedProfilePaths(rootDir, selected);
      const managed = await readSlotFile(managedPaths.authFile);
      if (managed.kind === "unreadable") return defer(`the Grok login of ${selected}`);
      const managedCanonical = managed.kind === "slot" ? managed.canonical : null;
      // ~/.grok holds the managed account's token unless a personal login
      // landed there since the swap; the subjects tell the two apart.
      const liveSubject = subjectOf(live);
      const backupSubject = subjectOf(backup);
      const managedSubject = subjectOf(managed);
      if (liveSubject && backupSubject && liveSubject === backupSubject && liveSubject !== managedSubject) {
        liveIsManaged = false;
      }
      if (liveIsManaged && live.kind === "slot" && liveCanonical) {
        const verdict = compareCredentials(managedCanonical, liveCanonical);
        if (verdict === "cli-newer" || verdict === "cli-only") {
          await writeSlot(managedPaths.authFile, live.file, true);
          result.restoredFrom = selected;
        }
      }
    } else {
      // A stale marker (a crash between the delete and the marker rewrite)
      // must not conjure a directory no registry row will ever reference.
      input.log?.(
        `[accounts] the Grok login vault marker names a profile that no longer exists (${selected}); its token is not copied anywhere`,
      );
    }
    if (backup.kind === "slot" && backupCanonical) {
      if (liveIsManaged || live.kind !== "slot" || !liveCanonical) {
        await writeSlot(liveFile, backup.file, false);
        result.personalRestored = true;
      } else if (!atLeastAsFresh(liveCanonical, backupCanonical)) {
        await writeSlot(liveFile, backup.file, false);
        result.personalRestored = true;
      }
    } else if (liveIsManaged && liveCanonical) {
      input.log?.(
        "[accounts] the personal Grok login vault is empty; ~/.grok keeps the credential it holds",
      );
    }
  } else if (backup.kind === "slot" && backupCanonical) {
    // The marker names personal (or is gone): ~/.grok is the personal login
    // and the backup is at best a fresher copy of it.
    if (!atLeastAsFresh(liveCanonical, backupCanonical)) {
      await writeSlot(liveFile, backup.file, false);
      result.personalRestored = true;
    }
  }

  // The backup goes only once ~/.grok holds a login at least as fresh, so an
  // aborted write above leaves the bytes for the next launch.
  if (vaultExists) {
    const after = await readSlotFile(liveFile);
    const afterCanonical = after.kind === "slot" ? after.canonical : null;
    if (backupCanonical && !atLeastAsFresh(afterCanonical, backupCanonical)) {
      return defer("~/.grok/auth.json after the restore");
    }
    await removePrivateFile(backupFile).catch(() => undefined);
    for (const name of VAULT_ARTIFACTS) {
      await fs.rm(join(vaultDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const remaining = await fs.readdir(vaultDir).catch(() => [] as string[]);
    if (remaining.length === 0) {
      await fs.rmdir(vaultDir).catch(() => undefined);
    } else {
      const retired = join(rootDir, `.personal.retired-${randomBytes(6).toString("hex")}`);
      await fs.rename(vaultDir, retired);
      result.retiredVaultDir = retired;
    }
  }
  await fs.rm(join(rootDir, ACTIVE_AUTH_FILE), { force: true }).catch(() => undefined);
  return result;
}
