import type { RemoteBrowseEntry, RemoteBrowseResult } from "@shared/remote";
import { getConnection } from "./connections";

// SFTP directory listing for the "pick a folder on the VPS" browser shown
// BEFORE a remote workspace exists (so it cannot go through the fs:* IPC,
// which is sandbox-gated to workspace roots). Only ever lists directories —
// files are shown greyed for orientation but selection is folder-only.

export async function browseRemoteDir(hostId: string, path: string | null): Promise<RemoteBrowseResult> {
  try {
    const conn = await getConnection(hostId);
    const sftp = await conn.sftp();
    // null = start at the user's home directory (sftp realpath of ".").
    const target = path
      ? path
      : await new Promise<string>((resolve, reject) => {
          sftp.realpath(".", (err, abs) => (err ? reject(err) : resolve(abs)));
        });
    const entries = await new Promise<RemoteBrowseEntry[]>((resolve, reject) => {
      sftp.readdir(target, (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        const out: RemoteBrowseEntry[] = list.map((item) => ({
          name: item.filename,
          path: target === "/" ? `/${item.filename}` : `${target.replace(/\/+$/, "")}/${item.filename}`,
          isDir: item.attrs.isDirectory(),
        }));
        resolve(out);
      });
    });
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    const parent = target === "/" ? null : target.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    return { path: target, parent, entries };
  } catch (err) {
    return {
      path: path ?? "/",
      parent: null,
      entries: [],
      error: (err as Error).message,
    };
  }
}
