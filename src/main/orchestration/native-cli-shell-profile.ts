import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../fs-atomic";

/**
 * One-time, consent-gated shell setup for the Active CLI account.
 *
 * The user clicks a button in Settings → Accounts; only then is a marked block
 * appended to their shell startup file. The block never contains account paths
 * of its own — it sources the env file that native-cli-active-pointer.ts
 * regenerates — so switching accounts later never touches the profile again,
 * and removing the feature is a pure block deletion.
 *
 * Nothing here reads a credential; it edits exactly one shell startup file,
 * atomically, after keeping a one-time backup of the original.
 */

export const NATIVE_CLI_SHELL_BLOCK_BEGIN = "# >>> codara active cli account >>>";
export const NATIVE_CLI_SHELL_BLOCK_END = "# <<< codara active cli account <<<";
export const NATIVE_CLI_SHELL_BACKUP_SUFFIX = ".codara-backup";

export type NativeCliShellKind = "zsh" | "bash";

export interface NativeCliShellProfileStatus {
  /** False on Windows and for shells this setup cannot write safely. */
  supported: boolean;
  installed: boolean;
  shell?: NativeCliShellKind;
  profilePath?: string;
  /** Exact block that install would append, for the UI to show up front. */
  snippet: string;
  /** Present when the shell is unsupported: what the user can do by hand. */
  manualInstruction?: string;
}

export interface NativeCliShellProfileOptions {
  /** The generated file from native-cli-active-pointer.ts. */
  envFile: string;
  /** Test seams; production reads $SHELL and the real home directory. */
  shell?: string;
  homeDir?: string;
}

function detectShell(options: NativeCliShellProfileOptions): NativeCliShellKind | null {
  const raw = (options.shell ?? process.env.SHELL ?? "").trim();
  if (!raw) return null;
  const name = basename(raw).toLowerCase();
  if (name === "zsh" || name === "-zsh") return "zsh";
  if (name === "bash" || name === "-bash") return "bash";
  return null;
}

function profileFor(shell: NativeCliShellKind, home: string): string {
  return shell === "zsh" ? join(home, ".zshrc") : join(home, ".bashrc");
}

/**
 * Keep the snippet readable in the user's own dotfile: paths under the home
 * directory are written as "$HOME/…" rather than a hard-coded absolute path.
 */
function shellPath(target: string, home: string): string {
  const absolute = resolve(target);
  const root = `${resolve(home)}${sep}`;
  return absolute.startsWith(root)
    ? `"$HOME/${absolute.slice(root.length)}"`
    : `'${absolute.replace(/'/g, `'\\''`)}'`;
}

export function renderNativeCliShellBlock(
  envFile: string,
  home: string = homedir(),
): string {
  const quoted = shellPath(envFile, home);
  return [
    NATIVE_CLI_SHELL_BLOCK_BEGIN,
    "# Added by Codara Studio (Settings → Accounts). Points this shell's Claude",
    "# Code / Codex CLI at the account marked Active. Remove this block, or turn",
    "# the setting off in Codara Studio, to go back to your own login.",
    `if [ -f ${quoted} ]; then`,
    `  . ${quoted}`,
    "fi",
    NATIVE_CLI_SHELL_BLOCK_END,
  ].join("\n");
}

function blockPattern(): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\n*${escape(NATIVE_CLI_SHELL_BLOCK_BEGIN)}[\\s\\S]*?${escape(
      NATIVE_CLI_SHELL_BLOCK_END,
    )}\\n?`,
    "g",
  );
}

/**
 * Where the block actually has to be written.
 *
 * writeFileAtomic renames a temporary file over its target, which would
 * replace a symlinked startup file (stow, chezmoi, a dotfiles repo) with a
 * regular file and sever the link. So follow the link first and write through
 * to the file it names. A link that resolves to nothing — a loop, or a target
 * that does not exist — is left alone and reported instead.
 */
async function resolveProfileTarget(
  profilePath: string,
): Promise<{ target: string | null; reason?: string }> {
  const link = await fs.lstat(profilePath).catch(() => null);
  if (!link) return { target: profilePath };
  if (!link.isSymbolicLink()) {
    if (!link.isFile()) {
      return {
        target: null,
        reason: `${profilePath} is not a regular file, so Codara left it untouched.`,
      };
    }
    return { target: profilePath };
  }
  try {
    return { target: await fs.realpath(profilePath) };
  } catch {
    return {
      target: null,
      reason:
        `${profilePath} is a symbolic link that does not lead to a file, so ` +
        `Codara left it untouched.`,
    };
  }
}

function manualLine(envFile: string, home: string): string {
  return `Add this line to your shell's startup file to get the same result:\n. ${shellPath(
    envFile,
    home,
  )}`;
}

/** Preserve the user's own permissions; only a brand-new file gets a default. */
async function profileMode(path: string): Promise<number> {
  try {
    const stats = await fs.stat(path);
    return stats.mode & 0o777;
  } catch {
    return 0o644;
  }
}

async function readProfile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function nativeCliShellProfileStatus(
  options: NativeCliShellProfileOptions,
): Promise<NativeCliShellProfileStatus> {
  const home = options.homeDir ?? homedir();
  const snippet = renderNativeCliShellBlock(options.envFile, home);
  if (process.platform === "win32") {
    return {
      supported: false,
      installed: false,
      snippet,
      manualInstruction:
        "Windows shells are not set up automatically yet. Set CLAUDE_CONFIG_DIR " +
        "and CODEX_HOME yourself if you want a terminal to follow the Active account.",
    };
  }
  const shell = detectShell(options);
  if (!shell) {
    return {
      supported: false,
      installed: false,
      snippet,
      manualInstruction:
        `Codara can only edit .zshrc and .bashrc automatically. ` +
        manualLine(options.envFile, home),
    };
  }
  const profilePath = profileFor(shell, home);
  const contents = (await readProfile(profilePath)) ?? "";
  const installed = contents.includes(NATIVE_CLI_SHELL_BLOCK_BEGIN);
  const resolved = await resolveProfileTarget(profilePath);
  if (!resolved.target) {
    return {
      supported: false,
      installed,
      shell,
      profilePath,
      snippet,
      manualInstruction: `${resolved.reason} ${manualLine(options.envFile, home)}`,
    };
  }
  return {
    supported: true,
    installed,
    shell,
    profilePath,
    snippet,
  };
}

/**
 * Append the block. Idempotent: an existing block is replaced in place, so a
 * repeated install never stacks duplicates and always ends at the current
 * wording.
 */
export async function installNativeCliShellProfile(
  options: NativeCliShellProfileOptions,
): Promise<NativeCliShellProfileStatus> {
  const status = await nativeCliShellProfileStatus(options);
  if (!status.supported || !status.profilePath) return status;
  const home = options.homeDir ?? homedir();
  const { target } = await resolveProfileTarget(status.profilePath);
  if (!target) return { ...status, supported: false };
  const original = await readProfile(target);
  if (original !== null) {
    // One backup only: the first edit preserves the user's untouched file, and
    // later installs must not overwrite it with already-modified content.
    const backup = `${status.profilePath}${NATIVE_CLI_SHELL_BACKUP_SUFFIX}`;
    try {
      await fs.access(backup);
    } catch {
      await writeFileAtomic(backup, original, {
        mode: await profileMode(target),
      });
    }
  }
  const stripped = (original ?? "").replace(blockPattern(), "\n").trimEnd();
  const block = renderNativeCliShellBlock(options.envFile, home);
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  await writeFileAtomic(target, next, {
    mode: await profileMode(target),
  });
  return { ...status, installed: true };
}

/** Remove the block and nothing else. The backup is deliberately left behind. */
export async function uninstallNativeCliShellProfile(
  options: NativeCliShellProfileOptions,
): Promise<NativeCliShellProfileStatus> {
  const status = await nativeCliShellProfileStatus(options);
  if (!status.supported || !status.profilePath) return status;
  const { target } = await resolveProfileTarget(status.profilePath);
  if (!target) return { ...status, supported: false };
  const original = await readProfile(target);
  if (original === null) return { ...status, installed: false };
  const stripped = original.replace(blockPattern(), "\n");
  if (stripped !== original) {
    const next = stripped.trimEnd();
    await writeFileAtomic(target, next ? `${next}\n` : "", {
      mode: await profileMode(target),
    });
  }
  return { ...status, installed: false };
}
