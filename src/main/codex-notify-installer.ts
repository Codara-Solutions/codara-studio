// Codex's `notify` program in ~/.codex/config.toml is how Codara learns that
// a Codex turn in a terminal pane finished, with Codex's own last message.
// Codex runs that argv after every turn with the event JSON appended, so the
// entry is a launcher for resources/codex-hooks/codara-codex-notify.py that
// carries the user's previous notify argv after a `--` and runs it too:
//
//   notify = ["python3", "-c", "<launcher>", "<script>", "--", ...previous]
//
// The config is the user's (shared by every Codex session, Codara-managed
// account homes symlink to it), so the edit is minimal and reversible:
// only the top-level `notify` value is replaced, every other byte of the file
// is kept, the result is re-parsed and compared before it is written, and
// uninstalling puts the previous value (or no value) back.
// SPARK_CODEX_NOTIFY=0 uninstalls at boot instead of installing.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveBundledResourcePath } from "./bundled-resources";
import { codaraHome, defaultCodaraHome } from "./codara-home";
import { withConfigFileLock, writeConfigFileAtomic } from "./config-file-io";
import { writeFileAtomic } from "./fs-atomic";
import { isTransientPath, resolvePythonBinary } from "./hook-installer";
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

export interface CodexNotifyOverrides {
  configPath?: string;
  sourceScriptPath?: string;
  stableScriptPath?: string | null;
  python?: string;
  // Skips the interpreter probe (tests pass a fake interpreter path).
  pythonAvailable?: boolean;
}

export type CodexNotifyResult = { installed: boolean; changed: boolean; reason?: string };

function isOurs(argv: string[]): boolean {
  return argv.length >= 5 && argv[1] === "-c" && basename(argv[3]) === SCRIPT_FILENAME && argv[4] === CHAIN_SEPARATOR;
}

function previousArgv(argv: string[] | null): string[] {
  if (!argv) return [];
  return isOurs(argv) ? argv.slice(5) : argv;
}

function buildArgv(python: string, scriptPath: string, previous: string[]): string[] {
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

function readNotify(doc: Record<string, unknown>): string[] | null | "invalid" {
  const value = doc.notify;
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return "invalid";
  return value as string[];
}

function personalConfigPath(): string | null {
  try {
    return resolveCodexHomePaths().configPath;
  } catch (err) {
    console.warn("[codex-notify] Codex home unusable:", (err as Error).message);
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

function probePython(python: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(python, ["-c", "import sys"], { timeout: 5_000, windowsHide: true }, (err) => done(!err));
  });
}

// The durable copy follows the same rule as the Claude hook: never point a
// long-lived config at a temp or worktree path. A config that is itself
// transient (an e2e CODEX_HOME) is paired with the current Codara home, so a
// test never writes into the real one.
async function resolveStableScriptPath(configPath: string): Promise<string | null> {
  if (await isTransientPath(configPath)) return resolve(join(codaraHome(), STABLE_DIR_NAME, SCRIPT_FILENAME));
  for (const home of [codaraHome(), defaultCodaraHome()]) {
    const candidate = resolve(join(home, STABLE_DIR_NAME, SCRIPT_FILENAME));
    if (!(await isTransientPath(candidate))) return candidate;
  }
  return null;
}

// A Codara home in a temp directory or a worktree is an e2e run or a
// throwaway launch. It must neither install into nor uninstall from a Codex
// config that outlives it (the user's own ~/.codex when the launch did not
// redirect CODEX_HOME).
async function sandboxedLaunchOnPersonalConfig(configPath: string): Promise<boolean> {
  return (await isTransientPath(codaraHome())) && !(await isTransientPath(configPath));
}

async function syncScript(source: string, destination: string): Promise<boolean> {
  try {
    const desired = await fs.readFile(source, "utf8");
    const current = await fs.readFile(destination, "utf8").catch(() => null);
    if (current !== desired) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await writeFileAtomic(destination, desired);
    }
    await fs.chmod(destination, 0o755).catch(() => undefined);
    return true;
  } catch (err) {
    console.warn("[codex-notify] could not copy", SCRIPT_FILENAME, "to", destination, ":", (err as Error).message);
    return exists(destination);
  }
}

async function editNotify(
  configPath: string,
  desired: (current: string[] | null) => string[] | null,
): Promise<CodexNotifyResult> {
  return withConfigFileLock(configPath, async () => {
    let text = "";
    try {
      text = await fs.readFile(configPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parsed = parseTomlText(text);
    if (!parsed.ok) return { installed: false, changed: false, reason: `config.toml does not parse (${parsed.error})` };
    const current = readNotify(parsed.value);
    if (current === "invalid") return { installed: false, changed: false, reason: "notify is not a list of strings" };
    const next = desired(current);
    const installed = next !== null && isOurs(next);
    if (isDeepStrictEqual(next, current)) return { installed, changed: false };
    const edited = setTopLevelNotify(text, next);
    if (edited === null || !verifiedEdit(parsed.value, edited, next)) {
      return { installed: current !== null && isOurs(current), changed: false, reason: "could not edit notify safely" };
    }
    if (text === "" && edited.trim() === "") return { installed, changed: false };
    await writeConfigFileAtomic(configPath, edited);
    return { installed, changed: true };
  });
}

export async function installCodexNotify(overrides: CodexNotifyOverrides = {}): Promise<CodexNotifyResult> {
  const configPath = overrides.configPath ?? personalConfigPath();
  if (!configPath) return { installed: false, changed: false, reason: "no Codex home" };
  // A machine without Codex gets no ~/.codex created for it.
  if (!(await exists(dirname(configPath)))) return { installed: false, changed: false, reason: "Codex home does not exist" };
  if (await sandboxedLaunchOnPersonalConfig(configPath)) {
    return { installed: false, changed: false, reason: "temporary Codara home; the Codex config is left alone" };
  }
  const stablePath =
    overrides.stableScriptPath !== undefined ? overrides.stableScriptPath : await resolveStableScriptPath(configPath);
  if (!stablePath) return { installed: false, changed: false, reason: "no durable place for the notify script" };
  const source = overrides.sourceScriptPath ?? resolveBundledResourcePath("codex-hooks", SCRIPT_FILENAME);
  if (!(await syncScript(source, stablePath))) {
    return { installed: false, changed: false, reason: "notify script unavailable" };
  }
  const python = overrides.python ?? resolvePythonBinary();
  if (!(overrides.pythonAvailable ?? (await probePython(python)))) {
    return { installed: false, changed: false, reason: `${python} not found` };
  }
  const result = await editNotify(configPath, (current) => buildArgv(python, stablePath, previousArgv(current)));
  console.log(
    `[codex-notify] ${result.installed ? "installed" : "not installed"}${result.changed ? " (config updated)" : ""}${result.reason ? `: ${result.reason}` : ""}`,
  );
  return result;
}

export async function uninstallCodexNotify(overrides: CodexNotifyOverrides = {}): Promise<CodexNotifyResult> {
  const configPath = overrides.configPath ?? personalConfigPath();
  if (!configPath || !(await exists(configPath))) return { installed: false, changed: false };
  if (await sandboxedLaunchOnPersonalConfig(configPath)) return { installed: false, changed: false };
  return editNotify(configPath, (current) => {
    if (!current || !isOurs(current)) return current;
    const previous = previousArgv(current);
    return previous.length > 0 ? previous : null;
  });
}

export const __test = { LAUNCHER_CODE, SCRIPT_FILENAME, buildArgv, isOurs, scanTopLevel };
