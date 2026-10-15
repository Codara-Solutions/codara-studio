// The record of where each installed skill came from, kept in Codara's own
// folder and keyed by the skill's folder. One small JSON file per skill, so
// two writes for different skills never race on one file, and nothing is
// ever written inside the skill folder, which may belong to a CLI.
//
//   <state>/receipts/<key>.json   the origin, the last check, the rollback
//   <state>/backups/<key>/skill/  the version the last update replaced

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillOrigin, SkillOriginStatus, SkillUpdateState } from "@shared/skill-origins";
import { writeFileAtomic } from "./fs-atomic";

const SCHEMA_VERSION = 1;
const MAX_RECEIPTS = 2048;
const MAX_RECEIPT_BYTES = 64 * 1024;

export interface SkillOriginCheck {
  state: Exclude<SkillUpdateState, "unchecked">;
  checkedAt: string;
  remoteCommit?: string;
  error?: string;
}

export interface SkillOriginRollback {
  savedAt: string;
  name: string;
  origin: SkillOrigin;
}

export interface SkillOriginReceipt {
  schemaVersion: 1;
  skillDir: string;
  name: string;
  origin: SkillOrigin;
  check?: SkillOriginCheck;
  rollback?: SkillOriginRollback;
  // The folder's file id (inode) when Codara last wrote it. A skill removed
  // outside Codara and another one put in the same place later has a new id,
  // so this record no longer describes it (see skillFolderId).
  folderId?: string;
}

// Folded the way outside-write-guard folds: macOS and Windows treat paths
// case-insensitively, so one folder must map to one key there.
export function normalizeSkillDir(skillDir: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = resolve(skillDir).normalize("NFC");
  return platform === "win32" || platform === "darwin" ? absolute.toLowerCase() : absolute;
}

export function skillOriginKey(skillDir: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256").update(normalizeSkillDir(skillDir, platform)).digest("hex").slice(0, 40);
}

export function skillOriginReceiptPath(stateDir: string, skillDir: string): string {
  return join(stateDir, "receipts", `${skillOriginKey(skillDir)}.json`);
}

/** Where the version an update replaced is kept: `<this>/skill`. */
export function skillOriginBackupDir(stateDir: string, skillDir: string): string {
  return join(stateDir, "backups", skillOriginKey(skillDir));
}

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const FOLDER_ID_PATTERN = /^[1-9][0-9]{0,39}$/;

/**
 * The folder's file id: the inode on macOS and Linux, the NTFS file index on
 * Windows. A rename keeps it; a folder removed and made again gets a new one.
 * Undefined when the folder is missing or the file system reports none.
 */
export async function skillFolderId(dir: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(dir, { bigint: true });
    return stat.isDirectory() && stat.ino > 0n ? stat.ino.toString() : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOrigin(value: unknown): value is SkillOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as Record<string, unknown>;
  if (origin.kind !== "git" && origin.kind !== "folder" && origin.kind !== "zip") return false;
  if (typeof origin.installedAt !== "string") return false;
  for (const key of ["url", "ref", "branch", "subpath", "sourcePath", "updatedAt"]) {
    if (!optionalString(origin[key])) return false;
  }
  for (const key of ["commit", "tree"]) {
    const field = origin[key];
    if (field !== undefined && (typeof field !== "string" || !COMMIT_PATTERN.test(field))) return false;
  }
  if (origin.kind === "git" && (typeof origin.url !== "string" || !origin.url.startsWith("https://"))) return false;
  return true;
}

function isCheck(value: unknown): value is SkillOriginCheck {
  if (!value || typeof value !== "object") return false;
  const check = value as Record<string, unknown>;
  return (
    (check.state === "current" || check.state === "update-available" || check.state === "error") &&
    typeof check.checkedAt === "string" &&
    optionalString(check.remoteCommit) &&
    optionalString(check.error)
  );
}

function isRollback(value: unknown): value is SkillOriginRollback {
  if (!value || typeof value !== "object") return false;
  const rollback = value as Record<string, unknown>;
  return typeof rollback.savedAt === "string" && typeof rollback.name === "string" && isOrigin(rollback.origin);
}

export function parseSkillOriginReceipt(text: string): SkillOriginReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const receipt = parsed as Record<string, unknown>;
  if (receipt.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof receipt.skillDir !== "string" || typeof receipt.name !== "string" || !isOrigin(receipt.origin)) return null;
  if (receipt.check !== undefined && !isCheck(receipt.check)) return null;
  if (receipt.rollback !== undefined && !isRollback(receipt.rollback)) return null;
  if (receipt.folderId !== undefined && (typeof receipt.folderId !== "string" || !FOLDER_ID_PATTERN.test(receipt.folderId))) {
    return null;
  }
  return receipt as unknown as SkillOriginReceipt;
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return null;
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readSkillOrigin(stateDir: string, skillDir: string): Promise<SkillOriginReceipt | null> {
  const text = await readSmall(skillOriginReceiptPath(stateDir, skillDir));
  const receipt = text === null ? null : parseSkillOriginReceipt(text);
  // A receipt filed under this key for another folder (a hash collision, or
  // a file copied by hand) does not describe this one.
  if (!receipt || normalizeSkillDir(receipt.skillDir) !== normalizeSkillDir(skillDir)) return null;
  return receipt;
}

export async function writeSkillOrigin(stateDir: string, receipt: SkillOriginReceipt): Promise<void> {
  const path = skillOriginReceiptPath(stateDir, receipt.skillDir);
  await fs.mkdir(join(stateDir, "receipts"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export async function recordSkillOrigin(
  stateDir: string,
  input: { skillDir: string; name: string; origin: SkillOrigin },
): Promise<void> {
  // A fresh install starts with no rollback: a backup kept for an earlier
  // skill in the same folder would restore something else.
  await fs.rm(skillOriginBackupDir(stateDir, input.skillDir), { recursive: true, force: true });
  const folderId = await skillFolderId(input.skillDir);
  await writeSkillOrigin(stateDir, {
    schemaVersion: SCHEMA_VERSION,
    skillDir: resolve(input.skillDir),
    name: input.name,
    origin: input.origin,
    ...(folderId ? { folderId } : {}),
  });
}

/** Drops the record and any kept backup, for a skill removed or replaced by hand. */
export async function forgetSkillOrigin(stateDir: string, skillDir: string): Promise<boolean> {
  const path = skillOriginReceiptPath(stateDir, skillDir);
  const existed = await fs
    .lstat(path)
    .then(() => true)
    .catch(() => false);
  await fs.rm(path, { force: true });
  await fs.rm(skillOriginBackupDir(stateDir, skillDir), { recursive: true, force: true });
  return existed;
}

export async function listSkillOriginReceipts(stateDir: string): Promise<SkillOriginReceipt[]> {
  const dir = join(stateDir, "receipts");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && /^[0-9a-f]{40}\.json$/.test(entry.name))
    .slice(0, MAX_RECEIPTS);
  const receipts = await Promise.all(
    files.map(async (entry) => {
      const text = await readSmall(join(dir, entry.name));
      const receipt = text === null ? null : parseSkillOriginReceipt(text);
      return receipt && `${skillOriginKey(receipt.skillDir)}.json` === entry.name ? receipt : null;
    }),
  );
  return receipts
    .filter((receipt): receipt is SkillOriginReceipt => receipt !== null)
    .sort((a, b) => a.skillDir.localeCompare(b.skillDir));
}

export function receiptToStatus(receipt: SkillOriginReceipt): SkillOriginStatus {
  const check = receipt.check;
  return {
    skillDir: receipt.skillDir,
    name: receipt.name,
    origin: receipt.origin,
    state: receipt.origin.kind === "git" && check ? check.state : "unchecked",
    ...(check?.remoteCommit ? { remoteCommit: check.remoteCommit } : {}),
    ...(check?.checkedAt ? { checkedAt: check.checkedAt } : {}),
    ...(check?.error ? { error: check.error } : {}),
    ...(receipt.rollback
      ? {
          rollback: {
            savedAt: receipt.rollback.savedAt,
            ...(receipt.rollback.origin.commit ? { commit: receipt.rollback.origin.commit } : {}),
          },
        }
      : {}),
  };
}
