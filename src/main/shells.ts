import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import type { ShellInfo } from "@shared/types";

function shellIntegrationPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "shell-integration", name)
    : join(__dirname, "..", "..", "resources", "shell-integration", name);
}

// PowerShell single-quoted strings escape ' as ''. Anything else is literal,
// so backslashes in Windows paths are safe.
function pwshSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const execFileAsync = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectWindows(): Promise<ShellInfo[]> {
  const out: ShellInfo[] = [];
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFiles86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LocalAppData || join(process.env.UserProfile || "", "AppData", "Local");

  // -NoExit -Command runs after $PROFILE loads, then drops to the interactive
  // prompt. We disable PSReadLine predictions (matches a stock terminal) and
  // dot-source spark.ps1, which installs OSC 133 / 633 boundary markers so the
  // BlockStrip can group output into per-command blocks.
  const sparkPs1 = shellIntegrationPath("spark.ps1");
  const pwshStartup = [
    "Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue",
    `if (Test-Path ${pwshSingleQuote(sparkPs1)}) { . ${pwshSingleQuote(sparkPs1)} }`,
  ].join("; ");
  const pwshArgs = ["-NoLogo", "-NoExit", "-Command", pwshStartup];
  const candidates: Array<Omit<ShellInfo, "id"> & { id?: string }> = [
    {
      label: "PowerShell 7",
      exe: join(programFiles, "PowerShell", "7", "pwsh.exe"),
      args: pwshArgs,
      family: "pwsh",
    },
    {
      label: "PowerShell 7 (x86)",
      exe: join(programFiles86, "PowerShell", "7", "pwsh.exe"),
      args: pwshArgs,
      family: "pwsh",
    },
    {
      label: "Windows PowerShell",
      exe: join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: pwshArgs,
      family: "powershell",
    },
    {
      label: "Command Prompt",
      exe: join(sysRoot, "System32", "cmd.exe"),
      args: [],
      family: "cmd",
    },
    {
      label: "Git Bash",
      exe: join(programFiles, "Git", "bin", "bash.exe"),
      args: ["--login", "-i"],
      family: "bash",
    },
    {
      label: "WSL",
      exe: join(sysRoot, "System32", "wsl.exe"),
      args: [],
      family: "wsl",
    },
  ];

  // VS Code-style PowerShell 7 from store/local install
  const userPwsh = join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe");
  candidates.push({
    label: "PowerShell 7 (user)",
    exe: userPwsh,
    args: pwshArgs,
    family: "pwsh",
  });

  for (const exe of await where("pwsh")) {
    candidates.push({
      label: "PowerShell 7",
      exe,
      args: pwshArgs,
      family: "pwsh",
    });
  }

  for (const c of candidates) {
    if (await exists(c.exe)) {
      out.push({ ...c, id: c.exe });
    }
  }
  const userPwshKey = normalizeWindowsPath(userPwsh);
  const hasRealPwsh = out.some(
    (s) => s.family === "pwsh" && normalizeWindowsPath(s.exe) !== userPwshKey,
  );

  // Dedupe by exe path (case-insensitive on Windows). Hide the WindowsApps
  // per-user pwsh alias when a real PowerShell 7 install is present; otherwise
  // the shell picker shows both "PowerShell 7" and "PowerShell 7 (user)" even
  // though they launch the same Store-installed pwsh.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = normalizeWindowsPath(s.exe);
    if (hasRealPwsh && key === userPwshKey) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

async function where(command: string): Promise<string[]> {
  if (platform() !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function detectUnix(): Promise<ShellInfo[]> {
  const out: ShellInfo[] = [];
  const tried = new Set<string>();
  const familyOf = (exe: string): ShellInfo["family"] => {
    const n = basename(exe);
    if (n === "bash") return "bash";
    if (n === "zsh") return "zsh";
    if (n === "fish") return "fish";
    if (n === "sh") return "sh";
    return "other";
  };
  const labelOf = (exe: string): string => basename(exe);

  // Read /etc/shells
  try {
    const raw = await fs.readFile("/etc/shells", "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (await exists(trimmed)) {
        if (tried.has(trimmed)) continue;
        tried.add(trimmed);
        out.push({
          id: trimmed,
          label: labelOf(trimmed),
          exe: trimmed,
          args: [],
          family: familyOf(trimmed),
        });
      }
    }
  } catch {
    /* ignore */
  }

  // Common fallbacks
  for (const exe of ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash", "/usr/bin/fish", "/bin/sh"]) {
    if (tried.has(exe)) continue;
    if (await exists(exe)) {
      tried.add(exe);
      out.push({
        id: exe,
        label: labelOf(exe),
        exe,
        args: [],
        family: familyOf(exe),
      });
    }
  }

  return out;
}

let cache: ShellInfo[] | null = null;

export async function listShells(): Promise<ShellInfo[]> {
  if (cache) return cache;
  cache = platform() === "win32" ? await detectWindows() : await detectUnix();
  return cache;
}

export async function defaultShell(): Promise<ShellInfo | null> {
  const shells = await listShells();
  if (shells.length === 0) return null;
  // Prefer pwsh > powershell > cmd on Windows, $SHELL > zsh > bash on unix
  if (platform() === "win32") {
    return (
      shells.find((s) => s.family === "pwsh") ??
      shells.find((s) => s.family === "powershell") ??
      shells.find((s) => s.family === "cmd") ??
      shells[0]
    );
  }
  const fromEnv = process.env.SHELL;
  if (fromEnv) {
    const match = shells.find((s) => s.exe === fromEnv);
    if (match) return match;
  }
  return (
    shells.find((s) => s.family === "zsh") ??
    shells.find((s) => s.family === "bash") ??
    shells[0]
  );
}
