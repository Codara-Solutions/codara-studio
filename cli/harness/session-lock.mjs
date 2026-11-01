// One writer per session. Two processes appending to one session file fork its
// history without either noticing, so a process holds the lock before Pi reads
// the file and until it exits. A live holder renews the lock; one that was killed
// stops renewing, and the lock can be taken over once it goes stale.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 6_000;
const RENEW_MS = 2_000;
const RETRY_MS = 200;
/** Pi's private methods that change a session file. */
const SESSION_WRITERS = ["_persist", "_rewriteFile"];

const idOf = (file) => basename(file, ".jsonl").split("_").at(-1);
export const sessionInUse = (file) => `session ${idOf(file)} is in use by another cora`;

/**
 * Makes Pi take the lock before it loads a session, because loading can rewrite
 * the file, and check it still has the lock before each write, because a process
 * waking from a pause can write before it notices the lock lapsed. Its entry would
 * become the session's leaf and hide what the new holder wrote. Everything held
 * stays held until `holdOnly` names the running session.
 * @param pi  { SessionManager, findMostRecentSession }
 * @param onLost  ends the process with this message
 */
export function lockSessions({ SessionManager, findMostRecentSession }, home, onLost) {
  const folder = join(home, "session-locks");
  const lockPath = (file) => join(folder, `${basename(file)}.lock`);
  const options = (file) => ({ realpath: false, lockfilePath: lockPath(file), stale: STALE_MS });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const held = new Map();
  const owner = randomUUID();
  const ownerFile = (path) => `${path}.owner`;

  const owns = (path) => {
    try {
      return readFileSync(ownerFile(path), "utf8") === owner;
    } catch {
      return false;
    }
  };

  /** A lock that lapsed may have let another writer in, and this process has no
   * sight of what it wrote, so it cannot go on from the history it loaded. */
  const stop = (file) =>
    onLost(`this cora lost session ${idOf(file)} and stopped. Continue with: cora resume ${idOf(file)}`);

  const tryLock = (file) => {
    try {
      return lockfile.lockSync(file, { ...options(file), update: RENEW_MS, onCompromised: () => stop(file) });
    } catch (error) {
      if (error.code === "ELOCKED") return null;
      throw error;
    }
  };

  /** Waits past the stale limit only at startup: a dead holder can only be told
   * from a live one by waiting, and blocking later would stop the held locks renewing. */
  const hold = (file) => {
    if (held.has(lockPath(file))) return;
    mkdirSync(folder, { recursive: true });
    const deadline = Date.now() + (held.size > 0 ? 0 : STALE_MS + 1_000);
    for (;;) {
      const release = tryLock(file);
      if (release) {
        writeFileSync(ownerFile(lockPath(file)), owner);
        held.set(lockPath(file), release);
        return;
      }
      if (Date.now() >= deadline) {
        if (held.size > 0) throw new Error(sessionInUse(file));
        onLost(sessionInUse(file));
      }
      Atomics.wait(pause, 0, 0, RETRY_MS);
    }
  };

  const { open, prototype } = SessionManager;
  SessionManager.open = (path, ...rest) => {
    hold(path);
    return open.call(SessionManager, path, ...rest);
  };
  SessionManager.continueRecent = (cwd, sessionDir) => {
    const recent = findMostRecentSession(sessionDir, cwd);
    return recent ? SessionManager.open(recent, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
  };
  for (const method of SESSION_WRITERS) {
    const write = prototype[method];
    if (!write) throw new Error(`this version of Pi has no SessionManager.${method}: update SESSION_WRITERS`);
    prototype[method] = function fenced(...args) {
      const path = this.sessionFile && lockPath(this.sessionFile);
      if (held.has(path) && !owns(path)) stop(this.sessionFile);
      return write.apply(this, args);
    };
  }
  // Runs before proper-lockfile's own exit hook frees the lock.
  process.on("exit", () => {
    for (const path of held.keys()) if (owns(path)) rmSync(ownerFile(path));
  });

  return {
    /** For when `file` has started: Pi writes the outgoing session until then. */
    holdOnly(file) {
      if (file) hold(file);
      for (const [path, release] of held) {
        if (!file || path !== lockPath(file)) {
          held.delete(path);
          if (!owns(path)) continue;
          rmSync(ownerFile(path));
          release();
        }
      }
    },
    inUse: (file) => !held.has(lockPath(file)) && lockfile.checkSync(file, options(file)),
  };
}
