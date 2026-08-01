import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syncDirectory, writeFileAtomic } from "../fs-atomic";
import {
  claudeCliManagedProfileConfigDir,
  CLAUDE_CLI_ACCOUNT_PROFILES_FILE,
  CLAUDE_CLI_PERSONAL_PROFILE_ID,
  codaraClaudeCliAccountRootDir,
  isClaudeCliManagedProfileId,
} from "./claude-cli-account-profiles";
import {
  codexCliManagedProfilePaths,
  CODEX_CLI_ACCOUNT_PROFILES_FILE,
  CODEX_CLI_PERSONAL_PROFILE_ID,
  codaraCodexCliAccountRootDir,
  isCodexCliManagedProfileId,
} from "./codex-cli-account-profiles";
import {
  codaraNativeCliActivePointerDir,
  NATIVE_CLI_ACTIVE_DIRNAME,
} from "./codara-managed-cli-roots";
import type { NativeCliAccountRuntime } from "./native-cli-accounts";

/**
 * The "Active account in your terminal" pointer.
 *
 * Studio already runs each native CLI against one isolated state directory by
 * setting a single selector variable — CLAUDE_CONFIG_DIR for Claude Code (see
 * buildClaudeCliProfileEnvironment) and CODEX_HOME for Codex (see
 * buildCodexCliProfileEnvironment). This module projects the *currently Active*
 * account of each runtime onto two stable paths the user's shell can follow:
 *
 *   <home>/cli/active/claude -> the Active Claude account's config directory
 *   <home>/cli/active/codex  -> the Active Codex account's CODEX_HOME
 *   <home>/cli/active/env.sh -> the exact exports a login shell should apply
 *
 * Why both a symlink and a generated env file:
 *
 *  - Codex resolves CODEX_HOME on every run, so pointing CODEX_HOME at the
 *    symlink means an already-open terminal follows an account switch live.
 *
 *  - Claude Code 2.1.220 derives its macOS Keychain service name from the
 *    *literal* CLAUDE_CONFIG_DIR string, NFC-normalized and hashed — it never
 *    resolves the symlink (`fn = Vr(() => (process.env.CLAUDE_CONFIG_DIR ??
 *    join(homedir(), ".claude")).normalize("NFC"))`, service name
 *    `Claude Code-credentials-${sha256(dir).slice(0, 8)}`). Exporting the
 *    symlink path would therefore give every account one shared credential
 *    slot that Studio itself never uses. env.sh exports the resolved account
 *    directory instead, so the terminal and the app land on the same slot.
 *
 *  - For the same reason, an Active *personal* Claude account exports nothing:
 *    Claude only omits the hash suffix when CLAUDE_CONFIG_DIR is unset, so
 *    exporting even the default ~/.claude would move the terminal to a
 *    different Keychain item and read as signed out.
 *
 * Nothing here reads, writes, copies, or refreshes a credential. It creates
 * symlinks to directories and writes one generated shell file; the CLIs own
 * everything inside those directories.
 */

export { NATIVE_CLI_ACTIVE_DIRNAME };
export const NATIVE_CLI_ACTIVE_ENV_FILE = "env.sh";

export interface NativeCliActivePointer {
  runtime: NativeCliAccountRuntime;
  /** Stable path the shell follows. */
  linkPath: string;
  /** Directory the link resolves to. */
  target: string;
  profileId: string;
  /** The stored Active account was unusable, so personal is in effect. */
  fellBackToPersonal: boolean;
  /** False when the selector must stay unset for this runtime (see above). */
  exported: boolean;
}

export interface NativeCliActivePointerState {
  supported: boolean;
  directory: string;
  envFile: string;
  pointers: NativeCliActivePointer[];
  /** Human-readable reason the pointers could not be written, if any. */
  error?: string;
}

export interface ReconcileNativeCliActivePointersOptions {
  /** Root that holds the pointer directory. Defaults to the Codara home. */
  homeDir?: string;
  claudeRootDir?: string;
  codexRootDir?: string;
  /** Test seam for the personal locations; production reads the real ones. */
  personalClaudeConfigDir?: string;
  personalCodexHomeDir?: string;
}

interface RuntimeLayout {
  runtime: NativeCliAccountRuntime;
  linkName: string;
  selectorEnv: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  listFile: string;
  personalProfileId: string;
  personalDir: string;
  managedDir: (profileId: string) => string;
  isManagedId: (value: unknown) => value is string;
}

/**
 * The CLI's own default location, deliberately independent of the current
 * process environment: Studio may itself have been launched from a shell that
 * already applies env.sh, and reading the inherited selector there would make
 * "personal" resolve to a managed account and pin the pointer to itself.
 */
function personalClaudeConfigDir(): string {
  return resolve(join(homedir(), ".claude"));
}

function personalCodexHomeDir(): string {
  return resolve(join(homedir(), ".codex"));
}

function layouts(
  options: ReconcileNativeCliActivePointersOptions,
): RuntimeLayout[] {
  const claudeRoot = options.claudeRootDir ?? codaraClaudeCliAccountRootDir();
  const codexRoot = options.codexRootDir ?? codaraCodexCliAccountRootDir();
  return [
    {
      runtime: "claude",
      linkName: "claude",
      selectorEnv: "CLAUDE_CONFIG_DIR",
      listFile: join(claudeRoot, CLAUDE_CLI_ACCOUNT_PROFILES_FILE),
      personalProfileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
      personalDir:
        options.personalClaudeConfigDir ?? personalClaudeConfigDir(),
      managedDir: (profileId) =>
        claudeCliManagedProfileConfigDir(claudeRoot, profileId),
      isManagedId: isClaudeCliManagedProfileId,
    },
    {
      runtime: "codex",
      linkName: "codex",
      selectorEnv: "CODEX_HOME",
      listFile: join(codexRoot, CODEX_CLI_ACCOUNT_PROFILES_FILE),
      personalProfileId: CODEX_CLI_PERSONAL_PROFILE_ID,
      personalDir: options.personalCodexHomeDir ?? personalCodexHomeDir(),
      managedDir: (profileId) =>
        codexCliManagedProfilePaths(codexRoot, profileId).homeDir,
      isManagedId: isCodexCliManagedProfileId,
    },
  ];
}

async function readActiveProfileId(
  listFile: string,
  personalProfileId: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(listFile, "utf8");
  } catch {
    return personalProfileId;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const value =
      parsed && typeof parsed === "object"
        ? (parsed as { defaultProfileId?: unknown }).defaultProfileId
        : undefined;
    return typeof value === "string" && value ? value : personalProfileId;
  } catch {
    return personalProfileId;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Replace the link atomically: create it under a temporary name in the same
 * directory, then rename over the old one. A pre-existing real directory or
 * file at the link path is never removed — that is user data this feature does
 * not own, so it is reported instead.
 */
async function writeSymlinkAtomic(linkPath: string, target: string): Promise<void> {
  const existing = await fs.lstat(linkPath).catch(() => null);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(
      `${linkPath} already exists and is not a symlink; leaving it untouched`,
    );
  }
  if (existing) {
    const current = await fs.readlink(linkPath).catch(() => null);
    if (current === target) return;
  }
  const tmp = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.symlink(target, tmp, "dir");
  try {
    await fs.rename(tmp, linkPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await syncDirectory(dirname(linkPath)).catch(() => undefined);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const NATIVE_CLI_SELECTOR_ENV: Readonly<
  Record<NativeCliAccountRuntime, "CLAUDE_CONFIG_DIR" | "CODEX_HOME">
> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function renderNativeCliActiveEnvFile(
  pointers: NativeCliActivePointer[],
): string {
  const lines = [
    "# Generated by Codara Studio — do not edit.",
    "# Points this shell's Claude Code / Codex CLI at the account marked Active",
    "# in Settings → Accounts. Regenerated whenever the Active account changes.",
    "",
  ];
  for (const pointer of pointers) {
    const selector = NATIVE_CLI_SELECTOR_ENV[pointer.runtime];
    if (!pointer.exported) {
      // Personal means "keep the login this terminal already had". For Claude
      // an exported selector is never equivalent to an unset one, so unset is
      // the only correct answer for both runtimes.
      lines.push(
        `# Active ${pointer.runtime} account: the login this terminal already had.`,
      );
      lines.push(`unset ${selector}`);
      lines.push("");
      continue;
    }
    if (pointer.runtime === "codex") {
      // Codex re-reads CODEX_HOME on every run, so the symlink lets an open
      // terminal follow an account switch without restarting the shell.
      lines.push(`export ${selector}=${shellQuote(pointer.linkPath)}`);
    } else {
      // Claude Code hashes this exact string into its Keychain service name,
      // so it must be the resolved account directory, not the symlink.
      lines.push(`export ${selector}=${shellQuote(pointer.target)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function nativeCliActivePointerDir(homeDir: string): string {
  return codaraNativeCliActivePointerDir(homeDir);
}

const RECONCILE_QUEUES = new Map<string, Promise<void>>();

/**
 * Bring both pointers in line with the stored Active accounts. Safe to call at
 * any time: on app start, and after every mutation that can change or remove
 * an Active account.
 *
 * Reconciles for one pointer directory run one at a time and in call order.
 * Each one re-reads the stored Active account, so serializing them is what
 * makes two rapid switches end on the newer state instead of whichever
 * interleaving happened to write its symlink last.
 */
export function reconcileNativeCliActivePointers(
  options: ReconcileNativeCliActivePointersOptions & { homeDir: string },
): Promise<NativeCliActivePointerState> {
  const directory = nativeCliActivePointerDir(options.homeDir);
  const previous = RECONCILE_QUEUES.get(directory) ?? Promise.resolve();
  const result = previous.then(() => reconcileOnce(options, directory));
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  RECONCILE_QUEUES.set(directory, settled);
  void settled.then(() => {
    if (RECONCILE_QUEUES.get(directory) === settled) {
      RECONCILE_QUEUES.delete(directory);
    }
  });
  return result;
}

async function reconcileOnce(
  options: ReconcileNativeCliActivePointersOptions & { homeDir: string },
  directory: string,
): Promise<NativeCliActivePointerState> {
  const envFile = join(directory, NATIVE_CLI_ACTIVE_ENV_FILE);
  if (process.platform === "win32") {
    // Creating a symlink on Windows needs Developer Mode or elevation, and the
    // shell-profile half of the feature is POSIX-only anyway.
    return { supported: false, directory, envFile, pointers: [] };
  }
  const runtimeLayouts = layouts(options);
  const pointers: NativeCliActivePointer[] = [];
  let error: string | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      supported: false,
      directory,
      envFile,
      pointers: [],
      error: (err as Error).message,
    };
  }
  for (const layout of runtimeLayouts) {
    const storedId = await readActiveProfileId(
      layout.listFile,
      layout.personalProfileId,
    );
    let profileId = storedId;
    let target = layout.personalDir;
    let fellBackToPersonal = false;
    if (layout.isManagedId(storedId)) {
      let managedDir: string | null = null;
      try {
        managedDir = layout.managedDir(storedId);
      } catch {
        managedDir = null;
      }
      // A deleted account leaves a dangling id in the list file until the
      // store reconciles; personal is the only safe destination meanwhile.
      if (managedDir && (await isDirectory(managedDir))) {
        target = managedDir;
      } else {
        profileId = layout.personalProfileId;
        fellBackToPersonal = true;
      }
    } else {
      profileId = layout.personalProfileId;
    }
    const linkPath = join(directory, layout.linkName);
    try {
      await writeSymlinkAtomic(linkPath, target);
    } catch (err) {
      error = error ?? (err as Error).message;
      continue;
    }
    pointers.push({
      runtime: layout.runtime,
      linkPath,
      target,
      profileId,
      fellBackToPersonal,
      exported: profileId !== layout.personalProfileId,
    });
  }
  try {
    await writeFileAtomic(envFile, renderNativeCliActiveEnvFile(pointers), {
      mode: 0o600,
    });
  } catch (err) {
    error = error ?? (err as Error).message;
  }
  return {
    supported: pointers.length > 0,
    directory,
    envFile,
    pointers,
    ...(error ? { error } : {}),
  };
}
