// One writer per session. Two processes appending to one session file fork its
// history without either noticing, so a process holds the lock before Pi reads
// the file and until it exits. A live holder renews the lock; one that was killed
// stops renewing, and the lock can be taken over once it goes stale.

import { randomUUID } from "node:crypto";
import fs, { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 6_000;
const RENEW_MS = 2_000;
const RETRY_MS = 200;
/** Pi's private methods that change a session file. */
const SESSION_WRITERS = ["_persist", "_rewriteFile"];

/** Not there yet, a new session is known by its folder. */
function canonical(file) {
  for (const read of [() => realpathSync(file), () => join(realpathSync(dirname(file)), basename(file))]) {
    try {
      return read();
    } catch {
      // Next.
    }
  }
  return resolve(file);
}

const idOf = (file) => basename(file, ".jsonl").split("_").at(-1);
export const sessionInUse = (file) => `session ${idOf(file)} is in use by another cora`;

/**
 * Makes Pi take the lock before it loads a session, because loading can rewrite
 * the file, and check it still has the lock before each write, because a process
 * waking from a pause can write before it notices the lock lapsed. Its entry would
 * become the session's leaf and hide what the new holder wrote. A pause between
 * that check and the write itself is not covered. Everything held stays held until
 * `holdOnly` names the running session. The lock sits beside the real file, so a
 * symlink or another Cora home reaches the same one.
 * @param pi  { SessionManager, findMostRecentSession }
 * @param onLost  ends the process with this message
 */
export function lockSessions({ SessionManager, findMostRecentSession }, onLost) {
  const known = new Map();
  /** Once per path: one session keeps its lock whatever happens to the links. */
  const realFile = (file) => {
    if (!known.has(file)) known.set(file, canonical(file));
    return known.get(file);
  };
  const lockPath = (file) => `${realFile(file)}.lock`;
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

  /** proper-lockfile removes its locks at exit without asking whose they are now,
   * so a held lock goes only while this process owns it. Anything else is a dead
   * holder's. A takeover between this check and the removal is not covered. */
  const lockFs = {
    ...fs,
    rmdirSync: (path) => {
      if (!held.has(path)) {
        fs.rmdirSync(path);
      } else if (owns(path)) {
        rmSync(ownerFile(path));
        fs.rmdirSync(path);
      }
    },
  };

  /** A lock that lapsed may have let another writer in, and this process has no
   * sight of what it wrote, so it cannot go on from the history it loaded. */
  const stop = (file) =>
    onLost(`this cora lost session ${idOf(file)} and stopped. Continue with: cora resume ${idOf(file)}`);

  const tryLock = (file) => {
    try {
      return lockfile.lockSync(realFile(file), { ...options(file), fs: lockFs, update: RENEW_MS, onCompromised: () => stop(file) });
    } catch (error) {
      if (error.code === "ELOCKED") return null;
      throw error;
    }
  };

  /** Waits past the stale limit only at startup: a dead holder can only be told
   * from a live one by waiting, and blocking later would stop the held locks renewing. */
  const hold = (file) => {
    if (held.has(lockPath(file))) return;
    mkdirSync(dirname(lockPath(file)), { recursive: true });
    const deadline = Date.now() + (held.size > 0 ? 0 : STALE_MS + 1_000);
    for (;;) {
      const release = tryLock(file);
      if (release) {
        writeFileSync(ownerFile(lockPath(file)), owner);
        held.set(lockPath(file), release);
        return;
      }
      if (Date.now() >= deadline) {
        if (held.size > 0) throw new Error(sessionInUse(realFile(file)));
        onLost(sessionInUse(realFile(file)));
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

  return {
    /** For when `file` has started: Pi writes the outgoing session until then. */
    holdOnly(file) {
      if (file) hold(file);
      for (const [path, release] of held) {
        if ((!file || path !== lockPath(file)) && owns(path)) {
          release();
          held.delete(path);
        }
      }
    },
    inUse: (file) => !held.has(lockPath(file)) && lockfile.checkSync(realFile(file), options(file)),
    /** Ends the run if another process has taken `file` since this one locked it. */
    confirm(file) {
      if (file && held.has(lockPath(file)) && !owns(lockPath(file))) stop(file);
    },
  };
}
