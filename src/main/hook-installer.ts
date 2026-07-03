// Hook installer — drops Codara's Python hook script into the user's Claude
// settings (`~/.claude/settings.json`) so every Claude Code session pipes
// SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop /
// Notification / PreCompact events into a JSON file under
// <spark-home>/hooks/. The companion `hook-watcher.ts` is the consumer.
//
// Design rules
// ------------
// 1. Idempotent. We tag every entry we write with `_sparkManaged: true` plus
//    a `_sparkVersion` token. On a second call we replace just our own
//    entries (drop everything where `_sparkManaged === true`, re-add the
//    current set) so the user's hand-rolled hooks stay put. Skip the write
//    entirely if the file already contains our entries at the current
//    version.
// 2. Non-destructive. Other top-level keys (`env`, `permissions`,
//    `statusLine`, etc.) are preserved exactly. We only touch the `hooks`
//    object. Unknown nested keys under hooks[Event] entries we don't own
//    are untouched.
// 3. Tolerant. If `~/.claude/settings.json` is missing we create it with
//    just our hooks. If it exists but is malformed JSON, we DON'T blow it
//    away — we log and bail (better to leave the user's settings alone than
//    to truncate a file we couldn't parse).
// 4. Path-quoting. The `command` we emit is `"<python>" "<script>" <hook>`.
//    Both the python path and script path are shell-quoted so spaces in
//    install paths (very common on Windows / macOS) work. Hook name is a
//    static identifier so it doesn't need quoting.
//
// The installer is fire-and-forget: failures don't block Codara startup;
// users without Claude installed (or who have hooks disabled) just lose
// the free observability — every other part of Codara keeps working.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./fs-atomic";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// Bumping this version forces the installer to re-write our hook entries on
// the next launch (after dropping the old ones). Use when the script path
// shape, command shape, or matcher convention changes.
const SPARK_HOOK_VERSION = "1";

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

// Resolve the absolute path to spark-hook.py in both dev and packaged builds.
//   dev:      __dirname is out/main/, script lives in repo at resources/claude-hooks
//   packaged: extraResources are copied to process.resourcesPath/claude-hooks
function resolveHookScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "claude-hooks", "spark-hook.py");
  }
  // Out path in dev is out/main/, source at resources/claude-hooks at repo root.
  return join(__dirname, "..", "..", "resources", "claude-hooks", "spark-hook.py");
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

// Shell-quote a single argument so paths with spaces survive. The command
// string Claude executes is shelled out via a system shell on each platform,
// so this is plain POSIX-style quoting (we wrap in double-quotes and escape
// any embedded double-quote). On Windows `cmd.exe` accepts double-quotes the
// same way for executable + argument paths, so the same form works there.
function shellQuote(value: string): string {
  // Double-quote and escape any inner double-quote with a backslash. This is
  // good enough for filesystem paths (which can't contain raw double-quotes
  // on Windows anyway and are vanishingly rare on POSIX).
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildHookCommand(python: string, scriptPath: string, hookName: HookEventName): ClaudeHookCommand {
  // Pass hook name as a single positional argument. The script reads stdin
  // for the JSON payload Claude pipes in.
  return {
    type: "command",
    command: `${shellQuote(python)} ${shellQuote(scriptPath)} ${hookName}`,
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
async function readExistingSettings(): Promise<{ settings: ClaudeSettings | null; raw: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_SETTINGS_PATH, "utf8");
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
        "[hook-installer] ~/.claude/settings.json is not a JSON object; refusing to overwrite",
      );
      return { settings: null, raw };
    }
    return { settings: parsed as ClaudeSettings, raw };
  } catch (err) {
    console.warn(
      "[hook-installer] ~/.claude/settings.json parse failed; refusing to overwrite:",
      (err as Error).message,
    );
    return { settings: null, raw };
  }
}

// Strip every entry we previously authored from the hooks map, returning a
// fresh map that contains only the user's own entries. Mutates a copy of
// the input map (caller passes us a freshly-cloned object).
function stripSparkEntries(hooks: ClaudeHookMap | undefined): ClaudeHookMap {
  const out: ClaudeHookMap = {};
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const keep = entries
      .filter((entry): entry is ClaudeHookEntry => entry !== null && typeof entry === "object")
      .filter((entry) => entry._sparkManaged !== true)
      .map((entry) => {
        // Also strip our hook commands from any user-shared entry (very
        // unlikely path — user manually merged ours into theirs — but the
        // schema allows it). We keep the entry if it still has commands.
        if (!Array.isArray(entry.hooks)) return entry;
        const remainingCommands = entry.hooks.filter(
          (cmd) => cmd !== null && typeof cmd === "object" && cmd._sparkManaged !== true,
        );
        if (remainingCommands.length === 0) return null;
        return { ...entry, hooks: remainingCommands };
      })
      .filter((entry): entry is ClaudeHookEntry => entry !== null);
    if (keep.length > 0) {
      out[event] = keep;
    }
  }
  return out;
}

// Check whether the existing hooks already contain our entries at the
// current version. Used to skip the rewrite (no atime/mtime churn) when
// nothing's changed.
function alreadyInstalled(hooks: ClaudeHookMap | undefined, scriptPath: string): boolean {
  if (!hooks) return false;
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) return false;
    const ours = entries.find((entry) => entry?._sparkManaged === true);
    if (!ours) return false;
    if (ours._sparkVersion !== SPARK_HOOK_VERSION) return false;
    if (!Array.isArray(ours.hooks)) return false;
    const cmd = ours.hooks.find((c) => c?._sparkManaged === true);
    if (!cmd) return false;
    // Verify the command still references the current script path so we
    // re-install if Codara moved (dev → packaged install, etc).
    if (typeof cmd.command !== "string" || !cmd.command.includes(scriptPath)) {
      return false;
    }
  }
  return true;
}

// Public API. Idempotent and non-throwing — caller should still await + log
// any rejection just in case, but normal operation always resolves.
export async function installClaudeHooks(): Promise<void> {
  const scriptPath = resolveHookScriptPath();

  // Verify the script we'll point Claude at actually exists. If it doesn't
  // (asar packaging glitch, repo moved, etc) we don't want to install hooks
  // that fail on every fire and spam Claude's debug log.
  try {
    await fs.access(scriptPath);
  } catch (err) {
    console.warn(
      "[hook-installer] spark-hook.py not found at",
      scriptPath,
      "— skipping install:",
      (err as Error).message,
    );
    return;
  }

  const { settings, raw } = await readExistingSettings().catch((err) => {
    console.warn("[hook-installer] failed to read ~/.claude/settings.json:", err);
    return { settings: null as ClaudeSettings | null, raw: null as string | null };
  });
  if (settings === null) {
    // Read failed unexpectedly OR settings malformed — already logged.
    return;
  }

  if (alreadyInstalled(settings.hooks, scriptPath)) {
    return;
  }

  const python = resolvePythonBinary();
  const userHooks = stripSparkEntries(settings.hooks);
  const merged: ClaudeHookMap = { ...userHooks };
  for (const event of HOOK_EVENTS) {
    const existing = merged[event] ?? [];
    merged[event] = [...existing, buildHookEntry(python, scriptPath, event)];
  }

  const nextSettings: ClaudeSettings = { ...settings, hooks: merged };

  try {
    await fs.mkdir(join(homedir(), ".claude"), { recursive: true });
    // Two-space indent matches Claude's own default settings file style so
    // diffs in version control / dotfile repos stay clean.
    const payload = JSON.stringify(nextSettings, null, 2);
    if (raw !== null && raw === payload) {
      // Bit-identical write would be a no-op; skip the disk hit.
      return;
    }
    await writeFileAtomic(CLAUDE_SETTINGS_PATH, payload);
  } catch (err) {
    console.warn("[hook-installer] failed to write ~/.claude/settings.json:", err);
  }
}

// Test/diagnostic helpers — exported so future ipc handlers can surface
// "are hooks installed?" status without re-implementing the parse logic.
export const __test = {
  CLAUDE_SETTINGS_PATH,
  HOOK_EVENTS,
  SPARK_HOOK_VERSION,
  resolveHookScriptPath,
  resolvePythonBinary,
  shellQuote,
  stripSparkEntries,
  alreadyInstalled,
};
