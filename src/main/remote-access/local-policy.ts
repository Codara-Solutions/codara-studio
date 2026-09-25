import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface ResolvedLocalPath {
  root: string;
  path: string;
}

export interface ResolveInsideOptions {
  allowAbsolute?: boolean;
  directory?: boolean;
  rejectSymlinks?: boolean;
}

const STUDIO_EXPLORER_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

// Keep the phone's workspace explorer aligned with Studio's recursive file
// listing. These generated trees are both noisy and expensive to enumerate.
export function isStudioExplorerIgnoredDirectory(name: string): boolean {
  return STUDIO_EXPLORER_IGNORED_DIRECTORIES.has(name.toLowerCase());
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Folders directly in the home folder where the system and apps keep settings
// and sign-ins, beyond the dot folders every platform uses for the same.
const HOME_SETTINGS_FOLDERS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["library"],
  win32: ["appdata"],
};

/**
 * Why a phone may not add `target` as a workspace, or null when it may.
 *
 * A workspace opens its whole tree to the phone (files, terminals, agents),
 * so a phone may add a project folder but not one that holds the user's keys:
 * a disk root or the home folder (they contain everything else), Codara's own
 * home (the remote-access private key, the agent-socket token, Cora's
 * logins), or a folder where tools keep credentials (~/.ssh, ~/.aws,
 * ~/.claude, ~/Library, ...). Every path must already be canonical.
 */
export function phoneWorkspaceRefusal(
  target: string,
  context: { home: string; codaraHome: string; platform?: NodeJS.Platform },
): string | null {
  if (parse(target).root === target) {
    return "A disk root cannot be a workspace. Choose a project folder.";
  }
  if (target === context.home) {
    return "Your home folder cannot be a workspace from the phone. Choose a project folder inside it.";
  }
  if (isPathInside(target, context.codaraHome) || isPathInside(context.codaraHome, target)) {
    return "Codara's own folder cannot be a workspace.";
  }
  if (isPathInside(context.home, target)) {
    const top = relative(context.home, target).split(sep)[0] ?? "";
    const settingsFolders = HOME_SETTINGS_FOLDERS[context.platform ?? process.platform] ?? [];
    if (top.startsWith(".") || settingsFolders.includes(top.toLowerCase())) {
      return "Folders where apps keep settings and sign-ins cannot be a workspace from the phone. Add it on the computer if you need it.";
    }
  }
  return null;
}

// Resolve an existing local path against a canonical security root. Both the
// lexical candidate and its real path must remain within the root. Callers that
// expose workspace contents also request component-by-component symlink
// rejection: merely checking the final real path would still let a workspace
// alias surprise the phone and would make future policy changes ambiguous.
export async function resolveExistingInside(
  rawRoot: string,
  rawPath: string | undefined,
  options: ResolveInsideOptions = {},
): Promise<ResolvedLocalPath> {
  const root = await realpath(resolve(rawRoot));
  const value = rawPath ?? "";
  if (value.includes("\0")) throw new Error("Path contains an invalid character.");
  if (isAbsolute(value) && !options.allowAbsolute) {
    throw new Error("Path must be relative to the workspace.");
  }

  const lexical = value
    ? isAbsolute(value)
      ? resolve(value)
      : resolve(root, value)
    : root;
  if (!isPathInside(root, lexical)) {
    throw new Error("Path must stay inside the allowed root.");
  }

  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new Error("Path does not exist.");
  }
  if (!isPathInside(root, canonical)) {
    throw new Error("Path must stay inside the allowed root.");
  }
  if (options.rejectSymlinks) {
    await assertNoSymlinkComponents(root, lexical);
  }

  const info = await stat(canonical).catch(() => null);
  if (!info) throw new Error("Path does not exist.");
  if (options.directory && !info.isDirectory()) {
    throw new Error("Path must be a directory.");
  }
  return { root, path: canonical };
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (!rel) return;
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    const info = await lstat(cursor).catch(() => null);
    if (!info) throw new Error("Path does not exist.");
    if (info.isSymbolicLink()) {
      throw new Error("Symbolic links are not available through Remote Access.");
    }
  }
}

export function toWireRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel ? rel.split(sep).join("/") : "";
}

// Slice by UTF-8 bytes, not UTF-16 code units, so every DTO remains inside its
// wire budget even when names/messages contain multi-byte glyphs.
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = maxBytes >= 3 ? "…" : "";
  const contentBudget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= contentBudget) low = mid;
    else high = mid - 1;
  }
  // Do not preserve half of a surrogate pair at the cut.
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}
