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

import type {
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
  SparkBuiltinRuntimeStatus,
} from "@shared/types";

import { writeFileAtomic } from "./fs-atomic";

const SERVER_NAME = "spark-preview";
const LEGACY_SERVER_NAME = "playwright";
const SPARK_VERSION = "1";

export const SPARK_ORCHESTRATOR_SERVER_NAME = "spark-orchestrator";
const ORCHESTRATOR_SPARK_VERSION = "1";

// Tool rosters kept in sync with resources/spark-*-mcp/server.js so the
// Capability Center can show "N tools" without spawning the servers.
const SPARK_PREVIEW_TOOLS = [
  "spark_preview_list",
  "spark_preview_url",
  "spark_preview_navigate",
  "spark_preview_snapshot",
  "spark_preview_click",
  "spark_preview_type",
  "spark_preview_press_key",
  "spark_preview_evaluate",
  "spark_preview_wait_for",
  "spark_preview_screenshot",
  "spark_preview_run",
];

const SPARK_ORCHESTRATOR_TOOLS = [
  "spark_spawn_workers",
  "spark_ask_user",
  "spark_complete",
  "spark_get_worker_status",
  "spark_wait_for_workers",
];

const CLAUDE_USER_CONFIG = join(homedir(), ".claude.json");
const CODEX_USER_CONFIG = join(homedir(), ".codex", "config.toml");
const CODEX_DIR = join(homedir(), ".codex");

const CODEX_BLOCK_START = "# >>> SPARK_AGENT_BUILTIN_MCP";
const CODEX_BLOCK_END = "# <<< SPARK_AGENT_BUILTIN_MCP";

const CODEX_ORCHESTRATOR_BLOCK_START = "# >>> SPARK_AGENT_ORCHESTRATOR_MCP";
const CODEX_ORCHESTRATOR_BLOCK_END = "# <<< SPARK_AGENT_ORCHESTRATOR_MCP";

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

function resolveOrchestratorServerScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "spark-orchestrator-mcp", "server.js");
  }
  return join(__dirname, "..", "..", "resources", "spark-orchestrator-mcp", "server.js");
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

function buildOrchestratorServerArgs(): string[] {
  return [resolveOrchestratorServerScript()];
}

function buildOrchestratorServerEnv(): Record<string, string> {
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

// Per-runtime entry points used by the Capability Center's explicit install
// buttons. `createIfMissing` lets a deliberate user action create the config
// file/dir when the runtime CLI is present but hasn't written one yet — the
// boot-time auto-installer never passes this (design rule #3: stay conservative).
export async function installSparkPreviewMcpForClaude(createIfMissing = false): Promise<void> {
  await installForClaude(createIfMissing);
}

export async function installSparkPreviewMcpForCodex(createIfMissing = false): Promise<void> {
  await installForCodex(createIfMissing);
}

// ---------------------------------------------------------------------------
// Claude (~/.claude.json)
// ---------------------------------------------------------------------------

async function installForClaude(createIfMissing = false): Promise<void> {
  const fileExists = existsSync(CLAUDE_USER_CONFIG);
  if (!fileExists && !createIfMissing) return;

  let raw = "";
  if (fileExists) {
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch (err) {
      console.warn("[mcp-installer] could not read ~/.claude.json:", err);
      return;
    }
  }

  let parsed: Record<string, unknown>;
  if (raw.trim()) {
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
  } else {
    parsed = {};
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

async function installForCodex(createIfMissing = false): Promise<void> {
  const dirExists = directoryExists(CODEX_DIR);
  if (!dirExists && !createIfMissing) return;
  if (!dirExists) {
    try {
      await fs.mkdir(CODEX_DIR, { recursive: true });
    } catch (err) {
      console.warn("[mcp-installer] could not create ~/.codex:", err);
      return;
    }
  }

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

// ---------------------------------------------------------------------------
// spark-orchestrator MCP — installed on demand, NOT on app boot
// ---------------------------------------------------------------------------
//
// The orchestrator MCP server gives the CLI (claude / codex) running in
// Execute mode access to spark_spawn_workers / spark_ask_user /
// spark_complete / spark_get_worker_status. It is wired into the SAME user
// configs as spark-preview (~/.claude.json + ~/.codex/config.toml), but the
// backends call installOrchestratorMcpFor*() lazily before spawning so
// passive users who never run Execute mode don't get the entry written.

function renderOrchestratorClaudeEntry(): ManagedClaudeMcpServer {
  return {
    type: "stdio",
    command: resolveNodeCommand(),
    args: buildOrchestratorServerArgs(),
    env: buildOrchestratorServerEnv(),
    _sparkManaged: true,
    _sparkVersion: ORCHESTRATOR_SPARK_VERSION,
  };
}

function orchestratorMatchesCurrent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry._sparkVersion !== ORCHESTRATOR_SPARK_VERSION) return false;
  if (entry.command !== resolveNodeCommand()) return false;
  const expectedArgs = buildOrchestratorServerArgs();
  if (!Array.isArray(entry.args)) return false;
  const args = entry.args as unknown[];
  if (args.length !== expectedArgs.length) return false;
  if (!args.every((arg, i) => arg === expectedArgs[i])) return false;
  const env = entry.env as Record<string, unknown> | undefined;
  if (!env || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  return true;
}

export async function installOrchestratorMcpForCC(createIfMissing = false): Promise<void> {
  const fileExists = existsSync(CLAUDE_USER_CONFIG);
  if (!fileExists && !createIfMissing) return;

  let raw = "";
  if (fileExists) {
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch (err) {
      console.warn("[mcp-installer] could not read ~/.claude.json:", err);
      return;
    }
  }

  let parsed: Record<string, unknown>;
  if (raw.trim()) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        console.warn("[mcp-installer] ~/.claude.json is not a JSON object; skipping orchestrator install");
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[mcp-installer] ~/.claude.json parse failed; skipping orchestrator install:",
        (err as Error).message,
      );
      return;
    }
  } else {
    parsed = {};
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

  const existing = servers[SPARK_ORCHESTRATOR_SERVER_NAME];
  if (existing && !isSparkManaged(existing)) {
    // User owns this entry — never overwrite.
    return;
  }
  if (existing && orchestratorMatchesCurrent(existing)) {
    return;
  }

  servers[SPARK_ORCHESTRATOR_SERVER_NAME] = renderOrchestratorClaudeEntry();
  parsed.mcpServers = servers;
  try {
    const payload = JSON.stringify(parsed, null, 2) + "\n";
    if (raw === payload) return;
    await writeFileAtomic(CLAUDE_USER_CONFIG, payload);
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.claude.json (orchestrator):", err);
  }
}

function hasUserOrchestratorSection(text: string): boolean {
  const withoutManaged = stripOrchestratorBlock(text);
  const pattern =
    /^\s*\[mcp_servers\.(?:"spark-orchestrator"|'spark-orchestrator'|spark-orchestrator)\]\s*$/m;
  return pattern.test(withoutManaged);
}

function stripOrchestratorBlock(text: string): string {
  const start = text.indexOf(CODEX_ORCHESTRATOR_BLOCK_START);
  const end = text.indexOf(CODEX_ORCHESTRATOR_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return text;
  const after = end + CODEX_ORCHESTRATOR_BLOCK_END.length;
  return `${text.slice(0, start).trimEnd()}\n${text.slice(after).trimStart()}`.trimEnd() + "\n";
}

function renderOrchestratorCodexBlock(): string {
  const args = buildOrchestratorServerArgs();
  return [
    CODEX_ORCHESTRATOR_BLOCK_START,
    `# Managed by Spark App. Auto-installs the spark-orchestrator MCP so the`,
    `# Codex CLI running in Execute mode can spawn Spark workers, ask the user`,
    `# clarifying questions, and mark the run complete. Disable via Settings >`,
    `# Capabilities or delete this block (Spark will re-add it on the next`,
    `# Execute-mode spawn unless the auto-install toggle is off).`,
    `# Version: ${ORCHESTRATOR_SPARK_VERSION}`,
    "",
    `[mcp_servers."${SPARK_ORCHESTRATOR_SERVER_NAME}"]`,
    `command = ${tomlString(resolveNodeCommand())}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `enabled = true`,
    "",
    `[mcp_servers."${SPARK_ORCHESTRATOR_SERVER_NAME}".env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    CODEX_ORCHESTRATOR_BLOCK_END,
  ].join("\n");
}

export async function installOrchestratorMcpForCodex(createIfMissing = false): Promise<void> {
  const dirExists = directoryExists(CODEX_DIR);
  if (!dirExists && !createIfMissing) return;
  if (!dirExists) {
    try {
      await fs.mkdir(CODEX_DIR, { recursive: true });
    } catch (err) {
      console.warn("[mcp-installer] could not create ~/.codex (orchestrator):", err);
      return;
    }
  }

  let existing = "";
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mcp-installer] could not read ~/.codex/config.toml (orchestrator):", err);
      return;
    }
  }

  // If the user has a non-Spark `spark-orchestrator` server defined outside
  // our managed block, leave the file alone.
  if (hasUserOrchestratorSection(existing)) return;

  const stripped = stripOrchestratorBlock(existing);
  const block = renderOrchestratorCodexBlock();
  const base = stripped.trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  if (next === existing) return;

  try {
    await fs.writeFile(CODEX_USER_CONFIG, next, "utf8");
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.codex/config.toml (orchestrator):", err);
  }
}

export async function isSparkOrchestratorMcpInstalled(
  target: "claude" | "codex",
): Promise<boolean> {
  if (target === "claude") {
    if (!existsSync(CLAUDE_USER_CONFIG)) return false;
    let raw: string;
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
    const entry = (servers as Record<string, unknown>)[SPARK_ORCHESTRATOR_SERVER_NAME];
    if (!entry) return false;
    // If a user-owned entry exists we consider it installed (don't reinstall
    // over it). If a Spark-managed entry exists, only treat it as installed
    // when it matches the current version + script path.
    if (!isSparkManaged(entry)) return true;
    return orchestratorMatchesCurrent(entry);
  }

  // target === "codex"
  if (!directoryExists(CODEX_DIR)) return false;
  let existing = "";
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
  if (hasUserOrchestratorSection(existing)) return true;
  // Managed block present?
  return (
    existing.includes(CODEX_ORCHESTRATOR_BLOCK_START) &&
    existing.includes(CODEX_ORCHESTRATOR_BLOCK_END)
  );
}

// ---------------------------------------------------------------------------
// Spark built-in status + per-runtime install/uninstall (Capability Center)
// ---------------------------------------------------------------------------
//
// The Capability Center renders spark-preview and spark-orchestrator in their
// own branded section with per-runtime install controls. These functions are
// the backend for that surface: they report where each built-in is installed
// and let the user add/remove it from a single runtime at a time.

interface SparkBuiltinMeta {
  id: SparkBuiltinMcpId;
  serverName: string;
  summary: string;
  detail: string;
  tools: string[];
  autoManaged: boolean;
}

function builtinMeta(autoInstallEnabled: boolean): SparkBuiltinMeta[] {
  return [
    {
      id: "spark-preview",
      serverName: SERVER_NAME,
      summary: "Drive the live preview tab",
      detail:
        "Lets verifier and worker agents click, type, snapshot, screenshot, and run JS against the exact <preview> DOM the user sees inside Spark — no extra browser window.",
      tools: SPARK_PREVIEW_TOOLS,
      autoManaged: autoInstallEnabled,
    },
    {
      id: "spark-orchestrator",
      serverName: SPARK_ORCHESTRATOR_SERVER_NAME,
      summary: "Spawn & steer workers in Execute mode",
      detail:
        "Gives the Claude/Codex CLI running in Execute mode the tools to spawn Spark workers, ask you clarifying questions, poll worker status, and mark the run complete. Installed automatically the first time you start an Execute-mode run.",
      tools: SPARK_ORCHESTRATOR_TOOLS,
      autoManaged: false,
    },
  ];
}

export async function getSparkBuiltinStatus(input: {
  claudeRuntimeAvailable: boolean;
  codexRuntimeAvailable: boolean;
  autoInstallEnabled: boolean;
}): Promise<SparkBuiltinMcpStatus[]> {
  const metas = builtinMeta(input.autoInstallEnabled);
  return Promise.all(
    metas.map(async (meta) => {
      const codexKind = meta.id === "spark-preview" ? "preview" : "orchestrator";
      const [claude, codex] = await Promise.all([
        detectClaudeBuiltinState(meta.serverName, input.claudeRuntimeAvailable),
        detectCodexBuiltinState(codexKind, input.codexRuntimeAvailable),
      ]);
      return {
        id: meta.id,
        name: meta.serverName,
        summary: meta.summary,
        detail: meta.detail,
        tools: meta.tools,
        autoManaged: meta.autoManaged,
        claude,
        codex,
      } satisfies SparkBuiltinMcpStatus;
    }),
  );
}

export async function installSparkBuiltin(
  id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
): Promise<SparkBuiltinActionResult> {
  try {
    if (id === "spark-preview") {
      if (runtime === "claude") await installSparkPreviewMcpForClaude(true);
      else await installSparkPreviewMcpForCodex(true);
    } else if (runtime === "claude") {
      await installOrchestratorMcpForCC(true);
    } else {
      await installOrchestratorMcpForCodex(true);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallSparkBuiltin(
  id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
): Promise<SparkBuiltinActionResult> {
  try {
    const serverName = id === "spark-preview" ? SERVER_NAME : SPARK_ORCHESTRATOR_SERVER_NAME;
    if (runtime === "claude") return await uninstallManagedClaudeServer(serverName);
    return await uninstallCodexBuiltinBlock(id === "spark-preview" ? "preview" : "orchestrator");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function detectClaudeBuiltinState(
  serverName: string,
  runtimeAvailable: boolean,
): Promise<SparkBuiltinRuntimeStatus> {
  const entry = await readClaudeServerEntry(serverName);
  if (entry !== undefined) {
    return {
      state: isSparkManaged(entry) ? "installed" : "user-managed",
      configPath: CLAUDE_USER_CONFIG,
    };
  }
  return { state: runtimeAvailable ? "available" : "unavailable", configPath: CLAUDE_USER_CONFIG };
}

async function detectCodexBuiltinState(
  kind: "preview" | "orchestrator",
  runtimeAvailable: boolean,
): Promise<SparkBuiltinRuntimeStatus> {
  let existing = "";
  if (existsSync(CODEX_USER_CONFIG)) {
    try {
      existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
    } catch {
      existing = "";
    }
  }
  const hasUserSection =
    kind === "preview" ? hasUserSparkPreviewSection(existing) : hasUserOrchestratorSection(existing);
  if (hasUserSection) return { state: "user-managed", configPath: CODEX_USER_CONFIG };
  const managed =
    kind === "preview"
      ? existing.includes(CODEX_BLOCK_START) && existing.includes(CODEX_BLOCK_END)
      : existing.includes(CODEX_ORCHESTRATOR_BLOCK_START) &&
        existing.includes(CODEX_ORCHESTRATOR_BLOCK_END);
  if (managed) return { state: "installed", configPath: CODEX_USER_CONFIG };
  return { state: runtimeAvailable ? "available" : "unavailable", configPath: CODEX_USER_CONFIG };
}

async function readClaudeServerEntry(serverName: string): Promise<unknown | undefined> {
  if (!existsSync(CLAUDE_USER_CONFIG)) return undefined;
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return undefined;
  return (servers as Record<string, unknown>)[serverName];
}

// Remove a Spark-managed entry from ~/.claude.json. Refuses to touch a
// user-defined entry of the same name and treats "already absent" as success.
async function uninstallManagedClaudeServer(serverName: string): Promise<SparkBuiltinActionResult> {
  if (!existsSync(CLAUDE_USER_CONFIG)) return { ok: true };
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ~/.claude.json: ${(err as Error).message}` };
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: true };
    parsed = value as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `~/.claude.json parse failed: ${(err as Error).message}` };
  }
  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : null;
  if (!servers || !(serverName in servers)) return { ok: true };
  if (!isSparkManaged(servers[serverName])) {
    return {
      ok: false,
      error: `'${serverName}' is a user-defined entry in ~/.claude.json; Spark won't remove it.`,
    };
  }
  delete servers[serverName];
  parsed.mcpServers = servers;
  try {
    await writeFileAtomic(CLAUDE_USER_CONFIG, JSON.stringify(parsed, null, 2) + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write ~/.claude.json: ${(err as Error).message}` };
  }
}

// Strip the Spark-managed Codex block. Refuses when the user keeps their own
// section outside the managed markers.
async function uninstallCodexBuiltinBlock(
  kind: "preview" | "orchestrator",
): Promise<SparkBuiltinActionResult> {
  if (!existsSync(CODEX_USER_CONFIG)) return { ok: true };
  let existing: string;
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ~/.codex/config.toml: ${(err as Error).message}` };
  }
  const serverName = kind === "preview" ? SERVER_NAME : SPARK_ORCHESTRATOR_SERVER_NAME;
  const hasUserSection =
    kind === "preview" ? hasUserSparkPreviewSection(existing) : hasUserOrchestratorSection(existing);
  if (hasUserSection) {
    return {
      ok: false,
      error: `A user-defined ${serverName} section exists in config.toml; Spark won't remove it.`,
    };
  }
  const next = kind === "preview" ? stripBuiltinBlock(existing) : stripOrchestratorBlock(existing);
  if (next === existing) return { ok: true };
  try {
    await fs.writeFile(CODEX_USER_CONFIG, next, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write ~/.codex/config.toml: ${(err as Error).message}` };
  }
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
  // Orchestrator-specific
  SPARK_ORCHESTRATOR_SERVER_NAME,
  ORCHESTRATOR_SPARK_VERSION,
  CODEX_ORCHESTRATOR_BLOCK_START,
  CODEX_ORCHESTRATOR_BLOCK_END,
  resolveOrchestratorServerScript,
  renderOrchestratorClaudeEntry,
  renderOrchestratorCodexBlock,
  hasUserOrchestratorSection,
  stripOrchestratorBlock,
  orchestratorMatchesCurrent,
};
