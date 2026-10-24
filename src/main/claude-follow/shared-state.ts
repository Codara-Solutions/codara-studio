import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertCodaraOwnedWrite, outsideWriteCapability } from "../outside-write-guard";
import {
  CLAUDE_SHARED_FILE_NAMES,
  placeLink,
  readSharedFileLinks,
  sameFileIdentity,
  sha256OfFile,
  sharedFileLinkRecordFile,
  updateSharedFileLinks,
} from "../orchestration/cli-account-homes";

/**
 * Windows only: mending the hard links of the live slot's shared files.
 *
 * On Windows the live slot shares settings.json, CLAUDE.md, keybindings.json
 * and history.jsonl with ~/.claude through hard links (a symlink needs
 * Developer Mode). A hard link holds while a file is written in place but
 * breaks when a program writes a new file and renames it over the old one,
 * which is how Claude Code saves settings and how many editors save. The
 * two names then hold two files, and a change made through either would be
 * lost to the other side.
 *
 * Each pass compares both files with the content they last shared (noted in
 * Codara's folder when the link was made):
 *
 *  - only the live slot's copy changed: it is written to the user's file
 *    (a new file renamed over theirs), then linked again;
 *  - only the user's file changed: the live slot is linked to it again;
 *  - both changed: the user's file wins and the live slot's copy is kept in
 *    Codara's backups, except history.jsonl, whose missing lines are added.
 *
 * Runs only while plain `claude` follows Codara, from its periodic pass.
 */

const SHARED_FILE_SYNC = outsideWriteCapability(
  "claude-follow: a shared Claude file changed through the live slot, saved back into the user's ~/.claude (Windows)",
);

const MAX_SHARED_FILE_BYTES = 32 * 1024 * 1024;

export interface SharedFileMendInput {
  /** Codara's claude-cli folder (holds the link record). */
  root: string;
  /** The live slot. */
  home: string;
  /** Where a live copy that lost a conflict is kept. */
  backupDir: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
  /** Test seam: runs after both sides are read and before any write. */
  beforeWrite?: () => Promise<void>;
}

export interface SharedFileMendReport {
  relinked: string[];
  savedToUser: string[];
  conflicts: string[];
}

async function readBounded(path: string): Promise<Buffer | null> {
  const stats = await fs.lstat(path).catch(() => null);
  if (!stats || !stats.isFile() || stats.size > MAX_SHARED_FILE_BYTES) return null;
  return fs.readFile(path).catch(() => null);
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The user's history plus the lines only the live slot has, in its order. */
export function mergeHistoryLines(user: Buffer, live: Buffer): Buffer {
  const userText = user.toString("utf8");
  const seen = new Set(userText.split(/\r?\n/).filter((line) => line.length > 0));
  const extra = live
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !seen.has(line));
  if (extra.length === 0) return user;
  const separator = userText.length === 0 || userText.endsWith("\n") ? "" : "\n";
  return Buffer.from(`${userText}${separator}${extra.join("\n")}\n`, "utf8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A new file renamed over the user's, keeping its mode; retried while Windows holds it open. */
async function replaceUserFile(target: string, content: Buffer, expected: string): Promise<boolean> {
  assertCodaraOwnedWrite(target, SHARED_FILE_SYNC);
  const stats = await fs.lstat(target).catch(() => null);
  if (!stats || !stats.isFile()) return false;
  const temporary = join(dirname(target), `.${basename(target)}.codara-${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(temporary, content, { flag: "wx", mode: stats.mode & 0o777 });
  try {
    // The file must still be what the merge read; a save meanwhile waits for the next pass.
    if ((await sha256OfFile(target)) !== expected) {
      await fs.rm(temporary, { force: true });
      return false;
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await sleep(50 * (attempt + 1));
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function mendSharedFileLinks(input: SharedFileMendInput): Promise<SharedFileMendReport> {
  const report: SharedFileMendReport = { relinked: [], savedToUser: [], conflicts: [] };
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return report;
  const recordFile = sharedFileLinkRecordFile(input.root);
  const links = await readSharedFileLinks(recordFile);
  for (const name of CLAUDE_SHARED_FILE_NAMES) {
    const entry = join(input.home, name);
    const record = links[entry];
    if (!record) continue;
    try {
      const entryStats = await fs.lstat(entry).catch(() => null);
      if (!entryStats || entryStats.isSymbolicLink() || !entryStats.isFile()) {
        await updateSharedFileLinks(recordFile, (current) => {
          delete current[entry];
        });
        continue;
      }
      if (await sameFileIdentity(entry, record.target)) {
        const now = await sha256OfFile(record.target);
        if (now && now !== record.sha256) {
          await updateSharedFileLinks(recordFile, (current) => {
            if (current[entry]) current[entry] = { ...current[entry], sha256: now };
          });
        }
        continue;
      }
      const live = await readBounded(entry);
      const user = await readBounded(record.target);
      // A user file that is gone or too large is left alone: the live copy stays private.
      if (!live || !user) continue;
      const liveHash = hash(live);
      const userHash = hash(user);
      let content: Buffer | null = null;
      if (liveHash === userHash || liveHash === record.sha256) {
        content = null;
      } else if (userHash === record.sha256) {
        content = live;
      } else if (name === "history.jsonl") {
        content = mergeHistoryLines(user, live);
        report.conflicts.push(name);
      } else {
        await fs.mkdir(input.backupDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(input.backupDir, `${name}.${Date.now()}.live`), live, { mode: 0o600 });
        report.conflicts.push(name);
        input.log?.(`[claude-follow] ${name} changed on both sides; yours was kept, the other copy is in Codara's backups`);
      }
      await input.beforeWrite?.();
      if (content && content !== user) {
        if (!(await replaceUserFile(record.target, content, userHash))) continue;
        report.savedToUser.push(name);
      }
      await placeLink(entry, record.target, false, platform);
      const shared = await sha256OfFile(record.target);
      await updateSharedFileLinks(recordFile, (current) => {
        if (shared) current[entry] = { target: record.target, sha256: shared };
      });
      report.relinked.push(name);
    } catch (error) {
      input.log?.(`[claude-follow] could not mend the shared ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
