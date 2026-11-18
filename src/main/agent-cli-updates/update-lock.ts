// One Codara on the machine updates agent tools at a time (two windows with
// SPARK_ALLOW_MULTI, or a launch handing off to the running one). The lock is
// a file created exclusively, holding its owner's pid, host and start time,
// and the installer's pid once one runs. It is held while the owner lives or
// its installer still runs: an installer outlives a Codara that quit or
// crashed, and the next start must not inspect, or roll back, a tool that is
// still being written. Past the longest an update can take it is stale
// whatever the pids say, as a pid can be reused after a reboot.

import { promises as fs } from "node:fs";
import { hostname } from "node:os";

import { UPDATE_TIMEOUT_MS, type UpdateLock } from "./service";

/** An update and its roll back, each bounded by UPDATE_TIMEOUT_MS, plus margin. */
export const LOCK_MAX_HOLD_MS = 2 * UPDATE_TIMEOUT_MS + 5 * 60 * 1000;

export interface UpdateLockOptions {
  pid?: number;
  host?: string;
  now?: () => number;
  /** Whether a process runs; EPERM still means it does. */
  alive?: (pid: number) => boolean;
  /** Whether the installer, or any process of its group, still runs. */
  installerAlive?: (pid: number) => boolean;
}

interface LockContent {
  pid: number;
  host: string | null;
  since: number | null;
  installer: number | null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// POSIX installers run detached as their own process group.
function groupAlive(pid: number): boolean {
  if (process.platform !== "win32" && processAlive(-pid)) return true;
  return processAlive(pid);
}

async function read(file: string): Promise<LockContent | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const installer = Number(raw.installer);
    const since = typeof raw.since === "string" ? Date.parse(raw.since) : NaN;
    return {
      pid,
      host: typeof raw.host === "string" ? raw.host : null,
      since: Number.isFinite(since) ? since : null,
      installer: Number.isInteger(installer) && installer > 0 ? installer : null,
    };
  } catch {
    return null;
  }
}

/** The lock, or null while another live Codara, or its installer, holds it. */
export async function acquireUpdateLock(file: string, options: UpdateLockOptions = {}): Promise<UpdateLock | null> {
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const now = options.now ?? Date.now;
  const alive = options.alive ?? processAlive;
  const installerAlive = options.installerAlive ?? groupAlive;
  const since = new Date(now()).toISOString();
  const write = async (target: string, installer: number | null) => {
    const handle = await fs.open(target, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid, host, since, ...(installer ? { installer } : {}) }));
    } finally {
      await handle.close();
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await write(file, null);
      const owned = async () => (await read(file))?.pid === pid;
      return {
        release: async () => {
          if (await owned()) await fs.rm(file, { force: true });
        },
        installerStarted: async (installer: number) => {
          if (!(await owned())) return;
          const next = `${file}.${pid}.next`;
          await fs.rm(next, { force: true });
          await write(next, installer);
          await fs.rename(next, file);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const content = await read(file);
    const mtime = await fs.stat(file).then((stat) => stat.mtimeMs, () => null);
    if (content === null) {
      // A lock being written has no pid yet: held for a moment.
      if (mtime !== null && now() - mtime < 10_000) return null;
    } else {
      const age = now() - (content.since ?? mtime ?? 0);
      if (age < LOCK_MAX_HOLD_MS) {
        // Another machine's lock (a home folder shared over the network): its pids mean nothing here.
        if (content.host !== null && content.host !== host) return null;
        if (content.pid !== pid && alive(content.pid)) return null;
        if (content.installer !== null && installerAlive(content.installer)) return null;
      }
    }
    await fs.rm(file, { force: true });
  }
  return null;
}
