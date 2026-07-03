import { promises as fsp, constants as fsc } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { app } from "electron";

// Materializes Codara's shell-integration scripts into a stable on-disk
// location (`~/.cache/spark/shell-integration/`) and returns the path so a
// shell can dot-source it on startup. Atomic write (tmp + rename) keeps a
// half-written file from being sourced if two pwsh shells start in parallel.
//
// Used by the bottom-strip terminal launcher in pty-manager to enrich the
// default shell with OSC 7 / 133 / 633 / 8888 sequences. Orchestration
// workers continue to use the existing shells.ts launch profile, which
// already loads spark.ps1 on Windows.

function bundledScriptDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "shell-integration")
    : join(app.getAppPath(), "resources", "shell-integration");
}

function cacheRoot(): string {
  return join(homedir(), ".cache", "spark", "shell-integration");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeIfChanged(target: string, content: string): Promise<void> {
  try {
    const existing = await fsp.readFile(target, "utf8");
    if (existing === content) return;
  } catch {
    /* file may not exist yet — fall through to the write path. */
  }
  const tmp = `${target}.__spark_tmp__`;
  await fsp.mkdir(dirname(target), { recursive: true });
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    // Cleanup the half-written tmp file so it can't be sourced. Re-throw the
    // original rename error — the caller logs and disables integration.
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function copyBundled(name: string, target: string): Promise<void> {
  const src = join(bundledScriptDir(), name);
  let content: string;
  try {
    content = await fsp.readFile(src, "utf8");
  } catch (err) {
    throw new Error(`shell-integration ${name} missing in bundle: ${(err as Error).message}`);
  }
  await writeIfChanged(target, content);
}

let preparedZsh: Promise<string | null> | null = null;
let preparedBash: Promise<string | null> | null = null;
let preparedPwsh: Promise<string | null> | null = null;

// Preparing the cache is async + idempotent. Returning null means the host
// could not stage the scripts (e.g. read-only home directory) — callers
// should fall back to launching the shell without integration.

export async function prepareZshIntegration(): Promise<string | null> {
  if (preparedZsh) return preparedZsh;
  preparedZsh = (async () => {
    if (platform() === "win32") return null;
    try {
      const dir = join(cacheRoot(), "zsh");
      await fsp.mkdir(dir, { recursive: true });
      await Promise.all([
        copyBundled("zshenv.zsh", join(dir, ".zshenv")),
        copyBundled("zprofile.zsh", join(dir, ".zprofile")),
        copyBundled("zlogin.zsh", join(dir, ".zlogin")),
        copyBundled("zshrc.zsh", join(dir, ".zshrc")),
      ]);
      return dir;
    } catch {
      return null;
    }
  })();
  return preparedZsh;
}

export async function prepareBashIntegration(): Promise<string | null> {
  if (preparedBash) return preparedBash;
  preparedBash = (async () => {
    if (platform() === "win32") return null;
    try {
      const dir = join(cacheRoot(), "bash");
      await fsp.mkdir(dir, { recursive: true });
      const rc = join(dir, "bashrc");
      await copyBundled("bashrc.bash", rc);
      return rc;
    } catch {
      return null;
    }
  })();
  return preparedBash;
}

export async function preparePwshIntegration(): Promise<string | null> {
  if (preparedPwsh) return preparedPwsh;
  preparedPwsh = (async () => {
    try {
      const dir = join(cacheRoot(), "powershell");
      await fsp.mkdir(dir, { recursive: true });
      const target = join(dir, "spark.ps1");
      await copyBundled("spark.ps1", target);
      return target;
    } catch {
      return null;
    }
  })();
  return preparedPwsh;
}

export interface IntegratedShellLaunch {
  exe: string;
  args: string[];
  env: Record<string, string>;
  family: "pwsh" | "powershell" | "bash" | "zsh" | "cmd" | "sh" | "other";
  label: string;
}

// Picks the user's default shell and returns a launch descriptor with the
// shell-integration bootstrap wired in. Called by the renderer-facing
// `terminal:open` IPC when the strip spawns a fresh interactive session.
export async function buildIntegratedShellLaunch(): Promise<IntegratedShellLaunch> {
  if (platform() === "win32") {
    return buildWindowsLaunch();
  }
  return buildUnixLaunch();
}

async function buildWindowsLaunch(): Promise<IntegratedShellLaunch> {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates: Array<{ exe: string; family: IntegratedShellLaunch["family"]; label: string }> = [
    { exe: join(programFiles, "PowerShell", "7", "pwsh.exe"), family: "pwsh", label: "PowerShell 7" },
    { exe: join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), family: "powershell", label: "Windows PowerShell" },
    { exe: join(sysRoot, "System32", "cmd.exe"), family: "cmd", label: "Command Prompt" },
  ];
  let chosen = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (await pathExists(c.exe)) {
      chosen = c;
      break;
    }
  }
  const env: Record<string, string> = { SPARK_TERMINAL: "1" };
  if (chosen.family === "pwsh" || chosen.family === "powershell") {
    const profile = await preparePwshIntegration();
    if (profile) {
      return {
        exe: chosen.exe,
        args: [
          "-NoLogo",
          "-NoExit",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          profile,
        ],
        env,
        family: chosen.family,
        label: chosen.label,
      };
    }
    return { exe: chosen.exe, args: ["-NoLogo", "-NoExit"], env, family: chosen.family, label: chosen.label };
  }
  return { exe: chosen.exe, args: [], env, family: chosen.family, label: chosen.label };
}

async function buildUnixLaunch(): Promise<IntegratedShellLaunch> {
  const env: Record<string, string> = { SPARK_TERMINAL: "1" };
  const shellEnv = process.env.SHELL;
  const shellPath = shellEnv && shellEnv.length > 0 ? shellEnv : "/bin/zsh";
  const family = detectFamily(shellPath);
  const label = shellPath.split("/").pop() ?? shellPath;

  if (family === "zsh") {
    const zdotdir = await prepareZshIntegration();
    if (zdotdir) {
      // Preserve the user's existing ZDOTDIR so our injected zshrc can
      // delegate back to their personal config — without this, users with a
      // custom ZDOTDIR (oh-my-zsh-installed-elsewhere setups) lose their
      // prompt theme on launch.
      if (process.env.ZDOTDIR) env.SPARK_USER_ZDOTDIR = process.env.ZDOTDIR;
      env.ZDOTDIR = zdotdir;
      // -l so /etc/zprofile (path_helper on macOS, /etc/profile on Linux)
      // runs and the GUI-launched shell ends up with a real PATH including
      // Homebrew / asdf / nix.
      return { exe: shellPath, args: ["-l"], env, family, label };
    }
    return { exe: shellPath, args: ["-l"], env, family, label };
  }

  if (family === "bash") {
    const rcfile = await prepareBashIntegration();
    if (rcfile) {
      // bash ignores --rcfile under -l, so we stay -i and the rcfile sources
      // /etc/profile + the user's bash_profile/bash_login/profile manually.
      return { exe: shellPath, args: ["--rcfile", rcfile, "-i"], env, family, label };
    }
    return { exe: shellPath, args: ["-i"], env, family, label };
  }

  return { exe: shellPath, args: [], env, family, label };
}

function detectFamily(exe: string): IntegratedShellLaunch["family"] {
  const name = exe.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  if (name === "fish") return "other";
  if (name === "sh") return "sh";
  if (name === "cmd.exe") return "cmd";
  if (name === "powershell.exe") return "powershell";
  if (name === "pwsh.exe" || name === "pwsh") return "pwsh";
  return "other";
}
