import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type {
  AgentAssetCompatibility,
  AgentSyncResult,
  AppSettings,
  WorkerRuntime,
} from "@shared/types";
import { claudeConfigDir, claudeUserConfigFile } from "./orchestration/claude-paths";
import type {
  AgentAssetDeleteResult,
  AgentAssetInstallResult,
  AgentAssetInventory,
  AgentAssetInventoryItem,
  AgentMcpSaveResult,
  AgentMcpServerDetail,
  AgentMcpServerDraft,
  AgentMcpTarget,
  AgentMcpTransport,
} from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";

type SyncKind = "mcp" | "skill";
// Grok Build reads the same Codex-shaped TOML (`[mcp_servers.<name>]`), which
// is why mcp-installer registers the built-in server in ~/.grok/config.toml
// with renderCodexBlock(). One parser and one writer serve both.
type SyncSourceRuntime = "claude" | "codex" | "grok" | "shared";
type TomlCopyRuntime = "codex" | "grok";
type SyncScope = "user" | "workspace";

interface SyncSource {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
  names: string[];
  // MCP only, and best effort: a name is discovered even when its definition
  // cannot be parsed, so a name may be missing from this map.
  configs?: Map<string, McpServerConfig>;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  // Read for remote servers only. Claude/Codex sync never writes it back, it
  // exists so the Pi bridge can authenticate a streamable-http endpoint.
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Which Pi session role a discovered MCP server was assigned to. */
export type PiMcpScope = "cora" | "worker";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SKILL_DOC_BYTES = 16 * 1024;
const MAX_NAMES_PER_LINE = 12;
// Keys that hold an MCP server map in a JSON config, at any nesting level.
const MCP_MAP_KEYS = ["mcpServers", "mcp_servers"];
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
    "Codara synced only compact MCP/skill awareness into this prompt so your context window stays focused.",
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

export function listAgentAssets(input: {
  cwd?: string | null;
  settings: Pick<
    AppSettings,
    "agentDisabledMcpIds" | "agentDisabledSkillIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds"
  >;
}): AgentAssetInventory {
  const cwd = input.cwd ?? "";
  const piScopes = {
    cora: input.settings.agentMcpCoraManagerIds ?? [],
    worker: input.settings.agentMcpPiWorkerIds ?? [],
  };
  return {
    mcp: cwd
      ? sourcesToInventory(discoverMcpSources(cwd), input.settings.agentDisabledMcpIds, piScopes)
      : sourcesToInventory(discoverMcpSources(homedir()), input.settings.agentDisabledMcpIds, piScopes)
        .filter((item) => item.scope === "user"),
    skills: cwd
      ? sourcesToInventory(discoverSkillSources(cwd), input.settings.agentDisabledSkillIds)
      : sourcesToInventory(discoverSkillSources(homedir()), input.settings.agentDisabledSkillIds)
        .filter((item) => item.scope === "user"),
  };
}

/**
 * Resolve the MCP servers a Pi session of the given role should connect to.
 * Assignment is opt-in per scope (AppSettings.agentMcpCoraManagerIds /
 * agentMcpPiWorkerIds) and still honors the session-wide disable list, so a
 * server disabled in the Capability Center never reaches Pi even if it was
 * assigned earlier. Discovery reuses the same config candidates Claude/Codex
 * sync reads; nothing is written.
 */
export function listPiMcpServers(input: {
  cwd?: string | null;
  scope: PiMcpScope;
  settings: Pick<AppSettings, "agentDisabledMcpIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds">;
}): McpServerConfig[] {
  const assigned = new Set(
    input.scope === "cora"
      ? input.settings.agentMcpCoraManagerIds ?? []
      : input.settings.agentMcpPiWorkerIds ?? [],
  );
  if (assigned.size === 0) return [];
  const disabled = new Set(input.settings.agentDisabledMcpIds ?? []);
  const sources = discoverMcpSources(input.cwd?.trim() || homedir());
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const name of source.names) {
      const key = sessionKey("mcp", name);
      if (!assigned.has(key) || disabled.has(key) || seen.has(key)) continue;
      const server = readMcpServerByName(source.path, name);
      // First readable definition wins: workspace candidates are listed before
      // user-scope ones, matching how the runtimes themselves resolve a name.
      if (!server || server.enabled === false) continue;
      seen.add(key);
      servers.push(server);
    }
  }
  return servers;
}

/**
 * Config files the Capability Center is allowed to write a user-authored MCP
 * server into. Workspace entries come first so the add form defaults to the
 * project, and every path is one discoverMcpSources already reads back.
 */
export function listMcpWriteTargets(input: { cwd?: string | null }): AgentMcpTarget[] {
  const cwd = input.cwd?.trim() ?? "";
  const home = homedir();
  const targets: AgentMcpTarget[] = [];
  if (cwd) {
    targets.push(mcpTarget("shared", "workspace", join(cwd, ".mcp.json"), "This workspace, all agents"));
    targets.push(mcpTarget("claude", "workspace", join(cwd, ".claude", "settings.json"), "This workspace, Claude"));
    targets.push(mcpTarget("codex", "workspace", join(cwd, ".codex", "config.toml"), "This workspace, Codex"));
  }
  targets.push(mcpTarget("shared", "user", join(home, ".mcp.json"), "Every workspace, all agents"));
  targets.push(mcpTarget("claude", "user", claudeUserConfigFile(), "Every workspace, Claude"));
  targets.push(mcpTarget("codex", "user", join(home, ".codex", "config.toml"), "Every workspace, Codex"));
  return targets;
}

/** Full definition behind one discovered MCP entry, for the edit form. */
export function readMcpServerDetail(input: { id: string }): AgentMcpServerDetail | null {
  const parsed = parseAssetId(input.id);
  if (!parsed || parsed.kind !== "mcp") return null;
  const server = readMcpServerByName(parsed.path, parsed.name);
  if (!server) return null;
  return {
    id: input.id,
    targetId: mcpTargetId(parsed.runtime, parsed.scope, parsed.path),
    name: server.name,
    // An SSE entry edits as HTTP: the form keeps the url and the save migrates
    // it to streamable-http, which is what both runtimes read today.
    transport: server.url ? "http" : "stdio",
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

/**
 * Create or update a user-authored MCP server. Unlike writeClaudeMcpServers,
 * which is additive and skips an existing name, this overwrites in place so an
 * edit sticks. When `replaceId` names an entry in a different file or under a
 * different name, that entry is removed after the new one is written, so an
 * edit that changes location moves rather than forks.
 */
export async function saveMcpServer(input: {
  cwd?: string | null;
  targetId: string;
  server: AgentMcpServerDraft;
  replaceId?: string | null;
}): Promise<AgentMcpSaveResult> {
  const previous = input.replaceId ? parseAssetId(input.replaceId) : null;
  let target = listMcpWriteTargets({ cwd: input.cwd ?? null }).find((item) => item.id === input.targetId);
  // Editing in place: an entry's own file is always a legal destination, even
  // when discovery reads it but the add form does not offer it as a location.
  if (!target && previous && previous.kind === "mcp") {
    const own = mcpTargetId(previous.runtime, previous.scope, previous.path);
    if (own === input.targetId) {
      target = mcpTarget(previous.runtime, previous.scope, previous.path, "Current location");
    }
  }
  if (!target) return { ok: false, error: "Unknown config location." };
  const validated = validateMcpDraft(input.server);
  if ("error" in validated) return { ok: false, error: validated.error };
  const server = validated.server;
  if (target.format === "toml" && server.headers) {
    return { ok: false, error: "Codex config.toml cannot carry request headers. Save this server to a JSON config instead." };
  }

  // Editing an entry that already lives in this file: the write rewrites it
  // where it sits, so a rename inside the file is not a move either.
  const editingHere = Boolean(previous && previous.kind === "mcp" && previous.path === target.path);
  const replaceName = editingHere ? previous!.name : null;
  const replacingHere = editingHere && previous!.name === server.name;
  if (!replacingHere && mcpNameTaken(target, server.name, replaceName)) {
    return { ok: false, error: `'${server.name}' already exists in ${target.path}.` };
  }

  try {
    if (target.format === "json") await upsertClaudeMcpServer(target.path, server, { replaceName });
    else await upsertCodexMcpServer(target.path, server);
    // A JSON rename in place already removed the old key; anything else that
    // changed file or name still needs the old entry taken out.
    const renamedInPlace = editingHere && target.format === "json";
    if (previous && previous.kind === "mcp" && !replacingHere && !renamedInPlace) {
      await deleteMcpAsset(previous);
    }
    return { ok: true, name: server.name, path: target.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

// Copy a single discovered asset into the runtime that was missing it. Powers
// the per-cell "Add to Claude/Codex/Grok" action in the Capability Center, so
// the user can spread one MCP server or skill without running a full sync.
export async function installAgentAssetToRuntime(input: {
  id: string;
  target: "claude" | "codex" | "grok";
}): Promise<AgentAssetInstallResult> {
  const parsed = parseAssetId(input.id);
  if (!parsed) return { ok: false, installed: [], error: "Invalid agent asset id." };
  if (parsed.runtime === input.target) {
    return { ok: false, installed: [], error: `'${parsed.name}' is already installed for ${input.target}.` };
  }
  try {
    if (parsed.kind === "mcp") {
      return await installMcpAssetToRuntime(parsed, input.target);
    }
    // Skills are a Claude/Codex directory convention; Grok Build has no
    // equivalent skill root, so the Skills tab never offers a Grok column.
    if (input.target === "grok") {
      return { ok: false, installed: [], error: `Grok Build cannot carry skill '${parsed.name}'.` };
    }
    return await installSkillAssetToRuntime(parsed, input.target);
  } catch (err) {
    return { ok: false, installed: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function blankSyncResult(): AgentSyncResult {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    mcp: { toClaude: [], toCodex: [], skipped: [], errors: [] },
    skills: { toClaude: [], toCodex: [], skipped: [], errors: [] },
  };
}

async function installMcpAssetToRuntime(
  asset: { name: string; path: string },
  target: "claude" | "codex" | "grok",
): Promise<AgentAssetInstallResult> {
  const server = readMcpServerByName(asset.path, asset.name);
  if (!server) {
    return {
      ok: false,
      installed: [],
      error: `Could not read MCP server '${asset.name}' from ${asset.path}.`,
    };
  }
  const result = blankSyncResult();
  if (target === "claude") {
    // Unlike a full sync, an explicit copy of one server carries its headers:
    // the destination is JSON, and a remote server without its Authorization
    // header is a connection that fails on the first call.
    const added = await writeClaudeMcpServers(claudeUserConfigFile(), [server], result, {
      keepHeaders: true,
    });
    if (added.length === 0) {
      return { ok: false, installed: [], error: firstMcpMessage(result, `Could not add '${asset.name}' to Claude.`) };
    }
    return { ok: true, installed: added };
  }
  const label = TOML_RUNTIME_LABEL[target];
  if (server.url && server.headers) {
    return {
      ok: false,
      installed: [],
      error: `'${asset.name}' sends request headers, which ${label} config.toml cannot carry. Keep it in a JSON config.`,
    };
  }
  const added = await writeCodexManagedMcpServers(tomlRuntimeConfigPath(target), [server], result, {
    runtime: target,
  });
  if (added.length === 0) {
    return { ok: false, installed: [], error: firstMcpMessage(result, `Could not add '${asset.name}' to ${label}.`) };
  }
  return { ok: true, installed: added };
}

const TOML_RUNTIME_LABEL: Record<TomlCopyRuntime, string> = {
  codex: "Codex",
  grok: "Grok Build",
};

function tomlRuntimeConfigPath(runtime: TomlCopyRuntime): string {
  return runtime === "grok"
    ? join(homedir(), ".grok", "config.toml")
    : join(homedir(), ".codex", "config.toml");
}

async function installSkillAssetToRuntime(
  asset: { name: string; path: string },
  target: "claude" | "codex",
): Promise<AgentAssetInstallResult> {
  const sourceDir = findSkillDirByName(asset.path, asset.name);
  if (!sourceDir) {
    return { ok: false, installed: [], error: `Could not locate skill '${asset.name}' under ${asset.path}.` };
  }
  if (isSymlink(sourceDir)) {
    return { ok: false, installed: [], error: `Skill '${asset.name}' is a symlink; copy it manually.` };
  }
  // Mirror the source scope: a workspace skill stays in the workspace (swap the
  // .claude/.codex segment), a user skill lands in the target's user root.
  const destRoot = deriveSkillDestRoot(asset.path, target);
  const dest = join(destRoot, basename(sourceDir));
  if (pathExists(dest)) {
    return { ok: false, installed: [], error: `${target} already has skill '${asset.name}'.` };
  }
  await fs.mkdir(destRoot, { recursive: true });
  await copyDir(sourceDir, dest);
  return { ok: true, installed: [asset.name] };
}

function firstMcpMessage(result: AgentSyncResult, fallback: string): string {
  return result.mcp.errors[0] ?? result.mcp.skipped[0] ?? fallback;
}

// Map a skill-root path on one runtime to the equivalent root on `target` by
// swapping the nearest `.claude`/`.codex` segment. Falls back to the target's
// user-scope root when the source path has no recognizable runtime segment.
function deriveSkillDestRoot(sourceRoot: string, target: "claude" | "codex"): string {
  const parts = sourceRoot.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === ".claude" || parts[i] === ".codex") {
      parts[i] = `.${target}`;
      return parts.join(sep);
    }
  }
  return join(homedir(), `.${target}`, "skills");
}

/**
 * Whether saving `name` into `target` would collide. Only the map the write
 * lands in counts: for a JSON add that is the top-level mcpServers map, so a
 * per-project entry nested deeper in the same file (a different scope the
 * writer never touches) does not block the add. `replaceName` names the entry
 * being edited in this same file, whose own map is the destination.
 */
function mcpNameTaken(target: AgentMcpTarget, name: string, replaceName: string | null): boolean {
  if (target.format !== "json") return readMcpServerByName(target.path, name) !== null;
  const text = readSmallText(target.path, MAX_CONFIG_BYTES);
  if (!text) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparseable configs are refused by the writer, not here.
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const located = replaceName ? locateJsonMcpServer(record, replaceName, 0) : null;
  const container =
    located?.container ??
    (record.mcpServers && typeof record.mcpServers === "object" && !Array.isArray(record.mcpServers)
      ? record.mcpServers as Record<string, unknown>
      : null);
  return Boolean(container && Object.prototype.hasOwnProperty.call(container, name));
}

function readMcpServerByName(path: string, name: string): McpServerConfig | null {
  const text = readSmallText(path, MAX_CONFIG_BYTES);
  if (!text) return null;
  if (path.toLowerCase().endsWith(".json")) {
    return findJsonMcpServer(text, name);
  }
  const servers = parseCodexTomlMcpServers(stripManagedMcpBlock(text).text);
  return servers.find((server) => server.name === name) ?? null;
}

function findJsonMcpServer(text: string, name: string): McpServerConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const located = locateJsonMcpServer(parsed, name, 0);
  if (!located) return null;
  return normalizeMcpServer(name, located.value);
}

/**
 * The map that actually holds `name` in a JSON config, plus its value. A map on
 * the record itself wins over one nested deeper (the per-project maps inside
 * ~/.claude.json), so reads, edits and deletes all agree on which definition a
 * single inventory row stands for.
 */
function locateJsonMcpServer(
  value: unknown,
  name: string,
  depth: number,
): { container: Record<string, unknown>; value: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return null;
  const record = value as Record<string, unknown>;
  for (const key of MCP_MAP_KEYS) {
    const child = record[key];
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.prototype.hasOwnProperty.call(child, name)
    ) {
      const container = child as Record<string, unknown>;
      return { container, value: container[name] };
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (MCP_MAP_KEYS.includes(key)) continue;
    const nested = locateJsonMcpServer(child, name, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function discoverMcpSources(cwd: string): SyncSource[] {
  const sources: SyncSource[] = [];
  for (const candidate of mcpConfigCandidates(cwd)) {
    const text = readSmallText(candidate.path, MAX_CONFIG_BYTES);
    if (!text) continue;
    // Names and definitions come out of one pass: ~/.claude.json can hold
    // hundreds of entries and a second parse per read stalls the inventory.
    const json = candidate.path.toLowerCase().endsWith(".json") ? collectJsonMcpEntries(text) : null;
    const names = json ? json.names : extractTomlMcpNames(text);
    if (names.length === 0) continue;
    const configs =
      json?.configs ??
      new Map(
        parseCodexTomlMcpServers(stripManagedMcpBlock(text).text).map((server) => [server.name, server]),
      );
    sources.push({
      kind: "mcp",
      runtime: candidate.runtime,
      scope: candidate.scope,
      path: candidate.path,
      names,
      configs,
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
  piScopes?: { cora: string[]; worker: string[] },
): AgentAssetInventoryItem[] {
  const disabled = new Set(disabledSessionKeys);
  const coraAssigned = new Set(piScopes?.cora ?? []);
  const workerAssigned = new Set(piScopes?.worker ?? []);
  const items: AgentAssetInventoryItem[] = [];
  for (const source of sources) {
    // Skill compatibility/protection used to call findSkillDirs twice for
    // every item. With plugin caches it turns one inventory read into hundreds
    // of repeated directory walks and leaves the Capability Center waiting on
    // the main process. Index each source tree once instead.
    const skillDirs = source.kind === "skill" ? indexSkillDirsByName(source.path) : null;
    for (const name of source.names) {
      const key = sessionKey(source.kind, name);
      const skillDir = skillDirs?.get(name) ?? null;
      const config = source.kind === "mcp" ? source.configs?.get(name) ?? null : null;
      const compatibility = describeAssetCompatibility(source, skillDir, config);
      items.push({
        id: assetId({ kind: source.kind, runtime: source.runtime, scope: source.scope, name, path: source.path }),
        sessionKey: key,
        kind: source.kind,
        runtime: source.runtime,
        scope: source.scope,
        name,
        path: source.path,
        enabledForSessions: !disabled.has(key),
        enabledForCoraManager: source.kind === "mcp" && coraAssigned.has(key),
        enabledForPiWorkers: source.kind === "mcp" && workerAssigned.has(key),
        detail: source.path,
        canDelete: !isProtectedSkillSource(source, skillDir),
        compatibility: compatibility.compatibility,
        compatibilityReason: compatibility.reason,
        syncable: compatibility.syncable,
        mcpTransport: config ? mcpTransportOf(config) : undefined,
        mcpSummary: config ? describeMcpServer(config) : undefined,
      });
    }
  }
  return items.sort((a, b) => `${a.kind}:${a.name}:${a.runtime}:${a.scope}`.localeCompare(`${b.kind}:${b.name}:${b.runtime}:${b.scope}`));
}

function describeAssetCompatibility(
  source: SyncSource,
  skillDir: string | null,
  config?: McpServerConfig | null,
): { compatibility: AgentAssetCompatibility; reason: string; syncable: boolean } {
  if (source.kind === "mcp") {
    // Codex reads its servers out of config.toml, which has no place for the
    // request headers a remote server authenticates with. Copying such a server
    // over would produce an entry that connects and then fails on the first
    // call, so it is reported as Claude-only rather than silently degraded.
    if (config?.url && config.headers) {
      return {
        compatibility: "claude",
        reason: "This server sends request headers, which Codex config.toml cannot carry. Keep it in a JSON config.",
        syncable: true,
      };
    }
    return {
      compatibility: "both",
      reason: "MCP servers are runtime-agnostic if the local command or URL is reachable.",
      syncable: true,
    };
  }

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

function isProtectedSkillSource(source: SyncSource, skillDir: string | null): boolean {
  if (source.kind !== "skill") return false;
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
      parsed.runtime === "claude" ||
      parsed.runtime === "codex" ||
      parsed.runtime === "grok" ||
      parsed.runtime === "shared"
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
  if (asset.runtime === "codex" || asset.runtime === "grok") {
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
      claude: join(claudeConfigDir(), "skills"),
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
  const headers = record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
    ? Object.fromEntries(
      Object.entries(record.headers as Record<string, unknown>)
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
    headers,
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

// Writes the Codex-shaped managed block. `options.runtime` only changes which
// CLI the skip messages name and how carefully the file is replaced; the TOML
// itself is identical, because Grok Build parses the same tables.
async function writeCodexManagedMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
  options?: { runtime?: TomlCopyRuntime },
): Promise<string[]> {
  if (sourceServers.length === 0) return [];
  const runtime = options?.runtime ?? "codex";
  const label = TOML_RUNTIME_LABEL[runtime];
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const stripped = stripManagedMcpBlock(existing);
  // The block is rewritten whole, so whatever an earlier sync put in it has to
  // be carried over: a one-server copy from the Capability Center would
  // otherwise uninstall every other managed server.
  const managed = readManagedMcpBlockServers(existing);
  const existingNames = new Set(parseCodexTomlMcpServers(stripped.text).map((server) => server.name));
  const syncable = sourceServers.filter((server) => {
    if (existingNames.has(server.name)) {
      result.mcp.skipped.push(`${label} already has MCP server '${server.name}'.`);
      return false;
    }
    // config.toml has no headers table, so copying one over would drop the
    // credential and leave a server that connects but cannot call.
    if (server.url && server.headers) {
      result.mcp.skipped.push(
        `MCP server '${server.name}' sends request headers, which ${label} config.toml cannot carry.`,
      );
      return false;
    }
    if (!server.command && !server.url) {
      result.mcp.skipped.push(`Claude MCP server '${server.name}' is missing command/url and was skipped for ${label}.`);
      return false;
    }
    return true;
  });
  if (syncable.length === 0 && !stripped.removed) return [];

  await fs.mkdir(dirname(path), { recursive: true, mode: runtime === "grok" ? 0o700 : undefined });
  // Source definitions win over the copy already in the block, so a re-sync
  // still refreshes a changed command or env.
  const merged = new Map(managed.map((server) => [server.name, server]));
  for (const server of syncable) merged.set(server.name, server);
  const block = merged.size > 0 ? renderCodexManagedBlock([...merged.values()]) : "";
  const base = stripped.text.trimEnd();
  const next = [base, block].filter(Boolean).join("\n\n") + "\n";
  if (runtime === "grok") {
    // ~/.grok/config.toml can be a share link into a Codara-managed account
    // profile and carries credentials, so the swap has to land on the real
    // file, atomically and owner-only, exactly as mcp-installer's
    // installForGrok does.
    const writePath = await fs.realpath(path).catch(() => path);
    await writeFileAtomic(writePath, next, { mode: 0o600 });
  } else {
    await fs.writeFile(path, next, "utf8");
  }
  return syncable.map((server) => server.name);
}

async function writeClaudeMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
  options?: { keepHeaders?: boolean },
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
    existing[server.name] = options?.keepHeaders
      ? renderUserMcpServer(server)
      : renderClaudeMcpServer(server);
    added.push(server.name);
  }
  if (added.length === 0) return [];
  parsed.mcpServers = existing;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return added;
}

function mcpTarget(
  runtime: SyncSourceRuntime,
  scope: SyncScope,
  path: string,
  label: string,
): AgentMcpTarget {
  return {
    id: mcpTargetId(runtime, scope, path),
    runtime,
    scope,
    path,
    label,
    format: path.toLowerCase().endsWith(".json") ? "json" : "toml",
  };
}

function mcpTargetId(runtime: SyncSourceRuntime, scope: SyncScope, path: string): string {
  return `${runtime}:${scope}:${path}`;
}

// Names are used as TOML bare-or-quoted keys, JSON object keys, and Pi tool
// prefixes, so keep them to the charset every one of those accepts.
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateMcpDraft(draft: AgentMcpServerDraft): { server: McpServerConfig } | { error: string } {
  const name = draft.name.trim();
  if (!name) return { error: "Name is required." };
  if (!MCP_NAME_PATTERN.test(name)) {
    return { error: "Name may use letters, digits, dot, underscore and hyphen, and must start with a letter or digit." };
  }
  if (draft.transport === "http") {
    const url = (draft.url ?? "").trim();
    if (!url) return { error: "URL is required for an HTTP server." };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "URL is not a valid address." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "URL must start with http:// or https://." };
    }
    const headers = normalizeMcpPairs(draft.headers);
    if ("error" in headers) return { error: `Header ${headers.error}` };
    return { server: { name, url, type: "streamable-http", headers: headers.value } };
  }
  const command = (draft.command ?? "").trim();
  if (!command) return { error: "Command is required for a stdio server." };
  const args = (draft.args ?? []).map((arg) => arg.trim()).filter(Boolean);
  const env = normalizeMcpPairs(draft.env);
  if ("error" in env) return { error: `Environment variable ${env.error}` };
  return {
    server: { name, command, args: args.length > 0 ? args : undefined, env: env.value },
  };
}

function normalizeMcpPairs(
  input?: Record<string, string>,
): { value?: Record<string, string> } | { error: string } {
  if (!input) return { value: undefined };
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (/[\s=:]/.test(key)) return { error: `name '${key}' cannot contain spaces, '=' or ':'.` };
    out[key] = String(rawValue ?? "").trim();
  }
  return { value: Object.keys(out).length > 0 ? out : undefined };
}

// Upsert, unlike writeClaudeMcpServers: an existing name is overwritten so an
// edit takes effect. A file that exists but does not parse throws rather than
// being replaced, so a hand-written config is never silently clobbered.
// `replaceName` is the name being edited in this same file: its entry is
// rewritten where it lives, including a per-project map nested inside
// ~/.claude.json, so an edit never forks into a second top-level copy that
// would apply to every workspace. New entries always land on the top-level map.
async function upsertClaudeMcpServer(
  path: string,
  server: McpServerConfig,
  options?: { replaceName?: string | null },
): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read ${path}: ${(err as Error).message}`);
    }
  }
  const replaceName = options?.replaceName ?? null;
  const located = replaceName ? locateJsonMcpServer(parsed, replaceName, 0) : null;
  const container = located?.container ?? ensureTopLevelJsonMcpMap(parsed);
  if (located && replaceName && replaceName !== server.name) delete located.container[replaceName];
  container[server.name] = renderUserMcpServer(server);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

function ensureTopLevelJsonMcpMap(parsed: Record<string, unknown>): Record<string, unknown> {
  const existing =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers as Record<string, unknown>
      : {};
  parsed.mcpServers = existing;
  return existing;
}

async function upsertCodexMcpServer(path: string, server: McpServerConfig): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const base = removeCodexMcpServerBlock(existing, server.name).trimEnd();
  const block = renderCodexMcpServer(server).join("\n").trimStart();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, [base, block].filter(Boolean).join("\n\n") + "\n", "utf8");
}

// renderClaudeMcpServer is shared with sync, which deliberately never copies
// headers between runtimes. A user-authored remote server keeps them.
function renderUserMcpServer(server: McpServerConfig): Record<string, unknown> {
  const rendered = renderClaudeMcpServer(server);
  if (server.url && server.headers) rendered.headers = server.headers;
  return rendered;
}

function mcpTransportOf(server: McpServerConfig): AgentMcpTransport {
  if (!server.url) return "stdio";
  return server.type === "sse" ? "sse" : "http";
}

function describeMcpServer(server: McpServerConfig): string {
  if (server.url) {
    try {
      const url = new URL(server.url);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return server.url;
    }
  }
  const text = [server.command ?? "", ...(server.args ?? [])].filter(Boolean).join(" ");
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

async function deleteClaudeMcpServer(path: string, name: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  // Removes the entry where discovery found it, which for ~/.claude.json can be
  // a per-project map rather than the top-level one.
  const located = locateJsonMcpServer(parsed, name, 0);
  if (!located) return;
  delete located.container[name];
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
    // Grok Build's workspace config mirrors Codex's, and mcp-installer already
    // probes the same path when it looks for a user-owned built-in entry.
    { runtime: "grok", scope: "workspace", path: join(cwd, ".grok", "config.toml") },
    { runtime: "shared", scope: "user", path: join(home, ".mcp.json") },
    { runtime: "claude", scope: "user", path: claudeUserConfigFile() },
    { runtime: "claude", scope: "user", path: join(claudeConfigDir(), "settings.json") },
    { runtime: "codex", scope: "user", path: join(home, ".codex", "config.toml") },
    { runtime: "grok", scope: "user", path: join(home, ".grok", "config.toml") },
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
    { runtime: "claude", scope: "user", path: join(claudeConfigDir(), "skills") },
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
  // Match [mcp_servers.<name>] AND its sub-tables like [mcp_servers."name".env].
  // The bare-key alternative excludes '.' so it never swallows a sub-table
  // segment, and the trailing (?:\.[^\]]+)? consumes ".env" (or any sub-table)
  // so it maps back to <name> instead of becoming a phantom "name".env server.
  const sectionPattern =
    /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\]\s*$/gm;
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

// Servers currently living between the managed markers. Callers that rebuild
// the block need them to keep the servers earlier syncs installed.
function readManagedMcpBlockServers(text: string): McpServerConfig[] {
  const start = text.indexOf(MCP_SYNC_START);
  const end = text.indexOf(MCP_SYNC_END);
  if (start === -1 || end === -1 || end < start) return [];
  return parseCodexTomlMcpServers(text.slice(start + MCP_SYNC_START.length, end));
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
    "# Managed by Codara Settings > Agents sync. Edit the source .mcp.json or remove this block to reset.",
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

// One walk over a JSON config: the names discovery needs plus the definitions
// the inventory row and the edit form need. An entry with neither command nor
// url normalizes to null, so it still counts as a discovered name while
// carrying no definition, which is why callers treat the map as best effort.
function collectJsonMcpEntries(text: string): {
  names: string[];
  configs: Map<string, McpServerConfig>;
} {
  let parsed: unknown;
  const configs = new Map<string, McpServerConfig>();
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names: [], configs };
  }
  const names = new Set<string>();
  walkJsonMcpEntries(parsed, names, configs, 0);
  return { names: [...names].sort((a, b) => a.localeCompare(b)), configs };
}

function walkJsonMcpEntries(
  value: unknown,
  names: Set<string>,
  configs: Map<string, McpServerConfig>,
  depth: number,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return;
  const record = value as Record<string, unknown>;
  // Own maps before nested ones so a top-level definition wins over a
  // per-project copy of the same name, matching locateJsonMcpServer.
  for (const key of MCP_MAP_KEYS) {
    const child = record[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    for (const [rawName, raw] of Object.entries(child as Record<string, unknown>)) {
      const name = rawName.trim();
      if (!name) continue;
      names.add(name);
      const server = normalizeMcpServer(name, raw);
      if (server && !configs.has(server.name)) configs.set(server.name, server);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (MCP_MAP_KEYS.includes(key)) continue;
    walkJsonMcpEntries(child, names, configs, depth + 1);
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

function indexSkillDirsByName(root: string): Map<string, string> {
  const indexed = new Map<string, string>();
  for (const dir of findSkillDirs(root)) {
    const skillFile = findSkillFile(dir);
    const declaredName = skillFile ? readSkillName(skillFile) : "";
    indexed.set(declaredName || basename(dir), dir);
  }
  return indexed;
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
