import { parse as parseToml } from "smol-toml";

// Codex and Grok Build keep MCP servers in config.toml under
// [mcp_servers.<name>]. Reads go through a real TOML parser. Writes splice
// only the lines that belong to one server, because a parse-and-stringify
// round trip would drop the comments, ordering and formatting of a file the
// user wrote by hand.

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  // Read for remote servers. Sync between runtimes never copies them blindly;
  // they exist so explicit copies and the Pi bridge can authenticate.
  headers?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
}

export type TomlParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function parseTomlText(text: string): TomlParseResult {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: parseToml(text) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, error: message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return null;
}

function stringTable(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const text = scalarString(raw);
    if (text !== null) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Only the exact ${VAR} form folds into env_vars, env_http_headers and
// bearer_token_env_var, because those read back as ${VAR}. Any other spelling,
// such as ${env:VAR}, is written literally so the post-write check matches.
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_PLACEHOLDER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * One parsed [mcp_servers.<name>] table in the runtime-agnostic shape. Codex's
 * indirections are folded into ${VAR} placeholders, which the Pi bridge and
 * Claude both expand: env_vars forwards a variable by name, env_http_headers
 * names the variable a header comes from, and bearer_token_env_var is the
 * Authorization header.
 */
export function tomlTableToMcpServer(name: string, table: unknown): McpServerConfig | null {
  if (!isRecord(table)) return null;
  const command = typeof table.command === "string" && table.command.trim() ? table.command : undefined;
  const url = typeof table.url === "string" && table.url.trim() ? table.url : undefined;
  if (!command && !url) return null;
  const server: McpServerConfig = { name };
  if (command) {
    server.command = command;
    if (Array.isArray(table.args)) {
      server.args = table.args.map(scalarString).filter((arg): arg is string => arg !== null);
    }
    const env: Record<string, string> = { ...(stringTable(table.env) ?? {}) };
    if (Array.isArray(table.env_vars)) {
      for (const entry of table.env_vars) {
        if (typeof entry === "string" && entry.trim() && !(entry in env)) env[entry] = `\${${entry}}`;
      }
    }
    if (Object.keys(env).length > 0) server.env = env;
    if (typeof table.cwd === "string" && table.cwd.trim()) server.cwd = table.cwd;
  }
  if (url) {
    server.url = url;
    server.type = "streamable-http";
    const headers: Record<string, string> = { ...(stringTable(table.http_headers) ?? {}) };
    const envHeaders = stringTable(table.env_http_headers) ?? {};
    for (const [header, variable] of Object.entries(envHeaders)) {
      if (!(header in headers)) headers[header] = `\${${variable}}`;
    }
    if (typeof table.bearer_token_env_var === "string" && table.bearer_token_env_var.trim() &&
      !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.Authorization = `Bearer \${${table.bearer_token_env_var.trim()}}`;
    }
    if (Object.keys(headers).length > 0) server.headers = headers;
  }
  if (typeof table.enabled === "boolean") server.enabled = table.enabled;
  return server;
}

export function tomlMcpServersFromDocument(doc: Record<string, unknown>): McpServerConfig[] {
  const map = doc.mcp_servers;
  if (!isRecord(map)) return [];
  const servers: McpServerConfig[] = [];
  for (const [name, table] of Object.entries(map)) {
    const server = tomlTableToMcpServer(name, table);
    if (server) servers.push(server);
  }
  return servers;
}

/** Every name under mcp_servers, including entries without a usable command or url. */
export function tomlMcpServerNamesFromDocument(doc: Record<string, unknown>): string[] {
  const map = doc.mcp_servers;
  if (!isRecord(map)) return [];
  return Object.keys(map).filter((name) => name.trim() && isRecord(map[name]));
}

// Header-only fallback for a file the parser rejects, so a broken config still
// lists its servers (with no definition) instead of making them vanish.
export function scanTomlMcpServerNames(text: string): string[] {
  const names = new Set<string>();
  const sectionPattern =
    /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\]\s*(?:#.*)?$/gm;
  for (const match of text.matchAll(sectionPattern)) {
    const name = (match[1] || match[2] || match[3] || "").trim();
    if (name) names.add(name);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Line structure
// ---------------------------------------------------------------------------

interface TomlStatement {
  start: number;
  end: number;
  kind: "header" | "kv" | "trivia" | "other";
  path: string[];
  arrayTable?: boolean;
}

interface ScanState {
  multiline: '"""' | "'''" | null;
  depth: number;
}

function parseKeyPath(text: string, from: number): { path: string[]; next: number } | null {
  const path: string[] = [];
  let index = from;
  const skipSpace = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  };
  for (;;) {
    skipSpace();
    const char = text[index];
    if (char === '"') {
      let value = "";
      index += 1;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        if (current === "\\") {
          const escaped = text[index + 1] ?? "";
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          index += 2;
          continue;
        }
        if (current === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) return null;
      path.push(value);
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close === -1) return null;
      path.push(text.slice(index + 1, close));
      index = close + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
      if (!match) return null;
      path.push(match[0]);
      index += match[0].length;
    }
    skipSpace();
    if (text[index] !== ".") break;
    index += 1;
  }
  return { path, next: index };
}

function scanValue(text: string, from: number, state: ScanState): void {
  let index = from;
  while (index < text.length) {
    if (state.multiline) {
      const close = state.multiline;
      if (close === '"""' && text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text.startsWith(close, index)) {
        state.multiline = null;
        index += 3;
        while (text[index] === close[0]) index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    const char = text[index];
    if (char === "#") return;
    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      if (text.startsWith(triple, index)) {
        state.multiline = triple as ScanState["multiline"];
        index += 3;
        continue;
      }
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (char === '"' && text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "[" || char === "{") state.depth += 1;
    else if (char === "]" || char === "}") state.depth = Math.max(0, state.depth - 1);
    index += 1;
  }
}

function scanStatements(lines: string[]): TomlStatement[] {
  const statements: TomlStatement[] = [];
  const state: ScanState = { multiline: null, depth: 0 };
  let current: TomlStatement | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (current && (state.multiline || state.depth > 0)) {
      scanValue(line, 0, state);
      current.end = lineIndex;
      continue;
    }
    current = null;
    const trimmed = line.trimStart();
    const offset = line.length - trimmed.length;
    if (!trimmed || trimmed.startsWith("#")) {
      statements.push({ start: lineIndex, end: lineIndex, kind: "trivia", path: [] });
      continue;
    }
    if (trimmed.startsWith("[")) {
      const arrayTable = trimmed.startsWith("[[");
      const key = parseKeyPath(line, offset + (arrayTable ? 2 : 1));
      const closing = arrayTable ? "]]" : "]";
      if (key && line.slice(key.next).trimStart().startsWith(closing)) {
        statements.push({ start: lineIndex, end: lineIndex, kind: "header", path: key.path, arrayTable });
      } else {
        statements.push({ start: lineIndex, end: lineIndex, kind: "other", path: [] });
      }
      continue;
    }
    const key = parseKeyPath(line, offset);
    if (!key || line[key.next] !== "=") {
      statements.push({ start: lineIndex, end: lineIndex, kind: "other", path: [] });
      continue;
    }
    current = { start: lineIndex, end: lineIndex, kind: "kv", path: key.path };
    statements.push(current);
    scanValue(line, key.next + 1, state);
  }
  return statements;
}

interface TomlSection {
  header: TomlStatement | null;
  path: string[];
  body: TomlStatement[];
}

function groupSections(statements: TomlStatement[]): TomlSection[] {
  const sections: TomlSection[] = [{ header: null, path: [], body: [] }];
  for (const statement of statements) {
    if (statement.kind === "header") {
      sections.push({ header: statement, path: statement.path, body: [] });
    } else {
      sections[sections.length - 1].body.push(statement);
    }
  }
  return sections;
}

function lastContentLine(section: TomlSection): number {
  let end = section.header?.end ?? -1;
  for (const statement of section.body) {
    if (statement.kind !== "trivia") end = Math.max(end, statement.end);
  }
  return end;
}

function samePrefix(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

interface ServerLayout {
  main: TomlSection | null;
  subSections: TomlSection[];
  inline: TomlStatement[];
}

function serverLayout(sections: TomlSection[], name: string): ServerLayout {
  const own = ["mcp_servers", name];
  const layout: ServerLayout = { main: null, subSections: [], inline: [] };
  for (const section of sections) {
    if (section.header && !section.header.arrayTable && section.path.length === 2 && samePrefix(section.path, own)) {
      layout.main = section;
    } else if (section.header && section.path.length > 2 && samePrefix(section.path, own)) {
      layout.subSections.push(section);
    } else if (section.header && section.path.length === 1 && section.path[0] === "mcp_servers") {
      layout.inline.push(...section.body.filter((statement) => statement.kind === "kv" && statement.path[0] === name));
    } else if (!section.header) {
      layout.inline.push(...section.body.filter((statement) =>
        statement.kind === "kv" && statement.path[0] === "mcp_servers" && statement.path[1] === name));
    }
  }
  return layout;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Drops line ranges, then closes the blank-line gap each removal leaves so the
// rest of the file keeps its exact spacing.
function dropLines(lines: string[], ranges: Array<[number, number]>): string[] {
  const removed = new Set<number>();
  for (const [start, end] of ranges) {
    for (let index = start; index <= end; index += 1) removed.add(index);
  }
  const out: string[] = [];
  let pendingGap = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (removed.has(index)) {
      pendingGap = true;
      continue;
    }
    if (pendingGap) {
      pendingGap = false;
      const previousBlank = out.length === 0 || out[out.length - 1].trim() === "";
      if (previousBlank && lines[index].trim() === "") continue;
    }
    out.push(lines[index]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

interface RenderedServer {
  keys: string[];
  tables: Array<{ suffix: string; entries: Array<[string, string]> }>;
}

function renderModeledServer(server: McpServerConfig, options: { includeEnabled: boolean }): RenderedServer {
  const keys: string[] = [];
  const tables: RenderedServer["tables"] = [];
  if (server.command) {
    keys.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) keys.push(`args = [${server.args.map(tomlString).join(", ")}]`);
    const literal: Array<[string, string]> = [];
    const forwarded: string[] = [];
    for (const key of Object.keys(server.env ?? {}).sort()) {
      const value = server.env![key];
      const placeholder = ENV_PLACEHOLDER.exec(value);
      if (placeholder && placeholder[1] === key) forwarded.push(key);
      else literal.push([key, value]);
    }
    if (forwarded.length > 0) keys.push(`env_vars = [${forwarded.map(tomlString).join(", ")}]`);
    if (literal.length > 0) tables.push({ suffix: "env", entries: literal });
    if (server.cwd) keys.push(`cwd = ${tomlString(server.cwd)}`);
  }
  if (server.url) {
    keys.push(`url = ${tomlString(server.url)}`);
    const literal: Array<[string, string]> = [];
    const fromEnv: Array<[string, string]> = [];
    for (const header of Object.keys(server.headers ?? {}).sort()) {
      const value = server.headers![header];
      const bearer = BEARER_PLACEHOLDER.exec(value);
      if (bearer && header.toLowerCase() === "authorization") {
        keys.push(`bearer_token_env_var = ${tomlString(bearer[1])}`);
        continue;
      }
      const placeholder = ENV_PLACEHOLDER.exec(value);
      if (placeholder) fromEnv.push([header, placeholder[1]]);
      else literal.push([header, value]);
    }
    if (literal.length > 0) tables.push({ suffix: "http_headers", entries: literal });
    if (fromEnv.length > 0) tables.push({ suffix: "env_http_headers", entries: fromEnv });
  }
  if (server.enabled !== undefined || options.includeEnabled) {
    keys.push(`enabled = ${server.enabled === false ? "false" : "true"}`);
  }
  return { keys, tables };
}

function renderTables(name: string, tables: RenderedServer["tables"]): string[] {
  const lines: string[] = [];
  for (const table of tables) {
    lines.push("", `[mcp_servers.${tomlKey(name)}.${table.suffix}]`);
    for (const [key, value] of table.entries) lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
  }
  return lines;
}

/** A complete, freshly written server: header, keys, then its sub-tables. */
export function renderTomlMcpServer(server: McpServerConfig): string[] {
  const rendered = renderModeledServer(server, { includeEnabled: true });
  return [
    "",
    `[mcp_servers.${tomlKey(server.name)}]`,
    ...rendered.keys,
    ...renderTables(server.name, rendered.tables),
  ];
}

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

const MODELED_KEYS = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "url",
  "http_headers",
  "env_http_headers",
  "bearer_token_env_var",
]);
// Keys that only make sense for one transport, dropped when an edit switches.
// The edit form carries no cwd, so an edit keeps the file's own cwd line; a
// definition that carries one (a copy from another config) replaces it.
const STDIO_ONLY_KEYS = new Set(["cwd"]);

function comparable(server: McpServerConfig | null): string {
  if (!server) return "null";
  return JSON.stringify({
    command: server.command ?? null,
    args: server.command ? server.args ?? [] : null,
    env: server.command ? sortedRecord(server.env) : null,
    url: server.url ?? null,
    headers: server.url ? sortedRecord(server.headers) : null,
  });
}

function sortedRecord(record?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function requireParsed(text: string, label: string): Record<string, unknown> {
  const parsed = parseTomlText(text);
  if (!parsed.ok) throw new Error(`Could not parse ${label}: ${parsed.error}`);
  return parsed.value;
}

/**
 * Create or update one server in place. Keys the Capability Center does not
 * model (cwd, startup_timeout_sec, tool_timeout_sec, enabled_tools, tools.*,
 * enabled) keep their original lines; only the modeled keys and their
 * sub-tables are rewritten. Every other byte of the file is left alone, and
 * the result is parsed back before it is returned, so a splice that would
 * corrupt the file throws instead.
 */
export function upsertTomlMcpServer(text: string, server: McpServerConfig, label = "config.toml"): string {
  const doc = requireParsed(text, label);
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const sections = groupSections(scanStatements(lines));
  const layout = serverLayout(sections, server.name);
  const existed = isRecord((doc.mcp_servers as Record<string, unknown> | undefined)?.[server.name]);
  let nextLines: string[];

  if (!existed || !layout.main) {
    const ranges: Array<[number, number]> = [
      ...layout.inline.map((statement): [number, number] => [statement.start, statement.end]),
      ...layout.subSections.map((section): [number, number] => [section.header!.start, lastContentLine(section)]),
    ];
    const base = dropLines(lines, ranges).join(eol).trimEnd();
    const block = renderTomlMcpServer(server).join(eol).trimStart();
    nextLines = [base, block].filter(Boolean).join(`${eol}${eol}`).split(eol);
    nextLines.push("");
  } else {
    const main = layout.main;
    const rendered = renderModeledServer(server, { includeEnabled: false });
    const dropKey = (key: string) =>
      MODELED_KEYS.has(key) ||
      (Boolean(server.url) && STDIO_ONLY_KEYS.has(key)) ||
      (key === "cwd" && Boolean(server.command && server.cwd)) ||
      (key === "enabled" && server.enabled !== undefined);
    const ranges: Array<[number, number]> = [];
    for (const statement of main.body) {
      if (statement.kind === "kv" && dropKey(statement.path[0])) ranges.push([statement.start, statement.end]);
    }
    for (const section of layout.subSections) {
      if (dropKey(section.path[2])) ranges.push([section.header!.start, lastContentLine(section)]);
    }
    for (const statement of layout.inline) ranges.push([statement.start, statement.end]);
    const insertAfter = lastContentLine(main);
    const insertion = [...rendered.keys, ...renderTables(server.name, rendered.tables)];
    const removed = new Set<number>();
    for (const [start, end] of ranges) for (let index = start; index <= end; index += 1) removed.add(index);
    const withInsertion: string[] = [];
    const removedRanges: Array<[number, number]> = [];
    for (let index = 0; index < lines.length; index += 1) {
      withInsertion.push(lines[index]);
      if (removed.has(index)) removedRanges.push([withInsertion.length - 1, withInsertion.length - 1]);
      if (index === insertAfter) withInsertion.push(...insertion);
    }
    nextLines = dropLines(withInsertion, removedRanges);
  }

  const next = nextLines.join(eol);
  const check = requireParsed(next, label);
  const written = tomlTableToMcpServer(server.name, (check.mcp_servers as Record<string, unknown> | undefined)?.[server.name]);
  if (comparable(written) !== comparable(server)) {
    throw new Error(`Could not update '${server.name}' in ${label} without changing other entries. Edit the file by hand.`);
  }
  return next;
}

/**
 * Rename one server where it sits: its table header, its
 * `[mcp_servers.<from>.*]` sub-table headers and any inline `from = {...}` or
 * `mcp_servers.from.*` keys. Every key under it (enabled, cwd, timeouts,
 * tools.* approvals) is untouched, which a remove-and-recreate would lose.
 */
export function renameTomlMcpServer(text: string, from: string, to: string, label = "config.toml"): string {
  const doc = requireParsed(text, label);
  if (from === to) return text;
  const servers = doc.mcp_servers as Record<string, unknown> | undefined;
  if (!isRecord(servers?.[from])) return text;
  if (servers && to in servers) throw new Error(`'${to}' already exists in ${label}.`);
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const layout = serverLayout(groupSections(scanStatements(lines)), from);
  const renamePath = (path: string[], at: number) =>
    path.map((segment, index) => tomlKey(index === at ? to : segment)).join(".");
  for (const section of [...(layout.main ? [layout.main] : []), ...layout.subSections]) {
    const header = section.header!;
    const line = lines[header.start];
    const open = line.indexOf("[");
    const key = parseKeyPath(line, open + 1);
    if (!key) throw new Error(`Could not rename '${from}' in ${label}. Edit the file by hand.`);
    const close = line.indexOf("]", key.next);
    lines[header.start] = `${line.slice(0, open)}[${renamePath(section.path, 1)}${line.slice(close)}`;
  }
  for (const statement of layout.inline) {
    const line = lines[statement.start];
    const offset = line.length - line.trimStart().length;
    const key = parseKeyPath(line, offset);
    if (!key) throw new Error(`Could not rename '${from}' in ${label}. Edit the file by hand.`);
    const at = statement.path[0] === "mcp_servers" ? 1 : 0;
    lines[statement.start] = `${line.slice(0, offset)}${renamePath(statement.path, at)} ${line.slice(key.next)}`;
  }
  const next = lines.join(eol);
  const check = requireParsed(next, label);
  const renamed = check.mcp_servers as Record<string, unknown> | undefined;
  if (
    isRecord(renamed?.[from]) ||
    JSON.stringify(renamed?.[to]) !== JSON.stringify(servers?.[from])
  ) {
    throw new Error(`Could not rename '${from}' to '${to}' in ${label}. Edit the file by hand.`);
  }
  return next;
}

/**
 * Remove every table, sub-table and inline key that defines `name`. Comment
 * lines after the server's last key stay, so a managed block's end marker that
 * follows the last server in the block survives.
 */
export function removeTomlMcpServer(text: string, name: string, label = "config.toml"): string {
  requireParsed(text, label);
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const layout = serverLayout(groupSections(scanStatements(lines)), name);
  const ranges: Array<[number, number]> = [
    ...layout.inline.map((statement): [number, number] => [statement.start, statement.end]),
    ...layout.subSections.map((section): [number, number] => [section.header!.start, lastContentLine(section)]),
  ];
  if (layout.main) ranges.push([layout.main.header!.start, lastContentLine(layout.main)]);
  if (ranges.length === 0) return text;
  const next = dropLines(lines, ranges).join(eol);
  const check = requireParsed(next, label);
  if (isRecord((check.mcp_servers as Record<string, unknown> | undefined)?.[name])) {
    throw new Error(`Could not remove '${name}' from ${label}. Edit the file by hand.`);
  }
  return next;
}
