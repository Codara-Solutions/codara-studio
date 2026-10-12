// Codex's `notify` program is how Codara learns that a Codex turn in a
// terminal pane finished, with Codex's own last message. Codara passes it on
// each launch (`codex -c notify=[...]`, agent-launch-integration.ts) and never
// writes it into the user's config.toml. Codex runs that argv after every
// turn with the event JSON appended, so the value is a launcher for
// resources/codex-hooks/codara-codex-notify.py that carries the user's own
// notify argv after a `--` and runs it too:
//
//   notify = ["python3", "-c", "<launcher>", "<script>", "--", ...previous]
//
// Codex keeps a single notifier, so the user's own value is read (never
// written) from their effective config at boot and chained. Older builds did
// write this value into ~/.codex/config.toml; global-config-cleanup.ts puts
// the user's previous value back with the helpers below.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveBundledResourcePath } from "./bundled-resources";
import { codaraHome } from "./codara-home";
import { writeFileAtomic } from "./fs-atomic";
import { parseTomlText } from "./mcp-toml";
import { resolveCodexHomePaths } from "./orchestration/codex-home";

const SCRIPT_FILENAME = "codara-codex-notify.py";
const STABLE_DIR_NAME = "codex-hooks";
const CHAIN_SEPARATOR = "--";

// `python -c CODE script -- previous... payload`: argv[1] is the script.
// The user's project must not shadow stdlib modules (Codex runs notify in the
// session's cwd, which `-c` puts on sys.path), so the path is cleaned the way
// the Claude hook launcher does it. When the script is gone (the Codara home
// was deleted) the previous program still runs, so uninstalling Codara by
// deleting files never silences the user's own notifier.
const LAUNCHER_CODE =
  "import sys; sys.path[:]=[d for d in sys.path if d]; import os; " +
  "b=set(os.path.realpath(e) for e in (os.environ.get('PYTHONPATH') or '').split(os.pathsep) if e); " +
  "b.add(os.path.realpath(os.getcwd())); " +
  "sys.path[:]=[d for d in sys.path if os.path.realpath(d) not in b]; " +
  "a=sys.argv[1:]; p=a[0]; sys.argv=a; " +
  "import runpy; os.path.isfile(p) and (runpy.run_path(p, run_name='__main__'), sys.exit(0)); " +
  "len(a)>3 and os.execvp(a[2], a[2:])";

export function isCodaraNotifyArgv(argv: string[]): boolean {
  return argv.length >= 5 && argv[1] === "-c" && basename(argv[3]) === SCRIPT_FILENAME && argv[4] === CHAIN_SEPARATOR;
}

export function previousNotifyArgv(argv: string[] | null): string[] {
  if (!argv) return [];
  return isCodaraNotifyArgv(argv) ? argv.slice(5) : argv;
}

export function buildCodexNotifyArgv(python: string, scriptPath: string, previous: string[]): string[] {
  return [python, "-c", LAUNCHER_CODE, scriptPath, CHAIN_SEPARATOR, ...previous];
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007F");
}

function renderNotify(argv: string[]): string {
  return `notify = [${argv.map(tomlString).join(", ")}]`;
}

// Where the top-level `notify` key sits, and where the first table header
// starts. A small scanner rather than a regex: strings, comments and
// multi-line arrays can all contain `[` or `notify =`.
function scanTopLevel(text: string): { notify: { start: number; end: number } | null; firstTable: number } {
  let notify: { start: number; end: number } | null = null;
  let depth = 0;
  let lineStart = true;
  let lineStartIndex = 0;
  let pendingNotifyStart = -1;
  let i = 0;
  const skipString = (from: number): number => {
    const triple = text.startsWith('"""', from) || text.startsWith("'''", from);
    const quote = text[from];
    if (triple) {
      const close = quote.repeat(3);
      let j = from + 3;
      for (;;) {
        const at = text.indexOf(close, j);
        if (at < 0) return text.length;
        if (quote === '"' && isEscaped(text, at)) {
          j = at + 1;
          continue;
        }
        let end = at + 3;
        // """a"""" ends with up to two extra quotes inside the string.
        while (end < text.length && text[end] === quote && end - at < 5) end++;
        return end;
      }
    }
    let j = from + 1;
    while (j < text.length && text[j] !== "\n") {
      if (quote === '"' && text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === quote) return j + 1;
      j++;
    }
    return j;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
      lineStartIndex = i + 1;
      i++;
      continue;
    }
    if (lineStart && (c === " " || c === "\t" || c === "\r")) {
      i++;
      continue;
    }
    if (lineStart && depth === 0) {
      if (c === "[") return { notify, firstTable: lineStartIndex };
      const key = /^(?:notify|"notify"|'notify')[ \t]*=[ \t]*/.exec(text.slice(i, i + 64));
      if (key) {
        pendingNotifyStart = lineStartIndex;
        i += key[0].length;
        lineStart = false;
        if (text[i] !== "[") return { notify: null, firstTable: -1 };
        continue;
      }
    }
    lineStart = false;
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(i);
      continue;
    }
    if (c === "[") depth++;
    if (c === "]") {
      depth--;
      if (depth === 0 && pendingNotifyStart >= 0) {
        notify = { start: pendingNotifyStart, end: i + 1 };
        pendingNotifyStart = -1;
      }
    }
    i++;
  }
  return { notify, firstTable: text.length };
}

function isEscaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let k = at - 1; k >= 0 && text[k] === "\\"; k--) slashes++;
  return slashes % 2 === 1;
}

// Returns the new text, or null when the file cannot be edited safely.
export function setTopLevelNotify(text: string, argv: string[] | null): string | null {
  const scan = scanTopLevel(text);
  if (scan.firstTable < 0) return null;
  if (scan.notify) {
    if (argv) return text.slice(0, scan.notify.start) + renderNotify(argv) + text.slice(scan.notify.end);
    let end = scan.notify.end;
    // Drop the rest of the line (spaces, a trailing comment) and its newline.
    const nl = text.indexOf("\n", end);
    const rest = text.slice(end, nl < 0 ? text.length : nl);
    if (/^[ \t\r]*(?:#.*)?$/.test(rest)) end = nl < 0 ? text.length : nl + 1;
    return text.slice(0, scan.notify.start) + text.slice(end);
  }
  if (!argv) return text;
  const line = `${renderNotify(argv)}\n`;
  if (scan.firstTable >= text.length) {
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return `${text}${sep}${line}`;
  }
  return text.slice(0, scan.firstTable) + line + text.slice(scan.firstTable);
}

function withoutNotify(doc: Record<string, unknown>): Record<string, unknown> {
  const { notify: _notify, ...rest } = doc;
  return rest;
}

// The edit is only written when the result parses to exactly what was
// intended: the new notify value, and every other key unchanged.
function verifiedEdit(original: Record<string, unknown>, next: string, argv: string[] | null): boolean {
  const parsed = parseTomlText(next);
  if (!parsed.ok) return false;
  if (argv ? !isDeepStrictEqual(parsed.value.notify, argv) : parsed.value.notify !== undefined) return false;
  return JSON.stringify(withoutNotify(parsed.value)) === JSON.stringify(withoutNotify(original));
}

export function readNotify(doc: Record<string, unknown>): string[] | null | "invalid" {
  const value = doc.notify;
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return "invalid";
  return value as string[];
}

/**
 * The text of a config whose top-level `notify` is one Codara wrote, with the
 * user's previous value put back (or the key removed when there was none).
 * Null when the file holds no Codara notify or cannot be edited safely.
 */
export function restoreUserNotify(text: string): { text: string; previous: string[] } | null {
  const parsed = parseTomlText(text);
  if (!parsed.ok) return null;
  const current = readNotify(parsed.value);
  if (current === null || current === "invalid" || !isCodaraNotifyArgv(current)) return null;
  const previous = previousNotifyArgv(current);
  const next = previous.length > 0 ? previous : null;
  const edited = setTopLevelNotify(text, next);
  if (edited === null || !verifiedEdit(parsed.value, edited, next)) return null;
  return { text: edited, previous };
}

/**
 * The user's own notify argv from the config their Codex reads, read-only.
 * A value an older Codara build left there is unwrapped to what it chained.
 */
export async function readUserCodexNotify(configPath?: string): Promise<string[]> {
  let path = configPath;
  if (!path) {
    try {
      path = resolveCodexHomePaths().configPath;
    } catch {
      return [];
    }
  }
  const text = await fs.readFile(path, "utf8").catch(() => "");
  const parsed = parseTomlText(text);
  if (!parsed.ok) return [];
  const current = readNotify(parsed.value);
  if (current === null || current === "invalid") return [];
  return previousNotifyArgv(current);
}

/** Whether the TOML text leaves `[tui] notifications` unset. */
export function tuiNotificationsUnset(text: string): boolean {
  const parsed = parseTomlText(text);
  if (!parsed.ok) return false;
  const tui = parsed.value.tui;
  if (tui === undefined) return true;
  return typeof tui === "object" && tui !== null && !Array.isArray(tui) && !("notifications" in tui);
}

export function probePython(python: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(python, ["-c", "import sys"], { timeout: 5_000, windowsHide: true }, (err) => done(!err));
  });
}

/** Where the durable copy of the notify script lives. */
export function stableNotifyScriptPath(home: string = codaraHome()): string {
  return resolve(join(home, STABLE_DIR_NAME, SCRIPT_FILENAME));
}

/**
 * Refresh the durable copy under the Codara home from the app's resources.
 * Returns its path, or null when no copy is in place.
 */
export async function ensureCodexNotifyScript(
  options: { source?: string; destination?: string } = {},
): Promise<string | null> {
  const source = options.source ?? resolveBundledResourcePath("codex-hooks", SCRIPT_FILENAME);
  const destination = options.destination ?? stableNotifyScriptPath();
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
    console.warn("[codex-notify] could not copy", SCRIPT_FILENAME, ":", (err as Error).message);
    const stats = await fs.stat(destination).catch(() => null);
    return stats?.isFile() ? destination : null;
  }
}

export const __test = { LAUNCHER_CODE, SCRIPT_FILENAME, scanTopLevel };
