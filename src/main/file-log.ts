// Tiny persistent main-process logger for lifecycle/recovery diagnostics.
//
// Packaged builds have no visible main-process console, and the dev console
// scrolls away — so when the app "dies after sleep" or a session restore
// silently downgrades, there is no evidence trail to debug from. Events worth
// keeping (suspend/resume, renderer recovery, boot watchdog, restore decisions)
// go through logMain() and land in <sparkHome>/logs/main.log with timestamps.
//
// Deliberately minimal: fire-and-forget, append-only, serialized through one
// promise chain, size-capped with a single .1 rotation. Never throws.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { sparkHome } from "./spark-home";

const MAX_LOG_BYTES = 1_000_000;

let chain: Promise<void> = Promise.resolve();
let dirEnsured = false;

function logPath(): string {
  return join(sparkHome(), "logs", "main.log");
}

export function logMain(category: string, message: string): void {
  const line = `${new Date().toISOString()} [${category}] ${message}\n`;
  // Mirror to the console so dev runs still see everything in one place.
  console.log(`[${category}] ${message}`);
  chain = chain
    .then(async () => {
      const path = logPath();
      if (!dirEnsured) {
        await fs.mkdir(join(sparkHome(), "logs"), { recursive: true });
        dirEnsured = true;
      }
      try {
        const stat = await fs.stat(path).catch(() => null);
        if (stat && stat.size > MAX_LOG_BYTES) {
          await fs.rename(path, `${path}.1`).catch(() => undefined);
        }
      } catch {
        /* rotation is best-effort */
      }
      await fs.appendFile(path, line, "utf8");
    })
    .catch(() => undefined);
}

/** Await pending writes (quit path); bounded by the caller's own timeout. */
export function flushMainLog(): Promise<void> {
  return chain;
}
