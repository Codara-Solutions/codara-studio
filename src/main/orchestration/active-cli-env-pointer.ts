import { promises as fs } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  claudeCliManagedProfileConfigDir,
  isClaudeCliManagedProfileId,
  type ClaudeCliAccountProfileStore,
} from "./claude-cli-account-profiles";
import {
  codaraActiveCliEnvPointerFile,
  codaraHomeDir,
  CODARA_CLAUDE_CLI_DIRNAME,
  CODARA_GROK_CLI_DIRNAME,
} from "./codara-managed-cli-roots";
import {
  grokCliManagedProfilePaths,
  isGrokCliManagedProfileId,
  type GrokCliAccountProfileStore,
} from "./grok-cli-account-profiles";
import { atomicWritePrivateFile } from "./native-cli-atomic-file";
import { nativeClaudeProfileStore } from "./native-claude-profile-runtime";
import { nativeGrokProfileStore } from "./native-grok-profile-runtime";

/**
 * The pointer a running plain Studio shell follows to the active account:
 * <codaraHome>/shell/active-cli-env, rewritten by main on every default
 * change. The bundled prompt hooks re-read it when its revision changed and
 * export or unset CLAUDE_CONFIG_DIR and GROK_HOME accordingly, never a
 * value outside the managed roots.
 *
 * The file is data, deliberately not shell syntax: no shell ever sources it
 * and no line of it is a shell export. Its format is
 *
 *   codara-active-cli-env 1 <revision>
 *   CLAUDE_CONFIG_DIR=<absolute managed dir>
 *   GROK_HOME=<absolute managed dir>
 *
 * with the header first, then zero, one or two key lines. A personal default
 * omits its line (absence is the value). CODEX_HOME never appears: Codex has
 * one home and switches only auth.json. The revision strictly increases on
 * every write, so a shell that missed an intermediate switch still converges
 * on the next prompt. It lives under shell/, never under the retired active
 * pointer directory, which boot deletes and the managed-root check treats as
 * managed.
 */

export const ACTIVE_CLI_ENV_HEADER_WORD = "codara-active-cli-env";
export const ACTIVE_CLI_ENV_FORMAT_VERSION = 1;

export interface ActiveCliEnvSelectors {
  /** Managed CLAUDE_CONFIG_DIR for the active Claude account; absent when personal. */
  claudeConfigDir?: string;
  /** Managed GROK_HOME for the active Grok account; absent when personal. */
  grokHome?: string;
}

export interface WriteActiveCliEnvPointerOptions {
  /** Test seam; production derives the file from the Codara home. */
  pointerFile?: string;
  /** Test seam; production reads CODARA_HOME_DIR / SPARK_HOME_DIR. */
  homeDir?: string;
  now?: () => number;
}

function isInside(child: string, parent: string): boolean {
  const inner = resolve(child).normalize("NFC");
  const outer = resolve(parent).normalize("NFC");
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** Only a directory under the managed accounts root of its CLI is written. */
function managedValue(
  value: string | undefined,
  homeDir: string,
  dirname: string,
): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const root = resolve(homeDir, dirname, "accounts");
  return isInside(value, root) ? resolve(value) : null;
}

let lastRevision = 0;
let tail: Promise<void> = Promise.resolve();

export function formatActiveCliEnvPointer(
  selectors: ActiveCliEnvSelectors,
  revision: number,
  homeDir: string,
): string {
  const lines = [`${ACTIVE_CLI_ENV_HEADER_WORD} ${ACTIVE_CLI_ENV_FORMAT_VERSION} ${revision}`];
  const claude = managedValue(selectors.claudeConfigDir, homeDir, CODARA_CLAUDE_CLI_DIRNAME);
  if (claude) lines.push(`CLAUDE_CONFIG_DIR=${claude}`);
  const grok = managedValue(selectors.grokHome, homeDir, CODARA_GROK_CLI_DIRNAME);
  if (grok) lines.push(`GROK_HOME=${grok}`);
  return `${lines.join("\n")}\n`;
}

/** Write the pointer with a fresh revision; writes are serialized. */
export function writeActiveCliEnvPointer(
  selectors: ActiveCliEnvSelectors,
  options: WriteActiveCliEnvPointerOptions = {},
): Promise<void> {
  const run = tail.then(async () => {
    const homeDir = resolve(options.homeDir ?? codaraHomeDir());
    const pointerFile = options.pointerFile ?? codaraActiveCliEnvPointerFile(homeDir);
    // A revision equal to the last one written would read as "unchanged"
    // to a hook; two writes in the same millisecond still advance it.
    let revision = options.now?.() ?? Date.now();
    if (revision <= lastRevision) revision = lastRevision + 1;
    lastRevision = revision;
    await fs.mkdir(dirname(pointerFile), { recursive: true, mode: 0o700 });
    await atomicWritePrivateFile(pointerFile, formatActiveCliEnvPointer(selectors, revision, homeDir));
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RefreshActiveCliEnvPointerOptions extends WriteActiveCliEnvPointerOptions {
  claudeStore?: Pick<ClaudeCliAccountProfileStore, "rootDir" | "snapshot">;
  grokStore?: Pick<GrokCliAccountProfileStore, "rootDir" | "snapshot">;
}

/**
 * The selectors a brand-new plain shell would get, read from the store
 * defaults directly so a refresh from inside the startup pass never waits
 * on the ready gate it is part of. Resolution is best-effort per CLI: an
 * unreadable store contributes nothing rather than blocking the write.
 */
export async function activeCliEnvSelectors(
  options: RefreshActiveCliEnvPointerOptions = {},
): Promise<ActiveCliEnvSelectors> {
  const claudeStore = options.claudeStore ?? nativeClaudeProfileStore;
  const grokStore = options.grokStore ?? nativeGrokProfileStore;
  const selectors: ActiveCliEnvSelectors = {};
  const claudeDefault = await claudeStore
    .snapshot()
    .then((snapshot) => snapshot.defaultProfileId)
    .catch(() => null);
  if (claudeDefault && isClaudeCliManagedProfileId(claudeDefault)) {
    selectors.claudeConfigDir = claudeCliManagedProfileConfigDir(claudeStore.rootDir, claudeDefault);
  }
  const grokDefault = await grokStore
    .snapshot()
    .then((snapshot) => snapshot.defaultProfileId)
    .catch(() => null);
  if (grokDefault && isGrokCliManagedProfileId(grokDefault)) {
    selectors.grokHome = grokCliManagedProfilePaths(grokStore.rootDir, grokDefault).homeDir;
  }
  return selectors;
}

/** Re-derive the pointer from the current defaults and write it. */
export async function refreshActiveCliEnvPointer(
  options: RefreshActiveCliEnvPointerOptions = {},
): Promise<void> {
  const selectors = await activeCliEnvSelectors(options);
  await writeActiveCliEnvPointer(selectors, options);
}

/** Test seam: forget the last revision so a suite can start from a clean clock. */
export function resetActiveCliEnvPointerForTests(): void {
  lastRevision = 0;
  tail = Promise.resolve();
}
