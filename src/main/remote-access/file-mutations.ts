import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import {
  isPathInside,
  isStudioExplorerIgnoredDirectory,
  resolveExistingInside,
  toWireRelative,
} from "./local-policy";

export type RemoteWorkspaceEntryKind = "file" | "directory";

export interface RemoteWorkspaceEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext?: string;
}

export interface RemoteWorkspaceDeleteResult {
  deletedPath: string;
  parentPath: string;
}

const MAX_ENTRY_NAME_BYTES = 240;
const CREATE_FILE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Validate one leaf name, never a path. The conservative cross-platform
 * policy makes a mutation created from macOS behave predictably if that
 * workspace is later opened on Windows, and prevents invisible Explorer
 * trees such as .git or node_modules from being created by the phone.
 */
export function validateRemoteEntryName(rawName: string): string {
  const name = rawName.trim();
  if (!name) throw new Error("Name cannot be empty.");
  if (Buffer.byteLength(name, "utf8") > MAX_ENTRY_NAME_BYTES) {
    throw new Error(`Name is too long (maximum ${MAX_ENTRY_NAME_BYTES} UTF-8 bytes).`);
  }
  if (name === "." || name === "..") {
    throw new Error("Name cannot be '.' or '..'.");
  }
  if (/[/\\]/.test(name)) {
    throw new Error("Name cannot include path separators.");
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Name contains an invalid control character.");
  }
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("Name contains characters that are not portable across computers.");
  }
  if (WINDOWS_RESERVED_BASENAME.test(name)) {
    throw new Error("That name is reserved by the operating system.");
  }
  if (isStudioExplorerIgnoredDirectory(name)) {
    throw new Error(`"${name}" is managed outside the phone Explorer.`);
  }
  return name;
}

export async function createRemoteWorkspaceEntry(
  root: string,
  input: { parentPath?: string; name: string; kind: RemoteWorkspaceEntryKind },
): Promise<RemoteWorkspaceEntry> {
  const parent = await resolveExistingInside(root, input.parentPath, {
    directory: true,
    rejectSymlinks: true,
  });
  assertVisiblePath(parent.root, parent.path, true);
  const name = validateRemoteEntryName(input.name);
  const target = join(parent.path, name);
  assertVisiblePath(parent.root, target, false);

  try {
    if (input.kind === "directory") {
      await mkdir(target, { recursive: false });
    } else {
      const handle = await open(target, CREATE_FILE_FLAGS, 0o666);
      await handle.close();
    }
  } catch (cause) {
    throw friendlyMutationError(cause, name, "create");
  }
  return readEntry(parent.root, target);
}

export async function renameRemoteWorkspaceEntry(
  root: string,
  input: { path: string; name: string },
): Promise<RemoteWorkspaceEntry> {
  const source = await resolveMutableEntry(root, input.path);
  const name = validateRemoteEntryName(input.name);
  const target = join(dirname(source.path), name);
  assertVisiblePath(source.root, target, false);
  if (target === source.path) return readEntry(source.root, source.path);

  const sameEntry = await assertDestinationAvailable(target, source.path, name);
  if (sameEntry && basename(source.path) === name) {
    return readEntry(source.root, source.path);
  }
  try {
    await rename(source.path, target);
  } catch (cause) {
    throw friendlyMutationError(cause, name, "rename");
  }
  return readEntry(source.root, target);
}

export async function moveRemoteWorkspaceEntry(
  root: string,
  input: { path: string; destinationPath?: string },
): Promise<RemoteWorkspaceEntry> {
  const source = await resolveMutableEntry(root, input.path);
  const destination = await resolveExistingInside(root, input.destinationPath, {
    directory: true,
    rejectSymlinks: true,
  });
  assertVisiblePath(destination.root, destination.path, true);

  if (dirname(source.path) === destination.path) {
    return readEntry(source.root, source.path);
  }
  const sourceInfo = await lstat(source.path);
  if (sourceInfo.isDirectory() && isPathInside(source.path, destination.path)) {
    throw new Error("A folder cannot be moved into itself.");
  }

  const name = basename(source.path);
  const target = join(destination.path, name);
  assertVisiblePath(source.root, target, false);
  await assertDestinationAvailable(target, source.path, name);
  try {
    await rename(source.path, target);
  } catch (cause) {
    throw friendlyMutationError(cause, name, "move");
  }
  return readEntry(source.root, target);
}

export async function deleteRemoteWorkspaceEntry(
  root: string,
  input: { path: string },
  remove: (path: string) => Promise<void> = (path) =>
    rm(path, { recursive: true, force: false }),
): Promise<RemoteWorkspaceDeleteResult> {
  const source = await resolveMutableEntry(root, input.path);
  const deletedPath = toWireRelative(source.root, source.path);
  const parentPath = dirnameWirePath(deletedPath);
  try {
    await remove(source.path);
  } catch (cause) {
    throw friendlyMutationError(cause, basename(source.path), "delete");
  }
  return { deletedPath, parentPath };
}

async function resolveMutableEntry(root: string, path: string) {
  if (!path) throw new Error("The workspace root cannot be changed.");
  const target = await resolveExistingInside(root, path, { rejectSymlinks: true });
  assertVisiblePath(target.root, target.path, false);
  const info = await lstat(target.path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("Only regular files and folders can be changed from the phone.");
  }
  return target;
}

async function readEntry(root: string, path: string): Promise<RemoteWorkspaceEntry> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("Only regular files and folders are available through Remote Access.");
  }
  const name = basename(path);
  const extension = info.isFile() ? extname(name).slice(1).toLowerCase() : "";
  return {
    name,
    path: toWireRelative(root, path),
    isDir: info.isDirectory(),
    ...(extension ? { ext: extension } : {}),
  };
}

async function assertDestinationAvailable(
  target: string,
  source: string,
  name: string,
): Promise<boolean> {
  const targetInfo = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (!targetInfo) return false;

  // Case-only and Unicode-normalization-only renames may resolve to the source
  // inode on a case-insensitive filesystem. Those are safe; every other
  // collision is refused instead of silently clobbered by fs.rename().
  const sourceInfo = await lstat(source);
  if (targetInfo.dev === sourceInfo.dev && targetInfo.ino === sourceInfo.ino) {
    return true;
  }
  throw new Error(`A file or folder named "${name}" already exists here.`);
}

function assertVisiblePath(root: string, target: string, allowRoot: boolean): void {
  if (!isPathInside(root, target)) {
    throw new Error("Path must stay inside the workspace.");
  }
  const rel = relative(root, target);
  if (!rel) {
    if (allowRoot) return;
    throw new Error("The workspace root cannot be changed.");
  }
  for (const segment of rel.split(sep)) {
    if (isStudioExplorerIgnoredDirectory(segment)) {
      throw new Error(`"${segment}" is managed outside the phone Explorer.`);
    }
  }
}

function dirnameWirePath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function friendlyMutationError(
  cause: unknown,
  name: string,
  operation: "create" | "rename" | "move" | "delete",
): Error {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST" || code === "ENOTEMPTY") {
    return new Error(`A file or folder named "${name}" already exists here.`);
  }
  if (code === "ENOENT") return new Error("The file or folder no longer exists.");
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`Codara Studio does not have permission to ${operation} "${name}".`);
  }
  if (code === "EXDEV") {
    return new Error("This item cannot be moved across filesystem volumes.");
  }
  return cause instanceof Error ? cause : new Error(`Could not ${operation} "${name}".`);
}
