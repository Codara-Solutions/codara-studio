// One Codara on the machine updates agent tools at a time (two windows with
// SPARK_ALLOW_MULTI, or a launch handing off to the running one). The lock is
// a file created exclusively, holding its owner's pid; a lock whose owner is
// gone is stale and taken over.

import { promises as fs } from "node:fs";

import type { ReleaseLock } from "./service";

export interface UpdateLockOptions {
  pid?: number;
  /** Whether a process runs; EPERM still means it does. */
  alive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function ownerOf(file: string): Promise<number | null> {
  try {
    const pid = Number((JSON.parse(await fs.readFile(file, "utf8")) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The lock, or null while another live Codara holds it. */
export async function acquireUpdateLock(file: string, options: UpdateLockOptions = {}): Promise<ReleaseLock | null> {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid, since: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return async () => {
        if ((await ownerOf(file)) === pid) await fs.rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await ownerOf(file);
    // A lock being written has no pid yet: treat it as held.
    if (owner === null) {
      const age = await fs.stat(file).then((stat) => Date.now() - stat.mtimeMs, () => Infinity);
      if (age < 10_000) return null;
    } else if (owner !== pid && alive(owner)) {
      return null;
    }
    await fs.rm(file, { force: true });
  }
  return null;
}
