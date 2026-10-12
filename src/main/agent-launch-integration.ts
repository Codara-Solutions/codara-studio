import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { codaraHome } from "./codara-home";
import {
  buildCodexNotifyArgv,
  ensureCodexNotifyScript,
  previousNotifyArgv,
  probePython,
  readNotify,
  tuiNotificationsUnset,
} from "./codex-notify-installer";
import { writeFileAtomic } from "./fs-atomic";
import { claudeHookSettings, ensureHookScript, resolvePythonBinary } from "./hook-installer";
import {
  CODEX_STUDIO_TIMEOUTS,
  codaraStudioServerSpec,
  readSparkBuiltinOptOuts,
  SPARK_BUILTIN_SERVER_NAME,
  type SparkMcpMode,
} from "./mcp-installer";
import { parseTomlText } from "./mcp-toml";
import { resolveCodexHomePaths } from "./orchestration/codex-home";

/**
 * What Codara adds to a Claude Code or Codex launch so the session reports
 * to Codara: Claude's hooks (`--settings`), the codara-studio MCP server
 * (`--mcp-config` / `-c mcp_servers.codara-studio=...`) and Codex's notify
 * program (`-c notify=[...]`). Everything is passed on the command line of a
 * process Codara starts, or of a `claude` / `codex` typed in a Codara pane
 * (the pane-scoped shell functions in resources/shell-integration read the
 * args files written here). Nothing goes into the user's own CLI config, so
 * a session started anywhere else behaves as if Codara were not installed.
 *
 * Files under <codaraHome>/integrations are regenerated at every boot from
 * the running binary, so a moved app, an AppImage mount or a worktree build
 * never leaves a launch pointing at a path that is gone; a session can only
 * start while this Codara runs.
 */

export type AgentMcpMode = SparkMcpMode;

const MCP_MODES: readonly AgentMcpMode[] = ["studio", "execute", "automation", "worker"];

// First arguments that are not sessions: management subcommands and version
// or help flags go through untouched.
const CLAUDE_PASS_THROUGH = new Set([
  "auth",
  "mcp",
  "config",
  "doctor",
  "update",
  "upgrade",
  "install",
  "setup-token",
  "plugin",
  "plugins",
  "migrate-installer",
  "agents",
  "attach",
  "logs",
  "rm",
  "stop",
  "kill",
  "respawn",
  "purge",
  "auto-mode",
  "import",
  "gateway",
  "ultrareview",
  "-v",
  "--version",
  "-h",
  "--help",
]);

const CODEX_PASS_THROUGH = new Set([
  "login",
  "logout",
  "mcp",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "plugin",
  "app-server",
  "remote-control",
  "agents",
  "--version",
  "-V",
  "--help",
  "-h",
]);

export interface AgentLaunchPlan {
  /** Inserted right after the binary. */
  argvPrefix: string[];
  /** Variables to set (a string) or unset (null) for this launch. */
  env: Record<string, string | null>;
}

interface IntegrationState {
  dir: string;
  claudeSettingsPath: string | null;
  claudeMcpConfigPaths: Partial<Record<AgentMcpMode, string>>;
  codexNotifyArgv: string[] | null;
  codexTuiNotificationsUnset: boolean;
}

let state: IntegrationState | null = null;

export function integrationsDir(home: string = codaraHome()): string {
  return resolve(join(home, "integrations"));
}

/** One TOML basic string, safe in argv and in a one-element-per-line file. */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      throw new Error("A control character cannot be passed to Codex.");
    }
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (code > 0x7e) {
      out += code > 0xffff
        ? `\\U${code.toString(16).toUpperCase().padStart(8, "0")}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += char;
  }
  return `${out}"`;
}

/**
 * The TOML string a `-c` value carries. A literal string where the value
 * allows one: it needs no double quotes and no backslash escapes, the two
 * things cmd.exe and Windows PowerShell rewrite on the way to codex.exe, and
 * a Windows path stays as it is.
 */
export function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("A control character cannot be passed to Codex.");
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("'''") && !value.startsWith("'") && !value.endsWith("'")) return `'''${value}'''`;
  return tomlBasicString(value);
}

/** A quoted TOML key: keys take no multi-line form. */
function tomlKey(value: string): string {
  return value.includes("'") ? tomlBasicString(value) : tomlString(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

/** The `-c` value that adds codara-studio to a Codex launch. The key is unquoted: a quoted segment keeps its quotes. */
export function codexStudioServerOverride(mode: AgentMcpMode): string {
  const spec = codaraStudioServerSpec(mode);
  const env = Object.entries(spec.env)
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  return (
    `mcp_servers.${SPARK_BUILTIN_SERVER_NAME}={command=${tomlString(spec.command)},` +
    `args=${tomlStringArray(spec.args)},env={${env}},` +
    `tool_timeout_sec=${CODEX_STUDIO_TIMEOUTS.tool_timeout_sec},` +
    `startup_timeout_sec=${CODEX_STUDIO_TIMEOUTS.startup_timeout_sec}}`
  );
}

/**
 * Trust for one working directory, as an inline table: dotted keys split on
 * every `.`, and paths contain dots. Null when the path cannot be rendered.
 */
export function codexTrustOverride(cwd: string): string | null {
  try {
    return `projects={${tomlKey(cwd)}={trust_level='trusted'}}`;
  } catch {
    return null;
  }
}

function claudeMcpConfig(mode: AgentMcpMode): string {
  const spec = codaraStudioServerSpec(mode);
  return `${JSON.stringify(
    { mcpServers: { [SPARK_BUILTIN_SERVER_NAME]: { type: "stdio", ...spec } } },
    null,
    2,
  )}\n`;
}

// One argv element per line, read by the shell functions. A newline inside an
// element would split it, so such an element is refused rather than written.
function argsFile(lines: readonly string[]): string {
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error("An agent argument cannot contain a line break.");
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await fs.readFile(path, "utf8").catch(() => null);
  if (current === content) return;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, content, { mode: 0o600 });
}

async function userCodexConfigText(): Promise<string> {
  try {
    return await fs.readFile(resolveCodexHomePaths().configPath, "utf8");
  } catch {
    return "";
  }
}

export interface IntegrationFilesOptions {
  home?: string;
  python?: string;
  /** Skips the interpreter probe (tests pass a fake interpreter path). */
  pythonAvailable?: boolean;
  hookScriptSource?: string;
  notifyScriptSource?: string;
  /** The user's Codex config.toml text; read from their Codex home otherwise. */
  codexConfigText?: string;
  /** False leaves Codex's notify program out of every launch. */
  codexNotify?: boolean;
}

export interface IntegrationFilesSummary {
  dir: string;
  claudeHooks: boolean;
  codexNotify: boolean;
}

/**
 * Boot: write <codaraHome>/integrations from the running binary. Every file
 * is Codara's own; the user's notify is only read, to be chained.
 */
export async function writeIntegrationFiles(
  options: IntegrationFilesOptions = {},
): Promise<IntegrationFilesSummary> {
  const home = options.home ?? codaraHome();
  const dir = integrationsDir(home);
  const python = options.python ?? resolvePythonBinary();
  const pythonAvailable = options.pythonAvailable ?? (await probePython(python));

  const hookScript = pythonAvailable
    ? await ensureHookScript({
        ...(options.hookScriptSource ? { source: options.hookScriptSource } : {}),
        destination: join(home, "claude-hooks", "codara-hook.py"),
      })
    : null;
  const notifyScript = pythonAvailable
    ? await ensureCodexNotifyScript({
        ...(options.notifyScriptSource ? { source: options.notifyScriptSource } : {}),
        destination: join(home, "codex-hooks", "codara-codex-notify.py"),
      })
    : null;

  const claudeSettingsPath = join(dir, "claude", "settings.json");
  if (hookScript) {
    await writeIfChanged(claudeSettingsPath, `${JSON.stringify(claudeHookSettings(python, hookScript), null, 2)}\n`);
  } else {
    await fs.rm(claudeSettingsPath, { force: true });
  }
  const claudeMcpConfigPaths: Partial<Record<AgentMcpMode, string>> = {};
  for (const mode of MCP_MODES) {
    const path = join(dir, "claude", `mcp-${mode}.json`);
    await writeIfChanged(path, claudeMcpConfig(mode));
    claudeMcpConfigPaths[mode] = path;
  }

  const codexText = options.codexConfigText ?? (await userCodexConfigText());
  const userNotify = userNotifyFromText(codexText);
  await writeIfChanged(join(dir, "codex-notify.json"), `${JSON.stringify({ notify: userNotify }, null, 2)}\n`);
  const codexNotifyArgv =
    notifyScript && options.codexNotify !== false ? buildCodexNotifyArgv(python, notifyScript, userNotify) : null;

  state = {
    dir,
    claudeSettingsPath: hookScript ? claudeSettingsPath : null,
    claudeMcpConfigPaths,
    codexNotifyArgv,
    codexTuiNotificationsUnset: tuiNotificationsUnset(codexText),
  };
  await writeShellArgsFiles();
  return { dir, claudeHooks: hookScript !== null, codexNotify: codexNotifyArgv !== null };
}

function userNotifyFromText(text: string): string[] {
  const parsed = parseTomlText(text);
  if (!parsed.ok) return [];
  const current = readNotify(parsed.value);
  return current === null || current === "invalid" ? [] : previousNotifyArgv(current);
}

/**
 * The files the pane functions read. Rewritten when the per-CLI MCP switch
 * changes, so the next `claude` typed in a pane follows it.
 */
export async function writeShellArgsFiles(): Promise<void> {
  if (!state) return;
  await writeIfChanged(join(state.dir, "claude", "args.txt"), argsFile(claudeLaunchArgs({ userArgs: [] })));
  await writeIfChanged(join(state.dir, "codex", "args.txt"), argsFile(codexLaunchArgs({ userArgs: [] })));
}

let bootPass: Promise<unknown> = Promise.resolve();

/** Boot hands its cleanup-then-write pass here so the first panes can wait for it. */
export function setIntegrationBootPass(pass: Promise<unknown>): void {
  bootPass = pass.catch(() => undefined);
}

/**
 * A pane spawned in the first moments after boot waits for the files, a
 * bounded wait: a shell must always open, with or without Codara's flags.
 */
export function integrationFilesReady(timeoutMs = 3_000): Promise<void> {
  return Promise.race([
    bootPass.then(() => undefined),
    new Promise<void>((done) => setTimeout(done, timeoutMs).unref?.()),
  ]);
}

/**
 * SPARK_AGENT_ARGS_DIR for a local pane. A fixed path, set even before the
 * boot pass has written the files: a shell decides once, at start, whether
 * to define its `claude` / `codex` functions, and those read the file at
 * every call, so a pane opened early picks the files up at its next launch.
 */
export function agentArgsDir(): string {
  return state?.dir ?? integrationsDir();
}

/** True while Codara passes its notify program to the Codex sessions it starts. */
export function codexNotifyInjected(): boolean {
  return Boolean(state?.codexNotifyArgv);
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/** The arguments Codara inserts after `claude`; empty for management subcommands. */
export function claudeLaunchArgs(input: { userArgs: readonly string[]; mode?: AgentMcpMode }): string[] {
  if (!state) return [];
  const first = input.userArgs[0];
  if (first !== undefined && CLAUDE_PASS_THROUGH.has(first)) return [];
  const out: string[] = [];
  // Claude keeps only the last --settings it is given, so a user's own one
  // wins and Codara's hooks stay out of that session.
  if (state.claudeSettingsPath && !hasFlag(input.userArgs, "--settings")) {
    out.push("--settings", state.claudeSettingsPath);
  }
  const mcp = state.claudeMcpConfigPaths[input.mode ?? "studio"];
  if (mcp && !readSparkBuiltinOptOuts().has("claude") && !hasFlag(input.userArgs, "--strict-mcp-config")) {
    // `--mcp-config <configs...>` is variadic: in its two-word form every
    // later word that is not a flag (a prompt, a subcommand) would be read
    // as one more config file. The `=` form takes exactly one.
    out.push(`--mcp-config=${mcp}`);
  }
  return out;
}

/** The arguments Codara inserts after `codex`; empty for management subcommands. */
export function codexLaunchArgs(input: {
  userArgs: readonly string[];
  mode?: AgentMcpMode;
  /** A directory Codara itself launches Codex in; the user's own folders are never pre-trusted. */
  trustCwd?: string | null;
}): string[] {
  if (!state) return [];
  const first = input.userArgs[0];
  if (first !== undefined && CODEX_PASS_THROUGH.has(first)) return [];
  const out: string[] = [];
  if (!readSparkBuiltinOptOuts().has("codex")) {
    out.push("-c", codexStudioServerOverride(input.mode ?? "studio"));
  }
  if (state.codexNotifyArgv) out.push("-c", `notify=${tomlStringArray(state.codexNotifyArgv)}`);
  // Only when the user left it unset: a filter list of their own stays theirs.
  if (state.codexTuiNotificationsUnset) out.push("-c", "tui.notifications=true");
  const trust = input.trustCwd ? codexTrustOverride(input.trustCwd) : null;
  if (trust) out.push("-c", trust);
  return out;
}

export function planClaudeLaunch(input: { userArgs: readonly string[]; mode?: AgentMcpMode }): AgentLaunchPlan {
  return { argvPrefix: claudeLaunchArgs(input), env: {} };
}

export function planCodexLaunch(input: {
  userArgs: readonly string[];
  mode?: AgentMcpMode;
  trustCwd?: string | null;
}): AgentLaunchPlan {
  return { argvPrefix: codexLaunchArgs(input), env: {} };
}

/** Test seam: forget what the last boot wrote. */
export function resetAgentLaunchIntegrationForTests(): void {
  state = null;
}
