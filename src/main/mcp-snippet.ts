import type { AgentMcpServerDraft, AgentMcpSnippetParseResult } from "@shared/types";
import { parseTomlText, tomlMcpServersFromDocument } from "./mcp-toml";
import type { McpServerConfig } from "./mcp-toml";

// Turns what MCP server READMEs publish into Capability Center form drafts:
//
//   { "mcpServers": { "name": { ... } } }       Claude, Cursor, Claude Desktop
//   { "servers": { ... } } / { "mcp": { "servers": { ... } } }   VS Code
//   "name": { ... }   or   { "command": ... }    a fragment of either
//   [mcp_servers.name] ...                      Codex config.toml
//   claude mcp add [options] <name> <command|url> [args...]
//   claude mcp add-json <name> '<json>'
//   codex mcp add <name> [--env K=V] -- <command> [args...]
//   npx -y @scope/server ...                    a bare stdio command line
//
// Nothing here runs or evaluates the text. The save path validates the drafts
// again, so this only has to be faithful, not authoritative.

const SNIPPET_MAX_CHARS = 64 * 1024;

export function parseMcpSnippet(text: string): AgentMcpSnippetParseResult {
  const source = typeof text === "string" ? text.trim() : "";
  if (!source) {
    return { ok: false, error: "Paste a JSON block, a Codex TOML table, or a `claude mcp add` command." };
  }
  if (source.length > SNIPPET_MAX_CHARS) return { ok: false, error: "That snippet is too large to be a server definition." };
  const notes: string[] = [];
  let servers: AgentMcpServerDraft[] | null = null;
  try {
    if (source.startsWith("{")) servers = parseJsonSnippet(source, notes);
    else if (source.startsWith('"')) {
      // A quoted fragment is either `"name": { ... }` or a command line whose
      // program path has spaces in it.
      try {
        servers = parseJsonSnippet(source, notes);
      } catch {
        servers = parseCommandLine(source, notes);
      }
    } else if (/^\s*\[/m.test(source) && /mcp_servers/.test(source)) servers = parseTomlSnippet(source, notes);
    else servers = parseCommandLine(source, notes);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!servers || servers.length === 0) {
    return { ok: false, error: "No MCP server definition was found in that text." };
  }
  return { ok: true, servers, notes };
}

// ── JSON ─────────────────────────────────────────────────────────────────────

function parseJsonSnippet(text: string, notes: string[]): AgentMcpServerDraft[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // README fragments are often one `"name": { ... }` entry cut out of a map.
    try {
      value = JSON.parse(`{${text.replace(/,\s*$/, "")}}`);
    } catch (error) {
      throw new Error(`That JSON does not parse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) throw new Error("Expected a JSON object with a server definition.");
  const map = serverMap(value);
  if (map) {
    const out: AgentMcpServerDraft[] = [];
    for (const [name, entry] of Object.entries(map)) {
      const draft = draftFromJson(name, entry, notes);
      if (draft) out.push(draft);
    }
    return out;
  }
  if (looksLikeServer(value)) {
    const name = typeof value.name === "string" ? value.name : "";
    const draft = draftFromJson(name, value, notes);
    return draft ? [draft] : [];
  }
  const entries = Object.entries(value).filter(([, entry]) => looksLikeServer(entry));
  return entries
    .map(([name, entry]) => draftFromJson(name, entry, notes))
    .filter((draft): draft is AgentMcpServerDraft => draft !== null);
}

function serverMap(value: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ["mcpServers", "servers", "mcp_servers"]) {
    if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  }
  if (isRecord(value.mcp) && isRecord((value.mcp as Record<string, unknown>).servers)) {
    return (value.mcp as Record<string, unknown>).servers as Record<string, unknown>;
  }
  return null;
}

function looksLikeServer(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (typeof value.command === "string" || typeof value.url === "string" ||
    typeof value.serverUrl === "string");
}

function draftFromJson(name: string, value: unknown, notes: string[]): AgentMcpServerDraft | null {
  if (!isRecord(value)) return null;
  const label = name.trim() || "server";
  const url = typeof value.url === "string" ? value.url : typeof value.serverUrl === "string" ? value.serverUrl : "";
  if (url) {
    return {
      name: name.trim(),
      transport: value.type === "sse" ? "sse" : "http",
      url: url.trim(),
      headers: stringRecord(value.headers),
    };
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    notes.push(`'${label}' has no command or url and was skipped.`);
    return null;
  }
  const args = Array.isArray(value.args)
    ? value.args.filter((arg): arg is string | number => typeof arg === "string" || typeof arg === "number").map(String)
    : [];
  if (typeof value.cwd === "string") notes.push(`'${label}' sets a working directory, which the form does not keep.`);
  return {
    name: name.trim(),
    transport: "stdio",
    command: value.command.trim(),
    args,
    env: stringRecord(value.env),
  };
}

// ── TOML ─────────────────────────────────────────────────────────────────────

function parseTomlSnippet(text: string, notes: string[]): AgentMcpServerDraft[] {
  const parsed = parseTomlText(text);
  if (!parsed.ok) throw new Error(`That TOML does not parse: ${parsed.error}`);
  return tomlMcpServersFromDocument(parsed.value).map((server) => draftFromConfig(server, notes));
}

function draftFromConfig(server: McpServerConfig, notes: string[]): AgentMcpServerDraft {
  if (server.cwd) notes.push(`'${server.name}' sets a working directory, which the form does not keep.`);
  if (server.url) {
    return { name: server.name, transport: "http", url: server.url, headers: server.headers };
  }
  return {
    name: server.name,
    transport: "stdio",
    command: server.command ?? "",
    args: server.args ?? [],
    env: server.env,
  };
}

// ── Command lines ────────────────────────────────────────────────────────────

function parseCommandLine(text: string, notes: string[]): AgentMcpServerDraft[] {
  const words = splitShellWords(text);
  if (words.length === 0) return [];
  const program = words[0].replace(/^.*[\\/]/, "").replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
  if ((program === "claude" || program === "codex") && words[1] === "mcp") {
    if (words[2] === "add-json") return parseClaudeAddJson(words.slice(3), notes);
    if (words[2] === "add") {
      return [program === "claude" ? parseClaudeAdd(words.slice(3), notes) : parseCodexAdd(words.slice(3), notes)];
    }
    throw new Error(`Only \`${program} mcp add\` can be pasted here.`);
  }
  if (/^https?:\/\//i.test(words[0]) && words.length === 1) {
    return [{ name: "", transport: "http", url: words[0], headers: undefined }];
  }
  return [{ name: "", transport: "stdio", command: words[0], args: words.slice(1), env: undefined }];
}

function parseClaudeAddJson(words: string[], notes: string[]): AgentMcpServerDraft[] {
  const positional = words.filter((word) => !word.startsWith("-"));
  if (positional.length < 2) throw new Error("`claude mcp add-json` needs a name and a JSON definition.");
  const [name, json] = positional;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`The JSON in that command does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  const draft = draftFromJson(name, value, notes);
  return draft ? [draft] : [];
}

// claude mcp add [-s scope] [-t transport] [-e KEY=VALUE]... [-H "Name: value"]... <name> <commandOrUrl> [args...]
function parseClaudeAdd(words: string[], notes: string[]): AgentMcpServerDraft {
  let transport = "stdio";
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") {
      positional.push(...words.slice(index + 1));
      break;
    }
    // Once the name and the command are known, the rest belongs to the
    // server, even when it looks like a flag (`npx -y pkg`).
    if (positional.length >= 2 || !word.startsWith("-")) {
      positional.push(word);
      continue;
    }
    const [flag, inline] = splitFlag(word);
    const takeValue = (): string => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= words.length) throw new Error(`${flag} needs a value.`);
      return words[index];
    };
    if (flag === "-t" || flag === "--transport") transport = takeValue().toLowerCase();
    else if (flag === "-e" || flag === "--env") addEnvPair(env, takeValue());
    else if (flag === "-H" || flag === "--header") addHeader(headers, takeValue());
    else if (flag === "-s" || flag === "--scope") {
      notes.push(`The ${takeValue()} scope from the command is replaced by the location you pick below.`);
    } else {
      notes.push(`The option ${flag} is not supported here and was ignored.`);
    }
  }
  const [name = "", target = "", ...args] = positional;
  if (!target) throw new Error("That `claude mcp add` command has no command or URL.");
  if (transport === "http" || transport === "sse" || /^https?:\/\//i.test(target)) {
    return { name, transport: transport === "sse" ? "sse" : "http", url: target, headers: nonEmpty(headers) };
  }
  return { name, transport: "stdio", command: target, args, env: nonEmpty(env) };
}

// codex mcp add <name> [--env KEY=VALUE]... -- <command> [args...]
// codex mcp add <name> --url <url> [--bearer-token-env-var VAR]
function parseCodexAdd(words: string[], notes: string[]): AgentMcpServerDraft {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let url = "";
  let name = "";
  const command: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") {
      command.push(...words.slice(index + 1));
      break;
    }
    if (!word.startsWith("-")) {
      if (!name) name = word;
      else command.push(word);
      continue;
    }
    const [flag, inline] = splitFlag(word);
    const takeValue = (): string => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= words.length) throw new Error(`${flag} needs a value.`);
      return words[index];
    };
    if (flag === "--env") addEnvPair(env, takeValue());
    else if (flag === "--url") url = takeValue();
    else if (flag === "--bearer-token-env-var") headers.Authorization = `Bearer \${${takeValue()}}`;
    else notes.push(`The option ${flag} is not supported here and was ignored.`);
  }
  if (url) return { name, transport: "http", url, headers: nonEmpty(headers) };
  if (command.length === 0) throw new Error("That `codex mcp add` command has no command after `--`.");
  return { name, transport: "stdio", command: command[0], args: command.slice(1), env: nonEmpty(env) };
}

function splitFlag(word: string): [string, string | null] {
  if (!word.startsWith("--")) return [word, null];
  const equals = word.indexOf("=");
  return equals === -1 ? [word, null] : [word.slice(0, equals), word.slice(equals + 1)];
}

function addEnvPair(env: Record<string, string>, pair: string): void {
  const equals = pair.indexOf("=");
  if (equals <= 0) throw new Error(`Environment values are KEY=VALUE, not '${pair}'.`);
  env[pair.slice(0, equals).trim()] = pair.slice(equals + 1);
}

function addHeader(headers: Record<string, string>, header: string): void {
  const colon = header.indexOf(":");
  if (colon <= 0) throw new Error(`Headers are 'Name: value', not '${header}'.`);
  headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
}

/**
 * POSIX-style word splitting: single quotes are literal, double quotes allow
 * backslash escapes, a backslash outside quotes escapes the next character,
 * and a backslash-newline (or PowerShell backtick-newline) joins lines.
 * Unbalanced quotes are an error rather than a guess.
 */
export function splitShellWords(input: string): string[] {
  const text = input.replace(/[\\`]\r?\n/g, " ");
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < text.length && /["\\$`]/.test(text[index + 1])) {
        current += text[index + 1];
        index += 1;
      } else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      inWord = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote) throw new Error("That command has an unclosed quote.");
  if (inWord) words.push(current);
  return words;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return nonEmpty(out);
}

function nonEmpty(record: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
