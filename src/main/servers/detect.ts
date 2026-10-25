// Pure helpers of the dev-server keeper: reading terminal output for a
// local URL and the command a shell ran, and checking what an agent or the
// user hands in. No I/O, so scripts/test-servers.cjs covers them directly.

import { basename } from "node:path";

// CSI, OSC (BEL or ST terminated), and the two-byte escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal output as plain text: escape sequences dropped, carriage-return overwrites resolved per line. */
export function plainTerminalText(raw: string): string {
  const text = raw.replace(ANSI_RE, "").replace(/\r\n/g, "\n");
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part !== "");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

const LOCAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost)(?::(\d{2,5}))?(?:\/[^\s'"<>`)\]]*)?/gi;

export interface LocalUrl {
  url: string;
  port: number;
}

/**
 * The lines of streamed output that have ended. A URL on the last line may
 * still be arriving ("http://localhost:5" then "173/"), so only these are
 * scanned for one.
 */
export function completeLines(text: string): string {
  const end = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return end < 0 ? "" : text.slice(0, end + 1);
}

/** Local URLs a dev server prints when it is ready, in order, with 0.0.0.0 and [::] shown as localhost. */
export function findLocalUrls(text: string): LocalUrl[] {
  const found: LocalUrl[] = [];
  const seen = new Set<string>();
  for (const match of plainTerminalText(text).matchAll(LOCAL_URL_RE)) {
    let url = match[0].replace(/[.,;:]+$/, "");
    url = url.replace(/\/\/(?:0\.0\.0\.0|\[::\])/, "//localhost");
    const secure = url.toLowerCase().startsWith("https:");
    const port = match[1] ? Number(match[1]) : secure ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, port });
  }
  return found;
}

// OSC 633;E;<command line>[;<nonce>] is what Codara's shell integration
// reports right before a typed command runs; ';' and '\' arrive escaped.
const OSC_COMMAND_RE = /\x1b\]633;E;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// The folder comes as OSC 633;P;Cwd=<path> (PowerShell) or as OSC 7's
// file://<host><url-encoded path> (bash and zsh).
const OSC_CWD_RE = /\x1b\](?:633;P;Cwd=([^\x07\x1b]*)|7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*))(?:\x07|\x1b\\)/g;

function unescapeOsc(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})|\\\\/g, (_whole, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : "\\",
  );
}

function decodeFileUrlPath(path: string): string {
  try {
    const decoded = decodeURIComponent(path);
    // file:///C:/x on Windows
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return "";
  }
}

/** The command lines and working directories a shell reported in this output, oldest first. */
export function shellReports(raw: string): { commands: string[]; cwds: string[] } {
  const commands = [...raw.matchAll(OSC_COMMAND_RE)].map((match) => unescapeOsc(match[1].split(";")[0]).trim()).filter(Boolean);
  const cwds = [...raw.matchAll(OSC_CWD_RE)]
    .map((match) => (match[1] !== undefined ? unescapeOsc(match[1]) : decodeFileUrlPath(match[2] ?? "")).trim())
    .filter(Boolean);
  return { commands, cwds };
}

export const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_COMMAND_CHARS = 2_000;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_CHARS = 32_768;

export class ServerInputError extends Error {}

/** A name usable as a server id: lowercase, dashes, at most 40 characters. */
export function serverSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** The id a new server gets from its command: the script name for a package manager run, else the program. */
export function suggestServerId(command: string, cwd: string): string {
  const words = command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const manager = /^(?:npm|pnpm|yarn|bun|deno)$/.test(words[0] ?? "");
  let name = "";
  if (manager) {
    const rest = words.slice(1).filter((word) => !word.startsWith("-"));
    name = rest[0] === "run" || rest[0] === "task" ? rest[1] ?? "" : rest[0] ?? "";
  } else {
    name = basename(words[0] ?? "");
  }
  return serverSlug(name) || serverSlug(basename(cwd)) || "server";
}

export function checkCommand(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) throw new ServerInputError("command is required");
  const trimmed = command.trim();
  if (trimmed.length > MAX_COMMAND_CHARS) throw new ServerInputError(`command is longer than ${MAX_COMMAND_CHARS} characters`);
  if (/[\r\n\0]/.test(trimmed)) throw new ServerInputError("command must be one line");
  return trimmed;
}

export function checkPort(port: unknown): number | null {
  if (port === undefined || port === null || port === "") return null;
  const value = typeof port === "string" ? Number(port) : port;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ServerInputError("port must be a whole number from 1 to 65535");
  }
  return value;
}

export function checkUrl(url: unknown): string | null {
  if (url === undefined || url === null || url === "") return null;
  if (typeof url !== "string") throw new ServerInputError("url must be text");
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ServerInputError(`url is not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ServerInputError("url must be http or https");
  return parsed.toString();
}

/** The port a URL names, or its scheme's default. */
export function portOfUrl(url: string | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** Values for one start. Only the names are ever written to disk. */
export function checkEnv(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new ServerInputError("env must be an object of NAME: value");
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) throw new ServerInputError(`env takes at most ${MAX_ENV_VARS} variables`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) throw new ServerInputError(`env name ${JSON.stringify(name)} is not a variable name`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ServerInputError(`env ${name} must be text`);
    }
    const text = String(value);
    if (text.length > MAX_ENV_VALUE_CHARS || text.includes("\0")) throw new ServerInputError(`env ${name} is too long or has a NUL`);
    out[name] = text;
  }
  return out;
}

// NAME=value at the start of a command: a single-quoted value, a
// double-quoted one with nothing to expand, or a bare word with no shell
// syntax. Anything else stays in the command for the shell to read.
const ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()~][^\s'"$`\\;&|<>()]*|))/;
const ENV_PREFIX_RE = new RegExp(`^${ASSIGNMENT_RE.source}(?=\\s)`);
const NEXT_ASSIGNMENT_RE = new RegExp(`^${ASSIGNMENT_RE.source}\\s*`);
// `export A=1 B=2 && cmd` or `export A=1; cmd`: the same values, set by a statement of their own.
const EXPORT_PREFIX_RE = /^export\s+((?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"$`\\]*"|[^\s'"$`\\;&|<>()~][^\s'"$`\\;&|<>()]*|)\s*)+)(?:&&|;)\s*/;
// PowerShell's `$env:A='1'; cmd`.
const PWSH_ENV_PREFIX_RE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"$`]*)")\s*;\s*/i;

function stripEnvPrefixOnce(rest: string, env: Record<string, string>): string | null {
  const plain = ENV_PREFIX_RE.exec(rest);
  if (plain) {
    const after = rest.slice(plain[0].length).trimStart();
    if (!after) return null;
    env[plain[1]] = plain[2] ?? plain[3] ?? plain[4] ?? "";
    return after;
  }
  if (/^env\s/.test(rest)) {
    const after = rest.slice(3).trimStart();
    return ENV_PREFIX_RE.test(after) ? after : null;
  }
  const exported = EXPORT_PREFIX_RE.exec(rest);
  if (exported) {
    const after = rest.slice(exported[0].length);
    if (!after) return null;
    let list = exported[1];
    for (let match = NEXT_ASSIGNMENT_RE.exec(list); match; match = NEXT_ASSIGNMENT_RE.exec(list)) {
      env[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
      list = list.slice(match[0].length);
      if (!list) break;
    }
    return after;
  }
  const pwsh = PWSH_ENV_PREFIX_RE.exec(rest);
  if (pwsh) {
    const after = rest.slice(pwsh[0].length);
    if (!after) return null;
    env[pwsh[1]] = pwsh[2] ?? pwsh[3] ?? "";
    return after;
  }
  return null;
}

/**
 * Splits the variable assignments off the front of a command line, so a
 * typed `API_KEY=... pnpm dev` (or `env API_KEY=... pnpm dev`, `export
 * API_KEY=... && pnpm dev`, `$env:API_KEY='...'; pnpm dev`) is remembered as
 * `pnpm dev` with the name API_KEY and its value never reaches the saved
 * command.
 */
export function splitEnvPrefix(command: string): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  let rest = command.trim();
  for (let next = stripEnvPrefixOnce(rest, env); next !== null; next = stripEnvPrefixOnce(rest, env)) rest = next;
  return { command: rest, env };
}

/**
 * A variable assignment still in a command after splitEnvPrefix whose value
 * is written out (not only a reference such as $PORT): the name, or null.
 * Saving such a command would store the value, so it is refused instead.
 */
export function assignedValueInCommand(command: string): string | null {
  const re = /(?:^|[;&|]\s*|\b(?:env|export)\s+(?:-\S+\s+)*|\$env:)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/gi;
  for (let match = re.exec(command); match; match = re.exec(command)) {
    const value = match[2];
    if (/^(?:"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?|~[\w./-]*|)$/.test(value)) continue;
    return match[1];
  }
  return null;
}

/** checkCommand, then the values typed before it split off; a value that cannot be split off is refused. */
export function checkServerCommand(command: unknown): { command: string; env: Record<string, string> } {
  const typed = splitEnvPrefix(checkCommand(command));
  const name = assignedValueInCommand(typed.command);
  if (name) {
    throw new ServerInputError(
      `${name}'s value would be saved with the command. Pass it in env instead, which keeps only the name.`,
    );
  }
  return typed;
}

export function checkEnvNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.filter((name): name is string => typeof name === "string" && ENV_NAME_RE.test(name)))].sort();
}

/** The command a shell runs for the server and then exits, so the process ending means the server ended. */
export function serverShellArgs(
  family: string,
  baseArgs: readonly string[],
  command: string,
): string[] {
  if (family === "pwsh" || family === "powershell") return ["-NoLogo", "-Command", command];
  if (family === "cmd") return ["/D", "/S", "/C", command];
  if (family === "fish") return ["-i", "-c", command];
  // bash keeps the --rcfile Codara's shell integration passes, so the user's
  // own rc (nvm, PATH) loads as it does in a pane.
  const rcIndex = family === "bash" ? baseArgs.indexOf("--rcfile") : -1;
  const rc = rcIndex >= 0 && baseArgs[rcIndex + 1] ? ["--rcfile", baseArgs[rcIndex + 1]] : [];
  if (family === "bash" || family === "zsh") return [...rc, "-ic", command];
  return ["-c", command];
}
