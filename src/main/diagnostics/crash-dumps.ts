// The minidumps Crashpad writes into <codaraHome>/crash-dumps: listing them
// for the About page and the export, and keeping the folder under its cap.
// Dumps hold process memory, so they never leave the computer; the export
// lists their names, sizes and times only.
//
// Crashpad's database keeps each report as <id>.dmp (with a <id>.meta beside
// it) under new/, pending/ or completed/, and attachments under
// attachments/<id>/.

import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CrashDumpInfo } from "@shared/diagnostics";

export const CRASH_DUMP_MAX_BYTES = 64 * 1024 * 1024;
export const CRASH_DUMP_MAX_COUNT = 20;
const MAX_WALK_DEPTH = 3;

async function walkDumps(dir: string, root: string, depth: number, out: Array<CrashDumpInfo & { absolute: string }>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH && entry.name !== "attachments") await walkDumps(absolute, root, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".dmp")) continue;
    try {
      const stat = await fs.stat(absolute);
      out.push({
        absolute,
        path: relative(root, absolute).split(sep).join("/"),
        bytes: stat.size,
        modifiedAt: Math.round(stat.mtimeMs),
      });
    } catch {
      // Crashpad moves reports between folders; a vanished file is normal.
    }
  }
}

/** Newest first. */
export async function listCrashDumps(root: string): Promise<CrashDumpInfo[]> {
  const found: Array<CrashDumpInfo & { absolute: string }> = [];
  await walkDumps(root, root, 0, found);
  return found
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map(({ path, bytes, modifiedAt }) => ({ path, bytes, modifiedAt }));
}

/**
 * Deletes the oldest dumps (with their .meta and attachments) until the
 * folder holds at most `maxCount` dumps and `maxBytes`. The newest dump is
 * always kept, whatever its size: it is the one someone is about to ask about.
 */
export async function pruneCrashDumps(
  root: string,
  limits: { maxBytes: number; maxCount: number } = { maxBytes: CRASH_DUMP_MAX_BYTES, maxCount: CRASH_DUMP_MAX_COUNT },
): Promise<string[]> {
  const found: Array<CrashDumpInfo & { absolute: string }> = [];
  await walkDumps(root, root, 0, found);
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const removed: string[] = [];
  let keptBytes = 0;
  let keptCount = 0;
  for (const [index, dump] of found.entries()) {
    const fits = keptBytes + dump.bytes <= limits.maxBytes && keptCount < limits.maxCount;
    if (index === 0 || fits) {
      keptBytes += dump.bytes;
      keptCount += 1;
      continue;
    }
    const id = basename(dump.absolute, ".dmp");
    try {
      await fs.rm(dump.absolute, { force: true });
      removed.push(dump.path);
    } catch {
      continue;
    }
    await fs.rm(join(dirname(dump.absolute), `${id}.meta`), { force: true }).catch(() => undefined);
    await fs.rm(join(root, "attachments", id), { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}
