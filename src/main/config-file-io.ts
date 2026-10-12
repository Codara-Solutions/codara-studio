import { realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./fs-atomic";
import type { OutsideWriteCapability } from "./outside-write-guard";

// One write queue per agent CLI config file (~/.claude.json, the Codex and
// Grok config.toml files, a workspace .mcp.json). agent-sync and mcp-installer
// both read, modify and rewrite these files, so they share this queue: the
// second writer re-reads only after the first writer's rename has landed.
// Claude Code and Codex still write the same files outside any lock, which is
// why every write is also an atomic replace of a fresh re-read.
const configWriteQueues = new Map<string, Promise<void>>();

function lockKey(path: string): string {
  let key = resolve(path);
  try {
    key = realpathSync(key);
  } catch {
    // A file that does not exist yet is keyed by its lexical path.
  }
  return process.platform === "win32" || process.platform === "darwin" ? key.toLowerCase() : key;
}

export function withConfigFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(path);
  const previous = configWriteQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  configWriteQueues.set(key, tail);
  void tail.then(() => {
    if (configWriteQueues.get(key) === tail) configWriteQueues.delete(key);
  });
  return run;
}

/**
 * Atomically replace an agent config file. Dotfile managers often symlink these
 * files, so the rename lands on the link's target, and the target keeps its
 * existing permissions. A file that does not exist yet is created owner-only,
 * because these files carry server credentials.
 */
export async function writeConfigFileAtomic(
  path: string,
  content: string,
  options?: { mode?: number; outsideWrite?: OutsideWriteCapability },
): Promise<void> {
  let target = path;
  let mode = options?.mode ?? 0o600;
  try {
    target = await fs.realpath(path);
    if (options?.mode === undefined) mode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileAtomic(target, content, {
    mode,
    ...(options?.outsideWrite ? { outsideWrite: options.outsideWrite } : {}),
  });
}
