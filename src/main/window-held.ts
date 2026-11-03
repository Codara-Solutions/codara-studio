import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

// Whether the window holds a worktree folder before a removal deletes it: it
// shows the worktree's workspace or has tabs of it, or a tab of any workspace
// shows a file inside the folder (an editor buffer may hold unsaved edits).
// The window matches the folder's spellings itself; the files its tabs show
// are also resolved here, because an editor opened through a symlink keeps
// the spelling it was opened with. Null when the window did not answer.

type Ask = (op: "workspaceHeld" | "tabFiles", params: Record<string, unknown>) => Promise<unknown>;

// More tab files than this is a window state nobody keeps; it reads as
// "cannot tell", so the removal waits.
const MAX_TAB_FILES = 5_000;

const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);

function inside(path: string, root: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

// Components exactly as written: ".." is applied only once the links before
// it are followed, as the kernel does.
function components(path: string): { root: string; names: string[] } {
  const root = parse(path).root;
  return { root, names: path.slice(root.length).split(SEPARATORS).filter(Boolean) };
}

// Where a path really leads, component by component: every symlink on the
// way is followed by hand, so a link whose target was deleted (a file or a
// folder above it) still points where the buffer came from; from the first
// missing component on, the rest is kept as written. Null when that cannot
// be told: a link loop, or a component that cannot be read.
export async function resolveLoose(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const start = components(path);
  let current = start.root;
  let pending = start.names;
  for (let hops = 0; pending.length > 0; ) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? join(next, ...pending) : null;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > 40) return null;
    const target = await fsp.readlink(next).catch(() => null);
    if (target === null) return null;
    if (isAbsolute(target)) {
      const followed = components(target);
      current = followed.root;
      pending = [...followed.names, ...pending];
    } else {
      // Relative to the folder holding the link, which is `current`.
      pending = [...target.split(SEPARATORS).filter(Boolean), ...pending];
    }
  }
  return current;
}

export async function filesInsideFolders(files: unknown, folders: readonly string[]): Promise<boolean | null> {
  if (!Array.isArray(files) || files.length > MAX_TAB_FILES) return null;
  const resolved = await Promise.all(folders.map(resolveLoose));
  const roots = [...new Set([...folders.map((folder) => resolve(folder)), ...resolved.filter((root): root is string => root !== null)])];
  for (const file of files) {
    if (typeof file !== "string" || !isAbsolute(file)) continue;
    if (roots.some((root) => inside(resolve(file), root))) return true;
    const real = await resolveLoose(file);
    if (real === null) return null;
    if (roots.some((root) => inside(real, root))) return true;
  }
  return false;
}

export async function windowHoldsFolder(ask: Ask, workspaceId: string, paths: readonly string[]): Promise<boolean | null> {
  try {
    const held = await ask("workspaceHeld", { workspaceId, paths });
    if (typeof held !== "boolean") return null;
    if (held || paths.length === 0) return held;
    return await filesInsideFolders(await ask("tabFiles", {}), paths);
  } catch {
    return null;
  }
}
