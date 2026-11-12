import { promises as fsp } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// A drive mounted inside a worktree (an rclone or sshfs folder under data/,
// a bind mount) would be copied to the archive and then deleted through the
// mount, on the far side. A worktree with anything inside it on another
// device than its own folder, or with a mount point under it, is never
// removed on its own: the walk below names the first one, and a walk that
// cannot finish refuses as well.

export interface MountReader {
  lstat(path: string): Promise<{ dev: number | bigint; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<string[]>;
  realpath?(path: string): Promise<string>;
  /** Mount points the system lists (Linux: /proc/self/mountinfo); null where there is no such list. */
  mountPoints(): Promise<string[] | null>;
}

const WALK_CONCURRENCY = 32;
// A walk that has not finished by then refuses: an unfinished walk proves nothing.
export const MOUNT_WALK_LIMIT_MS = 30_000;

// /proc/self/mountinfo escapes space, tab, newline and backslash as octal.
function unescapeMountPath(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

export function mountPointsFromMountinfo(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    if (fields.length > 4 && fields[4]) out.push(unescapeMountPath(fields[4]));
  }
  return out;
}

// Electron's fs reads an .asar file as a folder whose entries it makes up,
// device included: an installed electron package (default_app.asar) looked
// like a drive mounted inside every worktree that had one, and kept it. The
// walk reads the disk through Electron's unpatched fs, where an archive is
// one file; plain Node has no such layer.
const diskFs: typeof fsp =
  (process.getBuiltinModule?.("original-fs") as typeof import("node:fs") | undefined)?.promises ?? fsp;

export const systemMountReader: MountReader = {
  lstat: (path) => diskFs.lstat(path),
  readdir: (path) => diskFs.readdir(path),
  realpath: (path) => diskFs.realpath(path),
  mountPoints: async () => {
    if (process.platform !== "linux") return null;
    return mountPointsFromMountinfo(await fsp.readFile("/proc/self/mountinfo", "utf8"));
  },
};

function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The first path inside `root` (relative to it) that is a mount point or on
 * another device than `root`, or null when there is none. Links are not
 * followed. Throws when a folder cannot be read, so a caller refuses.
 */
export async function mountInside(
  root: string,
  reader: MountReader = systemMountReader,
  limitMs = MOUNT_WALK_LIMIT_MS,
): Promise<string | null> {
  const started = Date.now();
  const base = resolve(root);
  const show = (path: string) => relative(base, path).split(sep).join("/") || ".";
  const listed = await reader.mountPoints();
  if (listed) {
    // The system lists mount points by their real path.
    const real = reader.realpath ? resolve(await reader.realpath(base)) : base;
    const under = listed.map((point) => resolve(point)).find((point) => point.startsWith(`${real}${sep}`));
    if (under) return relative(real, under).split(sep).join("/");
  }
  const device = (await reader.lstat(base)).dev;
  let level = [base];
  while (level.length) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += WALK_CONCURRENCY) {
      if (Date.now() - started > limitMs) throw new Error(`the walk took longer than ${Math.round(limitMs / 1000)}s`);
      const batch = level.slice(i, i + WALK_CONCURRENCY);
      const children = await Promise.all(
        batch.map(async (dir) => {
          const names = await reader.readdir(dir).catch((err: unknown) => {
            if (missing(err)) return [] as string[];
            throw err;
          });
          return names.map((name) => join(dir, name));
        }),
      );
      const paths = children.flat();
      for (let j = 0; j < paths.length; j += WALK_CONCURRENCY) {
        const infos = await Promise.all(
          paths.slice(j, j + WALK_CONCURRENCY).map(async (path) => ({
            path,
            info: await reader.lstat(path).catch((err: unknown) => {
              if (missing(err)) return null;
              throw err;
            }),
          })),
        );
        for (const { path, info } of infos) {
          if (!info) continue;
          if (info.dev !== device) return show(path);
          if (info.isDirectory() && !info.isSymbolicLink()) next.push(path);
        }
      }
    }
    level = next;
  }
  return null;
}

/** The refusal for a worktree with a mount inside, or null when it has none. */
export async function mountRefusal(root: string, reader?: MountReader, limitMs?: number): Promise<string | null> {
  try {
    const found = await mountInside(root, reader, limitMs);
    return found ? `${found} is a mounted drive or on another disk, so it was kept. Unmount it first.` : null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `It could not be checked for mounted drives (${why.slice(0, 200)}), so it was kept.`;
  }
}
