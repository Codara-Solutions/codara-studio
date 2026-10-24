import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  isClaudeCliManagedProfileId,
  type ClaudeCliAccountProfileStore,
} from "./claude-cli-account-profiles";
import {
  codaraActiveCliEnvPointerFile,
  codaraHomeDir,
  CODARA_CLAUDE_CLI_DIRNAME,
  CODARA_CODEX_CLI_DIRNAME,
  CODARA_GROK_CLI_DIRNAME,
} from "./codara-managed-cli-roots";
import {
  codexCliManagedProfilePaths,
  isCodexCliManagedProfileId,
  type CodexCliAccountProfileStore,
} from "./codex-cli-account-profiles";
import {
  grokCliManagedProfilePaths,
  isGrokCliManagedProfileId,
  type GrokCliAccountProfileStore,
} from "./grok-cli-account-profiles";
import { nativeClaudeProfileStore } from "./native-claude-profile-runtime";
import { atomicWritePrivateFile } from "./native-cli-atomic-file";
import { nativeCodexProfileStore } from "./native-codex-profile-runtime";
import { nativeGrokProfileStore } from "./native-grok-profile-runtime";

/**
 * The pointer a running plain Studio shell follows to the active account:
 * <codaraHome>/shell/active-cli-env, rewritten by main on every default
 * change. The bundled prompt hooks re-read it when its revision changed and
 * export or unset CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME accordingly,
 * never a value outside Codara's directory for that CLI.
 *
 * The file is data, deliberately not shell syntax: no shell ever sources it
 * and no line of it is a shell export. Its format is
 *
 *   codara-active-cli-env 2 <revision>
 *   CLAUDE_CONFIG_DIR=<the Claude live slot>
 *   CODEX_HOME=<absolute managed home>
 *   GROK_HOME=<absolute managed home>
 *
 * with the header first, then at most one line per CLI. A CLI on the System
 * login omits its line (absence is the value): the hook unsets what it set,
 * and the CLI uses its own home as in any other terminal app. The hooks
 * accept version 1 files too; the header version is informational. The revision
 * strictly increases on every write, so a shell that missed an intermediate
 * switch still converges on the next prompt. It lives under shell/, never
 * under the retired active pointer directory, which boot deletes and the
 * managed-root check treats as managed.
 */

export const ACTIVE_CLI_ENV_HEADER_WORD = "codara-active-cli-env";
export const ACTIVE_CLI_ENV_FORMAT_VERSION = 2;

export interface ActiveCliEnvSelectors {
  /** The Claude live slot while a managed Claude account is Active. */
  claudeConfigDir?: string;
  /** Managed CODEX_HOME for the Active Codex account. */
  codexHome?: string;
  /** Managed GROK_HOME for the Active Grok account. */
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
  const resolvedChild = resolve(child).normalize("NFC");
  const resolvedParent = resolve(parent).normalize("NFC");
  const inner = process.platform === "win32" ? resolvedChild.toLowerCase() : resolvedChild;
  const outer = process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent;
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** Only a directory inside Codara's own directory for its CLI is written. */
function managedValue(
  value: string | undefined,
  homeDir: string,
  root: string,
): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return isInside(value, resolve(homeDir, root)) ? resolve(value) : null;
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
  const codex = managedValue(selectors.codexHome, homeDir, join(CODARA_CODEX_CLI_DIRNAME, "accounts"));
  if (codex) lines.push(`CODEX_HOME=${codex}`);
  const grok = managedValue(selectors.grokHome, homeDir, join(CODARA_GROK_CLI_DIRNAME, "accounts"));
  if (grok) lines.push(`GROK_HOME=${grok}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Write the pointer with a fresh revision. Writes are serialized, and a
 * selector function is evaluated inside that serialization: the read
 * behind write N then always follows write N-1, so revision order is state
 * order even when two refreshes overlap (every default change in the
 * startup pass fires one, and each store read is a fresh disk read).
 */
export function writeActiveCliEnvPointer(
  selectors: ActiveCliEnvSelectors | (() => Promise<ActiveCliEnvSelectors>),
  options: WriteActiveCliEnvPointerOptions = {},
): Promise<void> {
  const run = tail.then(async () => {
    const resolved = typeof selectors === "function" ? await selectors() : selectors;
    const homeDir = resolve(options.homeDir ?? codaraHomeDir());
    const pointerFile = options.pointerFile ?? codaraActiveCliEnvPointerFile(homeDir);
    // A revision equal to the last one written would read as "unchanged"
    // to a hook; two writes in the same millisecond still advance it.
    let revision = options.now?.() ?? Date.now();
    if (revision <= lastRevision) revision = lastRevision + 1;
    lastRevision = revision;
    await fs.mkdir(dirname(pointerFile), { recursive: true, mode: 0o700 });
    await atomicWritePrivateFile(pointerFile, formatActiveCliEnvPointer(resolved, revision, homeDir));
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RefreshActiveCliEnvPointerOptions extends WriteActiveCliEnvPointerOptions {
  claudeStore?: Pick<ClaudeCliAccountProfileStore, "liveConfigDir" | "snapshot">;
  codexStore?: Pick<CodexCliAccountProfileStore, "rootDir" | "snapshot">;
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
  const codexStore = options.codexStore ?? nativeCodexProfileStore;
  const grokStore = options.grokStore ?? nativeGrokProfileStore;
  const defaultOf = (store: { snapshot(): Promise<{ defaultProfileId: string }> }) =>
    store
      .snapshot()
      .then((snapshot) => snapshot.defaultProfileId)
      .catch(() => null);
  const [claudeDefault, codexDefault, grokDefault] = await Promise.all([
    defaultOf(claudeStore),
    defaultOf(codexStore),
    defaultOf(grokStore),
  ]);
  const selectors: ActiveCliEnvSelectors = {};
  if (claudeDefault && isClaudeCliManagedProfileId(claudeDefault)) {
    selectors.claudeConfigDir = claudeStore.liveConfigDir;
  }
  if (codexDefault && isCodexCliManagedProfileId(codexDefault)) {
    selectors.codexHome = codexCliManagedProfilePaths(codexStore.rootDir, codexDefault).homeDir;
  }
  if (grokDefault && isGrokCliManagedProfileId(grokDefault)) {
    selectors.grokHome = grokCliManagedProfilePaths(grokStore.rootDir, grokDefault).homeDir;
  }
  return selectors;
}

/** Re-derive the pointer from the current defaults and write it. */
export async function refreshActiveCliEnvPointer(
  options: RefreshActiveCliEnvPointerOptions = {},
): Promise<void> {
  await writeActiveCliEnvPointer(() => activeCliEnvSelectors(options), options);
}
