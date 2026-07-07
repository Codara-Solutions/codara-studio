import { extname } from "node:path";
import type { SFTPWrapper, Stats as SftpStats } from "ssh2";
import {
  FS_READ_TEXT_LIMIT_BYTES,
  type FileListResult,
  type FsEntry,
  type FsFileContent,
  type FsReadResult,
  type FsWriteResult,
} from "@shared/types";
import {
  isRemotePath,
  makeRemotePath,
  parseRemotePath,
  remoteJoin,
} from "@shared/remote";
import { getConnection, shQuote } from "./connections";

// SFTP + exec backed filesystem for ssh:// workspaces. Reads/writes/stat go
// over SFTP; recursive or heavy operations (find, rm -rf, cp -r, mv, mkdir -p)
// shell out over the exec channel, which is both simpler and far faster than
// SFTP recursion. Every FsEntry.path returned is re-prefixed with ssh://<host>
// so the renderer round-trips it back through the fs:* IPC unchanged.

const MAX_BINARY_READ_BYTES = 300 * 1024 * 1024;
const MAX_FILE_LIST_FILES = 10000;
const MAX_MARKDOWN_FILES = 200;
const LIST_SKIP_DIRS = [".git", "node_modules", "out", "dist", "build", ".next", ".turbo", "coverage"];

function toMs(attrs: SftpStats): number {
  // SFTP mtime is in whole seconds.
  return (attrs.mtime ?? 0) * 1000;
}

async function sftpFor(remotePath: string): Promise<{ sftp: SFTPWrapper; hostId: string; path: string }> {
  const parts = parseRemotePath(remotePath);
  if (!parts) throw new Error(`Not a remote path: ${remotePath}`);
  const conn = await getConnection(parts.hostId);
  const sftp = await conn.sftp();
  return { sftp, hostId: parts.hostId, path: parts.path };
}

function basenamePosix(p: string): string {
  const clean = p.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function dirnamePosix(p: string): string {
  const clean = p.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i > 0 ? clean.slice(0, i) : "/";
}

function extOf(name: string, isDir: boolean): string | undefined {
  if (isDir) return undefined;
  return extname(name).replace(/^\./, "").toLowerCase() || undefined;
}

// ── promisified SFTP primitives ──────────────────────────────────────────────

function pReaddir(sftp: SFTPWrapper, path: string) {
  return new Promise<Array<{ filename: string; attrs: SftpStats }>>((resolve, reject) => {
    sftp.readdir(path, (err, list) =>
      err ? reject(err) : resolve(list.map((i) => ({ filename: i.filename, attrs: i.attrs }))),
    );
  });
}
function pStat(sftp: SFTPWrapper, path: string) {
  return new Promise<SftpStats>((resolve, reject) => {
    sftp.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs)));
  });
}
function pReadFile(sftp: SFTPWrapper, path: string) {
  return new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data as Buffer)));
  });
}

// ── routed operations ────────────────────────────────────────────────────────

export async function remoteListDir(remoteDir: string): Promise<FsEntry[]> {
  const { sftp, hostId, path } = await sftpFor(remoteDir);
  let list: Array<{ filename: string; attrs: SftpStats }>;
  try {
    list = await pReaddir(sftp, path);
  } catch {
    return []; // missing / not-a-dir / no-perm — match local listDir's soft fail
  }
  const out: FsEntry[] = [];
  for (const item of list) {
    let isDir = item.attrs.isDirectory();
    if (item.attrs.isSymbolicLink()) {
      // Resolve the link target's type so directory symlinks expand.
      try {
        const target = await pStat(sftp, remoteJoin(path, item.filename));
        isDir = target.isDirectory();
      } catch {
        isDir = false;
      }
    }
    out.push({
      name: item.filename,
      path: makeRemotePath(hostId, remoteJoin(path, item.filename)),
      isDir,
      ext: extOf(item.filename, isDir),
    });
  }
  out.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return out;
}

export async function remoteReadFileEx(remotePath: string): Promise<FsReadResult> {
  const { sftp, path } = await sftpFor(remotePath);
  const st = await pStat(sftp, path);
  if (!st.isFile()) throw new Error("Path is not a file.");
  if (st.size > FS_READ_TEXT_LIMIT_BYTES) {
    return { kind: "toolarge", path: remotePath, size: st.size, limit: FS_READ_TEXT_LIMIT_BYTES };
  }
  const buf = await pReadFile(sftp, path);
  if (buf.includes(0)) return { kind: "binary", path: remotePath, size: st.size };
  return { kind: "text", path: remotePath, content: buf.toString("utf8"), size: st.size, mtimeMs: toMs(st) };
}

export async function remoteReadText(remotePath: string): Promise<FsFileContent> {
  const { sftp, path } = await sftpFor(remotePath);
  const st = await pStat(sftp, path);
  if (!st.isFile()) throw new Error("Path is not a file.");
  if (st.size > FS_READ_TEXT_LIMIT_BYTES) throw new Error("File is too large to open in the editor.");
  const buf = await pReadFile(sftp, path);
  if (buf.includes(0)) throw new Error("Binary files cannot be opened in the editor.");
  return { path: remotePath, content: buf.toString("utf8"), size: st.size, mtimeMs: toMs(st) };
}

export async function remoteStatFile(remotePath: string): Promise<{ size: number; mtimeMs: number }> {
  const { sftp, path } = await sftpFor(remotePath);
  const st = await pStat(sftp, path);
  if (!st.isFile()) throw new Error("Path is not a file.");
  return { size: st.size, mtimeMs: toMs(st) };
}

export async function remoteReadFileBytes(remotePath: string): Promise<Uint8Array> {
  const { sftp, path } = await sftpFor(remotePath);
  const st = await pStat(sftp, path);
  if (!st.isFile()) throw new Error("Path is not a file.");
  if (st.size > MAX_BINARY_READ_BYTES) throw new Error("File is too large to preview.");
  return pReadFile(sftp, path);
}

// Atomic-ish write: SFTP-write a sibling temp file, then `mv -f` over the
// target on the host (POSIX rename is atomic on the same filesystem). The
// mtime conflict guard (autosave) is honored exactly as locally.
export async function remoteWriteText(
  remotePath: string,
  content: string,
  opts?: { expectedMtimeMs?: number },
): Promise<FsWriteResult> {
  const parts = parseRemotePath(remotePath);
  if (!parts) throw new Error(`Not a remote path: ${remotePath}`);
  const conn = await getConnection(parts.hostId);
  const sftp = await conn.sftp();

  if (opts?.expectedMtimeMs != null) {
    let before: SftpStats | null = null;
    try {
      before = await pStat(sftp, parts.path);
    } catch {
      return { kind: "conflict", path: remotePath, reason: "deleted", diskMtimeMs: null };
    }
    // Remote mtime has 1s granularity, so compare at second resolution to
    // avoid false conflicts from our own sub-second local mtime tracking.
    if (Math.floor(toMs(before) / 1000) !== Math.floor(opts.expectedMtimeMs / 1000)) {
      return { kind: "conflict", path: remotePath, reason: "modified", diskMtimeMs: toMs(before) };
    }
  }

  const tmp = `${parts.path}.spark-tmp-${Date.now()}`;
  await new Promise<void>((resolve, reject) => {
    sftp.writeFile(tmp, content, { encoding: "utf8" }, (err) => (err ? reject(err) : resolve()));
  });
  const mv = await conn.exec(`mv -f ${shQuote(tmp)} ${shQuote(parts.path)}`);
  if (mv.code !== 0) {
    await conn.exec(`rm -f ${shQuote(tmp)}`).catch(() => undefined);
    throw new Error(mv.stderr || "Remote write failed.");
  }
  const st = await pStat(sftp, parts.path);
  return { kind: "ok", path: remotePath, size: st.size, mtimeMs: toMs(st) };
}

export async function remoteRename(remotePath: string, newName: string): Promise<FsEntry> {
  const parts = parseRemotePath(remotePath);
  if (!parts) throw new Error(`Not a remote path: ${remotePath}`);
  const clean = newName.replace(/[\\/]/g, "").trim();
  if (!clean || clean === "." || clean === "..") throw new Error("Invalid name.");
  const conn = await getConnection(parts.hostId);
  const sftp = await conn.sftp();
  const nextPath = remoteJoin(dirnamePosix(parts.path), clean);
  if (nextPath === parts.path) {
    const st = await pStat(sftp, parts.path);
    return { name: clean, path: remotePath, isDir: st.isDirectory(), ext: extOf(clean, st.isDirectory()) };
  }
  // Clobber guard (mirrors local renameFile): refuse if the target exists.
  const exists = await conn.exec(`test -e ${shQuote(nextPath)}`);
  if (exists.code === 0) throw new Error(`A file named "${clean}" already exists in this folder.`);
  const st = await pStat(sftp, parts.path);
  await new Promise<void>((resolve, reject) => {
    sftp.rename(parts.path, nextPath, (err) => (err ? reject(err) : resolve()));
  });
  const isDir = st.isDirectory();
  return { name: clean, path: makeRemotePath(parts.hostId, nextPath), isDir, ext: extOf(clean, isDir) };
}

// Remote delete is permanent (no OS trash on the host). The confirm step in
// the file tree already gates this; here we just rm -rf.
export async function remoteDelete(remotePath: string): Promise<void> {
  const parts = parseRemotePath(remotePath);
  if (!parts) throw new Error(`Not a remote path: ${remotePath}`);
  // Guardrail: never rm -rf "/" or an empty path.
  if (parts.path === "/" || parts.path.trim() === "") throw new Error("Refusing to delete the filesystem root.");
  const conn = await getConnection(parts.hostId);
  const res = await conn.exec(`rm -rf ${shQuote(parts.path)}`);
  if (res.code !== 0) throw new Error(res.stderr || "Remote delete failed.");
}

export async function remoteCreateFile(parentRemotePath: string, name: string): Promise<FsEntry> {
  const parts = parseRemotePath(parentRemotePath);
  if (!parts) throw new Error(`Not a remote path: ${parentRemotePath}`);
  const clean = name.replace(/[\\/]/g, "").trim();
  if (!clean) throw new Error("Invalid name.");
  const conn = await getConnection(parts.hostId);
  const target = remoteJoin(parts.path, clean);
  // `set -C` (noclobber) makes `> file` fail if it already exists.
  const res = await conn.exec(`set -C; : > ${shQuote(target)}`);
  if (res.code !== 0) throw new Error(`A file named "${clean}" already exists.`);
  return { name: clean, path: makeRemotePath(parts.hostId, target), isDir: false, ext: extOf(clean, false) };
}

export async function remoteCreateFolder(parentRemotePath: string, name: string): Promise<FsEntry> {
  const parts = parseRemotePath(parentRemotePath);
  if (!parts) throw new Error(`Not a remote path: ${parentRemotePath}`);
  const clean = name.replace(/[\\/]/g, "").trim();
  if (!clean) throw new Error("Invalid name.");
  const conn = await getConnection(parts.hostId);
  const target = remoteJoin(parts.path, clean);
  const res = await conn.exec(`mkdir ${shQuote(target)}`);
  if (res.code !== 0) throw new Error(res.stderr || `Could not create "${clean}".`);
  return { name: clean, path: makeRemotePath(parts.hostId, target), isDir: true };
}

export async function remotePathExists(remotePath: string): Promise<boolean> {
  const parts = parseRemotePath(remotePath);
  if (!parts) return false;
  try {
    const conn = await getConnection(parts.hostId);
    const res = await conn.exec(`test -e ${shQuote(parts.path)}`);
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function remoteListFiles(remoteRoot: string): Promise<FileListResult> {
  const parts = parseRemotePath(remoteRoot);
  if (!parts) throw new Error(`Not a remote path: ${remoteRoot}`);
  const conn = await getConnection(parts.hostId);
  const prune = LIST_SKIP_DIRS.map((d) => `-name ${shQuote(d)}`).join(" -o ");
  // Prune skip-dirs, print files as relative paths.
  const cmd = `cd ${shQuote(parts.path)} && find . \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${MAX_FILE_LIST_FILES + 1}`;
  const res = await conn.exec(cmd, { timeoutMs: 30_000 });
  const rels = res.stdout.split("\n").map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean);
  const truncated = rels.length > MAX_FILE_LIST_FILES;
  const files: FsEntry[] = rels.slice(0, MAX_FILE_LIST_FILES).map((rel) => {
    const name = basenamePosix(rel);
    return {
      name,
      path: makeRemotePath(parts.hostId, remoteJoin(parts.path, rel)),
      isDir: false,
      ext: extOf(name, false),
    };
  });
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  return { files, truncated };
}

export async function remoteListMarkdownFiles(
  remoteRoot: string,
): Promise<Array<{ name: string; path: string; relativePath: string }>> {
  const parts = parseRemotePath(remoteRoot);
  if (!parts) throw new Error(`Not a remote path: ${remoteRoot}`);
  const conn = await getConnection(parts.hostId);
  const prune = LIST_SKIP_DIRS.map((d) => `-name ${shQuote(d)}`).join(" -o ");
  const cmd = `cd ${shQuote(parts.path)} && find . -maxdepth 6 \\( ${prune} \\) -prune -o -type f \\( -iname '*.md' -o -iname '*.markdown' \\) -print 2>/dev/null | head -n ${MAX_MARKDOWN_FILES}`;
  const res = await conn.exec(cmd, { timeoutMs: 20_000 });
  const rels = res.stdout.split("\n").map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean);
  return rels
    .map((rel) => ({
      name: basenamePosix(rel),
      path: makeRemotePath(parts.hostId, remoteJoin(parts.path, rel)),
      relativePath: rel,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" }));
}

// Paste-after-copy. Sources may be LOCAL absolute paths (upload) or ssh://
// paths on the SAME host (server-side cp -r). Cross-host is refused for v1.
export async function remoteImportEntries(destDir: string, sourcePaths: string[]): Promise<FsEntry[]> {
  const destParts = parseRemotePath(destDir);
  if (!destParts) throw new Error(`Not a remote path: ${destDir}`);
  const conn = await getConnection(destParts.hostId);
  const created: FsEntry[] = [];
  for (const src of sourcePaths) {
    if (!src) continue;
    if (isRemotePath(src)) {
      const sp = parseRemotePath(src);
      if (!sp || sp.hostId !== destParts.hostId) {
        throw new Error("Cross-host copy is not supported yet.");
      }
      const name = await uniqueRemoteName(conn, destParts.path, basenamePosix(sp.path));
      const target = remoteJoin(destParts.path, name);
      const res = await conn.exec(`cp -r ${shQuote(sp.path)} ${shQuote(target)}`, { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(res.stderr || "Remote copy failed.");
      created.push(await entryFor(conn, destParts.hostId, target));
    } else {
      // Local → remote upload via SFTP fastPut.
      const name = await uniqueRemoteName(conn, destParts.path, basenamePosix(src.replace(/\\/g, "/")));
      const target = remoteJoin(destParts.path, name);
      const sftp = await conn.sftp();
      await uploadPath(sftp, conn, src, target);
      created.push(await entryFor(conn, destParts.hostId, target));
    }
  }
  return created;
}

// Paste-after-cut. Same-host server-side mv; refuses collisions (mirrors the
// local moveEntries clobber guard).
export async function remoteMoveEntries(destDir: string, sourcePaths: string[]): Promise<FsEntry[]> {
  const destParts = parseRemotePath(destDir);
  if (!destParts) throw new Error(`Not a remote path: ${destDir}`);
  const conn = await getConnection(destParts.hostId);
  const moved: FsEntry[] = [];
  for (const src of sourcePaths) {
    if (!isRemotePath(src)) throw new Error("Can only move files already on the host.");
    const sp = parseRemotePath(src);
    if (!sp || sp.hostId !== destParts.hostId) throw new Error("Cross-host move is not supported.");
    if (dirnamePosix(sp.path) === destParts.path) continue; // no-op: same parent
    const name = basenamePosix(sp.path);
    const target = remoteJoin(destParts.path, name);
    const exists = await conn.exec(`test -e ${shQuote(target)}`);
    if (exists.code === 0) throw new Error(`A file named "${name}" already exists in this folder.`);
    const res = await conn.exec(`mv ${shQuote(sp.path)} ${shQuote(target)}`);
    if (res.code !== 0) throw new Error(res.stderr || "Remote move failed.");
    moved.push(await entryFor(conn, destParts.hostId, target));
  }
  return moved;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function uniqueRemoteName(
  conn: Awaited<ReturnType<typeof getConnection>>,
  destDir: string,
  name: string,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 1; i < 1000; i++) {
    const res = await conn.exec(`test -e ${shQuote(remoteJoin(destDir, candidate))}`);
    if (res.code !== 0) return candidate;
    candidate = `${stem} (${i})${ext}`;
  }
  return candidate;
}

async function entryFor(
  conn: Awaited<ReturnType<typeof getConnection>>,
  hostId: string,
  remotePath: string,
): Promise<FsEntry> {
  const sftp = await conn.sftp();
  const st = await pStat(sftp, remotePath);
  const name = basenamePosix(remotePath);
  const isDir = st.isDirectory();
  return { name, path: makeRemotePath(hostId, remotePath), isDir, ext: extOf(name, isDir) };
}

async function uploadPath(
  sftp: SFTPWrapper,
  conn: Awaited<ReturnType<typeof getConnection>>,
  localPath: string,
  remoteTarget: string,
): Promise<void> {
  const { promises: fsp } = await import("node:fs");
  const st = await fsp.stat(localPath);
  if (st.isDirectory()) {
    await conn.exec(`mkdir -p ${shQuote(remoteTarget)}`);
    const entries = await fsp.readdir(localPath, { withFileTypes: true });
    for (const e of entries) {
      const { join } = await import("node:path");
      await uploadPath(sftp, conn, join(localPath, e.name), remoteJoin(remoteTarget, e.name));
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remoteTarget, (err) => (err ? reject(err) : resolve()));
    });
  }
}
