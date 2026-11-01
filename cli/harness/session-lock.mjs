// One writer per session. Two processes appending to one session file fork its
// history without either noticing. The lock names its holder, so one a kill left
// behind is taken over at once instead of after a timeout.

import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const TAKEOVER_ATTEMPTS = 3;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function holderOf(path) {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** Moves a dead holder's lock aside. Only one process wins the rename, and the
 * winner puts it back if a new holder got there between the read and the move. */
function clearDeadHolder(path) {
  const aside = `${path}.${process.pid}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const moved = holderOf(aside);
  if (moved && isAlive(moved)) linkSync(aside, path);
  rmSync(aside, { force: true });
}

export function sessionLocks(home) {
  const folder = join(home, "session-locks");
  const pathFor = (sessionFile) => join(folder, `${basename(sessionFile)}.lock`);
  let held = null;

  const release = () => {
    if (held) rmSync(held, { force: true });
    held = null;
  };
  process.on("exit", release);

  /** @returns the process holding the session, or null when this one may write. */
  const inUseBy = (sessionFile) => {
    const path = pathFor(sessionFile);
    if (path === held) return null;
    const holder = holderOf(path);
    return holder && isAlive(holder) ? holder : null;
  };

  /** @returns null once this process holds the session, else the process that does. */
  const acquire = (sessionFile) => {
    const path = pathFor(sessionFile);
    if (path === held) return null;
    mkdirSync(folder, { recursive: true });
    for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
      try {
        writeFileSync(path, String(process.pid), { flag: "wx" });
        release();
        held = path;
        return null;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = inUseBy(sessionFile);
      if (holder) return holder;
      clearDeadHolder(path);
    }
    return holderOf(path) || process.pid;
  };

  return { acquire, inUseBy };
}
