// spark-preview MCP auto-installer — registers a tiny stdio MCP server in
// the user-scope Claude and Codex configs so every sub-agent Spark spawns
// (including verifier passes) can drive the actual <preview> tab inside
// Spark App. The server lives at resources/spark-preview-mcp/server.js
// and proxies JSON-RPC calls back to Spark's agent-socket loopback HTTP
// channel. See preview-bridge.ts + previewRpc.ts for the round-trip.
//
// Design mirrors hook-installer.ts:
// 1. Idempotent. JSON entries are tagged `_sparkManaged: true` + version;
//    Codex TOML insertion lives in a dedicated managed block (`SPARK_AGENT_
//    BUILTIN_MCP`) so it never fights the agent-sync managed block.
// 2. Non-destructive. If the user already has a non-Spark `spark-preview`
//    entry, we leave it alone. We never touch user-owned `playwright`
//    entries (the user may have installed Playwright MCP separately).
// 3. Conservative. We only touch a config file if it (or its parent dir)
//    already exists — no foreign config gets created in clean homedirs.
// 4. Fire-and-forget. Errors are logged; they never block startup.
// 5. Cleanup. Any old Spark-managed `playwright` entries from earlier
//    Spark versions are removed on every launch.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./fs-atomic";

const SERVER_NAME = "spark-preview";
const LEGACY_SERVER_NAME = "playwright";
const SPARK_VERSION = "1";

const CLAUDE_USER_CONFIG = join(homedir(), ".claude.json");
const CODEX_USER_CONFIG = join(homedir(), ".codex", "config.toml");
const CODEX_DIR = join(homedir(), ".codex");

const CODEX_BLOCK_START = "# >>> SPARK_AGENT_BUILTIN_MCP";
const CODEX_BLOCK_END = "# <<< SPARK_AGENT_BUILTIN_MCP";

interface ManagedClaudeMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  _sparkManaged: true;
  _sparkVersion: string;
}

function resolveServerScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "spark-preview-mcp", "server.js");
  }
  return join(__dirname, "..", "..", "resources", "spark-preview-mcp", "server.js");
}

function resolveNodeCommand(): string {
  // process.execPath inside Electron points at the Electron binary, which
  // ALSO works as a Node interpreter when ELECTRON_RUN_AS_NODE=1 is set in
  // the spawned env. That keeps us from depending on a system Node install.
  // We pass ELECTRON_RUN_AS_NODE via the entry's env field.
  return process.execPath;
}

function buildServerArgs(): string[] {
  return [resolveServerScript()];
}

function buildServerEnv(): Record<string, string> {
  return { ELECTRON_RUN_AS_NODE: "1" };
}

// Install (or refresh) the spark-preview entry and remove any old Spark-
// managed Playwright entries from previous versions.
export async function installPlaywrightMcp(): Promise<void> {
  // Keep the old function name so existing callers stay compatible — the
  // wrapper just delegates. New code should call installSparkPreviewMcp.
  await installSparkPreviewMcp();
}

export async function installSparkPreviewMcp(): Promise<void> {
  await Promise.all([installForClaude(), installForCodex()]);
}

// ---------------------------------------------------------------------------
// Claude (~/.claude.json)
// ---------------------------------------------------------------------------

async function installForClaude(): Promise<void> {
  if (!existsSync(CLAUDE_USER_CONFIG)) return;

  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
  } catch (err) {
    console.warn("[mcp-installer] could not read ~/.claude.json:", err);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      console.warn("[mcp-installer] ~/.claude.json is not a JSON object; skipping");
      return;
    }
    parsed = value as Record<string, unknown>;
  } catch (err) {
    console.warn("[mcp-installer] ~/.claude.json parse failed; skipping:", (err as Error).message);
    return;
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

  let changed = false;

  // Cleanup: remove a Spark-managed legacy `playwright` entry if present.
  // Never touch a user-owned playwright entry.
  if (servers[LEGACY_SERVER_NAME] && isSparkManaged(servers[LEGACY_SERVER_NAME])) {
    delete servers[LEGACY_SERVER_NAME];
    changed = true;
  }

  const existing = servers[SERVER_NAME];
  if (existing && !isSparkManaged(existing)) {
    // User owns this entry — never overwrite. If we made any cleanup change,
    // still write.
  } else if (!existing || !matchesCurrent(existing)) {
    servers[SERVER_NAME] = renderClaudeEntry();
    changed = true;
  }

  if (!changed) return;

  parsed.mcpServers = servers;
  try {
    const payload = JSON.stringify(parsed, null, 2) + "\n";
    if (raw === payload) return;
    await writeFileAtomic(CLAUDE_USER_CONFIG, payload);
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.claude.json:", err);
  }
}

function renderClaudeEntry(): ManagedClaudeMcpServer {
  return {
    type: "stdio",
    command: resolveNodeCommand(),
    args: buildServerArgs(),
    env: buildServerEnv(),
    _sparkManaged: true,
    _sparkVersion: SPARK_VERSION,
  };
}

function isSparkManaged(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)._sparkManaged === true
  );
}

function matchesCurrent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry._sparkVersion !== SPARK_VERSION) return false;
  if (entry.command !== resolveNodeCommand()) return false;
  const expectedArgs = buildServerArgs();
  if (!Array.isArray(entry.args)) return false;
  const args = entry.args as unknown[];
  if (args.length !== expectedArgs.length) return false;
  if (!args.every((arg, i) => arg === expectedArgs[i])) return false;
  const env = entry.env as Record<string, unknown> | undefined;
  if (!env || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Codex (~/.codex/config.toml)
// ---------------------------------------------------------------------------

async function installForCodex(): Promise<void> {
  if (!directoryExists(CODEX_DIR)) return;

  let existing = "";
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mcp-installer] could not read ~/.codex/config.toml:", err);
      return;
    }
  }

  // If the user has a non-Spark `spark-preview` server defined outside our
  // managed block, leave the file alone.
  if (hasUserSparkPreviewSection(existing)) return;

  const stripped = stripBuiltinBlock(existing);
  const block = renderCodexBlock();
  const base = stripped.trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  if (next === existing) return;

  try {
    await fs.writeFile(CODEX_USER_CONFIG, next, "utf8");
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.codex/config.toml:", err);
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasUserSparkPreviewSection(text: string): boolean {
  const withoutBuiltin = stripBuiltinBlock(text);
  const pattern = /^\s*\[mcp_servers\.(?:"spark-preview"|'spark-preview'|spark-preview)\]\s*$/m;
  return pattern.test(withoutBuiltin);
}

function stripBuiltinBlock(text: string): string {
  const start = text.indexOf(CODEX_BLOCK_START);
  const end = text.indexOf(CODEX_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return text;
  const after = end + CODEX_BLOCK_END.length;
  return `${text.slice(0, start).trimEnd()}\n${text.slice(after).trimStart()}`.trimEnd() + "\n";
}

function renderCodexBlock(): string {
  const args = buildServerArgs();
  return [
    CODEX_BLOCK_START,
    `# Managed by Spark App. Auto-installs the spark-preview MCP so verifier`,
    `# passes can drive the live <preview> tab inside Spark. Disable via`,
    `# Settings > Capabilities or delete this block (Spark will re-add it on`,
    `# next launch unless the auto-install toggle is off).`,
    `# Version: ${SPARK_VERSION}`,
    "",
    `[mcp_servers."${SERVER_NAME}"]`,
    `command = ${tomlString(resolveNodeCommand())}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `enabled = true`,
    "",
    `[mcp_servers."${SERVER_NAME}".env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    CODEX_BLOCK_END,
  ].join("\n");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Availability detection
// ---------------------------------------------------------------------------

// True when sub-agent prompts should be told to USE the spark-preview MCP.
// True if either (a) auto-install is on AND a Claude/Codex runtime is on
// disk (so we know we wrote an entry), or (b) the user has a spark-preview
// entry of their own in any user/workspace config.
export function isSparkPreviewMcpAvailable(input: {
  cwd: string | null;
  autoInstallEnabled: boolean;
}): boolean {
  if (input.autoInstallEnabled) {
    if (existsSync(CLAUDE_USER_CONFIG)) return true;
    if (existsSync(CODEX_DIR)) return true;
  }
  return detectUserSparkPreviewEntry(input.cwd);
}

// Back-compat shim — orchestration code still imports this name. Will be
// renamed in a follow-up.
export function isPlaywrightMcpAvailable(input: {
  cwd: string | null;
  autoInstallEnabled: boolean;
}): boolean {
  return isSparkPreviewMcpAvailable(input);
}

function detectUserSparkPreviewEntry(cwd: string | null): boolean {
  const jsonCandidates = [
    CLAUDE_USER_CONFIG,
    join(homedir(), ".mcp.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  if (cwd) {
    jsonCandidates.push(join(cwd, ".mcp.json"));
    jsonCandidates.push(join(cwd, ".claude", "settings.json"));
    jsonCandidates.push(join(cwd, ".claude", "settings.local.json"));
  }
  for (const path of jsonCandidates) {
    if (jsonHasServer(path, SERVER_NAME)) return true;
  }
  const tomlCandidates = [CODEX_USER_CONFIG];
  if (cwd) tomlCandidates.push(join(cwd, ".codex", "config.toml"));
  for (const path of tomlCandidates) {
    if (tomlHasUserSparkPreviewSectionAt(path)) return true;
  }
  return false;
}

function jsonHasServer(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return jsonContainsServerName(parsed, name, 0);
}

function jsonContainsServerName(value: unknown, name: string, depth: number): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "mcpServers" || key === "mcp_servers") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.prototype.hasOwnProperty.call(child, name)
    ) {
      return true;
    }
    if (jsonContainsServerName(child, name, depth + 1)) return true;
  }
  return false;
}

function tomlHasUserSparkPreviewSectionAt(path: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return hasUserSparkPreviewSection(raw);
}

// Test/diagnostic surface.
export const __test = {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  SPARK_VERSION,
  CLAUDE_USER_CONFIG,
  CODEX_USER_CONFIG,
  CODEX_BLOCK_START,
  CODEX_BLOCK_END,
  renderClaudeEntry,
  renderCodexBlock,
  hasUserSparkPreviewSection,
  stripBuiltinBlock,
  matchesCurrent,
  resolveServerScript,
  resolveNodeCommand,
};
