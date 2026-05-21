import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  AgentAssetCompatibility,
  AgentSyncResult,
  AppSettings,
  WorkerRuntime,
} from "@shared/types";
import type {
  AgentAssetDeleteResult,
  AgentAssetInventory,
  AgentAssetInventoryItem,
} from "@shared/types";

type SyncKind = "mcp" | "skill";
type SyncSourceRuntime = "claude" | "codex" | "shared";
type SyncScope = "user" | "workspace";

interface SyncSource {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
  names: string[];
}

interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  enabled?: boolean;
}

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SKILL_DOC_BYTES = 16 * 1024;
const MAX_NAMES_PER_LINE = 12;
const MAX_SOURCE_LINES = 8;
const MCP_SYNC_START = "# >>> SPARK_AGENT_MCP_SYNC";
const MCP_SYNC_END = "# <<< SPARK_AGENT_MCP_SYNC";
const CODEX_SYSTEM_SKILL_ROOT = `${normalizePathForMatch(join(".codex", "skills", ".system"))}`;

export function renderAgentSyncPromptLines(input: {
  cwd: string;
  runtime: WorkerRuntime;
  settings: Pick<AppSettings, "agentMcpSyncEnabled" | "agentSkillSyncEnabled" | "agentDisabledMcpIds" | "agentDisabledSkillIds">;
}): string[] {
  if (input.runtime !== "claude" && input.runtime !== "codex") return [];

  const mcpSources = input.settings.agentMcpSyncEnabled
    ? filterSourcesForSessions(discoverMcpSources(input.cwd), input.settings.agentDisabledMcpIds)
    : [];
  const skillSources = input.settings.agentSkillSyncEnabled
    ? filterSourcesForSessions(discoverSkillSources(input.cwd), input.settings.agentDisabledSkillIds)
    : [];
  if (mcpSources.length === 0 && skillSources.length === 0) return [];

  const lines = [
    "Spark synced only compact MCP/skill awareness into this prompt so your context window stays focused.",
    "- Treat the names below as capability hints, not full documentation.",
    "- Inspect full runtime config or skill docs only when they materially help this task; summarize findings instead of pasting large config/tool output back into your working context.",
    "- If a listed MCP server or skill is not available in your current runtime session, continue with normal filesystem and terminal tools.",
  ];

  if (mcpSources.length > 0) {
    lines.push("", "MCP servers discovered:", ...formatSources(mcpSources));
  }
  if (skillSources.length > 0) {
    lines.push("", "Skills discovered:", ...formatSources(skillSources));
  }

  return lines;
}

export function renderAgentSyncManagerContext(input: {
  cwd: string;
  settings: Pick<AppSettings, "agentMcpSyncEnabled" | "agentSkillSyncEnabled" | "agentDisabledMcpIds" | "agentDisabledSkillIds">;
}): string {
  const lines: string[] = [];
  if (input.settings.agentMcpSyncEnabled) {
    const mcpSources = filterSourcesForSessions(discoverMcpSources(input.cwd), input.settings.agentDisabledMcpIds);
    if (mcpSources.length > 0) {
      lines.push("MCP servers:", ...formatSources(mcpSources));
    }
  }
  if (input.settings.agentSkillSyncEnabled) {
    const skillSources = filterSourcesForSessions(discoverSkillSources(input.cwd), input.settings.agentDisabledSkillIds);
    if (skillSources.length > 0) {
      lines.push("Skills:", ...formatSources(skillSources));
    }
  }
  if (lines.length === 0) return "No synced MCP servers or skills discovered.";
  return [
    "Use these compact capability names to decide when a worker prompt should explicitly say to use a named MCP server or skill. Do not paste configs/docs into task descriptions.",
    ...lines,
  ].join("\n");
}

export function listAgentAssets(input: {
  cwd?: string | null;
  settings: Pick<AppSettings, "agentDisabledMcpIds" | "agentDisabledSkillIds">;
}): AgentAssetInventory {
  const cwd = input.cwd ?? "";
  return {
    mcp: cwd
      ? sourcesToInventory(discoverMcpSources(cwd), input.settings.agentDisabledMcpIds)
      : sourcesToInventory(discoverMcpSources(homedir()), input.settings.agentDisabledMcpIds)
        .filter((item) => item.scope === "user"),
    skills: cwd
      ? sourcesToInventory(discoverSkillSources(cwd), input.settings.agentDisabledSkillIds)
      : sourcesToInventory(discoverSkillSources(homedir()), input.settings.agentDisabledSkillIds)
        .filter((item) => item.scope === "user"),
  };
}

export async function deleteAgentAsset(input: { id: string }): Promise<AgentAssetDeleteResult> {
  const parsed = parseAssetId(input.id);
  if (!parsed) return { ok: false, deleted: [], error: "Invalid agent asset id." };
  try {
    if (parsed.kind === "mcp") {
      const deleted = await deleteMcpAsset(parsed);
      return { ok: true, deleted };
    }
    const deleted = await deleteSkillAsset(parsed);
    return { ok: true, deleted };
  } catch (err) {
    return { ok: false, deleted: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncAgentAssets(input: { cwd?: string | null }): Promise<AgentSyncResult> {
  const startedAt = new Date().toISOString();
  const result: AgentSyncResult = {
    startedAt,
    completedAt: startedAt,
    mcp: { toClaude: [], toCodex: [], skipped: [], errors: [] },
    skills: { toClaude: [], toCodex: [], skipped: [], errors: [] },
  };

  await syncMcpConfigs(input.cwd ?? null, result);
  await syncSkillDirs(input.cwd ?? null, result);

  result.completedAt = new Date().toISOString();
  return result;
}

function discoverMcpSources(cwd: string): SyncSource[] {
  const sources: SyncSource[] = [];
  for (const candidate of mcpConfigCandidates(cwd)) {
    const text = readSmallText(candidate.path, MAX_CONFIG_BYTES);
    if (!text) continue;
    const names = candidate.path.toLowerCase().endsWith(".json")
      ? extractJsonMcpNames(text)
      : extractTomlMcpNames(text);
    if (names.length === 0) continue;
    sources.push({
      kind: "mcp",
      runtime: candidate.runtime,
      scope: candidate.scope,
      path: candidate.path,
      names,
    });
  }
  return dedupeSources(sources);
}

function discoverSkillSources(cwd: string): SyncSource[] {
  const sources: SyncSource[] = [];
  for (const candidate of skillRootCandidates(cwd)) {
    const names = findSkillNames(candidate.path);
    if (names.length === 0) continue;
    sources.push({
      kind: "skill",
      runtime: candidate.runtime,
      scope: candidate.scope,
      path: candidate.path,
      names,
    });
  }
  return dedupeSources(sources);
}

function filterSourcesForSessions(sources: SyncSource[], disabledSessionKeys: string[]): SyncSource[] {
  const disabled = new Set(disabledSessionKeys);
  return sources
    .map((source) => ({
      ...source,
      names: source.names.filter((name) => !disabled.has(sessionKey(source.kind, name))),
    }))
    .filter((source) => source.names.length > 0);
}

function sourcesToInventory(
  sources: SyncSource[],
  disabledSessionKeys: string[],
): AgentAssetInventoryItem[] {
  const disabled = new Set(disabledSessionKeys);
  const items: AgentAssetInventoryItem[] = [];
  for (const source of sources) {
    for (const name of source.names) {
      const key = sessionKey(source.kind, name);
      const compatibility = describeAssetCompatibility(source, name);
      items.push({
        id: assetId({ kind: source.kind, runtime: source.runtime, scope: source.scope, name, path: source.path }),
        sessionKey: key,
        kind: source.kind,
        runtime: source.runtime,
        scope: source.scope,
        name,
        path: source.path,
        enabledForSessions: !disabled.has(key),
        detail: source.path,
        canDelete: !isProtectedSkillSource(source, name),
        compatibility: compatibility.compatibility,
        compatibilityReason: compatibility.reason,
        syncable: compatibility.syncable,
      });
    }
  }
  return items.sort((a, b) => `${a.kind}:${a.name}:${a.runtime}:${a.scope}`.localeCompare(`${b.kind}:${b.name}:${b.runtime}:${b.scope}`));
}

function describeAssetCompatibility(
  source: SyncSource,
  name: string,
): { compatibility: AgentAssetCompatibility; reason: string; syncable: boolean } {
  if (source.kind === "mcp") {
    return {
      compatibility: "both",
      reason: "MCP servers are runtime-agnostic if the local command or URL is reachable.",
      syncable: true,
    };
  }

  const skillDir = findSkillDirByName(source.path, name);
  const normalizedSkillDir = normalizePathForMatch(skillDir ?? source.path);
  if (source.runtime === "codex" && normalizedSkillDir.includes(CODEX_SYSTEM_SKILL_ROOT)) {
    return {
      compatibility: "codex",
      reason: "Bundled Codex system skill; it may reference Codex-only tools or plugin hooks.",
      syncable: false,
    };
  }
  if (source.runtime === "shared") {
    return {
      compatibility: "both",
      reason: "Shared skill source.",
      syncable: true,
    };
  }
  return {
    compatibility: "both",
    reason: "Plain skill docs can be offered to either runtime; workers load full docs only when useful.",
    syncable: true,
  };
}

function isProtectedSkillSource(source: SyncSource, name: string): boolean {
  if (source.kind !== "skill") return false;
  const skillDir = findSkillDirByName(source.path, name);
  return Boolean(skillDir && normalizePathForMatch(skillDir).includes(CODEX_SYSTEM_SKILL_ROOT));
}

function sessionKey(kind: SyncKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

function assetId(input: {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  name: string;
  path: string;
}): string {
  return JSON.stringify(input);
}

function parseAssetId(id: string): {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  name: string;
  path: string;
} | null {
  try {
    const parsed = JSON.parse(id) as Record<string, unknown>;
    const kind = parsed.kind === "mcp" || parsed.kind === "skill" ? parsed.kind : null;
    const runtime =
      parsed.runtime === "claude" || parsed.runtime === "codex" || parsed.runtime === "shared"
        ? parsed.runtime
        : null;
    const scope = parsed.scope === "user" || parsed.scope === "workspace" ? parsed.scope : null;
    const name = typeof parsed.name === "string" ? parsed.name : null;
    const path = typeof parsed.path === "string" ? parsed.path : null;
    if (!kind || !runtime || !scope || !name || !path) return null;
    return { kind, runtime, scope, name, path };
  } catch {
    return null;
  }
}

async function deleteMcpAsset(asset: { runtime: SyncSourceRuntime; name: string; path: string }): Promise<string[]> {
  if (asset.runtime === "claude" || asset.runtime === "shared") {
    await deleteClaudeMcpServer(asset.path, asset.name);
    return [asset.name];
  }
  if (asset.runtime === "codex") {
    await deleteCodexMcpServer(asset.path, asset.name);
    return [asset.name];
  }
  return [];
}

async function deleteSkillAsset(asset: { runtime: SyncSourceRuntime; name: string; path: string }): Promise<string[]> {
  const root = asset.path;
  const candidates = findSkillDirs(root).filter((dir) => basename(dir) === asset.name || readSkillName(join(dir, "SKILL.md")) === asset.name);
  for (const dir of candidates) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return candidates;
}

async function syncMcpConfigs(cwd: string | null, result: AgentSyncResult): Promise<void> {
  if (!cwd) {
    result.mcp.skipped.push("No active workspace; project-scoped Claude .mcp.json sync was skipped.");
    return;
  }

  const claudePath = join(cwd, ".mcp.json");
  const codexPath = join(homedir(), ".codex", "config.toml");

  try {
    const claudeServers = readClaudeMcpServers(claudePath);
    const codexServers = readCodexMcpServers(codexPath);

    const codexAdded = await writeCodexManagedMcpServers(codexPath, claudeServers, result);
    result.mcp.toCodex.push(...codexAdded);

    const claudeAdded = await writeClaudeMcpServers(claudePath, codexServers, result);
    result.mcp.toClaude.push(...claudeAdded);

    if (claudeServers.length === 0 && codexServers.length === 0) {
      result.mcp.skipped.push("No MCP servers found in workspace .mcp.json or user Codex config.toml.");
    }
  } catch (err) {
    result.mcp.errors.push(err instanceof Error ? err.message : String(err));
  }
}

async function syncSkillDirs(cwd: string | null, result: AgentSyncResult): Promise<void> {
  const home = homedir();
  const rootPairs = [
    {
      codex: join(home, ".codex", "skills"),
      claude: join(home, ".claude", "skills"),
      label: "user",
    },
  ];
  if (cwd) {
    rootPairs.push({
      codex: join(cwd, ".codex", "skills"),
      claude: join(cwd, ".claude", "skills"),
      label: "workspace",
    });
  }

  for (const pair of rootPairs) {
    await copyMissingSkills(pair.codex, pair.claude, "codex", "claude", pair.label, result);
    await copyMissingSkills(pair.claude, pair.codex, "claude", "codex", pair.label, result);
  }
}

function readClaudeMcpServers(path: string): McpServerConfig[] {
  const text = readSmallText(path, MAX_CONFIG_BYTES);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).mcpServers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([name, value]) => normalizeMcpServer(name, value))
    .filter((server): server is McpServerConfig => Boolean(server));
}

function readCodexMcpServers(path: string): McpServerConfig[] {
  const text = readSmallText(path, MAX_CONFIG_BYTES);
  if (!text) return [];
  return parseCodexTomlMcpServers(stripManagedMcpBlock(text).text);
}

function normalizeMcpServer(name: string, value: unknown): McpServerConfig | null {
  if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const args = Array.isArray(record.args)
    ? record.args.filter((item): item is string => typeof item === "string")
    : undefined;
  const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
    ? Object.fromEntries(
      Object.entries(record.env as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, String(v)]),
    )
    : undefined;
  const server: McpServerConfig = {
    name: name.trim(),
    command: typeof record.command === "string" ? record.command : undefined,
    args,
    env,
    url: typeof record.url === "string" ? record.url : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
  };
  if (!server.command && !server.url) return null;
  return server;
}

function parseCodexTomlMcpServers(text: string): McpServerConfig[] {
  const servers = new Map<string, McpServerConfig>();
  let current: McpServerConfig | null = null;
  let envTarget: McpServerConfig | null = null;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[mcp_servers(?:\.(?:"([^"]+)"|'([^']+)'|([^\].\s]+)))?(?:\.env)?\]$/);
    if (section) {
      const name = section[1] || section[2] || section[3] || "";
      const isEnv = /\.env\]$/.test(line);
      current = name ? (servers.get(name) ?? { name }) : null;
      if (current && !servers.has(name)) servers.set(name, current);
      envTarget = isEnv ? current : null;
      continue;
    }
    if (envTarget) {
      const kv = parseTomlKeyValue(line);
      if (kv) {
        envTarget.env = { ...(envTarget.env ?? {}), [kv.key]: kv.value };
      }
      continue;
    }
    if (!current) continue;
    const kv = parseTomlKeyValue(line);
    if (!kv) continue;
    if (kv.key === "command") current.command = kv.value;
    if (kv.key === "url") current.url = kv.value;
    if (kv.key === "enabled") current.enabled = kv.value !== "false";
    if (kv.key === "args") current.args = parseTomlStringArray(kv.rawValue);
  }
  return [...servers.values()].filter((server) => server.command || server.url);
}

async function writeCodexManagedMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
): Promise<string[]> {
  if (sourceServers.length === 0) return [];
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const stripped = stripManagedMcpBlock(existing);
  const existingNames = new Set(parseCodexTomlMcpServers(stripped.text).map((server) => server.name));
  const syncable = sourceServers.filter((server) => {
    if (existingNames.has(server.name)) {
      result.mcp.skipped.push(`Codex already has MCP server '${server.name}'.`);
      return false;
    }
    if (!server.command && !server.url) {
      result.mcp.skipped.push(`Claude MCP server '${server.name}' is missing command/url and was skipped for Codex.`);
      return false;
    }
    return true;
  });
  if (syncable.length === 0 && !stripped.removed) return [];

  await fs.mkdir(join(homedir(), ".codex"), { recursive: true });
  const block = syncable.length > 0 ? renderCodexManagedBlock(syncable) : "";
  const base = stripped.text.trimEnd();
  const next = [base, block].filter(Boolean).join("\n\n") + "\n";
  await fs.writeFile(path, next, "utf8");
  return syncable.map((server) => server.name);
}

async function writeClaudeMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
): Promise<string[]> {
  if (sourceServers.length === 0) return [];
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.mcp.errors.push(`Could not read ${path}: ${(err as Error).message}`);
      return [];
    }
  }
  const existing =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers as Record<string, unknown>
      : {};
  const added: string[] = [];
  for (const server of sourceServers) {
    if (existing[server.name]) {
      result.mcp.skipped.push(`Claude already has MCP server '${server.name}'.`);
      continue;
    }
    existing[server.name] = renderClaudeMcpServer(server);
    added.push(server.name);
  }
  if (added.length === 0) return [];
  parsed.mcpServers = existing;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return added;
}

async function deleteClaudeMcpServer(path: string, name: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) return;
  const servers = parsed.mcpServers as Record<string, unknown>;
  delete servers[name];
  parsed.mcpServers = servers;
  await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

async function deleteCodexMcpServer(path: string, name: string): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch {
    return;
  }
  const next = removeCodexMcpServerBlock(existing, name);
  if (next !== existing) {
    await fs.writeFile(path, next, "utf8");
  }
}

async function copyMissingSkills(
  sourceRoot: string,
  destRoot: string,
  sourceRuntime: "claude" | "codex",
  destRuntime: "claude" | "codex",
  scope: string,
  result: AgentSyncResult,
): Promise<void> {
  const skillDirs = findSkillDirs(sourceRoot);
  if (skillDirs.length === 0) return;
  await fs.mkdir(destRoot, { recursive: true });
  for (const source of skillDirs) {
    const name = basename(source);
    const compatibility = describeSkillDirCompatibility(sourceRuntime, source);
    if (!skillDirCanSyncToRuntime(compatibility.compatibility, destRuntime)) {
      result.skills.skipped.push(
        `${sourceRuntime} ${scope} skill '${name}' is ${compatibility.compatibility}-only; not copied to ${destRuntime}.`,
      );
      continue;
    }
    if (isSymlink(source)) {
      result.skills.skipped.push(`${sourceRuntime} ${scope} skill '${name}' is a symlink; skipped direct copy.`);
      continue;
    }
    const dest = join(destRoot, name);
    if (pathExists(dest)) {
      result.skills.skipped.push(`${destRuntime} already has ${scope} skill '${name}'.`);
      continue;
    }
    try {
      await copyDir(source, dest);
      const label = `${scope}:${name}`;
      if (destRuntime === "claude") result.skills.toClaude.push(label);
      else result.skills.toCodex.push(label);
    } catch (err) {
      result.skills.errors.push(
        `Could not copy ${sourceRuntime} ${scope} skill '${name}' to ${destRuntime}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function describeSkillDirCompatibility(
  sourceRuntime: "claude" | "codex",
  source: string,
): { compatibility: AgentAssetCompatibility; reason: string } {
  const normalized = normalizePathForMatch(source);
  if (sourceRuntime === "codex" && normalized.includes(CODEX_SYSTEM_SKILL_ROOT)) {
    return {
      compatibility: "codex",
      reason: "Bundled Codex system skill.",
    };
  }
  return {
    compatibility: "both",
    reason: "Plain skill docs.",
  };
}

function skillDirCanSyncToRuntime(
  compatibility: AgentAssetCompatibility,
  destRuntime: "claude" | "codex",
): boolean {
  return compatibility === "both" || compatibility === "unknown" || compatibility === destRuntime;
}

function mcpConfigCandidates(cwd: string): Array<{
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
}> {
  const home = homedir();
  return [
    { runtime: "shared", scope: "workspace", path: join(cwd, ".mcp.json") },
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "settings.json") },
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "settings.local.json") },
    { runtime: "codex", scope: "workspace", path: join(cwd, ".codex", "config.toml") },
    { runtime: "shared", scope: "user", path: join(home, ".mcp.json") },
    { runtime: "claude", scope: "user", path: join(home, ".claude.json") },
    { runtime: "claude", scope: "user", path: join(home, ".claude", "settings.json") },
    { runtime: "codex", scope: "user", path: join(home, ".codex", "config.toml") },
  ];
}

function skillRootCandidates(cwd: string): Array<{
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
}> {
  const home = homedir();
  return [
    { runtime: "codex", scope: "workspace", path: join(cwd, ".codex", "skills") },
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "skills") },
    { runtime: "shared", scope: "workspace", path: join(cwd, ".agents", "skills") },
    { runtime: "codex", scope: "user", path: join(home, ".codex", "skills") },
    { runtime: "claude", scope: "user", path: join(home, ".claude", "skills") },
  ];
}

function readSmallText(path: string, maxBytes: number): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function extractTomlMcpNames(text: string): string[] {
  const names = new Set<string>();
  const sectionPattern = /^\s*\[mcp_servers(?:\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+)))?\]\s*$/gm;
  for (const match of text.matchAll(sectionPattern)) {
    const name = (match[1] || match[2] || match[3] || "").trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function stripManagedMcpBlock(text: string): { text: string; removed: boolean } {
  const start = text.indexOf(MCP_SYNC_START);
  const end = text.indexOf(MCP_SYNC_END);
  if (start === -1 || end === -1 || end < start) return { text, removed: false };
  const after = end + MCP_SYNC_END.length;
  return {
    text: `${text.slice(0, start).trimEnd()}\n${text.slice(after).trimStart()}`.trimEnd() + "\n",
    removed: true,
  };
}

function removeCodexMcpServerBlock(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  const serverSection = new RegExp(
    `^\\s*\\[mcp_servers\\.(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)})(?:\\.env)?\\]\\s*$`,
  );
  for (const line of lines) {
    const isSection = /^\s*\[/.test(line);
    if (serverSection.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && isSection) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderCodexManagedBlock(servers: McpServerConfig[]): string {
  return [
    MCP_SYNC_START,
    "# Managed by Spark Agent Settings > Agents sync. Edit the source .mcp.json or remove this block to reset.",
    ...servers.flatMap((server) => renderCodexMcpServer(server)),
    MCP_SYNC_END,
  ].join("\n");
}

function renderCodexMcpServer(server: McpServerConfig): string[] {
  const lines = ["", `[mcp_servers.${quoteTomlBareOrString(server.name)}]`];
  if (server.command) {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
  }
  if (server.url) lines.push(`url = ${tomlString(server.url)}`);
  if (server.enabled === false) lines.push("enabled = false");
  else lines.push("enabled = true");
  const env = server.env ?? {};
  const envKeys = Object.keys(env).sort();
  if (envKeys.length > 0) {
    lines.push("", `[mcp_servers.${quoteTomlBareOrString(server.name)}.env]`);
    for (const key of envKeys) {
      lines.push(`${quoteTomlBareOrString(key)} = ${tomlString(env[key])}`);
    }
  }
  return lines;
}

function renderClaudeMcpServer(server: McpServerConfig): Record<string, unknown> {
  if (server.url) {
    return {
      type: server.type === "sse" ? "sse" : "streamable-http",
      url: server.url,
    };
  }
  return {
    type: "stdio",
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
  };
}

function parseTomlKeyValue(line: string): { key: string; value: string; rawValue: string } | null {
  const match = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
  if (!match) return null;
  const key = unquoteTomlString(match[1]);
  const rawValue = match[2].trim();
  if (rawValue === "true" || rawValue === "false") return { key, value: rawValue, rawValue };
  return { key, value: unquoteTomlString(rawValue), rawValue };
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const body = trimmed.slice(1, -1);
  const out: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of body.matchAll(regex)) {
    out.push(match[1] !== undefined ? unescapeTomlString(match[1]) : match[2]);
  }
  return out;
}

function unquoteTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeTomlString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteTomlBareOrString(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function extractJsonMcpNames(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const names = new Set<string>();
  collectJsonMcpNames(parsed, names, 0);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function collectJsonMcpNames(value: unknown, names: Set<string>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if ((key === "mcpServers" || key === "mcp_servers") && child && typeof child === "object" && !Array.isArray(child)) {
      for (const name of Object.keys(child as Record<string, unknown>)) {
        if (name.trim()) names.add(name.trim());
      }
      continue;
    }
    collectJsonMcpNames(child, names, depth + 1);
  }
}

function findSkillNames(root: string): string[] {
  if (!directoryExists(root)) return [];
  const names = new Set<string>();
  walkSkillDirs(root, 0, names);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function findSkillDirs(root: string): string[] {
  if (!directoryExists(root)) return [];
  const out: string[] = [];
  collectSkillDirs(root, 0, out);
  return out;
}

function findSkillDirByName(root: string, name: string): string | null {
  return findSkillDirs(root).find((dir) => basename(dir) === name || readSkillName(join(dir, "SKILL.md")) === name) ?? null;
}

function collectSkillDirs(dir: string, depth: number, out: string[]): void {
  if (depth > 3 || out.length >= 128) return;
  if (findSkillFile(dir)) {
    out.push(dir);
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const child = join(dir, entry);
    if (!directoryExists(child)) continue;
    collectSkillDirs(child, depth + 1, out);
  }
}

async function copyDir(source: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const sourcePath = join(source, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath);
    }
  }
}

function walkSkillDirs(dir: string, depth: number, names: Set<string>): void {
  if (depth > 3 || names.size >= 48) return;
  const skillMd = findSkillFile(dir);
  if (skillMd) {
    names.add(readSkillName(skillMd) || basename(dir));
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const child = join(dir, entry);
    if (!directoryExists(child)) continue;
    walkSkillDirs(child, depth + 1, names);
    if (names.size >= 48) return;
  }
}

function findSkillFile(dir: string): string | null {
  const candidates = [join(dir, "SKILL.md"), join(dir, "skill.md")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function readSkillName(path: string): string | null {
  const text = readSmallText(path, MAX_SKILL_DOC_BYTES);
  const heading = text?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return null;
  return heading.replace(/\s+/g, " ").slice(0, 80);
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function dedupeSources(sources: SyncSource[]): SyncSource[] {
  const out: SyncSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.kind}:${source.runtime}:${source.scope}:${source.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...source,
      names: [...new Set(source.names.map((name) => name.trim()).filter(Boolean))],
    });
  }
  return out.filter((source) => source.names.length > 0);
}

function formatSources(sources: SyncSource[]): string[] {
  const visible = sources.slice(0, MAX_SOURCE_LINES);
  const lines = visible.map((source) => {
    const names = source.names.slice(0, MAX_NAMES_PER_LINE);
    const suffix = source.names.length > names.length ? `, +${source.names.length - names.length} more` : "";
    return `- ${source.runtime} ${source.scope} (${source.path}): ${names.join(", ")}${suffix}`;
  });
  const omitted = sources.length - visible.length;
  if (omitted > 0) {
    lines.push(`- +${omitted} more source(s) omitted to keep this prompt compact.`);
  }
  return lines;
}
