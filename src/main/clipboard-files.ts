import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// File-clipboard interop with the real OS clipboard, so files copied in the
// native file manager show up when pasting into the in-app explorer and vice
// versa. Two platform backends, both fail soft:
//
// Windows — CF_HDROP via Windows PowerShell's clipboard cmdlets. Electron's
// clipboard.readBuffer/writeBuffer only handles custom registered formats
// reliably, not the predefined CF_HDROP, so files copied in Windows Explorer
// are invisible to it — while `Get-Clipboard -Format FileDropList` /
// `Set-Clipboard -Path` read/write the genuine article with no native addon.
//   IMPORTANT: this must spawn `powershell.exe` (Windows PowerShell 5.1).
//   PowerShell 7+ (pwsh) REMOVED both -Format FileDropList and -Path — verified
//   on this machine: the same commands fail under pwsh and succeed under 5.1.
//
// macOS — real NSPasteboard file URLs (public.file-url), the same thing Finder
// reads and writes, via osascript's AppleScript-ObjC AppKit bridge (no native
// addon). Paths are passed as `on run argv` arguments, never interpolated into
// the script, so spaces/quotes/unicode need no escaping. Two subtleties:
//   - writes spin the run loop briefly after writeObjects:. A short-lived
//     osascript process otherwise exits before AppKit flushes the second and
//     later pasteboard items, so a reader in another process (Finder, or our
//     own next osascript) sees only the first file.
//   - reads pass NSPasteboardURLReadingFileURLsOnlyKey so a plain-text
//     clipboard is never misread as file URLs (a non-file clipboard yields
//     zero paths → null).
//
// Both helpers fail soft (null/false): the renderer keeps an in-app clipboard
// as the fallback source of truth, so a locked-down machine without
// powershell.exe / osascript still gets working in-app copy/paste.
const PS_OPTS = { windowsHide: true, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 } as const;
const OSA_OPTS = { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 } as const;

// AppleScript-ObjC: print the POSIX path of every file URL on the general
// pasteboard, one per line. FileURLsOnly keeps a plain-text clipboard from
// being read as URLs; a non-file clipboard produces no lines.
const OSA_READ = `use framework "AppKit"
use scripting additions
on run argv
set pb to current application's NSPasteboard's generalPasteboard()
set opts to (current application's NSDictionary's dictionaryWithObject:(current application's NSNumber's numberWithBool:true) forKey:(current application's NSPasteboardURLReadingFileURLsOnlyKey))
set theURLs to (pb's readObjectsForClasses:{current application's NSURL} options:opts)
if theURLs is missing value then return ""
set out to ""
repeat with i from 1 to count of theURLs
set out to out & ((item i of theURLs)'s |path|() as text) & linefeed
end repeat
return out
end run`;

// AppleScript-ObjC: replace the general pasteboard with the argv paths as file
// URLs. The run-loop spin lets AppKit flush every item before osascript exits
// (see header). Prints OK only when writeObjects: reports success.
const OSA_WRITE = `use framework "AppKit"
use scripting additions
on run argv
set pb to current application's NSPasteboard's generalPasteboard()
pb's clearContents()
set urls to {}
repeat with i from 1 to count of argv
set end of urls to (current application's NSURL's fileURLWithPath:(item i of argv))
end repeat
set ok to (pb's writeObjects:urls)
(current application's NSRunLoop's currentRunLoop()'s runUntilDate:(current application's NSDate's dateWithTimeIntervalSinceNow:0.3))
if ok then return "OK"
return "FAIL"
end run`;

export async function readClipboardFilePaths(): Promise<string[] | null> {
  if (process.platform === "win32") {
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
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", OSA_READ], OSA_OPTS);
      const paths = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return paths.length > 0 ? paths : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function writeClipboardFilePaths(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  if (process.platform === "win32") {
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
  if (process.platform === "darwin") {
    try {
      // Paths go after `--` and arrive via `on run argv` — never interpolated
      // into the script, so no quoting/escaping and no injection surface.
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", OSA_WRITE, "--", ...paths],
        OSA_OPTS,
      );
      return stdout.trim() === "OK";
    } catch {
      return false;
    }
  }
  return false;
}
