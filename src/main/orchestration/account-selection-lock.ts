import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";

/**
 * The lock every change of a CLI's live login is made under (a switch, the
 * mirror writing a slot, a renewal, following a terminal sign-in).
 *
 * Inside one process the callers queue in order. Across processes a lock
 * file beside the selection does the same: two Codara builds running side
 * by side (a development build next to the installed app) manage the one
 * real ~/.claude and ~/.codex, and must not switch or write a slot at the
 * same time. A holder that crashed leaves a lock that goes stale after
 * STALE_MS; a live holder keeps it fresh however long it works.
 */

const LOCK_FILE = ".selection.lock";
const STALE_MS = 30_000;
const UPDATE_MS = 5_000;

const tails = new Map<string, Promise<void>>();

export async function withAccountSelectionLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(rootDir);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    await fs.mkdir(key, { recursive: true, mode: 0o700 });
    const unlock = await lock(key, {
      lockfilePath: join(key, LOCK_FILE),
      realpath: false,
      stale: STALE_MS,
      update: UPDATE_MS,
      // Another process's switch finishes in seconds; wait up to about a
      // minute before giving up.
      retries: { retries: 120, minTimeout: 50, maxTimeout: 500 },
      // A lost lock is reported by the operation's own checks; it must not
      // throw on a timer and take the main process down.
      onCompromised: () => undefined,
    });
    try {
      return await operation();
    } finally {
      await unlock().catch(() => undefined);
    }
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
