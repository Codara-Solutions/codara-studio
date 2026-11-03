import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Which names under `worktreesRoot` a workspace row still names, even when
 * the folder is gone: a row whose worktree was removed outside Studio (plain
 * `git worktree remove`) stays until the rail's next look, and a removal
 * asked for that old row would judge, and delete, a new worktree made in its
 * folder. Compared as the file system does: through links (via the nearest
 * folder that exists), and without case where the default file systems
 * ignore it. Every path that picks a managed worktree folder asks this.
 */
export async function reservedDirNames(
  worktreesRoot: string,
  takenPaths: readonly string[] = [],
): Promise<(name: string) => boolean> {
  const fold = (path: string) =>
    process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
  const real = async (path: string): Promise<string> => {
    const rest: string[] = [];
    for (let at = resolve(path); ; at = dirname(at)) {
      const found = await realpath(at).catch(() => null);
      if (found !== null) return join(found, ...rest.reverse());
      if (dirname(at) === at) return resolve(path);
      rest.push(basename(at));
    }
  };
  const roots = new Set([fold(resolve(worktreesRoot)), fold(await real(worktreesRoot))]);
  const taken = new Set<string>();
  for (const path of takenPaths) {
    if (typeof path !== "string" || !path || !isAbsolute(path)) continue;
    const at = resolve(path);
    for (const parent of new Set([dirname(at), await real(dirname(at))])) {
      if (roots.has(fold(parent))) taken.add(fold(basename(at)));
    }
  }
  return (name) => taken.has(fold(name));
}
