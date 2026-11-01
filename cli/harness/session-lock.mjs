// One writer per session. Two processes appending to one session file fork its
// history without either noticing, so a process holds the lock before Pi reads
// the file and until it exits. A live holder renews the lock; one that was killed
// stops renewing, and the lock can be taken over once it goes stale.

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 6_000;
const RENEW_MS = 2_000;
const RETRY_MS = 200;

export const sessionInUse = (file) => `session ${basename(file, ".jsonl").split("_").at(-1)} is in use by another cora`;

/**
 * Makes Pi take the lock before it loads a session.
 * @param onLost  ends the process with this message: another one has the session
 */
export function lockSessions(SessionManager, home, onLost) {
  const folder = join(home, "session-locks");
  const lockPath = (file) => join(folder, `${basename(file)}.lock`);
  const options = (file) => ({ realpath: false, lockfilePath: lockPath(file), stale: STALE_MS });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let held = null;

  const tryLock = (file) => {
    try {
      return lockfile.lockSync(file, { ...options(file), update: RENEW_MS, onCompromised: renew });
    } catch (error) {
      if (error.code === "ELOCKED") return null;
      throw error;
    }
  };

  /** A sleeping laptop misses its renewals, and nobody may have taken over. */
  function renew() {
    held.release = tryLock(held.file);
    if (!held.release) onLost(sessionInUse(held.file));
  }

  /** Waits past the stale limit only at startup: a dead holder can only be told
   * from a live one by waiting, and blocking later would stop this lock renewing. */
  const hold = (file) => {
    if (held && lockPath(held.file) === lockPath(file)) return;
    mkdirSync(folder, { recursive: true });
    const deadline = Date.now() + (held ? 0 : STALE_MS + 1_000);
    for (;;) {
      const release = tryLock(file);
      if (release) {
        held?.release();
        held = { file, release };
        return;
      }
      if (Date.now() >= deadline) {
        if (held) throw new Error(sessionInUse(file));
        onLost(sessionInUse(file));
      }
      Atomics.wait(pause, 0, 0, RETRY_MS);
    }
  };

  const { open, continueRecent } = SessionManager;
  SessionManager.open = (path, ...rest) => {
    hold(path);
    return open.call(SessionManager, path, ...rest);
  };
  SessionManager.continueRecent = (cwd, sessionDir) => {
    const recent = continueRecent.call(SessionManager, cwd, sessionDir);
    const file = recent.getSessionFile();
    hold(file);
    // What it read predates the lock.
    return existsSync(file) ? open.call(SessionManager, file, sessionDir, cwd) : recent;
  };

  return {
    hold,
    inUse: (file) => Boolean(held) && lockPath(held.file) !== lockPath(file) && lockfile.checkSync(file, options(file)),
  };
}
