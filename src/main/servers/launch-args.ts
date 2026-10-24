// Extra startup arguments per agent runtime, from Settings. They ride on the
// command line of each launch Codara makes (and of a `claude`, `codex`,
// `grok` or `pi` typed in a Codara pane, through the args files the pane
// functions read), never in ~/.claude, ~/.codex, ~/.grok or any CLI config.
// The text is split into argv here, once: nothing a user types is ever run
// by a shell, and anything that would need one is refused.

import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LAUNCH_ARG_RUNTIMES,
  type LaunchArgRuntime,
  type LaunchArgsCheck,
  type LaunchArgsSettings,
} from "../../shared/servers";
import { codaraHome } from "../codara-home";
import { writeFileAtomic } from "../fs-atomic";

const FILE = "agent-launch-args.json";
const MAX_CHARS = 1_000;
const MAX_ARGS = 40;

/**
 * Flags Codara itself sets on a launch (its hooks, its tool server, the
 * session it resumes or tracks). A user copy would break that launch.
 */
const RESERVED: Record<LaunchArgRuntime, readonly string[]> = {
  claude: ["--settings", "--mcp-config", "--strict-mcp-config", "--session-id", "--resume", "-r", "--continue", "-c", "--print", "-p", "--output-format", "--input-format"],
  codex: ["resume", "exec"],
  grok: ["--session-id", "-s", "--resume", "-r", "--continue", "-c", "--single", "-p", "--output-format"],
  pi: ["--session", "--resume", "-r", "--continue", "-c", "--print", "-p", "--mode"],
};
/**
 * Options that take every following word as another value. The Settings
 * flags sit right before what the user types after the command, so the
 * spaced form would swallow a typed prompt; the --opt=value form ends the
 * option at its one value in both Commander (claude) and clap (codex).
 */
const VARIADIC: Record<LaunchArgRuntime, readonly string[]> = {
  claude: ["--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--betas", "--file"],
  codex: ["-i", "--image"],
  grok: [],
  pi: [],
};
// Codex takes config overrides as -c key=value; Codara's own keys stay its own.
const CODEX_RESERVED_KEYS = /^\s*(?:mcp_servers\s*\.\s*(?:codara-studio\b|"codara-studio"|'codara-studio')|notify\s*=|tui\s*\.\s*notifications\s*=)/;

export class LaunchArgsError extends Error {}

/** Splits what the user typed into argv: quotes group, nothing expands, shell syntax is refused. */
export function splitLaunchArgs(text: string): string[] {
  if (/[\r\n\0]/.test(text)) throw new LaunchArgsError("Use one line; new lines are not allowed.");
  const out: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "`")) {
        throw new LaunchArgsError(`${char} is not allowed: arguments are passed as typed, never expanded.`);
      }
      token += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) out.push(token);
      token = "";
      started = false;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (";&|<>`$(){}\\".includes(char)) {
      throw new LaunchArgsError(`${char} is shell syntax, which launch arguments cannot use. Quote a value that contains it.`);
    }
    token += char;
    started = true;
  }
  if (quote) throw new LaunchArgsError("A quote is not closed.");
  if (started) out.push(token);
  return out;
}

export function checkLaunchArgs(runtime: LaunchArgRuntime, text: string): LaunchArgsCheck {
  try {
    if (text.length > MAX_CHARS) throw new LaunchArgsError(`Keep it under ${MAX_CHARS} characters.`);
    const argv = splitLaunchArgs(text);
    if (argv.length > MAX_ARGS) throw new LaunchArgsError(`At most ${MAX_ARGS} arguments.`);
    if (argv.length && !argv[0].startsWith("-")) {
      throw new LaunchArgsError(`Start with a flag, such as --verbose. "${argv[0]}" would be read as a prompt or a command.`);
    }
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      const flag = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (RESERVED[runtime].includes(flag)) {
        throw new LaunchArgsError(`${flag} is set by Codara for each launch and cannot be added here.`);
      }
      if (VARIADIC[runtime].includes(arg)) {
        const example = `${arg.startsWith("--") ? arg : "--image"}=${argv[index + 1] ?? "value"}`;
        throw new LaunchArgsError(`Write ${arg} as ${example}, one value per flag. With a space it would also take the prompt typed after the command as a value.`);
      }
      if (runtime === "codex" && (arg === "-c" || arg === "--config")) {
        const value = argv[index + 1] ?? "";
        if (CODEX_RESERVED_KEYS.test(value)) throw new LaunchArgsError(`${value.split("=")[0]} is set by Codara for each launch.`);
      }
      if (runtime === "codex" && arg.startsWith("--config=") && CODEX_RESERVED_KEYS.test(arg.slice("--config=".length))) {
        throw new LaunchArgsError("That config key is set by Codara for each launch.");
      }
    }
    return { ok: true, argv, error: null };
  } catch (error) {
    return { ok: false, argv: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function settingsPath(): string {
  return join(codaraHome(), FILE);
}

function clean(raw: unknown): LaunchArgsSettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const args: LaunchArgsSettings["args"] = {};
  const given = value.args && typeof value.args === "object" ? (value.args as Record<string, unknown>) : {};
  for (const runtime of LAUNCH_ARG_RUNTIMES) {
    const text = given[runtime];
    if (typeof text === "string" && text.trim()) args[runtime] = text.trim();
  }
  return { args, claudeChrome: value.claudeChrome === true };
}

let cached: { at: number; settings: LaunchArgsSettings } | null = null;
const CACHE_MS = 2_000;

export function readLaunchArgsSettings(): LaunchArgsSettings {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.settings;
  let settings: LaunchArgsSettings;
  try {
    settings = clean(JSON.parse(readFileSync(settingsPath(), "utf8")));
  } catch {
    settings = { args: {}, claudeChrome: false };
  }
  cached = { at: now, settings };
  return settings;
}

/** The arguments a launch of this runtime gets from Settings; invalid text adds nothing. */
export function extraLaunchArgs(runtime: LaunchArgRuntime, settings = readLaunchArgsSettings()): string[] {
  const text = settings.args[runtime] ?? "";
  const checked = text ? checkLaunchArgs(runtime, text) : { ok: true, argv: [] as string[], error: null };
  const argv = checked.ok ? [...checked.argv] : [];
  if (runtime === "claude" && settings.claudeChrome && !argv.includes("--chrome") && !argv.includes("--no-chrome")) {
    argv.push("--chrome");
  }
  return argv;
}

let writes: Promise<unknown> = Promise.resolve();

/** Saves after checking every runtime's text; the first problem is refused with its message. */
export function saveLaunchArgsSettings(next: LaunchArgsSettings): Promise<LaunchArgsSettings> {
  const settings = clean(next);
  for (const runtime of LAUNCH_ARG_RUNTIMES) {
    const text = settings.args[runtime];
    if (!text) continue;
    const checked = checkLaunchArgs(runtime, text);
    if (!checked.ok) return Promise.reject(new LaunchArgsError(`${runtime}: ${checked.error}`));
  }
  const write = writes.catch(() => undefined).then(async () => {
    await fs.mkdir(codaraHome(), { recursive: true });
    await writeFileAtomic(settingsPath(), `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`);
    cached = { at: Date.now(), settings };
    return settings;
  });
  writes = write;
  return write;
}

/** Test seam. */
export function resetLaunchArgsCacheForTests(): void {
  cached = null;
}
