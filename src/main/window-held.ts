import { promises as fsp } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

// The real path of a file that may not exist (an editor tab on a deleted
// file): the deepest folder above it that exists, resolved, plus the rest.
export async function realpathLoose(path: string): Promise<string> {
  let head = resolve(path);
  const rest: string[] = [];
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const real = await fsp.realpath(head);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      rest.push(basename(head));
      head = parent;
    }
  }
  return resolve(path);
}

// Where a tab's file really is: its folder resolved, then each symlink
// followed by hand, so a link whose target was deleted still points where the
// buffer came from. Null for a loop.
async function resolveFile(file: string, folderOf: (dir: string) => Promise<string>): Promise<string | null> {
  let current = join(await folderOf(dirname(resolve(file))), basename(file));
  for (let hops = 0; hops < 40; hops += 1) {
    const stat = await fsp.lstat(current).catch(() => null);
    if (!stat?.isSymbolicLink()) return current;
    const target = await fsp.readlink(current).catch(() => null);
    if (target === null) return null;
    const next = resolve(dirname(current), target);
    current = join(await realpathLoose(dirname(next)), basename(next));
  }
  return null;
}

export async function filesInsideFolders(files: unknown, folders: readonly string[]): Promise<boolean | null> {
  if (!Array.isArray(files) || files.length > MAX_TAB_FILES) return null;
  const roots = [...new Set([...folders.map((folder) => resolve(folder)), ...(await Promise.all(folders.map(realpathLoose)))])];
  const parents = new Map<string, Promise<string>>();
  for (const file of files) {
    if (typeof file !== "string" || !isAbsolute(file)) continue;
    if (roots.some((root) => inside(resolve(file), root))) return true;
    // Files of one folder share its resolution.
    const folderOf = (dir: string): Promise<string> => {
      let real = parents.get(dir);
      if (!real) {
        real = realpathLoose(dir);
        parents.set(dir, real);
      }
      return real;
    };
    const real = await resolveFile(file, folderOf);
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
