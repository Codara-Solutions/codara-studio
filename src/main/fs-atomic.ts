import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** Persist directory-entry changes such as rename/unlink on POSIX. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Atomic file write — write content to a sibling tmp file, fsync to flush
// the kernel buffers, then rename over the target. The rename is atomic on
// POSIX and best-effort on Windows (NTFS rename-over is atomic but a few
// edge cases like ReadDirectoryChangesW listeners can still observe both
// names). Mirrors the Tauri reference impl (terax-scout's fs/file.rs).
export async function writeFileAtomic(
  path: string,
  content: string,
  options?: { mode?: number },
): Promise<void> {
  const dir = dirname(path);
  // sibling tmp keeps the rename within the same volume so it stays atomic.
  // pid + clock alone is not unique: two same-process writers in the same
  // millisecond would share a temp file and rename torn content over the
  // target, so a random suffix disambiguates them.
  const tmp = join(
    dir,
    `.${baseName(path)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: import("node:fs").promises.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w", options?.mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    if (options?.mode !== undefined) {
      // open(2) applies the process umask. Security-sensitive callers require
      // the exact mode, including when an existing destination is replaced.
      await handle.chmod(options.mode);
    }
    await handle.close();
    handle = null;
    await fs.rename(tmp, path);
    // Persist the directory entry as well as the file contents. Without this,
    // a power loss after rename can resurrect the previous name/content even
    // though the file handle itself was fsynced. Some Windows filesystems do
    // not permit opening a directory handle; that platform keeps rename's
    // best-effort semantics.
    await syncDirectory(dir);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore close failure during error cleanup
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore — tmp may have already been renamed or never created
    }
    throw err;
  }
}

function baseName(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep === -1 ? path : path.slice(sep + 1);
}
