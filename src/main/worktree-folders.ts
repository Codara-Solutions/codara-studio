import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where a path leads, as the file system resolves it, also when it is gone:
 * links are followed, a link whose target is gone too, and a missing tail is
 * joined onto the nearest folder that exists.
 */
export async function folderIdentity(path: string): Promise<string> {
  let at = resolve(path);
  for (let hops = 0; hops < 40; hops += 1) {
    const found = await realpath(at).catch(() => null);
    if (found !== null) return found;
    const rest: string[] = [];
    let probe = at;
    let info = await lstat(probe).catch(() => null);
    while (!info) {
      if (dirname(probe) === probe) return at;
      rest.unshift(basename(probe));
      probe = dirname(probe);
      info = await lstat(probe).catch(() => null);
    }
    if (!info.isSymbolicLink()) return join(await realpath(probe).catch(() => probe), ...rest);
    const target = await readlink(probe).catch(() => null);
    if (target === null) return at;
    at = join(resolve(dirname(probe), target), ...rest);
  }
  return resolve(path);
}

// Case is ignored when comparing folders that are gone: some file systems
// ignore it (Windows and macOS by default, case-folding Linux mounts), and
// treating two spellings as one folder only ever keeps more.
const fold = (path: string) => path.toLowerCase();

/**
 * Whether two paths name one folder. Two that exist are compared by the file
 * system's own identity; when either is gone, by where they lead, without
 * case, as reservations compare them: a row naming `Task` while `task`
 * exists is taken to share it.
 */
export async function sameFolder(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  if (left && right) return left.dev === right.dev && left.ino === right.ino;
  return fold(await folderIdentity(a)) === fold(await folderIdentity(b));
}

/**
 * The folders the workspace rows name, for `reservedDirNames`. Throws when
 * the rows cannot be read: without them no folder may be handed out.
 */
export async function rowFolders(loadRows: () => Promise<readonly { cwd?: string | null; remote?: unknown }[]>): Promise<string[]> {
  const rows = await loadRows();
  return rows.filter((row) => !row.remote && typeof row.cwd === "string" && row.cwd).map((row) => row.cwd as string);
}

/**
 * Which names under `worktreesRoot` a workspace row still names, even when
 * the folder is gone: a row whose worktree was removed outside Studio (plain
 * `git worktree remove`) stays until the rail's next look, and a removal
 * asked for that old row would judge, and delete, a new worktree made in its
 * folder. Compared by where the paths lead (`folderIdentity`) and without
 * case. Every path that picks a managed worktree folder asks this.
 */
export async function reservedDirNames(
  worktreesRoot: string,
  takenPaths: readonly string[] = [],
): Promise<(name: string) => boolean> {
  const roots = new Set([fold(resolve(worktreesRoot)), fold(await folderIdentity(worktreesRoot))]);
  const taken = new Set<string>();
  for (const path of takenPaths) {
    if (typeof path !== "string" || !path || !isAbsolute(path)) continue;
    for (const at of new Set([resolve(path), await folderIdentity(path)])) {
      if (roots.has(fold(dirname(at)))) taken.add(fold(basename(at)));
      const parent = await folderIdentity(dirname(at));
      if (roots.has(fold(parent))) taken.add(fold(basename(at)));
    }
  }
  return (name) => taken.has(fold(name));
}
