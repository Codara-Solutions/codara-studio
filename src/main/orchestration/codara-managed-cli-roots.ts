import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The directories Codara owns for the native CLIs, and the one question every
 * "personal account" resolution has to ask about the inherited environment.
 *
 * Studio can itself be launched from a terminal that sources the generated
 * env.sh — that is the whole point of the shell block — so CLAUDE_CONFIG_DIR or
 * CODEX_HOME may arrive already pointing at a *managed* account directory, or
 * at the pointer symlink that follows the Active account. Reading that as the
 * user's own login makes the Personal card show a managed account's identity,
 * attaches pairing to the wrong account, and lets "Sign out" on Personal hit
 * the account currently in use. A selector inside these roots therefore never
 * counts as a personal override; a genuinely custom directory outside them
 * still does.
 */

export const CODARA_CLAUDE_CLI_DIRNAME = "claude-cli";
export const CODARA_CODEX_CLI_DIRNAME = "codex-cli";
export const NATIVE_CLI_ACTIVE_DIRNAME = "active";

export function codaraHomeDir(): string {
  const override =
    process.env.CODARA_HOME_DIR ??
    process.env.SPARK_HOME_DIR ??
    process.env.SPARK_USER_DATA_DIR;
  return resolve(override?.trim() || join(homedir(), ".Codara"));
}

export function codaraNativeCliActivePointerDir(
  homeDir: string = codaraHomeDir(),
): string {
  return join(resolve(homeDir), "cli", NATIVE_CLI_ACTIVE_DIRNAME);
}

export function codaraManagedCliRoots(
  homeDir: string = codaraHomeDir(),
): string[] {
  const home = resolve(homeDir);
  return [
    join(home, CODARA_CLAUDE_CLI_DIRNAME),
    join(home, CODARA_CODEX_CLI_DIRNAME),
    codaraNativeCliActivePointerDir(home),
  ];
}

function isInside(child: string, parent: string): boolean {
  // Claude Code hashes the literal config-directory string, so Codara-owned
  // paths are persisted NFC-normalized; compare on that spelling both ways.
  const inner = child.normalize("NFC");
  const outer = parent.normalize("NFC");
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * True when a path names something Codara manages — a managed account
 * directory or the Active pointer — whether directly or through a symlink.
 */
export function isCodaraManagedCliPath(
  candidate: string,
  homeDir?: string,
): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  const resolved = resolve(trimmed);
  const variants = [resolved];
  try {
    // The pointer directory is reached through a symlink by design, and a
    // user's own dotfile manager may add another; judge the real location too.
    const real = realpathSync(resolved);
    if (real !== resolved) variants.push(real);
  } catch {
    // A path that does not exist yet is judged exactly as it was written.
  }
  const roots = codaraManagedCliRoots(homeDir);
  return variants.some((variant) => roots.some((root) => isInside(variant, root)));
}
