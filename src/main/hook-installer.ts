// Claude hook commands for the sessions Codara starts. Codara passes them to
// each launch through `claude --settings <codaraHome>/integrations/claude/
// settings.json` (agent-launch-integration.ts); nothing is written into the
// user's own Claude settings, so a `claude` started outside Codara runs
// without them. The hooks pipe SessionStart / PreToolUse / PostToolUse /
// UserPromptSubmit / Stop / Notification / PreCompact events into JSON files
// under <codara-home>/hooks/, and hook-watcher.ts consumes them.
//
// Rules kept from the days these hooks lived in ~/.claude/settings.json:
// 1. Path quoting. The command is `"<python>" -c "<launcher>" "<script>"
//    <hook>`, every part shell-quoted for the local shell so spaces in
//    install paths work.
// 2. Durable script path. The command points at a copy of codara-hook.py
//    under the Codara home, never at the directory the app booted from, so
//    an upgrade or a deleted worktree cannot leave a session pointing at a
//    missing file mid-run.
// 3. Never block. A missing script exits 0 through the launcher, because
//    exit 2 from a PreToolUse hook is Claude's "block this tool call" signal.
//
// The command strings of every shape older builds wrote into the user's
// settings are recognized here too (isGeneratedHookCommand), so the one-time
// cleanup in global-config-cleanup.ts can remove exactly those and nothing
// the user wrote.

import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { resolveBundledResourcePath } from "./bundled-resources";
import { temporaryRoots } from "./temporary-roots";
import { writeFileAtomic } from "./fs-atomic";
import { codaraHome } from "./codara-home";

const CODARA_HOOK_SCRIPT_FILENAME = "codara-hook.py";
const LEGACY_HOOK_SCRIPT_FILENAME = "spark-hook.py";
const STABLE_HOOK_DIR_NAME = "claude-hooks";

// The Claude hook events Codara ingests. Order is the order they are written,
// which keeps the generated file stable across boots.
export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
  "Notification",
  "PreCompact",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface ClaudeHookCommand {
  type: "command";
  command: string;
}

export interface ClaudeHookSettings {
  hooks: Record<HookEventName, Array<{ hooks: ClaudeHookCommand[] }>>;
}

// Resolve symlinks as far as the path actually exists, then re-append the
// missing tail. /tmp is a symlink to /private/tmp on macOS, so a raw prefix
// compare against os.tmpdir() would miss half the temp paths.
async function realpathBestEffort(target: string): Promise<string> {
  const absolute = resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await realpathBestEffort(parent), basename(absolute));
  }
}

function isInside(child: string, parent: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const rel = relative(normalize(parent), normalize(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// True when the path lives somewhere that can vanish while a config that
// outlives this process still references it: a temp directory, or a git
// worktree checkout. The opt-in global MCP install refuses such paths.
export async function isTransientPath(target: string): Promise<boolean> {
  const real = await realpathBestEffort(target);
  for (const root of temporaryRoots()) {
    const realRoot = await realpathBestEffort(root);
    if (isInside(real, realRoot)) return true;
  }
  return isInsideGitWorktree(real);
}

// A linked worktree marks its root with a `.git` FILE pointing at
// `<repo>/.git/worktrees/<name>`; the main checkout has a `.git` DIRECTORY.
// The walk stops at the home directory, which people do check out as a
// dotfiles worktree and which never gets cleaned up.
async function isInsideGitWorktree(target: string): Promise<boolean> {
  const stopAt = await realpathBestEffort(homedir());
  let current = dirname(target);
  for (;;) {
    if (current === stopAt) return false;
    const dotGit = join(current, ".git");
    try {
      const stat = await fs.stat(dotGit);
      if (stat.isDirectory()) return false;
      if (stat.isFile()) return isWorktreeGitFile(await fs.readFile(dotGit, "utf8"));
    } catch {
      // No .git here; keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// A submodule's gitdir ends in `modules/<name>` and must not match.
function isWorktreeGitFile(contents: string): boolean {
  const match = contents.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return false;
  return /[\\/]worktrees[\\/][^\\/]+$/.test(match[1]);
}

// `python3` on POSIX (modern macOS ships no bare `python`), `python` on
// Windows. Not probed: a missing interpreter only costs the hook events.
export function resolvePythonBinary(): string {
  return process.platform === "win32" ? "python" : "python3";
}

// Quote for the local shell Claude runs hooks through. POSIX double quotes
// still expand `$` and backticks, so the four characters that survive them
// are escaped; cmd.exe has no backslash escapes and NTFS paths hold no `"`.
function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `"${value.replace(/([\\$`"])/g, "\\$1")}"`;
}

// Run the script through a tiny launcher instead of handing its path to the
// interpreter: `python3 <missing file>` exits 2, which Claude reads as "block
// this tool call". The launcher also drops the cwd and PYTHONPATH entries
// from sys.path before importing anything a project could shadow (Claude
// runs hooks in the project's directory, and `-c` puts that on the path),
// and leaves before any work when the session is not in a Codara pane.
// The payload holds no double quotes, `$`, `%`, `^`, `&`, `|`, `<`, `>`, `!`
// or backticks, so neither /bin/sh nor cmd.exe rewrites it.
const HOOK_LAUNCHER_CODE =
  "import sys; sys.path[:]=[d for d in sys.path if d]; import os; " +
  "os.environ.get('SPARK_PANE_ID') or sys.exit(0); " +
  "b=set(os.path.realpath(e) for e in (os.environ.get('PYTHONPATH') or '').split(os.pathsep) if e); " +
  "b.add(os.path.realpath(os.getcwd())); " +
  "sys.path[:]=[d for d in sys.path if os.path.realpath(d) not in b]; " +
  "import runpy; p=sys.argv[1]; sys.argv=sys.argv[1:]; " +
  "os.path.isfile(p) and runpy.run_path(p, run_name='__main__')";

// The launcher builds before the SPARK_PANE_ID guard existed. Only used to
// recognize what those builds wrote into the user's settings.
const LEGACY_HOOK_LAUNCHER_CODE = HOOK_LAUNCHER_CODE.replace(
  "os.environ.get('SPARK_PANE_ID') or sys.exit(0); ",
  "",
);

export function buildHookCommand(
  python: string,
  scriptPath: string,
  hookName: HookEventName,
): ClaudeHookCommand {
  return {
    type: "command",
    command:
      `${shellQuote(python)} -c ${shellQuote(HOOK_LAUNCHER_CODE)} ` +
      `${shellQuote(scriptPath)} ${hookName}`,
  };
}

/** The `--settings` file content: hooks only, one catch-all entry per event. */
export function claudeHookSettings(python: string, scriptPath: string): ClaudeHookSettings {
  const hooks = {} as ClaudeHookSettings["hooks"];
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [buildHookCommand(python, scriptPath, event)] }];
  }
  return { hooks };
}

/** Where the durable copy of codara-hook.py lives. */
export function stableHookScriptPath(home: string = codaraHome()): string {
  return resolve(join(home, STABLE_HOOK_DIR_NAME, CODARA_HOOK_SCRIPT_FILENAME));
}

/**
 * Refresh the durable copy from the app's resources. Content-compared first,
 * because the rename would race a hook that is mid-execution. Returns the
 * path when a copy is in place (a stale copy from an earlier boot counts),
 * or null when there is nothing to point Claude at.
 */
export async function ensureHookScript(
  options: { source?: string; destination?: string } = {},
): Promise<string | null> {
  const source = options.source ?? resolveBundledResourcePath("claude-hooks", CODARA_HOOK_SCRIPT_FILENAME);
  const destination = options.destination ?? stableHookScriptPath();
  try {
    const desired = await fs.readFile(source, "utf8");
    const current = await fs.readFile(destination, "utf8").catch(() => null);
    if (current !== desired) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await writeFileAtomic(destination, desired);
    }
    await fs.chmod(destination, 0o755).catch(() => undefined);
    return destination;
  } catch (err) {
    console.warn("[hook-installer] could not copy codara-hook.py:", (err as Error).message);
    const stats = await fs.stat(destination).catch(() => null);
    return stats?.isFile() ? destination : null;
  }
}

// ---------------------------------------------------------------------------
// What older builds wrote into the user's settings.
// ---------------------------------------------------------------------------

// Pull the script path back out of a command string. The quoted token is
// returned as written and with shellQuote's POSIX escaping undone, because
// the two readings differ between Windows and POSIX and a settings file can
// travel between them (WSL, synced dotfiles).
export function extractHookScriptCandidates(command: string): string[] {
  const quoted = command.match(/"((?:[^"\\]|\\[\\$`"]|\\(?=[^\\$`"]))*(?:codara|spark)-hook\.py)"/);
  if (quoted) {
    const raw = quoted[1];
    const unescaped = raw.replace(/\\([\\$`"])/g, "$1");
    return unescaped === raw ? [raw] : [raw, unescaped];
  }
  const bare = command.match(/(\S*(?:codara|spark)-hook\.py)/);
  return bare ? [bare[1]] : [];
}

// Every quoting older builds used: the current one, and the first builds'
// escape-only-double-quotes form.
function historicQuotes(value: string): string[] {
  return [...new Set([shellQuote(value), `"${value.replace(/"/g, '\\"')}"`])];
}

function isCodaraHookScriptPath(path: string): boolean {
  const name = basename(path.replace(/\\/g, "/"));
  if (name !== CODARA_HOOK_SCRIPT_FILENAME && name !== LEGACY_HOOK_SCRIPT_FILENAME) return false;
  return basename(dirname(path.replace(/\\/g, "/"))) === STABLE_HOOK_DIR_NAME;
}

/**
 * True when `command` is byte-for-byte a hook command some Codara build
 * generated: `"<python>" "<script>" <Event>` or `"<python>" -c "<launcher>"
 * "<script>" <Event>`, with python being `python` or `python3`, the launcher
 * one of the two Codara shipped, and the script a codara-hook.py or
 * spark-hook.py inside a `claude-hooks` directory. Anything a user typed or
 * edited fails the comparison and is left alone.
 */
export function isGeneratedHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const event = /\s([A-Za-z]+)$/.exec(command)?.[1];
  if (!event) return false;
  for (const script of extractHookScriptCandidates(command)) {
    if (!isCodaraHookScriptPath(script)) continue;
    for (const python of ["python3", "python"]) {
      for (const quotedPython of historicQuotes(python)) {
        for (const quotedScript of historicQuotes(script)) {
          if (command === `${quotedPython} ${quotedScript} ${event}`) return true;
          for (const launcher of [HOOK_LAUNCHER_CODE, LEGACY_HOOK_LAUNCHER_CODE]) {
            for (const quotedLauncher of historicQuotes(launcher)) {
              if (command === `${quotedPython} -c ${quotedLauncher} ${quotedScript} ${event}`) return true;
            }
          }
        }
      }
    }
  }
  return false;
}

export const __test = {
  HOOK_LAUNCHER_CODE,
  LEGACY_HOOK_LAUNCHER_CODE,
  STABLE_HOOK_DIR_NAME,
  shellQuote,
  isInsideGitWorktree,
};
