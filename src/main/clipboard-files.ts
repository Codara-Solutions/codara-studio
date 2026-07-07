import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Windows file-clipboard interop (real CF_HDROP) via Windows PowerShell's
// clipboard cmdlets. Electron's clipboard.readBuffer/writeBuffer only handles
// custom registered formats reliably, not the predefined CF_HDROP, so files
// copied in Windows Explorer are invisible to it — while
// `Get-Clipboard -Format FileDropList` / `Set-Clipboard -Path` read/write the
// genuine article with no native addon.
//
// IMPORTANT: this must spawn `powershell.exe` (Windows PowerShell 5.1).
// PowerShell 7+ (pwsh) REMOVED both -Format FileDropList and -Path — verified
// on this machine: the same commands fail under pwsh and succeed under 5.1.
//
// Both helpers fail soft (null/false): the renderer keeps an in-app clipboard
// as the fallback source of truth, so a locked-down machine without
// powershell.exe still gets working in-app copy/paste.
const PS_OPTS = { windowsHide: true, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 } as const;

export async function readClipboardFilePaths(): Promise<string[] | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
      ],
      PS_OPTS,
    );
    const paths = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return paths.length > 0 ? paths : null;
  } catch {
    return null;
  }
}

export async function writeClipboardFilePaths(paths: string[]): Promise<boolean> {
  if (process.platform !== "win32" || paths.length === 0) return false;
  try {
    // Single-quoted PS string literals; embedded quotes doubled. Paths come
    // from our own fs layer (no user-typed shell input), this is belt+braces.
    const args = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Path ${args}`],
      PS_OPTS,
    );
    return true;
  } catch {
    return false;
  }
}
