// Hook installer — drops Codara's Python hook script into the user's Claude
// settings (`~/.claude/settings.json`) so every Claude Code session pipes
// SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop /
// Notification / PreCompact events into a JSON file under
// <spark-home>/hooks/. The companion `hook-watcher.ts` is the consumer.
//
// Design rules
// ------------
// 1. Idempotent. Our entries are identified by their COMMAND STRING (any
//    command referencing spark-hook.py is ours) — not just by the
//    `_sparkManaged: true` / `_sparkVersion` tags we also write. Claude Code
//    rewrites ~/.claude/settings.json itself (e.g. when the user changes a
//    setting) and STRIPS unknown keys like our tags; a tag-only identity
//    check then sees "user hooks" it refuses to touch and appends a fresh
//    tagged set on every boot — which is exactly how settings files ended up
//    with N identical spark-hook entries per event. On every call we drop
//    everything that matches by command-or-tag and re-add exactly one entry
//    per event (collapsing any accumulated duplicates), leaving genuine user
//    hooks untouched. Skip the write entirely when the file already contains
//    exactly one current-shape entry per event and nothing else of ours.
// 2. Non-destructive. Other top-level keys (`env`, `permissions`,
//    `statusLine`, etc.) are preserved exactly. We only touch the `hooks`
//    object. Unknown nested keys under hooks[Event] entries we don't own
//    are untouched.
// 3. Tolerant. If `~/.claude/settings.json` is missing we create it with
//    just our hooks. If it exists but is malformed JSON, we DON'T blow it
//    away — we log and bail (better to leave the user's settings alone than
//    to truncate a file we couldn't parse).
// 4. Path-quoting. The `command` we emit is
//    `"<python>" -c "<launcher>" "<script>" <hook>`. The python path, the
//    launcher source and the script path are all shell-quoted so spaces in
//    install paths (very common on Windows / macOS) work. Hook name is a
//    static identifier so it doesn't need quoting.
// 5. Durable script path. We NEVER point Claude at whatever directory the app
//    happened to boot from. On install we copy spark-hook.py to a stable
//    per-user location (<spark-home>/claude-hooks/) and write THAT path.
//    Rationale, from a real incident: Codara was launched from a throwaway git
//    worktree, wrote the worktree path into settings, and the worktree was
//    then deleted. `python3 <deleted path>` exits 2, and exit code 2 from a
//    PreToolUse hook is Claude's "block this tool call" signal, so every
//    prompt and tool call in every Claude session was denied until the user
//    hand-edited settings.json. A copy under the user's home survives the app
//    being moved, upgraded, run from a worktree, or deleted.
// 6. Self-healing. A user in that state cannot use Claude Code to repair
//    itself, but Codara still runs. So on every install we drop spark-hook
//    entries whose script path no longer exists, INCLUDING when we cannot
//    install (missing resources, no durable destination). Repairing is
//    unconditional; installing is not.
// 7. Never poison. If the only script path we could write lives in a temp
//    directory or inside a git worktree checkout, we skip the install and log
//    why. A missing hook costs telemetry; a booby-trapped hook costs the user
//    their Claude session.
//
// The installer is fire-and-forget: failures don't block Codara startup;
// users without Claude installed (or who have hooks disabled) just lose
// the free observability — every other part of Codara keeps working.

import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import { resolveBundledResourcePath } from "./bundled-resources";
import { writeFileAtomic } from "./fs-atomic";
import { defaultSparkHome, sparkHome } from "./spark-home";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// Bumping this version forces the installer to re-write our hook entries on
// the next launch (after dropping the old ones). Use when the script path
// shape, command shape, or matcher convention changes.
const SPARK_HOOK_VERSION = "2";

// The Claude hook events we want to ingest. Order is the order we'll write
// them into the JSON, which has no semantic meaning to Claude but keeps the
// file diff stable across runs.
const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "Notification",
  "PreCompact",
] as const;

type HookEventName = (typeof HOOK_EVENTS)[number];

// Shape we emit. Claude's hook schema (per the Anthropic docs) is:
//   hooks: { [Event]: Array<{ matcher?: string, hooks: HookCommand[] }> }
// We keep matcher empty (catch-all) and emit one HookCommand per event.
interface ClaudeHookCommand {
  type: "command";
  command: string;
  _sparkManaged?: true;
  _sparkVersion?: string;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHookCommand[];
  _sparkManaged?: true;
  _sparkVersion?: string;
}

type ClaudeHookMap = Partial<Record<HookEventName, ClaudeHookEntry[]>> & {
  [key: string]: ClaudeHookEntry[] | undefined;
};

interface ClaudeSettings {
  hooks?: ClaudeHookMap;
  [key: string]: unknown;
}

// Resolve the absolute path to spark-hook.py in both development and packaged
// builds through the stable application resource root. This is the SOURCE we
// copy from, never (except as a last-resort fallback) the path we hand to
// Claude: it moves with the app.
function resolveHookScriptPath(): string {
  return resolveBundledResourcePath("claude-hooks", "spark-hook.py");
}

// The directory name we keep our durable copy of the hook script in, under
// the Codara home.
const STABLE_HOOK_DIR_NAME = "claude-hooks";

// Where the durable copy lives. Normally <spark-home>/claude-hooks, but the
// home itself can be overridden to a throwaway directory (CODARA_HOME_DIR /
// SPARK_HOME_DIR are how e2e runs and sandboxes isolate their state), and a
// throwaway destination would recreate the very bug this guards against. In
// that case fall back to the un-overridden $HOME/.Codara: the script resolves
// its OUTPUT directory from the environment at fire time, so where the file
// itself lives is independent of which home the events land in. Returns null
// when even that is transient (nothing durable to write, so don't install).
async function resolveStableScriptPath(): Promise<string | null> {
  const candidates = [sparkHome(), defaultSparkHome()];
  for (const home of candidates) {
    // resolve() because the home overrides are raw environment strings: a
    // relative one would be written into settings verbatim and then resolved
    // against Claude's cwd, which is a different directory in every session.
    const candidate = resolve(join(home, STABLE_HOOK_DIR_NAME, SPARK_HOOK_SCRIPT_FILENAME));
    if (!(await isTransientPath(candidate))) return candidate;
  }
  return null;
}

// Resolve symlinks as far as the path actually exists, then re-append the
// missing tail. Needed because the destination usually does not exist yet and
// because /tmp is a symlink to /private/tmp on macOS, so a raw prefix compare
// against os.tmpdir() would miss half the temp paths.
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

// Directories whose contents are expected to be deleted out from under us.
function temporaryRoots(): string[] {
  const roots = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP];
  if (process.platform !== "win32") {
    // macOS per-user temp lives under /var/folders (a.k.a. /private/var/folders)
    // and is reaped by the OS; /tmp and /var/tmp are the POSIX classics.
    roots.push("/tmp", "/var/tmp", "/var/folders");
  }
  return roots.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

// True when the path lives somewhere that can vanish while Claude's settings
// still reference it: a temp directory, or a git worktree checkout (worktrees
// are created and destroyed routinely by agents and by Codara itself).
async function isTransientPath(target: string): Promise<boolean> {
  const real = await realpathBestEffort(target);
  for (const root of temporaryRoots()) {
    const realRoot = await realpathBestEffort(root);
    if (isInside(real, realRoot)) return true;
  }
  return isInsideGitWorktree(real);
}

// A linked worktree marks its root with a `.git` FILE containing
// `gitdir: <repo>/.git/worktrees/<name>`, where the main checkout has a `.git`
// DIRECTORY. Walk up until we find either, so an ordinary development checkout
// (the common case, and durable) is NOT treated as transient.
//
// The walk stops at the home directory. People do manage dotfiles as a linked
// worktree checked out at $HOME, and letting that mark everything underneath
// as transient would disable the durable copy for exactly the users most
// likely to also run this app from a worktree, leaving them with no hooks at
// all. $HOME is not a directory that gets cleaned up.
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

// A linked worktree's gitdir always ends in `worktrees/<name>`. A submodule's
// ends in `modules/<name>`, which must not match even when the superproject
// itself happens to live under a directory called `worktrees`.
function isWorktreeGitFile(contents: string): boolean {
  const match = contents.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return false;
  return /[\\/]worktrees[\\/][^\\/]+$/.test(match[1]);
}

// Refresh the durable copy so it tracks the shipped script across upgrades.
// Content-compared first: rewriting an identical file every boot is pointless
// churn, and the rename would race any hook that is mid-execution. The write
// itself is atomic for the same reason. Returns false when the copy could not
// be made (read-only home, full disk), which sends the caller down the
// fallback path rather than pointing Claude at a file that isn't there.
async function syncStableHookScript(source: string, destination: string): Promise<boolean> {
  try {
    const desired = await fs.readFile(source, "utf8");
    let current: string | null = null;
    try {
      current = await fs.readFile(destination, "utf8");
    } catch {
      current = null;
    }
    if (current !== desired) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await writeFileAtomic(destination, desired);
    }
    try {
      // Not strictly needed (we always invoke it through the python binary)
      // but a hook script that can't be run by hand is confusing to debug.
      await fs.chmod(destination, 0o755);
    } catch {
      // chmod is a no-op or unsupported on some Windows filesystems.
    }
    return true;
  } catch (err) {
    console.warn(
      "[hook-installer] could not copy spark-hook.py to",
      destination,
      ":",
      (err as Error).message,
    );
    return false;
  }
}

// isFile rather than exists: the launcher runs the script only when
// os.path.isfile is true, so a directory sitting at the script path is
// indistinguishable from a missing one at hook time. Treating it as present
// would install a permanent no-op that the repair pass could never spot.
async function isExistingFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

// Decide which absolute path Claude should invoke. Preference order:
//   1. the durable copy (refreshed from the app's bundled resources),
//   2. the durable copy left by an earlier boot, whether the app's own
//      resources went missing or the refresh failed. A stale copy of a script
//      that has been careful never to fail is worth far more than a path that
//      an app upgrade will delete: electron-builder installs into a versioned
//      directory, so falling back to the install path after one bad boot
//      (disk full, permissions) would arm the original bug,
//   3. the bundled resource in place, but ONLY when it is durable, which
//      preserves the pre-copy behaviour for a normal installation whose home
//      directory we could not write to,
//   4. nothing: repair what is there and install no new entries.
async function resolveTargetScriptPath(
  sourcePath: string,
  stablePath: string | null,
): Promise<{ path: string } | { path: null; reason: string }> {
  const sourceExists = await isExistingFile(sourcePath);
  if (stablePath !== null) {
    if (sourceExists && (await syncStableHookScript(sourcePath, stablePath))) {
      return { path: stablePath };
    }
    if (await isExistingFile(stablePath)) {
      return { path: stablePath };
    }
  }
  if (!sourceExists) {
    return { path: null, reason: `spark-hook.py not found at ${sourcePath}` };
  }
  if (await isTransientPath(sourcePath)) {
    return {
      path: null,
      reason: `refusing to install a hook pointing at the transient path ${sourcePath}`,
    };
  }
  return { path: sourcePath };
}

// Resolve the python executable. Prefer `python3` (most POSIX systems have
// only python3 on PATH — modern macOS ships no bare `python` at all), fall
// back to `python` (Windows installer default and the Microsoft Store stub).
// We DON'T verify the binary exists here — the failure surface is "the hook
// command errors when fired" which Claude logs to its own debug surface.
// Trying to probe at install time would double the startup cost (fork/exec
// on every launch) for marginal benefit. Exported so the per-run hook config
// in claude-backend uses the SAME decision — hardcoding `python` there broke
// every Talk/Execute turn on macOS (Stop hook → "python: command not found"
// → no turn-done marker → turns only ended on the 90s timeout).
export function resolvePythonBinary(): string {
  return process.platform === "win32" ? "python" : "python3";
}

// Shell-quote a single argument so paths with spaces survive. Claude shells
// the command out through the system shell, which differs per platform, and
// the settings file we write is only ever read on the machine that wrote it,
// so quote for the local shell rather than for a lowest common denominator.
function shellQuote(value: string): string {
  // Windows: cmd.exe does not process backslash escapes, so double-quoting is
  // all we have (and a raw double-quote cannot appear in an NTFS path).
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  // POSIX: a double-quoted string still expands `$` and backticks, and the
  // script path is now derived from the user's home directory, so a home
  // containing either would silently resolve to the wrong file. Escape the
  // four characters that survive double quotes. The settings file we write is
  // per-machine, so quoting for the local shell is correct.
  return `"${value.replace(/([\\$`"])/g, "\\$1")}"`;
}

// Defence in depth on top of the durable copy: run the script THROUGH a tiny
// python launcher instead of handing its path to the interpreter directly.
// `python3 <missing file>` exits 2, and exit 2 from a PreToolUse hook is
// Claude's "block this tool call" signal, so a script that disappears denies
// every tool call. The launcher turns that into a silent no-op (exit 0), which
// costs telemetry instead of costing the user their session.
//
// sys.path discipline, which is the whole reason this is not a naive one
// liner. Two ways the user's project can get onto the hook's import path:
// `python -c CODE` prepends the CURRENT DIRECTORY, and Claude runs hooks with
// the cwd set to the user's project; and PYTHONPATH (`PYTHONPATH=src` out of
// a .envrc is ordinary in Python repos) is inherited from the user's
// environment. Either way a `json.py`, `uuid.py`, `datetime.py` or `runpy.py`
// there is imported ahead of the standard library, which runs arbitrary repo
// code on every tool call and re-creates the exit-2 deny when that code
// fails. So drop both before importing anything the project could shadow:
// the empty (cwd) entry goes first using only the `sys` builtin, then `os`,
// then the cwd and every PYTHONPATH entry by resolved path.
//
// Removing exactly those entries, rather than everything under the cwd, is
// deliberate: pyenv and uv keep their interpreters under $HOME, so a user
// whose project IS $HOME would otherwise lose the standard library too
// (measured: `import runpy` then fails and the hook is a silent no-op).
//
// Deliberately NOT using the interpreter's own `-I`, which would do the same
// job: an interpreter that does not recognise an option exits 2, and 2 is the
// deny code. `resolvePythonBinary` returns bare `python` on Windows, which is
// not guaranteed to be a version that has `-I` (3.4+). Trading a certain
// no-op for a possible machine-wide deny is the wrong direction, and the
// filter needs no support from the interpreter. Verified separately that a
// `sitecustomize.py` in the cwd does not run under `-c` either way, so `-I`
// buys nothing here.
//
// Portability notes, because this string is re-parsed by a shell:
//   - No shell conditionals. `[ -f x ] && ...` would be POSIX-only, and this
//     app ships on Windows.
//   - No double quotes, `$`, `%`, `^`, `&`, `|`, `<`, `>`, `!` or backticks in
//     the payload, so neither /bin/sh nor cmd.exe rewrites it. Single quotes
//     are inert inside a double-quoted argument for both. (PowerShell would
//     additionally need a `&` call operator before the quoted interpreter
//     path, which is true of the command shape this replaced as well.)
//   - `python -c CODE a b` sets argv to ['-c', a, b]; dropping element 0 hands
//     the script the argv it expects (script path, then hook name).
const HOOK_LAUNCHER_CODE =
  "import sys; sys.path[:]=[d for d in sys.path if d]; import os; " +
  "b=set(os.path.realpath(e) for e in (os.environ.get('PYTHONPATH') or '').split(os.pathsep) if e); " +
  "b.add(os.path.realpath(os.getcwd())); " +
  "sys.path[:]=[d for d in sys.path if os.path.realpath(d) not in b]; " +
  "import runpy; p=sys.argv[1]; sys.argv=sys.argv[1:]; " +
  "os.path.isfile(p) and runpy.run_path(p, run_name='__main__')";

function buildHookCommand(python: string, scriptPath: string, hookName: HookEventName): ClaudeHookCommand {
  // Pass hook name as a single positional argument. The script reads stdin
  // for the JSON payload Claude pipes in.
  return {
    type: "command",
    command:
      `${shellQuote(python)} -c ${shellQuote(HOOK_LAUNCHER_CODE)} ` +
      `${shellQuote(scriptPath)} ${hookName}`,
    _sparkManaged: true,
    _sparkVersion: SPARK_HOOK_VERSION,
  };
}

function buildHookEntry(python: string, scriptPath: string, hookName: HookEventName): ClaudeHookEntry {
  return {
    // Empty matcher = catch-all. PreToolUse/PostToolUse can be filtered by
    // tool name via matcher; we want everything, so leave it out.
    hooks: [buildHookCommand(python, scriptPath, hookName)],
    _sparkManaged: true,
    _sparkVersion: SPARK_HOOK_VERSION,
  };
}

// Read existing settings. Returns null when the file is absent OR malformed.
// On malformed we log and bail upstream (rather than overwriting user data).
async function readExistingSettings(
  settingsPath: string,
): Promise<{ settings: ClaudeSettings | null; raw: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, raw: null };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[hook-installer] ${settingsPath} is not a JSON object; refusing to overwrite`,
      );
      return { settings: null, raw };
    }
    return { settings: parsed as ClaudeSettings, raw };
  } catch (err) {
    console.warn(
      `[hook-installer] ${settingsPath} parse failed; refusing to overwrite:`,
      (err as Error).message,
    );
    return { settings: null, raw };
  }
}

// The basename that identifies our hook command regardless of install
// location (dev repo, packaged resourcesPath, a moved checkout). Command-
// string identity survives Claude Code stripping our `_sparkManaged` /
// `_sparkVersion` tags when IT rewrites the settings file.
const SPARK_HOOK_SCRIPT_FILENAME = "spark-hook.py";

// Pull the script path back out of a command string so we can tell a live
// entry from a dead one. Handles both command shapes we have ever emitted
// (`"python" "<script>" <hook>` and `"python" -c "<launcher>" "<script>"
// <hook>`) plus unquoted variants written by hand.
// Returns every path the command could plausibly mean: the quoted token as
// written, and the same token with shellQuote's POSIX escaping undone. Both,
// rather than a guess, because the two readings differ (`C:\Users\...` on
// Windows vs `\$HOME` on POSIX) and the caller PRUNES on the answer. Guessing
// the authoring platform would delete a live hook off a settings.json that
// was written on the other one, which WSL and synced dotfiles both produce.
function extractHookScriptCandidates(command: string): string[] {
  // A backslash is an escape only in front of a character shellQuote escapes.
  // Anywhere else it is an ordinary Windows separator: treating `\s` as an
  // escape pair would swallow the `s` of `\spark-hook.py` and never match a
  // Windows path at all.
  const quoted = command.match(/"((?:[^"\\]|\\[\\$`"]|\\(?=[^\\$`"]))*spark-hook\.py)"/);
  if (quoted) {
    const raw = quoted[1];
    const unescaped = raw.replace(/\\([\\$`"])/g, "$1");
    return unescaped === raw ? [raw] : [raw, unescaped];
  }
  const bare = command.match(/(\S*spark-hook\.py)/);
  return bare ? [bare[1]] : [];
}

// Absolute on ANY platform, not just this one. A `C:\...` path read on POSIX
// is not path.isAbsolute() there, but it is not a relative path either: it can
// never resolve, so it is provably dead and safe to prune. Only genuinely
// relative paths, which resolve against Claude's cwd, stay off limits.
function looksAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

// The reading that matches the local platform, for diagnostics and tests.
function extractHookScriptPath(command: string): string | null {
  const candidates = extractHookScriptCandidates(command);
  if (candidates.length === 0) return null;
  return process.platform === "win32" ? candidates[0] : candidates[candidates.length - 1];
}

// A command is ours when it carries our tag OR its command string references
// spark-hook.py (tag-stripped survivors from a CC rewrite, and entries
// written by older Codara builds from a different install path).
function isSparkHookCommand(cmd: unknown): boolean {
  if (cmd === null || typeof cmd !== "object") return false;
  const record = cmd as ClaudeHookCommand;
  if (record._sparkManaged === true) return true;
  return (
    typeof record.command === "string" &&
    record.command.includes(SPARK_HOOK_SCRIPT_FILENAME)
  );
}

// An entry is ours when it's tagged or when it carries at least one of our
// commands. (An entry the user manually merged one of our commands into is
// handled command-by-command in stripSparkEntries, not dropped wholesale.)
function entryHasSparkCommand(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as ClaudeHookEntry;
  if (record._sparkManaged === true) return true;
  return Array.isArray(record.hooks) && record.hooks.some((cmd) => isSparkHookCommand(cmd));
}

// Strip every entry we previously authored from the hooks map — matched by
// tag OR by command string, so untagged duplicates left behind by Claude
// Code's own settings rewrites are collapsed too. Returns a fresh map that
// contains only the user's own entries.
function stripSparkEntries(hooks: ClaudeHookMap | undefined): ClaudeHookMap {
  const out: ClaudeHookMap = {};
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const keep = entries
      .filter((entry): entry is ClaudeHookEntry => entry !== null && typeof entry === "object")
      .filter((entry) => entry._sparkManaged !== true)
      .map((entry) => {
        // Strip our hook commands from any user-shared entry. We keep the
        // entry only if it still has commands of the user's own.
        if (!Array.isArray(entry.hooks)) return entry;
        const remainingCommands = entry.hooks.filter((cmd) => !isSparkHookCommand(cmd));
        if (remainingCommands.length === 0) return null;
        if (remainingCommands.length === entry.hooks.length) return entry;
        return { ...entry, hooks: remainingCommands };
      })
      .filter((entry): entry is ClaudeHookEntry => entry !== null);
    if (keep.length > 0) {
      out[event] = keep;
    }
  }
  return out;
}

// Drop every spark-hook command whose script path is gone, and any entry left
// with no commands. This is the rescue path: a user whose settings point at a
// deleted checkout has a Claude Code that denies every tool call, so they
// cannot fix it with Claude, but Codara still boots and can fix it for them.
// Runs even when we have nothing to install, which is exactly the case where
// the old code returned early and left them stuck.
//
// Conservative on purpose: an entry whose path we cannot read out of the
// command string, or whose path is relative (resolution would depend on
// Claude's cwd), is left alone. We only remove what we can prove is dead.
async function pruneDeadSparkEntries(
  hooks: ClaudeHookMap | undefined,
): Promise<{ hooks: ClaudeHookMap; removed: string[] }> {
  const out: ClaudeHookMap = {};
  const removed: string[] = [];
  if (!hooks || typeof hooks !== "object") return { hooks: out, removed };

  const existsCache = new Map<string, boolean>();
  const scriptExists = async (path: string): Promise<boolean> => {
    const cached = existsCache.get(path);
    if (cached !== undefined) return cached;
    const found = await isExistingFile(path);
    existsCache.set(path, found);
    return found;
  };
  // Returns the missing script path when the command is a dead hook of ours,
  // null when it is live, not ours, or not provably dead. A command is dead
  // only when NONE of its readings resolves to a file: half a percent of
  // certainty is not enough to justify deleting a hook that works.
  const deadScriptPath = async (cmd: unknown): Promise<string | null> => {
    if (!isSparkHookCommand(cmd)) return null;
    const command = (cmd as ClaudeHookCommand).command;
    if (typeof command !== "string") return null;
    const candidates = extractHookScriptCandidates(command).filter((c) => looksAbsolute(c));
    if (candidates.length === 0) return null;
    for (const candidate of candidates) {
      if (await scriptExists(candidate)) return null;
    }
    return candidates[candidates.length - 1];
  };

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      // Not a shape we understand. The install path drops these; the rescue
      // path must not, because it runs against users we have already broken
      // once and it is not here to tidy their file.
      out[event] = entries;
      continue;
    }
    const keep: ClaudeHookEntry[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") {
        keep.push(entry);
        continue;
      }
      if (!Array.isArray(entry.hooks)) {
        keep.push(entry);
        continue;
      }
      const survivors: ClaudeHookCommand[] = [];
      for (const cmd of entry.hooks) {
        const dead = await deadScriptPath(cmd);
        if (dead !== null) {
          removed.push(dead);
          continue;
        }
        survivors.push(cmd);
      }
      if (survivors.length === entry.hooks.length) {
        keep.push(entry);
        continue;
      }
      // An entry that only ever held a dead command of ours goes away with it.
      if (survivors.length > 0) keep.push({ ...entry, hooks: survivors });
    }
    // An empty array the USER wrote stays: this pass repairs, it does not tidy.
    // An empty array WE created by removing the last dead entry is our own
    // litter, so it goes.
    if (keep.length === 0 && entries.length > 0) continue;
    out[event] = keep;
  }
  return { hooks: out, removed };
}

// Check whether the existing hooks already contain EXACTLY our current set:
// one spark entry per event, each with exactly our current command string,
// and no stray spark commands anywhere else (duplicates, retired events,
// stale install paths all fail this and trigger the strip-and-rewrite).
// Deliberately does NOT require our `_sparkManaged`/`_sparkVersion` tags:
// Claude Code strips unknown keys when it rewrites the settings file, and
// re-writing just to restore cosmetic tags would churn the file every boot.
// When a tag DID survive, a version mismatch still forces a reinstall.
function alreadyInstalled(
  hooks: ClaudeHookMap | undefined,
  scriptPath: string,
  python: string,
): boolean {
  if (!hooks) return false;
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) return false;
    const sparkEntries = entries.filter((entry) => entryHasSparkCommand(entry));
    // 0 = missing, >1 = duplicates: either way, rewrite.
    if (sparkEntries.length !== 1) return false;
    const ours = sparkEntries[0];
    if (ours._sparkVersion !== undefined && ours._sparkVersion !== SPARK_HOOK_VERSION) {
      return false;
    }
    // Must be purely ours with a single command — a user-merged entry gets
    // disentangled by the rewrite (their commands stay, ours re-added
    // standalone).
    if (!Array.isArray(ours.hooks) || ours.hooks.length !== 1) return false;
    const cmd = ours.hooks[0];
    if (cmd === null || typeof cmd !== "object") return false;
    if (cmd._sparkVersion !== undefined && cmd._sparkVersion !== SPARK_HOOK_VERSION) {
      return false;
    }
    // Exact command equality — covers script relocation (dev → packaged),
    // python launcher changes, and any future command-shape change.
    if (cmd.command !== buildHookCommand(python, scriptPath, event).command) {
      return false;
    }
  }
  // No spark leftovers under events we no longer manage.
  for (const [event, entries] of Object.entries(hooks)) {
    if ((HOOK_EVENTS as readonly string[]).includes(event)) continue;
    if (!Array.isArray(entries)) continue;
    if (entries.some((entry) => entryHasSparkCommand(entry))) return false;
  }
  return true;
}

// Write the settings file, skipping a bit-identical write. Two-space indent
// matches Claude's own default settings file style so diffs in version
// control / dotfile repos stay clean.
//
// The write lands on the file's REAL path: a Codara-managed account shares
// settings.json with the personal ~/.claude through a symlink (see
// native-cli-shared-state.ts), and writeFileAtomic's rename-over would
// replace that link with a private copy, silently forking the two accounts'
// settings. readExistingSettings already follows the link on the read side.
async function persistSettings(
  settingsPath: string,
  next: ClaudeSettings,
  raw: string | null,
): Promise<void> {
  try {
    const payload = JSON.stringify(next, null, 2);
    if (raw !== null && raw === payload) return;
    const targetPath = await fs.realpath(settingsPath).catch(() => settingsPath);
    await fs.mkdir(dirname(targetPath), { recursive: true });
    await writeFileAtomic(targetPath, payload);
  } catch (err) {
    console.warn("[hook-installer] failed to write", settingsPath, ":", err);
  }
}

// Test seams. Production always calls installClaudeHooks() with no arguments;
// the overrides exist so the tests can never touch the developer's real
// ~/.claude/settings.json, which drives their live Claude session.
export interface HookInstallOverrides {
  settingsPath?: string;
  sourceScriptPath?: string;
  // null means "no durable destination", the same signal resolveStableScriptPath
  // produces when every candidate home is transient.
  stableScriptPath?: string | null;
}

// Public API. Idempotent and non-throwing: the caller should still await and log
// any rejection just in case, but normal operation always resolves.
export async function installClaudeHooks(overrides: HookInstallOverrides = {}): Promise<void> {
  const settingsPath = overrides.settingsPath ?? CLAUDE_SETTINGS_PATH;
  const sourcePath = overrides.sourceScriptPath ?? resolveHookScriptPath();
  const stablePath =
    overrides.stableScriptPath !== undefined
      ? overrides.stableScriptPath
      : await resolveStableScriptPath();

  const { settings, raw } = await readExistingSettings(settingsPath).catch((err) => {
    console.warn("[hook-installer] failed to read", settingsPath, ":", err);
    return { settings: null as ClaudeSettings | null, raw: null as string | null };
  });
  if (settings === null) {
    // Read failed unexpectedly OR settings malformed, already logged. We
    // can't repair a file we couldn't parse without risking the user's data.
    return;
  }

  const target = await resolveTargetScriptPath(sourcePath, stablePath);
  if (target.path === null) {
    // Nothing safe to install. Still repair: leaving a dead hook in place
    // blocks every tool call in every Claude session on this machine.
    console.warn(`[hook-installer] ${target.reason}, repairing existing entries only`);
    const { hooks: repaired, removed } = await pruneDeadSparkEntries(settings.hooks);
    if (removed.length === 0) return;
    console.warn(
      "[hook-installer] removed",
      removed.length,
      "dead hook entries pointing at:",
      [...new Set(removed)].join(", "),
    );
    await persistSettings(settingsPath, { ...settings, hooks: repaired }, raw);
    return;
  }

  const scriptPath = target.path;
  const python = resolvePythonBinary();
  if (alreadyInstalled(settings.hooks, scriptPath, python)) {
    return;
  }

  // The rewrite is itself the repair for anything dead: stripSparkEntries
  // drops every command of ours regardless of which path it pointed at, and
  // the loop below re-adds exactly one live entry per event.
  const userHooks = stripSparkEntries(settings.hooks);
  const merged: ClaudeHookMap = { ...userHooks };
  for (const event of HOOK_EVENTS) {
    const existing = merged[event] ?? [];
    merged[event] = [...existing, buildHookEntry(python, scriptPath, event)];
  }

  await persistSettings(settingsPath, { ...settings, hooks: merged }, raw);
}

// Test/diagnostic helpers — exported so future ipc handlers can surface
// "are hooks installed?" status without re-implementing the parse logic.
export const __test = {
  CLAUDE_SETTINGS_PATH,
  HOOK_EVENTS,
  HOOK_LAUNCHER_CODE,
  SPARK_HOOK_VERSION,
  STABLE_HOOK_DIR_NAME,
  resolveHookScriptPath,
  resolvePythonBinary,
  resolveStableScriptPath,
  shellQuote,
  buildHookCommand,
  extractHookScriptPath,
  isTransientPath,
  pruneDeadSparkEntries,
  stripSparkEntries,
  alreadyInstalled,
};
