// The Windows setup script: every line of a step in one .cmd file, so a `cd`
// or a `set` on one line is still in effect on the next, the way it is in the
// POSIX script. Pure, so scripts/test-worktree-setup.cjs checks it everywhere.

// cmd's own commands: `call` is for programs and batch files, and does not
// take these.
const CMD_BUILTINS = new Set([
  "assoc", "break", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal", "erase",
  "exit", "for", "goto", "if", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "pushd", "rd", "rem",
  "ren", "rename", "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
]);

/** The non-empty, non-comment lines of a setup command. */
export function setupLines(command: string): string[] {
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function needsCall(line: string): boolean {
  const first = /^[("@\s]*([^\s"&|<>()^,;=]+)/.exec(line)?.[1]?.toLowerCase() ?? "";
  if (!first || first.startsWith(":")) return false;
  // `cd..` and `cd\` are cd too.
  const word = first.replace(/[.\\/].*$/, "");
  return !CMD_BUILTINS.has(first) && !CMD_BUILTINS.has(word);
}

/**
 * The text of the .cmd file. A command that is itself a batch file (npm,
 * yarn, pnpm, composer ship as .cmd) never gives control back to a script
 * unless it is `call`ed, so a line that starts with a program is called. Each
 * line is followed by an errorlevel check that stops the script with that
 * code; `if errorlevel 1` would miss negative codes, so the value is compared
 * as text. `chcp 65001` lets a path like C:\Users\Étienne survive: the file is
 * written as UTF-8 without a BOM, which cmd would read as part of the first
 * command.
 *
 * Differences from typing a line at a prompt: `%%` is `%`, a `for` variable is
 * written `%%i`, and `call` reads `^` and `%` a second time. A line that
 * chains a batch file after another command (`cd app && npm ci`) starts with a
 * builtin, so it is not called and npm.cmd ends the script: put such steps on
 * their own lines.
 */
export function buildCmdScript(lines: readonly string[]): string {
  const out = ["@echo off", "chcp 65001 >nul"];
  for (const line of lines) {
    out.push(needsCall(line) ? `call ${line}` : line);
    out.push('if not "%errorlevel%"=="0" exit /b %errorlevel%');
  }
  out.push("exit /b 0");
  return `${out.join("\r\n")}\r\n`;
}
